// LLM player: selects a provider backend. Each provider owns its own
// conversation history in its API's native format and exposes the same
// interface: requestCommands(gameOutputs) -> { commands, commentary }.
import { createOpenAIProvider } from './providers/openai.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createClaudeCliProvider } from './providers/claude-cli.js';

// Provider selection: LLM_PROVIDER wins; otherwise infer from which API key
// is present in the environment.
export function createAgent({ systemPrompt }) {
  const options = { systemPrompt };
  const choice = (process.env.LLM_PROVIDER ?? '').toLowerCase();
  switch (choice) {
    case 'openai':
      return createOpenAIProvider(options);
    case 'anthropic':
      return createAnthropicProvider(options);
    case 'claude-cli':
      return createClaudeCliProvider(options);
    case '':
      break;
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${choice}". Use "openai", "anthropic", or "claude-cli".`,
      );
  }

  if (process.env.OPENAI_API_KEY) return createOpenAIProvider(options);
  if (process.env.ANTHROPIC_API_KEY) return createAnthropicProvider(options);
  throw new Error(
    'No LLM configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or pick a backend with LLM_PROVIDER (see .env.example).',
  );
}
