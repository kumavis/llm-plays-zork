// Claude Code CLI as a persistent headless process with all tools disabled,
// acting as a pure text oracle using whatever auth it is already logged in
// with. One process is spawned per game (`--input-format stream-json`);
// each turn writes a user message to its stdin and awaits the matching
// result event, so the CLI's multi-second boot cost is paid once, not per
// turn. The CLI keeps the full native conversation (thinking included) and
// its own prompt cache in-process. A shadow transcript is kept locally for
// debug logs and process-loss recovery.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TEXT_PROTOCOL_APPENDIX, parseTextTurn } from './text-protocol.js';

const TURN_TIMEOUT_MS = 5 * 60 * 1000;

export function createClaudeCliProvider({ systemPrompt }) {
  const model = process.env.CLAUDE_CLI_MODEL;
  const system = systemPrompt + TEXT_PROTOCOL_APPENDIX;
  const history = [];

  let child = null;
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
    child = spawn('claude', [
      '-p',
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--tools', '',
      '--system-prompt', system,
      ...(model ? ['--model', model] : []),
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // A write to a just-died process surfaces as EPIPE; the exit handler
    // below reports the failure.
    child.stdin.on('error', () => {});

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type !== 'result') return;
      if (event.is_error) {
        settle('reject', new Error(`claude CLI returned an error: ${event.result ?? event.subtype}`));
      } else {
        settle('resolve', event.result ?? '');
      }
    });

    child.on('error', (err) => {
      child = null;
      settle('reject', err);
    });
    child.on('exit', (code) => {
      child = null;
      settle('reject', new Error(`claude CLI exited (code ${code})${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`));
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
          stuck?.kill();
        }, TURN_TIMEOUT_MS),
      };
      child.stdin.write(JSON.stringify({
        type: 'user',
        // Empty text blocks are rejected upstream with a 400.
        message: { role: 'user', content: [{ type: 'text', text: text || '(no output)' }] },
      }) + '\n');
    });
  };

  return {
    name: 'claude-cli',
    model: model ?? '(claude CLI default)',
    history: () => history,

    // gameOutputs pair 1:1 with the commands returned by the previous call.
    async requestCommands(gameOutputs) {
      const prompt = gameOutputs.join('\n')
        || 'Please submit your next command with a COMMAND: line.';

      // A fresh process (first turn, or respawn after a timeout kill) has no
      // conversation state — send the whole shadow transcript instead.
      const needsReplay = child === null && history.length > 0;
      let raw;
      try {
        raw = await sendTurn(needsReplay ? withTranscript(history, prompt) : prompt);
      } catch (err) {
        // Process died — restart once, replaying the shadow transcript.
        console.warn(`claude CLI process failed (${err.message}), restarting.`);
        child?.kill();
        child = null;
        raw = await sendTurn(withTranscript(history, prompt));
      }

      // Commit only after a successful exchange, so a retried request
      // rebuilds the same transcript instead of double-appending.
      history.push({ role: 'user', content: prompt }, { role: 'assistant', content: raw });
      return parseTextTurn(raw);
    },

    // Kill the CLI process so the parent can exit cleanly.
    dispose() {
      const running = child;
      child = null;
      running?.kill();
    },
  };
}

function withTranscript(history, prompt) {
  return formatTranscript([...history, { role: 'user', content: prompt }]);
}

// Rebuilds a single prompt from the shadow transcript when the process is lost.
export function formatTranscript(history) {
  const transcript = history
    .map(({ role, content }) =>
      role === 'assistant' ? `[Your previous turn]\n${content}` : `[Game]\n${content}`,
    )
    .join('\n\n');
  return `${transcript}\n\nRespond with your next turn.`;
}
