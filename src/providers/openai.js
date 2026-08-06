// OpenAI (or any OpenAI-compatible endpoint, e.g. LM Studio, Ollama).
import OpenAI from 'openai';

const DEFAULT_MODEL = 'gpt-5-mini';

const TURN_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'zork_turn',
    strict: true,
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
      },
      required: ['thinking', 'command'],
      additionalProperties: false,
    },
  },
};

export function createOpenAIProvider() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.',
    );
  }

  // The SDK reads OPENAI_API_KEY and OPENAI_BASE_URL from the environment,
  // and retries rate-limit and server errors with exponential backoff.
  const client = new OpenAI({ maxRetries: 5 });
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  // Not every OpenAI-compatible server implements json_schema response
  // formats; on the first rejection we fall back to prompt-only JSON.
  let useJsonSchema = true;

  return {
    name: 'openai',
    model,

    async requestTurn({ systemMessage, chatHistory }) {
      const messages = [{ role: 'system', content: systemMessage }, ...chatHistory];

      let response;
      try {
        response = await client.chat.completions.create({
          model,
          messages,
          ...(useJsonSchema ? { response_format: TURN_RESPONSE_FORMAT } : {}),
        });
      } catch (err) {
        if (!useJsonSchema || !isResponseFormatError(err)) throw err;
        useJsonSchema = false;
        console.warn('Endpoint rejected json_schema response format, falling back to prompt-only JSON.');
        response = await client.chat.completions.create({ model, messages });
      }

      return response.choices[0]?.message?.content ?? '';
    },
  };
}

function isResponseFormatError(err) {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /response_format|json_schema/i.test(err.message ?? '')
  );
}
