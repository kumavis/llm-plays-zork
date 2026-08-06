// Anthropic API via the official SDK. Commands are submitted through a
// submit_command tool call, with the game's response returned as the tool
// result. The provider owns its conversation history in the API's native
// content-block format, so thinking blocks are retained and replayed.
import Anthropic from '@anthropic-ai/sdk';
import { trimAnthropicHistory } from './trim.js';

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_EFFORT = 'low';

const SUBMIT_COMMAND_TOOL = {
  name: 'submit_command',
  description:
    'Submit your next command to the Zork interpreter. ' +
    'The tool result is the text the game prints in response. ' +
    'Call this exactly once per turn.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'A single simple game command in caps, e.g. "GO NORTH" or "TAKE LEAFLET".',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
};

const PROMPT_APPENDIX = `
# Response Format:
- Each turn, submit exactly one game command by calling the submit_command tool. The game's response comes back as the tool result.
- Before the tool call you may say a brief sentence or two out loud about your intent.
- Respond only in English. Do not respond in any other language.
`;

export function createAnthropicProvider({ systemPrompt }) {
  // No API-key check here: the SDK also resolves ANTHROPIC_AUTH_TOKEN and
  // `ant auth login` profiles, so an unset ANTHROPIC_API_KEY can still work.
  const client = new Anthropic({ maxRetries: 5 });
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  // A single game turn is a simple task; keep effort (and latency) low by
  // default. Override with ANTHROPIC_EFFORT=medium|high|xhigh|max.
  const effort = process.env.ANTHROPIC_EFFORT || DEFAULT_EFFORT;
  const system = `${systemPrompt}\n${PROMPT_APPENDIX}`;

  // Server-side refusal fallbacks re-run a safety-declined request on a
  // fallback model. Not every endpoint supports the beta; degrade gracefully.
  let useFallbacks = true;

  let history = [];
  let pendingToolUses = [];

  const createMessage = async (request) => {
    try {
      return await client.beta.messages.create({
        ...request,
        ...(useFallbacks
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
          : {}),
      });
    } catch (err) {
      if (!useFallbacks || !isFallbackUnsupportedError(err)) throw err;
      useFallbacks = false;
      console.warn('Endpoint rejected the server-side fallback beta, continuing without it.');
      return client.beta.messages.create(request);
    }
  };

  return {
    name: 'anthropic',
    model,
    history: () => history,

    // gameOutputs pair 1:1 with the commands returned by the previous call.
    async requestCommands(gameOutputs) {
      if (pendingToolUses.length > 0) {
        history.push({
          role: 'user',
          content: pendingToolUses.map((toolUse, i) => ({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: gameOutputs[i] ?? '(no output)',
          })),
        });
        pendingToolUses = [];
      } else {
        const text = gameOutputs.join('\n')
          || 'Please submit your next command by calling the submit_command tool.';
        history.push({ role: 'user', content: [{ type: 'text', text }] });
      }

      history = trimAnthropicHistory(history);

      const response = await createMessage({
        model,
        max_tokens: 16000,
        system,
        messages: history,
        // Summarized display makes the model's reasoning visible in the
        // terminal; thinking is billed the same either way.
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort },
        tools: [SUBMIT_COMMAND_TOOL],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        // Auto-place a cache breakpoint on the last cacheable block, so each
        // turn reads the previous turn's prefix (system + transcript) from
        // cache instead of re-billing it at full price.
        cache_control: { type: 'ephemeral' },
      });

      if (response.stop_reason === 'refusal') {
        throw new Error('Model declined the request (stop_reason: refusal)');
      }

      // Store the full native content — thinking blocks must be replayed
      // unchanged on later turns.
      history.push({ role: 'assistant', content: response.content });

      const commands = [];
      const commentary = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          // Every tool_use needs a tool_result on the next request, so keep
          // commands and pendingToolUses paired 1:1 even for odd calls.
          pendingToolUses.push(block);
          commands.push(String(block.input?.command ?? '').trim());
        } else if (block.type === 'thinking' && block.thinking) {
          commentary.push(block.thinking);
        } else if (block.type === 'text' && block.text.trim() !== '') {
          commentary.push(block.text.trim());
        }
      }
      return { commands, commentary: commentary.join('\n') };
    },
  };
}

function isFallbackUnsupportedError(err) {
  return (
    err instanceof Anthropic.BadRequestError &&
    /fallback/i.test(err.message ?? '')
  );
}
