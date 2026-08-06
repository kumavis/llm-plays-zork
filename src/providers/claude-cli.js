// Claude Code CLI in headless mode with all tools disabled, so the CLI acts
// as a pure text oracle using whatever auth it is already logged in with.
//
// The first call starts a session; later turns `--resume` it and send only
// the new game output, so the CLI keeps the conversation (and its own
// prompt cache) instead of re-reading the whole transcript every turn.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createClaudeCliProvider() {
  const model = process.env.CLAUDE_CLI_MODEL;

  let sessionId = null;
  // How many transcript messages the session has already seen.
  let sentCount = 0;

  const invoke = async (prompt, { systemMessage, resume }) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--tools', '',
      ...(resume ? ['--resume', sessionId] : ['--system-prompt', systemMessage]),
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

    async requestTurn({ systemMessage, chatHistory }) {
      if (sessionId === null) {
        const response = await invoke(formatTranscript(chatHistory), { systemMessage, resume: false });
        sentCount = chatHistory.length;
        return response;
      }

      // The session already holds its own previous replies; forward only
      // the game output that arrived since the last call. When there is
      // none, the last response failed to parse — ask for a retry.
      const newGameOutput = chatHistory
        .slice(sentCount)
        .filter(({ role }) => role === 'user')
        .map(({ content }) => content)
        .join('\n');
      const prompt = newGameOutput !== ''
        ? newGameOutput
        : 'Your previous response could not be parsed. Respond with a single JSON object and nothing else.';

      try {
        const response = await invoke(prompt, { resume: true });
        sentCount = chatHistory.length;
        return response;
      } catch (err) {
        // Session may have expired — start fresh with the full transcript.
        console.warn(`claude CLI resume failed (${err.message}), starting a new session.`);
        sessionId = null;
        const response = await invoke(formatTranscript(chatHistory), { systemMessage, resume: false });
        sentCount = chatHistory.length;
        return response;
      }
    },
  };
}

// The CLI takes a single prompt string, so the role-based transcript is
// flattened into labeled sections.
export function formatTranscript(chatHistory) {
  const transcript = chatHistory
    .map(({ role, content }) =>
      role === 'assistant' ? `[Your previous turn]\n${content}` : `[Game]\n${content}`,
    )
    .join('\n\n');
  return `${transcript}\n\nRespond with your next turn as a single JSON object.`;
}
