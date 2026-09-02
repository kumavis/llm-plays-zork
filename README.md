# llm-plays-zork

An LLM plays [Zork I](https://en.wikipedia.org/wiki/Zork). A z-machine
interpreter compiled to WebAssembly (`web.wasm`) runs the original
`zork1.z3` story file, and an agent loop wires the game up to an LLM as a
tool: each turn the model submits one command via a `submit_command` tool
call, and the game's printed response comes back as the tool result. Text
the model writes outside the tool call is its "out loud" commentary.

![Score progression across all completed runs](logs/run-scores.svg)

Four interchangeable player backends are supported:

- **OpenAI** — or any OpenAI-compatible endpoint (LM Studio, Ollama, etc.)
  via `OPENAI_BASE_URL`. Uses the `submit_command` tool; endpoints without
  tool calling fall back to a plain-text `COMMAND:` protocol.
- **Anthropic API** — via the official SDK, defaulting to `claude-opus-5`.
  Uses the `submit_command` tool with server-side refusal fallbacks, and
  surfaces the model's summarized thinking in the terminal.
- **Claude Code CLI** — headless `claude -p` with all tools disabled, using
  whatever login the CLI already has; no API key needed. Uses the
  `COMMAND:` text protocol over one persistent CLI process per game, so
  the CLI's multi-second startup is paid once rather than every turn.
- **Codex CLI** — headless `codex exec` on whatever ChatGPT login the CLI
  already has; no API key needed. Also the `COMMAND:` text protocol, but
  `codex exec` has no persistent stdin channel, so each turn is its own
  process continuing the thread with `codex exec resume <id>` — boot is
  paid per turn (~2s of wall time, no move budget).

Each backend owns its conversation history in its API's native format, so
thinking blocks and tool calls are retained and replayed where the API
supports them.

## Setup

Requires Node.js 22+.

```sh
cp .env.example .env   # pick a backend and add a key (not needed for claude-cli)
yarn                   # install dependencies
```

The backend is chosen with `LLM_PROVIDER` (`openai`, `anthropic`,
`claude-cli`, or `codex-cli`); when unset, it is inferred from which API
key is present. The two CLI backends need their tool installed and logged
in (`claude`, or `brew install codex && codex login`) but no key here. See
`.env.example` for all knobs (models, base URL, reasoning effort).

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

## Eval

`yarn eval` runs a models × trials matrix and reports how they compare:

```sh
yarn eval --models haiku,sonnet --trials 3 --moves 300 --name my-eval
yarn eval:report logs/eval-my-eval        # re-aggregate a batch
yarn eval:report logs/eval-a logs/eval-b  # one table across batches
yarn eval:score-svg                       # chart all completed runs together
```

A `--models` entry may carry its own backend and reasoning effort, so a
single batch can span harnesses:

```sh
yarn eval --models claude-cli:sonnet,codex-cli:gpt-5.6-sol@medium --trials 3
```

Each run is bounded by **game moves**, not wall-clock, so a slower model
is not penalized for thinking longer. The trial number doubles as the
game's RNG seed, so every model plays the same game in trial *k* —
combat rolls and thief movement included — which makes the comparison
paired rather than noisy. A trial that already spent its budget is
skipped, so an interrupted batch resumes with the same command.

Runs write `logs/eval-<name>/run-*.jsonl`: one event per model turn,
command (with the game's response and whether it was a parser rejection
or a world refusal), score change, and a `run_end` summary with token
usage and cost. Only runs that spent their full move budget are counted;
one stopped early is labeled and excluded. Metrics are queries over
those logs, so new questions can be asked of old runs.

Model comparisons hold the backend constant. The `claude-cli` backend
spawns with no tools, no MCP servers, no setting sources, and a neutral
working directory, so a run cannot search the web, read files, or keep
notes between turns: its only effector is the game. The `codex-cli`
backend gets the same treatment it can ask for — `--ignore-user-config`
(no plugins, skills, or MCP servers), `--ignore-rules`, web search off, a
read-only sandbox, and an empty scratch directory of its own per game —
with two differences worth stating rather than papering over:

- Codex's shell tool cannot be turned off the way `claude --tools ''`
  removes Claude's, so the model *can* run read-only commands. There is
  nothing in its working directory to find, but the capability is there.
- `codex exec` has no equivalent of `claude --system-prompt`, so Codex's
  own agent instructions stay in the request and the player prompt rides
  on top of them as `developer_instructions`.

So cross-harness numbers compare *harness plus model*, which is what a
subscription actually buys; only within a backend is the model the single
variable.

The report groups runs by the model name they requested, so pin one
reasoning effort per model within a batch (`gpt-5.6-sol@medium`) — the two
Codex efforts of one model would otherwise share a row.

Cost is reported only where the backend reports it. The Claude CLI
estimates each run at API list prices; the Codex CLI reports tokens but no
price, so its cost and score-per-dollar columns read `n/a` rather than
`$0.00` — a subscription run is not a free one.

### Results

Claude Code CLI backend, 300 game moves per run, seeds 1–3, score out of
350. Full logs are in `logs/eval-haiku-300/` and `logs/eval-sonnet-300/`.

| seed | haiku | sonnet |
| ---- | ----- | ------ |
| 1    | 15    | 95     |
| 2    | 49    | 75     |
| 3    | *pending* | *pending* |

| model  | median score | mean cost/run | score per $ | mean wall/run |
| ------ | ------------ | ------------- | ----------- | ------------- |
| haiku  | 32           | $0.99         | 32.3        | 13.5 min      |
| sonnet | 85           | $1.69         | 50.4        | 18.9 min      |

Sonnet scores far higher per run *and* per dollar: it is roughly 1.7×
the cost but 2.7× the score. Variance between seeds is large for both
models (haiku scored 15 and 49 on the same budget), so single runs are
anecdotes — the seeded, repeated matrix exists for that reason.

## How it works

- `src/zork.js` — bridges the WASM z-machine via `wasm-ffi`: loads the
  story file, feeds commands, and emits the game's printed output.
- `src/agent.js` — selects the provider backend.
- `src/providers/` — the backends: `openai.js`, `anthropic.js`,
  `claude-cli.js`, and `codex-cli.js`. Each owns its native conversation
  history and exposes the same interface: `requestCommands(gameOutputs)`
  returns the model's submitted commands plus its out-loud commentary.
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
history and caching. The Codex backend cannot hold a process open, so each
turn re-enters the same thread with `codex exec resume`; the Responses API
still cache-reads the replayed prefix, which is most of the request.
