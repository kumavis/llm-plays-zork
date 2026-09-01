import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';

// In-process OpenAI-compatible stub: each request pops the next scripted
// response; every request body is captured for assertions.
const requests = [];
let script = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    requests.push(JSON.parse(body));
    const next = script.shift() ?? { status: 500, body: { error: { message: 'script exhausted' } } };
    res.statusCode = next.status ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(next.body));
  });
});
await new Promise((resolve) => server.listen(0, resolve));
after(() => server.close());

process.env.OPENAI_API_KEY = 'stub';
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.OPENAI_MODEL = 'stub-model';
const { createOpenAIProvider } = await import('../src/providers/openai.js');

function toolCallResponse(id, command, say = '') {
  return {
    status: 200,
    body: {
      id: 'stub',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: say,
          tool_calls: [{
            id,
            type: 'function',
            function: { name: 'submit_command', arguments: JSON.stringify({ command }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
  };
}

test('pairs tool results, and a failed request does not corrupt history', async () => {
  requests.length = 0;
  const provider = createOpenAIProvider({ systemPrompt: 'You play Zork.' });

  script = [toolCallResponse('call_0', 'OPEN MAILBOX', 'Checking the mailbox.')];
  const turn1 = await provider.requestCommands(['West of House']);
  assert.deepEqual(turn1.commands, ['OPEN MAILBOX']);
  assert.equal(turn1.commentary, 'Checking the mailbox.');

  // Non-retryable failure (message must not trip the tools-fallback match).
  script = [{ status: 400, body: { error: { message: 'boom' } } }];
  await assert.rejects(() => provider.requestCommands(['Opening the mailbox reveals a leaflet.']));

  script = [toolCallResponse('call_1', 'TAKE LEAFLET')];
  const turn2 = await provider.requestCommands(['Opening the mailbox reveals a leaflet.']);
  assert.deepEqual(turn2.commands, ['TAKE LEAFLET']);

  // The game output is delivered as the tool result paired to call_0...
  const lastMessage = requests.at(-1).messages.at(-1);
  assert.equal(lastMessage.role, 'tool');
  assert.equal(lastMessage.tool_call_id, 'call_0');
  assert.match(lastMessage.content, /leaflet/);

  // ...exactly once, despite the failed attempt in between.
  const toolResults = requests.at(-1).messages.filter((m) => m.role === 'tool');
  assert.equal(toolResults.length, 1);

  // Replayed assistant message is sanitized to known fields.
  const assistant = requests.at(-1).messages.find((m) => m.role === 'assistant');
  assert.deepEqual(Object.keys(assistant).sort(), ['content', 'role', 'tool_calls']);
});

test('falls back to the text protocol when tools are rejected', async () => {
  requests.length = 0;
  const provider = createOpenAIProvider({ systemPrompt: 'You play Zork.' });

  script = [
    { status: 400, body: { error: { message: 'tools is not supported' } } },
    {
      status: 200,
      body: {
        id: 'stub',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Looking around.\nCOMMAND: LOOK' },
          finish_reason: 'stop',
        }],
      },
    },
  ];

  const turn = await provider.requestCommands(['West of House']);
  assert.deepEqual(turn.commands, ['LOOK']);
  assert.equal(turn.commentary, 'Looking around.');
  assert.equal(requests.at(-1).tools, undefined);
  assert.match(requests.at(-1).messages[0].content, /COMMAND:/);
});
