# llm-plays-zork

An LLM plays [Zork I](https://en.wikipedia.org/wiki/Zork). A z-machine
interpreter compiled to WebAssembly (`web.wasm`) runs the original
`zork1.z3` story file, and an agent loop wires the game up to an LLM as a
tool: each turn the model submits one command via a `submit_command` tool
call, and the game's printed response comes back as the tool result. Text
the model writes outside the tool call is its "out loud" commentary.

Three interchangeable player backends are supported:

- **OpenAI** — or any OpenAI-compatible endpoint (LM Studio, Ollama, etc.)
  via `OPENAI_BASE_URL`. Uses the `submit_command` tool; endpoints without
  tool calling fall back to a plain-text `COMMAND:` protocol.
- **Anthropic API** — via the official SDK, defaulting to `claude-opus-5`.
  Uses the `submit_command` tool with server-side refusal fallbacks, and
  surfaces the model's summarized thinking in the terminal.
- **Claude Code CLI** — headless `claude -p` with all tools disabled, using
  whatever login the CLI already has; no API key needed. Uses the
  `COMMAND:` text protocol over a resumed CLI session.

Each backend owns its conversation history in its API's native format, so
thinking blocks and tool calls are retained and replayed where the API
supports them.

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
mailbox), unit tests for the text protocol and history trimming, and
stub-server tests of both API providers (tool-result pairing, thinking
replay, failure recovery, and the tools fallback).

## How it works

- `src/zork.js` — bridges the WASM z-machine via `wasm-ffi`: loads the
  story file, feeds commands, and emits the game's printed output.
- `src/agent.js` — selects the provider backend.
- `src/providers/` — the backends: `openai.js`, `anthropic.js`, and
  `claude-cli.js`. Each owns its native conversation history and exposes
  the same interface: `requestCommands(gameOutputs)` returns the model's
  submitted commands plus its out-loud commentary.
- `src/index.js` — the game loop: runs submitted commands in the game,
  feeds the printed output back as the next tool result, and restarts
  the game when it ends.
- `src/system-prompt.txt` — the player's static instructions (tutorial,
  game commands); each backend appends its own response-format section.

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
