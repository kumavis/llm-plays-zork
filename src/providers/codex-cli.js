// Codex CLI as a text oracle, using whatever ChatGPT login the CLI already
// has. Unlike the Claude CLI, `codex exec` has no persistent stdin protocol,
// so one process is spawned per turn and the conversation is carried by
// `codex exec resume <thread-id>`: the CLI reloads the thread, appends the
// new game output, and the Responses API prompt cache covers the replayed
// prefix. Boot is therefore paid per turn (~2s), which costs wall time but
// not move budget — runs are bounded by game moves, not the clock.
//
// Sandbox: a fresh empty working directory per game, `--ignore-user-config`
// (no plugins, skills, or MCP servers), `--ignore-rules`, a read-only
// sandbox, and no web search, so the model's only effector is the game.
// Codex's own agent instructions cannot be replaced the way `claude
// --system-prompt` replaces Claude Code's, so the player prompt is injected
// as `developer_instructions` and rides on top of them.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  TEXT_PROTOCOL_APPENDIX,
  parseTextTurn,
  withTranscript,
} from './text-protocol.js';

const TURN_TIMEOUT_MS = 5 * 60 * 1000;

export function createCodexCliProvider({ systemPrompt }) {
  const model = process.env.CODEX_CLI_MODEL;
  const effort = process.env.CODEX_CLI_EFFORT;
  const instructions = systemPrompt + TEXT_PROTOCOL_APPENDIX;
  const history = [];

  // Cumulative usage from turn.completed events. Codex reports tokens only —
  // a ChatGPT-subscription run has no per-call price — so costUsd stays null
  // and the report shows cost as unavailable rather than as $0.
  const usage = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    costUsd: null,
    apiMs: 0,
  };

  // The thread the game is being played in; null until the first turn opens
  // one, and reset to null when a thread is lost so the next turn starts a
  // fresh one from the shadow transcript.
  let threadId = null;
  let workspace = null;
  const children = new Set();

  const killChild = (proc) => {
    if (!proc) return;
    proc.kill();
    setTimeout(() => proc.kill('SIGKILL'), 5000).unref();
  };

  // TOML basic-string encoding for -c overrides. JSON's escapes (\n, \", \\,
  // \uXXXX) are all valid TOML, so JSON.stringify is a correct encoder here;
  // without it a multi-line prompt would fall back to Codex's raw-literal
  // path and any TOML-looking prefix could be misparsed.
  const config = (key, value) => ['-c', `${key}=${JSON.stringify(value)}`];

  const commonArgs = () => [
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    ...config('sandbox_mode', 'read-only'),
    '-c',
    'tools.web_search=false',
    ...config('developer_instructions', instructions),
    ...(effort ? config('model_reasoning_effort', effort) : []),
    ...(model ? ['-m', model] : []),
  ];

  // One `codex exec` invocation: writes the prompt on stdin, reads the JSONL
  // event stream, and resolves with the agent's final message.
  const runTurn = (prompt) =>
    new Promise((resolve, reject) => {
      const args = threadId
        ? ['exec', 'resume', threadId, ...commonArgs(), '-']
        : ['exec', ...commonArgs(), '-C', workspace, '-'];
      const child = spawn('codex', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workspace,
      });
      children.add(child);

      let stderr = '';
      let message = null;
      let failure = null;
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdin.on('error', () => {});

      const finish = (outcome, value) => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
        children.delete(child);
        (outcome === 'resolve' ? resolve : reject)(value);
      };
      let timer = setTimeout(() => {
        finish('reject', new Error('codex CLI turn timed out'));
        killChild(child);
      }, TURN_TIMEOUT_MS);

      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        switch (event.type) {
          case 'thread.started':
            // A resumed thread reports the same id; a fresh one adopts it.
            threadId = event.thread_id ?? threadId;
            break;
          case 'item.completed':
            // The last agent_message of the turn is the model's answer;
            // reasoning and command_execution items are ignored.
            if (event.item?.type === 'agent_message') {
              message = event.item.text ?? '';
            }
            break;
          case 'turn.completed': {
            const u = event.usage ?? {};
            usage.turns += 1;
            usage.inputTokens += u.input_tokens ?? 0;
            usage.outputTokens += u.output_tokens ?? 0;
            usage.cacheReadTokens += u.cached_input_tokens ?? 0;
            usage.cacheWriteTokens += u.cache_write_input_tokens ?? 0;
            usage.thinkingTokens += u.reasoning_output_tokens ?? 0;
            break;
          }
          case 'turn.failed':
            failure = event.error?.message ?? 'turn failed';
            break;
          case 'error':
            failure = event.message ?? 'codex error';
            break;
          default:
            break;
        }
      });

      child.on('error', (err) => finish('reject', err));
      child.on('exit', (code) => {
        if (failure !== null) {
          finish('reject', new Error(`codex CLI: ${failure}`));
        } else if (message === null) {
          finish(
            'reject',
            new Error(
              `codex CLI produced no message (exit ${code})${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`,
            ),
          );
        } else {
          finish('resolve', message);
        }
      });

      child.stdin.end(prompt || '(no output)');
    });

  return {
    name: 'codex-cli',
    model: model ?? '(codex CLI default)',
    history: () => history,
    // Seeds the transcript when the harness resumes an interrupted run. There
    // is no live thread, so the next turn replays the whole transcript.
    restoreHistory(entries) {
      history.push(...entries);
    },

    // No resolvedModel: Codex's event stream never names the model it
    // served, and CODEX_CLI_MODEL is already an exact id rather than a
    // moving alias, so the report labels the row with what was requested
    // instead of claiming a resolution that was never observed.
    stats: () => ({ ...usage }),

    // gameOutputs pair 1:1 with the commands returned by the previous call.
    async requestCommands(gameOutputs) {
      if (workspace === null) {
        // An empty directory of its own: nothing to read, nothing to keep
        // between turns.
        workspace = await mkdtemp(join(tmpdir(), 'zork-codex-'));
      }
      const prompt =
        gameOutputs.join('\n') ||
        'Please submit your next command with a COMMAND: line.';

      // No thread yet but a transcript exists (resumed run, or a lost
      // thread): open a fresh thread with the whole transcript replayed.
      const needsReplay = threadId === null && history.length > 0;
      let raw;
      try {
        raw = await runTurn(needsReplay ? withTranscript(history, prompt) : prompt);
      } catch (err) {
        console.warn(`codex CLI turn failed (${err.message}), restarting thread.`);
        threadId = null;
        raw = await runTurn(withTranscript(history, prompt));
      }

      // Commit only after a successful exchange, so a retried request
      // rebuilds the same transcript instead of double-appending.
      history.push(
        { role: 'user', content: prompt },
        { role: 'assistant', content: raw },
      );
      return parseTextTurn(raw);
    },

    dispose() {
      for (const proc of children) killChild(proc);
      children.clear();
    },
  };
}
