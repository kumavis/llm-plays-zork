// Bridge to the z-machine interpreter compiled to WebAssembly (web.wasm).
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import wasmFFI from 'wasm-ffi';

const { Wrapper } = wasmFFI;

const projectRoot = new URL('..', import.meta.url);
const WASM_URL = new URL('web.wasm', projectRoot);
const STORY_URL = new URL('zork1.z3', projectRoot);

// Deterministic PRNG (mulberry32) so eval runs can pin the game's RNG —
// combat rolls, thief movement — to a seed.
function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Creates a fresh interpreter instance with the Zork I story file loaded.
// Game output is delivered via `events`: the interpreter emits 'print' with
// HTML-ish text, plus 'header', 'map', 'tree', 'savestate', and 'quit'.
// With `seed` set, the z-machine's RNG is deterministic: the same seed and
// command sequence replays the same game (a restart rewinds the RNG too).
export async function setup({ seed } = {}) {
  const events = new EventEmitter();
  let rng = seed === undefined ? Math.random : createRng(seed);

  const zmachine = new Wrapper({
    hook: [],
    create: [null, ['number', 'number']],
    feed: [null, ['string']],
    step: ['bool'],
    flush_log: [],
  });

  const imports = zmachine.imports((wrap) => ({
    env: {
      js_message: wrap('string', 'string', (type, msg) => {
        events.emit(type, msg);
      }),
      trace: wrap('string', (msg) => {
        setTimeout(() => zmachine.flush_log(), 200);
        console.error(`z-machine trace: ${msg}`);
      }),
      rand: () => Math.floor(rng() * 0xffff),
    },
  }));

  const wasmBytes = await readFile(WASM_URL);
  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  zmachine.use(instance);
  zmachine.hook();

  const storyFile = new Uint8Array(await readFile(STORY_URL));

  const loadStory = () => {
    const ptr = zmachine.utils.writeArray(storyFile);
    zmachine.create(ptr, storyFile.length);
  };

  // Run the interpreter until it blocks waiting for input.
  const step = () => {
    const done = zmachine.step();
    if (done) events.emit('quit');
  };

  loadStory();

  return {
    events,

    async start() {
      step();
    },

    // Feed one command and return the lines the game printed in response.
    async input(command) {
      const messages = [];
      const onPrint = (msg) => messages.push(msg);
      events.on('print', onPrint);
      try {
        zmachine.feed(command);
        step();
      } finally {
        events.off('print', onPrint);
      }
      return messages;
    },

    // Reset the machine to the beginning of the story.
    async restart() {
      if (seed !== undefined) rng = createRng(seed);
      loadStory();
      step();
    },
  };
}
