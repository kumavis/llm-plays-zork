// Plain-text turn protocol for backends without native tool calling: the
// model talks freely and marks its move with a "COMMAND:" line.

export const TEXT_PROTOCOL_APPENDIX = `
# Response Format:
- You may briefly talk through your intent out loud first.
- Then submit your move as its own line in the form: COMMAND: <your next game command>
  For example: COMMAND: GO NORTH
- Exactly one COMMAND line per response.
- Respond only in English. Do not respond in any other language.
`;

// Guard against runaway generations from small local models.
const MAX_RESPONSE_LENGTH = 10_000;

// Splits a response into spoken commentary and submitted commands. A missing
// COMMAND line is not an error — the caller nudges the model to retry.
export function parseTextTurn(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_RESPONSE_LENGTH) {
    return { commands: [], commentary: '' };
  }
  const commands = [];
  const commentary = [];
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*COMMAND:\s*(.+)$/i);
    if (match) {
      commands.push(match[1].trim());
    } else {
      commentary.push(line);
    }
  }
  return { commands, commentary: commentary.join('\n').trim() };
}
