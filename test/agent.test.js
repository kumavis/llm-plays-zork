import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTurn, updateTrimStart } from '../src/agent.js';

test('parses a plain JSON turn', () => {
  const turn = parseTurn(JSON.stringify({
    thinking: 'The mailbox may contain something useful.',
    command: 'OPEN MAILBOX',
  }));
  assert.equal(turn.command, 'OPEN MAILBOX');
  assert.equal(turn.thinking, 'The mailbox may contain something useful.');
});

test('tolerates code fences and surrounding prose', () => {
  const raw = 'Here is my move:\n```json\n{"thinking": "hm", "command": "GO NORTH"}\n```\n';
  const turn = parseTurn(raw);
  assert.equal(turn.command, 'GO NORTH');
});

test('trims the command and defaults thinking to empty', () => {
  const turn = parseTurn('{"command": " LOOK "}');
  assert.equal(turn.command, 'LOOK');
  assert.equal(turn.thinking, '');
});

test('rejects responses without a command', () => {
  assert.throws(() => parseTurn('{"thinking": "lost"}'), /missing a command/);
});

test('rejects responses without JSON', () => {
  assert.throws(() => parseTurn('COMMAND: GO NORTH'), /No JSON object/);
});

test('rejects empty and runaway responses', () => {
  assert.throws(() => parseTurn(''), /Empty response/);
  assert.throws(() => parseTurn(`{"command": "${'A'.repeat(20_000)}"}`), /Runaway response/);
});

test('trim window stays put until the ceiling, then jumps once', () => {
  const history = [];
  for (let i = 0; i < 100; i++) {
    history.push({ role: 'user', content: `game ${i}` });
    history.push({ role: 'assistant', content: `turn ${i}` });
  }

  // Under the ceiling: never moves (a moving window would break the cache prefix).
  assert.equal(updateTrimStart(0, history.slice(0, 300), { maxMessages: 300, keepMessages: 150 }), 0);

  // Over the ceiling: jumps forward once, keeping ~keepMessages.
  const jumped = updateTrimStart(0, history, { maxMessages: 150, keepMessages: 80 });
  assert.ok(jumped >= 120);
  assert.equal(history[jumped].role, 'user');

  // After the jump it stays put again.
  assert.equal(updateTrimStart(jumped, history, { maxMessages: 150, keepMessages: 80 }), jumped);
});
