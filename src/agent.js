// LLM player: talks to any OpenAI-compatible endpoint and returns one
// structured game turn per invocation.
import OpenAI from 'openai';

const DEFAULT_MODEL = 'gpt-5-mini';

// Guard against runaway generations from small local models.
const MAX_RESPONSE_LENGTH = 10_000;

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
        note: {
          type: ['string', 'null'],
          description: 'Something worth remembering for later, or null.',
        },
        mission: {
          type: ['string', 'null'],
          description: 'A replacement mission if the current one is accomplished or obsolete, or null.',
        },
      },
      required: ['thinking', 'command', 'note', 'mission'],
      additionalProperties: false,
    },
  },
};

export function createAgent({ systemPrompt, maxHistoryLength = 200 }) {
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
    model,

    // Returns the model's raw text for one turn. Callers parse it with
    // parseTurn so a malformed response can be logged and retried.
    async requestTurn({ chatHistory, currentMission, notes }) {
      const systemMessage = systemPrompt
        .replaceAll('{MISSION}', currentMission)
        .replaceAll('{NOTES}', notes.length > 0 ? notes.join('\n') : '(No notes)');
      const messages = [
        { role: 'system', content: systemMessage },
        ...chatHistory.slice(-maxHistoryLength),
      ];

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
    note: typeof turn.note === 'string' && turn.note.trim() !== '' ? turn.note.trim() : null,
    mission: typeof turn.mission === 'string' && turn.mission.trim() !== '' ? turn.mission.trim() : null,
  };
}
