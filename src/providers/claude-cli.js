// Claude Code CLI in headless mode: each turn shells out to
// `claude -p --output-format json` with all tools disabled, so the CLI acts
// as a pure text oracle using whatever auth it is already logged in with.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createClaudeCliProvider() {
  const model = process.env.CLAUDE_CLI_MODEL;

  return {
    name: 'claude-cli',
    model: model ?? '(claude CLI default)',

    async requestTurn({ systemMessage, chatHistory }) {
      const args = [
        '-p',
        '--output-format', 'json',
        '--tools', '',
        '--system-prompt', systemMessage,
        ...(model ? ['--model', model] : []),
        formatTranscript(chatHistory),
      ];

      const { stdout } = await execFileAsync('claude', args, {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
      });

      const result = JSON.parse(stdout);
      if (result.is_error) {
        throw new Error(`claude CLI returned an error: ${result.result ?? 'unknown'}`);
      }
      return result.result ?? '';
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
