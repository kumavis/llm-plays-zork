// OpenAI (or any OpenAI-compatible endpoint, e.g. LM Studio, Ollama).
// Commands are submitted through a submit_command tool call, with the
// game's response returned as the tool result. Endpoints that reject tool
// calling fall back to the plain-text COMMAND: protocol.
import OpenAI from 'openai';
import { TEXT_PROTOCOL_APPENDIX, parseTextTurn } from './text-protocol.js';
import { trimOpenAIHistory } from './trim.js';

const DEFAULT_MODEL = 'gpt-5-mini';

const SUBMIT_COMMAND_TOOL = {
  type: 'function',
  function: {
    name: 'submit_command',
    description:
      'Submit your next command to the Zork interpreter. ' +
      'The tool result is the text the game prints in response. ' +
      'Call this exactly once per turn.',
    strict: true,
    parameters: {
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
  },
};

const TOOL_PROMPT_APPENDIX = `
# Response Format:
- Each turn, submit exactly one game command by calling the submit_command tool. The game's response comes back as the tool result.
- Before the tool call you may say a brief sentence or two out loud about your intent.
- Respond only in English. Do not respond in any other language.
`;

export function createOpenAIProvider({ systemPrompt }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.',
    );
  }

  // The SDK reads OPENAI_API_KEY and OPENAI_BASE_URL from the environment,
  // and retries rate-limit and server errors with exponential backoff.
  const client = new OpenAI({ maxRetries: 5 });
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  // Not every OpenAI-compatible server supports tool calling; on the first
  // rejection we fall back to the plain-text COMMAND: protocol.
  let useTools = true;

  let history = [];
  let pendingToolCalls = [];

  const complete = async () => {
    const messages = [
      {
        role: 'system',
        content: systemPrompt + (useTools ? TOOL_PROMPT_APPENDIX : TEXT_PROTOCOL_APPENDIX),
      },
      ...history,
    ];
    try {
      return await client.chat.completions.create({
        model,
        messages,
        ...(useTools
          ? { tools: [SUBMIT_COMMAND_TOOL], parallel_tool_calls: false }
          : {}),
      });
    } catch (err) {
      if (!useTools || !isToolsUnsupportedError(err)) throw err;
      useTools = false;
      console.warn('Endpoint rejected tool calling, falling back to the plain-text COMMAND: protocol.');
      return complete();
    }
  };

  return {
    name: 'openai',
    model,
    history: () => history,

    // gameOutputs pair 1:1 with the commands returned by the previous call.
    async requestCommands(gameOutputs) {
      if (pendingToolCalls.length > 0) {
        for (const [i, toolCall] of pendingToolCalls.entries()) {
          history.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: gameOutputs[i] ?? '(no output)',
          });
        }
        pendingToolCalls = [];
      } else {
        const text = gameOutputs.join('\n')
          || 'Please submit your next command.';
        history.push({ role: 'user', content: text });
      }

      history = trimOpenAIHistory(history);

      const response = await complete();
      const message = response.choices[0]?.message;
      if (!message) throw new Error('Empty completion response');

      if (useTools) {
        history.push(message);
        pendingToolCalls = message.tool_calls ?? [];
        const commands = pendingToolCalls.map((toolCall) => {
          try {
            return String(JSON.parse(toolCall.function.arguments).command ?? '').trim();
          } catch {
            return '';
          }
        });
        return { commands, commentary: (message.content ?? '').trim() };
      }

      const raw = message.content ?? '';
      history.push({ role: 'assistant', content: raw });
      return parseTextTurn(raw);
    },
  };
}

function isToolsUnsupportedError(err) {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /tool|function/i.test(err.message ?? '')
  );
}
