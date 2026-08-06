import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';

// In-process Anthropic-compatible stub: each request pops the next scripted
// response; every request body is captured for assertions.
const requests = [];
let script = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    requests.push(JSON.parse(body));
    const next = script.shift()
      ?? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'script exhausted' } } };
    res.statusCode = next.status ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(next.body));
  });
});
await new Promise((resolve) => server.listen(0, resolve));
after(() => server.close());

process.env.ANTHROPIC_API_KEY = 'stub';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const { createAnthropicProvider } = await import('../src/providers/anthropic.js');

function toolUseResponse(id, command, think) {
  return {
    status: 200,
    body: {
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: 'stub-model',
      content: [
        { type: 'thinking', thinking: think, signature: `sig_${id}` },
        { type: 'tool_use', id, name: 'submit_command', input: { command } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

test('pairs tool results, replays thinking, and survives a failed request', async () => {
  requests.length = 0;
  const provider = createAnthropicProvider({ systemPrompt: 'You play Zork.' });

  script = [toolUseResponse('toolu_0', 'OPEN MAILBOX', 'A mailbox! Let me open it.')];
  const turn1 = await provider.requestCommands(['West of House']);
  assert.deepEqual(turn1.commands, ['OPEN MAILBOX']);
  assert.match(turn1.commentary, /mailbox/);

  // Non-retryable failure (message must not trip the fallback-beta match).
  script = [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'boom' } } }];
  await assert.rejects(() => provider.requestCommands(['Opening the mailbox reveals a leaflet.']));

  script = [toolUseResponse('toolu_1', 'TAKE LEAFLET', 'A leaflet.')];
  const turn2 = await provider.requestCommands(['Opening the mailbox reveals a leaflet.']);
  assert.deepEqual(turn2.commands, ['TAKE LEAFLET']);

  const messages = requests.at(-1).messages;

  // The game output is delivered as the tool_result paired to toolu_0...
  const last = messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 'toolu_0');
  assert.match(last.content[0].content, /leaflet/);

  // ...exactly once, despite the failed attempt in between.
  const toolResults = messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : [],
  );
  assert.equal(toolResults.length, 1);

  // The thinking block is replayed unchanged in the assistant turn.
  const assistant = messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.content[0].type, 'thinking');
  assert.equal(assistant.content[0].thinking, 'A mailbox! Let me open it.');
  assert.equal(assistant.content[0].signature, 'sig_toolu_0');
});

test('a refusal is surfaced as an error without corrupting history', async () => {
  requests.length = 0;
  const provider = createAnthropicProvider({ systemPrompt: 'You play Zork.' });

  script = [{
    status: 200,
    body: {
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: 'stub-model',
      content: [],
      stop_reason: 'refusal',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  }];
  await assert.rejects(() => provider.requestCommands(['West of House']), /refusal/);

  script = [toolUseResponse('toolu_0', 'LOOK', 'Looking.')];
  const turn = await provider.requestCommands(['West of House']);
  assert.deepEqual(turn.commands, ['LOOK']);
  // The retried request contains the intro exactly once.
  const userMessages = requests.at(-1).messages.filter((m) => m.role === 'user');
  assert.equal(userMessages.length, 1);
});
