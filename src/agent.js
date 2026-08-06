// LLM player: sends the static system prompt plus the game transcript and
// asks the configured provider backend for one turn.
import { createOpenAIProvider } from './providers/openai.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createClaudeCliProvider } from './providers/claude-cli.js';

// Guard against runaway generations from small local models.
const MAX_RESPONSE_LENGTH = 10_000;

export function createAgent({ systemPrompt }) {
  const provider = createProvider();

  // Prompt caching is a prefix match, so the transcript sent to the model
  // must only ever grow between requests. Instead of a sliding window
  // (which shifts the front of the transcript every turn), history is
  // trimmed in chunks: the window start stays put until the transcript
  // hits the ceiling, then jumps forward once.
  let trimStart = 0;

  return {
    name: provider.name,
    model: provider.model,

    // Returns the model's raw text for one turn. Callers parse it with
    // parseTurn so a malformed response can be logged and retried.
    async requestTurn({ chatHistory }) {
      trimStart = updateTrimStart(trimStart, chatHistory);
      return provider.requestTurn({
        systemMessage: systemPrompt,
        chatHistory: chatHistory.slice(trimStart),
      });
    },
  };
}

// Advances the window start only when the transcript exceeds maxMessages,
// keeping the most recent keepMessages and landing on a user turn (the
// first message sent to the API must be a user message).
export function updateTrimStart(trimStart, chatHistory, { maxMessages = 300, keepMessages = 150 } = {}) {
  if (chatHistory.length - trimStart <= maxMessages) return trimStart;
  let next = chatHistory.length - keepMessages;
  while (next < chatHistory.length && chatHistory[next].role !== 'user') {
    next += 1;
  }
  return next;
}

// Provider selection: LLM_PROVIDER wins; otherwise infer from which API key
// is present in the environment.
function createProvider() {
  const choice = (process.env.LLM_PROVIDER ?? '').toLowerCase();
  switch (choice) {
    case 'openai':
      return createOpenAIProvider();
    case 'anthropic':
      return createAnthropicProvider();
    case 'claude-cli':
      return createClaudeCliProvider();
    case '':
      break;
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${choice}". Use "openai", "anthropic", or "claude-cli".`,
      );
  }

  if (process.env.OPENAI_API_KEY) return createOpenAIProvider();
  if (process.env.ANTHROPIC_API_KEY) return createAnthropicProvider();
  throw new Error(
    'No LLM configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or pick a backend with LLM_PROVIDER (see .env.example).',
  );
}

// Extracts the turn object from a model response. Tolerates code fences and
// surrounding prose. Throws if no valid turn can be found.
export function parseTurn(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('Empty response');
  }
  if (raw.length > MAX_RESPONSE_LENGTH) {
    throw new Error(`Runaway response (${raw.length} chars)`);
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('No JSON object in response');
  }

  const turn = JSON.parse(raw.slice(start, end + 1));
  if (typeof turn.command !== 'string' || turn.command.trim() === '') {
    throw new Error('Response is missing a command');
  }

  return {
    thinking: typeof turn.thinking === 'string' ? turn.thinking : '',
    command: turn.command.trim(),
  };
}
