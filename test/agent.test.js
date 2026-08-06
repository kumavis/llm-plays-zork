import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTextTurn } from '../src/providers/text-protocol.js';
import { trimAnthropicHistory, trimOpenAIHistory } from '../src/providers/trim.js';

test('parseTextTurn splits commentary and COMMAND lines', () => {
  const turn = parseTextTurn('The door is boarded, going around.\nCOMMAND: GO NORTH');
  assert.deepEqual(turn.commands, ['GO NORTH']);
  assert.equal(turn.commentary, 'The door is boarded, going around.');
});

test('parseTextTurn is case-insensitive and trims', () => {
  const turn = parseTextTurn('command:  open mailbox  ');
  assert.deepEqual(turn.commands, ['open mailbox']);
});

test('parseTextTurn takes the last COMMAND line (earlier ones are quotes)', () => {
  const turn = parseTextTurn('The format is "COMMAND: X".\nCOMMAND: GO NORTH\nCOMMAND: GO SOUTH');
  assert.deepEqual(turn.commands, ['GO SOUTH']);
});

test('parseTextTurn returns no commands for plain chatter', () => {
  const turn = parseTextTurn('Hmm, let me think about this.');
  assert.deepEqual(turn.commands, []);
  assert.equal(turn.commentary, 'Hmm, let me think about this.');
});

test('parseTextTurn rejects runaway responses', () => {
  const turn = parseTextTurn(`COMMAND: GO NORTH\n${'A'.repeat(20_000)}`);
  assert.deepEqual(turn.commands, []);
});

test('anthropic trim stays put under the ceiling, then jumps once', () => {
  const history = [];
  for (let i = 0; i < 100; i++) {
    history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `game ${i}` }] });
    history.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i + 1}`, name: 'submit_command', input: {} }] });
  }

  // Under the ceiling: untouched (a moving window would break the cache prefix).
  assert.equal(trimAnthropicHistory(history, { maxMessages: 300, keepMessages: 150 }), history);

  const trimmed = trimAnthropicHistory(history, { maxMessages: 150, keepMessages: 80 });
  assert.ok(trimmed.length <= 80);
  assert.equal(trimmed[0].role, 'user');
  // The boundary tool_result was converted to plain text (its tool_use is gone).
  assert.equal(trimmed[0].content[0].type, 'text');

  // After the jump it stays put again.
  assert.equal(trimAnthropicHistory(trimmed, { maxMessages: 150, keepMessages: 80 }), trimmed);
});

test('openai trim converts orphaned leading tool results to user text', () => {
  const history = [];
  for (let i = 0; i < 100; i++) {
    history.push({ role: 'assistant', content: '', tool_calls: [{ id: `t${i}` }] });
    history.push({ role: 'tool', tool_call_id: `t${i}`, content: `game ${i}` });
  }

  assert.equal(trimOpenAIHistory(history, { maxMessages: 300, keepMessages: 150 }), history);

  const trimmed = trimOpenAIHistory(history, { maxMessages: 150, keepMessages: 80 });
  assert.ok(trimmed.length <= 80);
  assert.equal(trimmed[0].role, 'user');
  assert.notEqual(trimmed[1]?.role, 'tool');
});
