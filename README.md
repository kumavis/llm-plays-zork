# llm-plays-zork

An LLM plays [Zork I](https://en.wikipedia.org/wiki/Zork). A z-machine
interpreter compiled to WebAssembly (`web.wasm`) runs the original
`zork1.z3` story file, and an agent loop feeds the game transcript to an
LLM, which responds with one structured turn at a time: its thinking and
a game command.

Three interchangeable player backends are supported:

- **OpenAI** — or any OpenAI-compatible endpoint (LM Studio, Ollama, etc.)
  via `OPENAI_BASE_URL`.
- **Anthropic API** — via the official SDK, defaulting to `claude-opus-5`
  with structured outputs and server-side refusal fallbacks enabled.
- **Claude Code CLI** — headless `claude -p` with all tools disabled, using
  whatever login the CLI already has; no API key needed.

All backends use structured (JSON schema) outputs where the endpoint
supports them, with a lenient fallback parser for those that don't.

## Setup

Requires Node.js 22+.

```sh
cp .env.example .env   # pick a backend and add a key (not needed for claude-cli)
yarn                   # install dependencies
```

The backend is chosen with `LLM_PROVIDER` (`openai`, `anthropic`, or
`claude-cli`); when unset, it is inferred from which API key is present.
See `.env.example` for all knobs (models, base URL, reasoning effort).

## Run

```sh
yarn start
```

The terminal shows the game transcript and the player's reasoning and
commands. Press Ctrl+C to stop; the chat history is written to `logs/`
for debugging. Malformed model responses are also dumped there.

## Test

```sh
yarn test
```

Runs a smoke test of the z-machine bridge (boots the game and opens the
mailbox) and unit tests for the response parser.

## How it works

- `src/zork.js` — bridges the WASM z-machine via `wasm-ffi`: loads the
  story file, feeds commands, and emits the game's printed output.
- `src/agent.js` — the LLM player: sends the static system prompt plus
  the game transcript and requests one JSON turn per move from the
  selected backend.
- `src/providers/` — the backends: `openai.js`, `anthropic.js`, and
  `claude-cli.js`, each exposing the same one-turn request interface.
- `src/index.js` — the game loop: runs commands in the game, appends the
  results to the chat history, and restarts the game when it ends.
- `src/system-prompt.txt` — the player's static instructions (tutorial,
  commands, response format).

## Prompt caching

Prompt caching is a prefix match, so the harness keeps the request prefix
byte-stable between turns: the system prompt is static (no interpolated
state), the transcript only grows, and history is trimmed in chunks (jump
the window forward once at a ceiling) rather than sliding every turn. The
Anthropic backend sets a cache breakpoint each request so the previous
turn's prefix bills at cache-read rates; OpenAI endpoints cache stable
prefixes automatically; the Claude CLI backend resumes one CLI session
per game and only sends new game output, letting the CLI manage its own
history and caching.
