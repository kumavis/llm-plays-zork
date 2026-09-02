import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTranscript } from '../src/providers/text-protocol.js';

test('formatTranscript labels game and player turns', () => {
  const prompt = formatTranscript([
    { role: 'user', content: 'West of House' },
    { role: 'assistant', content: '{"command": "OPEN MAILBOX"}' },
    { role: 'user', content: 'Opening the small mailbox reveals a leaflet.' },
  ]);
  assert.match(prompt, /\[Game\]\nWest of House/);
  assert.match(prompt, /\[Your previous turn\]\n\{"command": "OPEN MAILBOX"\}/);
  assert.match(prompt, /Respond with your next turn\.$/);
});
