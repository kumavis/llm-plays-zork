// Bridge to the z-machine interpreter compiled to WebAssembly (web.wasm).
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import wasmFFI from 'wasm-ffi';

const { Wrapper } = wasmFFI;

const projectRoot = new URL('..', import.meta.url);
const WASM_URL = new URL('web.wasm', projectRoot);
const STORY_URL = new URL('zork1.z3', projectRoot);

// Creates a fresh interpreter instance with the Zork I story file loaded.
// Game output is delivered via `events`: the interpreter emits 'print' with
// HTML-ish text, plus 'header', 'map', 'tree', 'savestate', and 'quit'.
export async function setup() {
  const events = new EventEmitter();

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
      rand: () => Math.floor(Math.random() * 0xffff),
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
      loadStory();
      step();
    },
  };
}
