import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from '../src/zork.js';

// Resume works by replaying a run's commands into a fresh seeded game, so it
// is only correct if a replay reproduces the original responses exactly.
test('replaying commands into a seeded game reproduces the same responses', async () => {
  const commands = [
    'OPEN MAILBOX',
    'TAKE LEAFLET',
    'NORTH',
    'EAST',
    'OPEN WINDOW',
    'ENTER WINDOW',
    'TAKE LAMP',
    'WEST',
    'MOVE RUG',
    'OPEN TRAP DOOR',
    'DIAGNOSE',
  ];

  const original = await setup({ seed: 42 });
  await original.start();
  const before = [];
  for (const command of commands) {
    before.push((await original.input(command)).join('\n'));
  }

  // A fresh interpreter on the same seed, fed the same commands.
  const replayed = await setup({ seed: 42 });
  await replayed.start();
  const after = [];
  for (const command of commands) {
    after.push((await replayed.input(command)).join('\n'));
  }

  assert.deepEqual(after, before);
  // The replay really did advance the world, not just echo refusals.
  assert.match(before.join('\n'), /trap door/i);

  // And the score carries over, which is what the resumed run reports.
  const score = (await replayed.input('SCORE')).join('\n');
  assert.match(score, /Your score is \d+/);
});
