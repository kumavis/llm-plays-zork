import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTurn } from '../src/agent.js';

test('parses a plain JSON turn', () => {
  const turn = parseTurn(JSON.stringify({
    thinking: 'The mailbox may contain something useful.',
    command: 'OPEN MAILBOX',
    note: null,
    mission: null,
  }));
  assert.equal(turn.command, 'OPEN MAILBOX');
  assert.equal(turn.thinking, 'The mailbox may contain something useful.');
  assert.equal(turn.note, null);
  assert.equal(turn.mission, null);
});

test('tolerates code fences and surrounding prose', () => {
  const raw = 'Here is my move:\n```json\n{"thinking": "hm", "command": "GO NORTH", "note": "The door is boarded.", "mission": null}\n```\n';
  const turn = parseTurn(raw);
  assert.equal(turn.command, 'GO NORTH');
  assert.equal(turn.note, 'The door is boarded.');
});

test('normalizes empty strings to null and trims the command', () => {
  const turn = parseTurn('{"thinking": "", "command": " LOOK ", "note": "", "mission": "  "}');
  assert.equal(turn.command, 'LOOK');
  assert.equal(turn.note, null);
  assert.equal(turn.mission, null);
});

test('rejects responses without a command', () => {
  assert.throws(() => parseTurn('{"thinking": "lost", "note": null, "mission": null}'), /missing a command/);
});

test('rejects responses without JSON', () => {
  assert.throws(() => parseTurn('COMMAND: GO NORTH'), /No JSON object/);
});

test('rejects empty and runaway responses', () => {
  assert.throws(() => parseTurn(''), /Empty response/);
  assert.throws(() => parseTurn(`{"command": "${'A'.repeat(20_000)}"}`), /Runaway response/);
});
