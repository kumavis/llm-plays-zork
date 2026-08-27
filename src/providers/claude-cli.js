// Claude Code CLI as a persistent headless process with all tools disabled,
// acting as a pure text oracle using whatever auth it is already logged in
// with. One process is spawned per game (`--input-format stream-json`);
// each turn writes a user message to its stdin and awaits the matching
// result event, so the CLI's multi-second boot cost is paid once, not per
// turn. The CLI keeps the full native conversation (thinking included) and
// its own prompt cache in-process. A shadow transcript is kept locally for
// debug logs and process-loss recovery.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { TEXT_PROTOCOL_APPENDIX, parseTextTurn } from './text-protocol.js';

const TURN_TIMEOUT_MS = 5 * 60 * 1000;

export function createClaudeCliProvider({ systemPrompt }) {
  const model = process.env.CLAUDE_CLI_MODEL;
  const system = systemPrompt + TEXT_PROTOCOL_APPENDIX;
  const history = [];
  // Cumulative usage across all turns, from the CLI's result events. costUsd
  // is the CLI's own estimate at API list prices. Token counts are per-turn
  // in result events and are summed; cost and api time are cumulative per
  // CLI process, so the latest value is kept and folded into a base when a
  // process dies.
  let costFromDeadProcesses = 0;
  let apiMsFromDeadProcesses = 0;
  const usage = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    // Output tokens per exact model id (e.g. claude-haiku-4-5-2025…), since
    // CLAUDE_CLI_MODEL is usually an alias that moves over time. The CLI also
    // bills small auxiliary calls to other models, so the model that played
    // the game is the one with the most output tokens, not merely the first.
    modelOutputTokens: {},
    costUsd: 0,
    apiMs: 0,
  };

  let child = null;
  // Every spawned process, so a replaced one can't outlive the run. The CLI
  // does not always exit on SIGTERM, so killing means: close stdin (its input
  // stream ends, so it can exit on its own), SIGTERM, then SIGKILL.
  const children = new Set();
  const killChild = (proc) => {
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      // Already closed.
    }
    proc.kill();
    setTimeout(() => proc.kill('SIGKILL'), 5000).unref();
  };

  // The harness is lockstep, so at most one turn is in flight.
  let waiter = null;

  const settle = (outcome, value) => {
    if (waiter === null) return;
    clearTimeout(waiter.timer);
    const { resolve, reject } = waiter;
    waiter = null;
    (outcome === 'resolve' ? resolve : reject)(value);
  };

  const start = () => {
    // Sandbox: the model must only interact with the game. --tools '' means
    // no tools reach the API request (no file access, no web search);
    // --strict-mcp-config ignores any MCP servers in user settings; a
    // neutral cwd and no setting sources keep project files and user config
    // out of the session for a clean eval.
    child = spawn(
      'claude',
      [
        '-p',
        '--verbose',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--system-prompt',
        system,
        ...(model ? ['--model', model] : []),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], cwd: tmpdir() },
    );
    children.add(child);

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    // A write to a just-died process surfaces as EPIPE; the exit handler
    // below reports the failure.
    child.stdin.on('error', () => {});

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== 'result') return;
      if (event.usage) {
        usage.turns += 1;
        usage.inputTokens += event.usage.input_tokens ?? 0;
        usage.outputTokens += event.usage.output_tokens ?? 0;
        usage.cacheReadTokens += event.usage.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens += event.usage.cache_creation_input_tokens ?? 0;
        usage.thinkingTokens +=
          event.usage.output_tokens_details?.thinking_tokens ?? 0;
      }
      for (const [id, stats] of Object.entries(event.modelUsage ?? {})) {
        usage.modelOutputTokens[id] =
          (usage.modelOutputTokens[id] ?? 0) + (stats.outputTokens ?? 0);
      }
      if (event.total_cost_usd !== undefined) {
        usage.costUsd = costFromDeadProcesses + event.total_cost_usd;
      }
      if (event.duration_api_ms !== undefined) {
        usage.apiMs = apiMsFromDeadProcesses + event.duration_api_ms;
      }
      if (event.is_error) {
        settle(
          'reject',
          new Error(
            `claude CLI returned an error: ${event.result ?? event.subtype}`,
          ),
        );
      } else {
        settle('resolve', event.result ?? '');
      }
    });

    child.on('error', (err) => {
      child = null;
      settle('reject', err);
    });
    const spawned = child;
    child.on('exit', (code) => {
      children.delete(spawned);
      child = null;
      costFromDeadProcesses = usage.costUsd;
      apiMsFromDeadProcesses = usage.apiMs;
      settle(
        'reject',
        new Error(
          `claude CLI exited (code ${code})${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`,
        ),
      );
    });
  };

  const sendTurn = (text) => {
    if (child === null) start();
    return new Promise((resolve, reject) => {
      waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const stuck = child;
          child = null;
          settle('reject', new Error('claude CLI turn timed out'));
          killChild(stuck);
        }, TURN_TIMEOUT_MS),
      };
      child.stdin.write(
        JSON.stringify({
          type: 'user',
          // Empty text blocks are rejected upstream with a 400.
          message: {
            role: 'user',
            content: [{ type: 'text', text: text || '(no output)' }],
          },
        }) + '\n',
      );
    });
  };

  return {
    name: 'claude-cli',
    model: model ?? '(claude CLI default)',
    history: () => history,
    stats: () => ({
      ...usage,
      modelOutputTokens: { ...usage.modelOutputTokens },
      resolvedModel: primaryModel(usage.modelOutputTokens),
    }),

    // gameOutputs pair 1:1 with the commands returned by the previous call.
    async requestCommands(gameOutputs) {
      const prompt =
        gameOutputs.join('\n') ||
        'Please submit your next command with a COMMAND: line.';

      // A fresh process (first turn, or respawn after a timeout kill) has no
      // conversation state — send the whole shadow transcript instead.
      const needsReplay = child === null && history.length > 0;
      let raw;
      try {
        raw = await sendTurn(
          needsReplay ? withTranscript(history, prompt) : prompt,
        );
      } catch (err) {
        // Process died, or returned an error while still alive — kill it and
        // restart, replaying the shadow transcript.
        console.warn(`claude CLI process failed (${err.message}), restarting.`);
        killChild(child);
        child = null;
        raw = await sendTurn(withTranscript(history, prompt));
      }

      // Commit only after a successful exchange, so a retried request
      // rebuilds the same transcript instead of double-appending.
      history.push(
        { role: 'user', content: prompt },
        { role: 'assistant', content: raw },
      );
      return parseTextTurn(raw);
    },

    // Kill every CLI process so the parent can exit cleanly.
    dispose() {
      child = null;
      for (const proc of children) killChild(proc);
      children.clear();
    },
  };
}

// The model that played the game: the one the CLI billed the most output
// tokens to, ignoring the small auxiliary calls it makes to other models.
function primaryModel(modelOutputTokens) {
  const ranked = Object.entries(modelOutputTokens).sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

function withTranscript(history, prompt) {
  return formatTranscript([...history, { role: 'user', content: prompt }]);
}

// Rebuilds a single prompt from the shadow transcript when the process is lost.
export function formatTranscript(history) {
  const transcript = history
    .map(({ role, content }) =>
      role === 'assistant'
        ? `[Your previous turn]\n${content}`
        : `[Game]\n${content}`,
    )
    .join('\n\n');
  return `${transcript}\n\nRespond with your next turn.`;
}
