# llm-plays-zork

An LLM plays [Zork I](https://en.wikipedia.org/wiki/Zork). A z-machine
interpreter compiled to WebAssembly (`web.wasm`) runs the original
`zork1.z3` story file, and an agent loop feeds the game transcript to an
LLM, which responds with one structured turn at a time: its thinking, a
game command, and optional self-maintained notes and mission updates.

Works with OpenAI or any OpenAI-compatible endpoint (LM Studio, Ollama,
etc.). Uses structured (JSON schema) outputs when the endpoint supports
them, with a lenient fallback parser for those that don't.

## Setup

Requires Node.js 22+.

```sh
cp .env.example .env   # add your API key; optionally set base URL / model
yarn                   # install dependencies
```

## Run

```sh
yarn start
```

The terminal shows the game transcript, the player's reasoning and
commands, and the agent's current mission and notes. Press Ctrl+C to stop;
the chat history is written to `logs/` for debugging. Malformed model
responses are also dumped there.

## Test

```sh
yarn test
```

Runs a smoke test of the z-machine bridge (boots the game and opens the
mailbox) and unit tests for the response parser.

## How it works

- `src/zork.js` — bridges the WASM z-machine via `wasm-ffi`: loads the
  story file, feeds commands, and emits the game's printed output.
- `src/agent.js` — the LLM player: builds the prompt from the system
  prompt, mission, notes, and recent transcript, and requests one JSON
  turn per move.
- `src/index.js` — the game loop: runs commands in the game, appends the
  results to the chat history, tracks mission/notes state, and restarts
  the game when it ends.
- `src/system-prompt.txt` — the player's instructions, with `{MISSION}`
  and `{NOTES}` placeholders filled in each turn.
