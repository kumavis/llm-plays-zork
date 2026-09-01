import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from '../src/zork.js';

test('z-machine bridge boots Zork I and accepts input', async () => {
  const zork = await setup();

  const intro = [];
  const onPrint = (msg) => intro.push(msg);
  zork.events.on('print', onPrint);
  await zork.start();
  zork.events.off('print', onPrint);

  const introText = intro.join('\n');
  assert.match(introText, /ZORK I: The Great Underground Empire/);
  assert.match(introText, /West of House/);

  const response = (await zork.input('open mailbox')).join('\n');
  assert.match(response, /leaflet/);

  const restarted = [];
  zork.events.on('print', (msg) => restarted.push(msg));
  await zork.restart();
  assert.match(restarted.join('\n'), /West of House/);
});
