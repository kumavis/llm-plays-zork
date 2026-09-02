import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ZORK_COMMAND_BYTES,
  selectReplayEvents,
  stripUnsuccessfulModelTails,
  validateZorkCommand,
} from '../src/run-safety.js';
import { setup } from '../src/zork.js';

test('rejects commands that can panic the Z-machine string boundary', async () => {
  const zork = await setup({ seed: 1 });
  await zork.start();
  const malformed =
    "GO WEST Feels like you've been wandering around the same area for a while—try something different.";

  assert.match(validateZorkCommand(malformed), /printable ASCII/);
  await assert.rejects(zork.input(malformed), /Invalid Zork command/);

  // Rejection happens before WASM is called, so the interpreter remains live.
  assert.match((await zork.input('LOOK')).join('\n'), /West of House/);
});

test('rejects overlong ASCII commands but accepts ordinary parser input', () => {
  assert.match(
    validateZorkCommand('X'.repeat(MAX_ZORK_COMMAND_BYTES + 1)),
    /at most/,
  );
  assert.equal(validateZorkCommand('PUT LEAFLET IN SACK'), null);
});

test('resume drops the unsuccessful tail from each stopped attempt', () => {
  const events = [
    { type: 'run_start' },
    { type: 'model_turn', turn: 1, commands: ['LOOK'] },
    { type: 'command', turn: 1, command: 'LOOK' },
    { type: 'model_turn', turn: 2, commands: ['bad'] },
    { type: 'model_turn', turn: 3, commands: ['bad again'] },
    { type: 'run_end', endReason: 'SIGTERM' },
    { type: 'run_resume' },
    { type: 'model_turn', turn: 2, commands: ['NORTH'] },
    { type: 'command', turn: 2, command: 'NORTH' },
    { type: 'model_turn', turn: 3, commands: ['pending'] },
    { type: 'run_end', endReason: 'SIGTERM' },
  ];

  const replay = selectReplayEvents(events);
  assert.deepEqual(
    replay.events.map(({ type, turn }) => [type, turn]),
    [
      ['model_turn', 1],
      ['command', 1],
      ['model_turn', 2],
      ['command', 2],
    ],
  );
  assert.equal(replay.droppedModelTurns, 3);

  const compacted = stripUnsuccessfulModelTails(events);
  assert.equal(compacted.droppedModelTurns, 3);
  assert.deepEqual(
    compacted.events.filter((event) => event.type === 'run_end'),
    [
      { type: 'run_end', endReason: 'SIGTERM' },
      { type: 'run_end', endReason: 'SIGTERM' },
    ],
  );
  assert.deepEqual(
    compacted.events
      .filter((event) => event.type === 'model_turn')
      .map((event) => event.turn),
    [1, 2],
  );
});
