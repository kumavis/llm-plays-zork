// Claude Code CLI in headless mode with all tools disabled, so the CLI acts
// as a pure text oracle using whatever auth it is already logged in with.
//
// The first call starts a session; later turns `--resume` it and send only
// the new game output, so the CLI keeps the full native conversation
// (thinking included) and its own prompt cache server-side. A shadow
// transcript is kept locally for debug logs and session-loss recovery.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TEXT_PROTOCOL_APPENDIX, parseTextTurn } from './text-protocol.js';

const execFileAsync = promisify(execFile);

export function createClaudeCliProvider({ systemPrompt }) {
  const model = process.env.CLAUDE_CLI_MODEL;
  const system = systemPrompt + TEXT_PROTOCOL_APPENDIX;

  let sessionId = null;
  const history = [];

  const invoke = async (prompt, { resume }) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--tools', '',
      ...(resume ? ['--resume', sessionId] : ['--system-prompt', system]),
      ...(model ? ['--model', model] : []),
      prompt,
    ];
    const { stdout } = await execFileAsync('claude', args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    });
    const result = JSON.parse(stdout);
    if (result.is_error) {
      throw new Error(`claude CLI returned an error: ${result.result ?? 'unknown'}`);
    }
    sessionId = result.session_id ?? sessionId;
    return result.result ?? '';
  };

  return {
    name: 'claude-cli',
    model: model ?? '(claude CLI default)',
    history: () => history,

    // gameOutputs pair 1:1 with the commands returned by the previous call.
    async requestCommands(gameOutputs) {
      const prompt = gameOutputs.join('\n')
        || 'Please submit your next command with a COMMAND: line.';
      history.push({ role: 'user', content: prompt });

      let raw;
      if (sessionId === null) {
        raw = await invoke(prompt, { resume: false });
      } else {
        try {
          raw = await invoke(prompt, { resume: true });
        } catch (err) {
          // Session may have expired — start fresh with the full transcript.
          console.warn(`claude CLI resume failed (${err.message}), starting a new session.`);
          sessionId = null;
          raw = await invoke(formatTranscript(history), { resume: false });
        }
      }

      history.push({ role: 'assistant', content: raw });
      return parseTextTurn(raw);
    },
  };
}

// Rebuilds a single prompt from the shadow transcript when a session is lost.
export function formatTranscript(history) {
  const transcript = history
    .map(({ role, content }) =>
      role === 'assistant' ? `[Your previous turn]\n${content}` : `[Game]\n${content}`,
    )
    .join('\n\n');
  return `${transcript}\n\nRespond with your next turn.`;
}
