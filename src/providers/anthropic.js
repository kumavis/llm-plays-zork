// Anthropic API via the official SDK. Uses structured (JSON schema) outputs
// and server-side refusal fallbacks.
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_EFFORT = 'low';

const TURN_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      thinking: {
        type: 'string',
        description: 'Brief reasoning about the current situation and your next move.',
      },
      command: {
        type: 'string',
        description: 'A single simple game command in caps, e.g. "GO NORTH" or "TAKE LEAFLET".',
      },
      note: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Something worth remembering for later, or null.',
      },
      mission: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'A replacement mission if the current one is accomplished or obsolete, or null.',
      },
    },
    required: ['thinking', 'command', 'note', 'mission'],
    additionalProperties: false,
  },
};

export function createAnthropicProvider() {
  // No API-key check here: the SDK also resolves ANTHROPIC_AUTH_TOKEN and
  // `ant auth login` profiles, so an unset ANTHROPIC_API_KEY can still work.
  const client = new Anthropic({ maxRetries: 5 });
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  // A single game turn is a simple task; keep effort (and latency) low by
  // default. Override with ANTHROPIC_EFFORT=medium|high|xhigh|max.
  const effort = process.env.ANTHROPIC_EFFORT || DEFAULT_EFFORT;

  // Server-side refusal fallbacks re-run a safety-declined request on a
  // fallback model. Not every endpoint supports the beta; degrade gracefully.
  let useFallbacks = true;

  return {
    name: 'anthropic',
    model,

    async requestTurn({ systemMessage, chatHistory }) {
      const request = {
        model,
        max_tokens: 16000,
        system: systemMessage,
        messages: chatHistory,
        output_config: { effort, format: TURN_OUTPUT_FORMAT },
      };

      let response;
      try {
        response = await client.beta.messages.create({
          ...request,
          ...(useFallbacks
            ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
            : {}),
        });
      } catch (err) {
        if (!useFallbacks || !isFallbackUnsupportedError(err)) throw err;
        useFallbacks = false;
        console.warn('Endpoint rejected the server-side fallback beta, continuing without it.');
        response = await client.beta.messages.create(request);
      }

      if (response.stop_reason === 'refusal') {
        throw new Error('Model declined the request (stop_reason: refusal)');
      }

      return response.content.find((block) => block.type === 'text')?.text ?? '';
    },
  };
}

function isFallbackUnsupportedError(err) {
  return (
    err instanceof Anthropic.BadRequestError &&
    /fallback/i.test(err.message ?? '')
  );
}
