import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from '../src/zork.js';

async function playthrough(seed, commands) {
  const zork = await setup({ seed });
  const output = [];
  zork.events.on('print', (msg) => output.push(msg));
  await zork.start();
  for (const command of commands) await zork.input(command);
  return output.join('\n');
}

test('the same seed replays the same game', async () => {
  const commands = [
    'OPEN MAILBOX',
    'TAKE LEAFLET',
    'NORTH',
    'EAST',
    'DIAGNOSE',
  ];
  const first = await playthrough(7, commands);
  const second = await playthrough(7, commands);
  assert.equal(first, second);
  assert.match(first, /small mailbox/);
});
