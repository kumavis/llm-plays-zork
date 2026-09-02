// Safety and recovery helpers shared by the live harness and tests.

// Zork I's input buffer is small, and the WASM bridge can panic when it
// truncates a long UTF-8 command in the middle of a multibyte character.
// The player prompt already asks for short commands, so reject anything that
// cannot be represented as a conservative, printable-ASCII parser line.
export const MAX_ZORK_COMMAND_BYTES = 64;

export function validateZorkCommand(command) {
  if (typeof command !== 'string' || command.length === 0) {
    return 'the command is empty';
  }
  if (!/^[\x20-\x7e]+$/.test(command)) {
    return 'commands must contain only printable ASCII characters';
  }
  if (Buffer.byteLength(command, 'utf8') > MAX_ZORK_COMMAND_BYTES) {
    return `commands must be at most ${MAX_ZORK_COMMAND_BYTES} bytes`;
  }
  return null;
}

export function assertValidZorkCommand(command) {
  const error = validateZorkCommand(command);
  if (error !== null) throw new RangeError(`Invalid Zork command: ${error}`);
}

// A stopped attempt may contain model turns after its last command was
// successfully applied (for example, after the interpreter panicked). Those
// turns did not advance the game and must not poison a resumed conversation.
// Keep only the successful prefix of each run_start/run_resume attempt.
export function stripUnsuccessfulModelTails(events) {
  const selected = [];
  let attempt = [];
  let droppedModelTurns = 0;

  const flushAttempt = () => {
    const lastCommand = attempt.findLastIndex((event) => event.type === 'command');
    const keepThrough = lastCommand + 1;
    selected.push(...attempt.slice(0, keepThrough));
    selected.push(
      ...attempt
        .slice(keepThrough)
        .filter((event) => event.type !== 'model_turn'),
    );
    droppedModelTurns += attempt
      .slice(keepThrough)
      .filter((event) => event.type === 'model_turn').length;
    attempt = [];
  };

  for (const event of events) {
    if (event.type === 'run_start' || event.type === 'run_resume') {
      flushAttempt();
      selected.push(event);
      continue;
    }
    if (event.type === 'run_end') {
      flushAttempt();
      selected.push(event);
      continue;
    }
    attempt.push(event);
  }
  flushAttempt();

  return { events: selected, droppedModelTurns };
}

export function selectReplayEvents(events) {
  const stripped = stripUnsuccessfulModelTails(events);
  return {
    events: stripped.events.filter(
      (event) => event.type === 'model_turn' || event.type === 'command',
    ),
    droppedModelTurns: stripped.droppedModelTurns,
  };
}
