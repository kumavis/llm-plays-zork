// this must run first
import './file-fetch-fix.js'

import pkg from 'wasm-ffi';
import { EventEmitter } from 'events';
const { Wrapper, rust } = pkg;

const wasmURL = 'file://./web.wasm'

// hold onto active file in case of restarts
let file = null;

const events = new EventEmitter();


function sendWorkerMessage(type, msg) {
  events.emit(type, msg);
  const knownEvents = ['header', 'map', 'print', 'tree', 'savestate']
  if (!knownEvents.includes(type)) {
    console.log({ type, msg });
  }
  // postMessage({ type, msg });
}

const zmachine = new Wrapper({
  hook: [],
  create: [null, ['number', 'number']],
  feed: [null, ['string']],
  step: ['bool'],
  undo: ['bool'],
  redo: ['bool'],
  get_updates: [],
  restore: [null, ['string']],
  load_savestate: [null, ['string']],
  enable_instruction_logs: [null, ['bool']],
  get_object_details: [rust.string, ['number']],
  flush_log: [],
});


zmachine.imports(wrap => ({
  env: {
    js_message: wrap('string', 'string', sendWorkerMessage),

    trace: wrap('string', (msg) => {
      const err = new Error(msg);

      setTimeout(() => {
        zmachine.flush_log();
      }, 200);

      postMessage({
        type: 'error',
        msg: { msg, stack: err.stack }
      });
    }),

    rand: function() {
      return Math.floor(Math.random() * 0xFFFF);
    }
  },
}));


function step() {
  const done = zmachine.step();
  if (done) sendWorkerMessage('quit');
}


function instantiate() {
  if (zmachine.exports) return Promise.resolve();
  return zmachine.fetch(wasmURL).then(() => zmachine.hook());
}

const api = {
  events,
  instantiate: async () => {
    instantiate().catch(err => setTimeout(() => {
      console.log('Error starting wasm: ', err, err.stack);
    }));
  },
  load: async ({ file }) => {
    return instantiate()
    .then(() => {
      file = new Uint8Array(file);
      const file_ptr = zmachine.utils.writeArray(file);

      zmachine.create(file_ptr, file.length);
      return 'loaded';
    })
    .catch(err => setTimeout(() => {
      console.log('Error starting wasm: ', err, err.stack);
    }));
  },
  restore: async (msg) => {
    zmachine.restore(msg);
    step();
  },
  load_savestate: async (msg) => {
    zmachine.load_savestate(msg);
    step();
    zmachine.feed('look'); // get description text and then undo
    step();
    zmachine.undo();
  },
  start: async () => {
    step();
  },
  restart: async () => {

    const file_ptr = zmachine.utils.writeArray(file);

    zmachine.create(file_ptr, file.length);
    return 'loaded';
  },
  input: async (msg) => {
    zmachine.feed(msg);
    step();
  },
  undo: async () => {
    const ok = zmachine.undo();
    // originally tick after return
    zmachine.get_updates();
    return ok;
  },
  redo: async () => {
    const ok = zmachine.redo();
    // originally tick after return
    zmachine.get_updates();
    return ok
  },
  'enable:instructions': async (msg) => {
    zmachine.enable_instruction_logs(!!msg);
  },
  getDetails: async (msg) => {
    const str = zmachine.get_object_details(ev.data.msg);
    const value = str.value;
    // originally tick after return
    str.free();
    return value;
  },
}


// dispatch handlers based on incoming messages
const onmessage = async (ev) => {
  const { type, msg } = ev.data;
  const response = await api[type](msg);
  if (response !== undefined) sendWorkerMessage(type, response);
};

// onmessage({
//   data: {
//     type: 'load',
//     msg: {
//       filename: 'zork1',
//       file: new ArrayBuffer(),
//     }
//   }
// });

async function main () {
  api.events.on('header', (msg) => {
    console.log(`Location: ${msg}`);
  });
  api.events.on('print', (msg) => {
    console.log(msg);
  });

  const fileBuffer = await (await fetch('file://./zork1.z3')).arrayBuffer();
  await api.load({
    filename: "zork1",
    file: fileBuffer,
  })
  // await api['enable:instructions'](true);
  // await api.load_savestate(
  //   'Rk9STQAAAS5JRlpTSUZoZAAAAA0AWDg0MDcyNqEpAFkMAFN0a3MAAABOAAAAAAAAAAYkkSSFJH8AtAABAAEAT54aAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAFVNG48AAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAKQ01lbQAAALUA'
  // )
  await api.start()
  // {
//   "type": "input",
//   "msg": "look"
// }
}

main();

// {
//   "type": "load",
//   "msg": {
//       "filename": "zork1",
//       "file": {}
//   }
// }

// {
//   "type": "enable:instructions",
//   "msg": false
// }

// {
//   "type": "load_savestate",
//   "msg": "Rk9STQAAAS5JRlpTSUZoZAAAAA0AWDg0MDcyNqEpAFkMAFN0a3MAAABOAAAAAAAAAAYkkSSFJH8AtAABAAEAT54aAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAFVNG48AAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAKQ01lbQAAALUA/wD/AP8ADLS1AP8A/wD/AP8A/wD/ACkQAASxAP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8AMbQAfqAAAgEATrQAAKAABgQAIAQAAiIA/wAKyG9VAAIob2oAAAH//4DwAAH//4B8AAAB//+AEAC0AQABBAEA6nNuZWsA/wD/AP8A/wBkKiUqJwADKlMqVQABKmsAASqBAP8A/wD/AA=="
// }

// {
//   "type": "start"
// }

// {
//   "type": "input",
//   "msg": "look"
// }