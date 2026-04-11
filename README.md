# pi-auto-continue

A [pi](https://shittycodingagent.ai) extension that automatically sends a "continue" message every time the agent finishes a turn, so you don't have to babysit long-running work.

## Why

The motivating use case is **autonomous overnight research loops**, in the spirit of Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch): you give an agent a `program.md`-style brief, walk away, and let it iterate — edit code, run experiments, evaluate, keep or discard, repeat — until morning.

The problem with doing that on a local coding agent is that the agent politely stops after every turn and waits for you to type "continue." If you're asleep, it sits there doing nothing. Ralph-style shell loops around the CLI work but are fiddly to set up and don't share state with the running session.

`pi-auto-continue` solves that at the extension layer: pi itself pushes a user message back into the loop as soon as the agent stops, bounded by a safety counter. Set your continue message, flip it on, and leave. The next morning you have a log of iterations instead of an idle prompt.

## What it does

Whenever the agent loop ends, this extension calls `pi.sendUserMessage(...)` to push a user message back into the loop, just as if you had typed it. A hard cap of 100 iterations prevents runaway loops. Typing anything yourself resets the counter. Hitting Escape to abort a turn disables auto-continue — if you want out, you want out.

## Install

```bash
pi install npm:@latent-variable/pi-auto-continue
```

Or directly from GitHub:

```bash
pi install git:github.com/latent-variable/pi-auto-continue
```

Or from a local clone:

```bash
pi install /path/to/pi-auto-continue
```

Then `/reload` inside pi if it's already running.

## Usage

Four commands, all discoverable via `/auto` tab-completion:

| Command | What it does |
|---|---|
| `/auto-continue-on` | Enable (uses the current continue text, default `"continue"`) |
| `/auto-continue-off` | Disable |
| `/auto-continue-set <text>` | Set the continue message AND enable |
| `/auto-continue-max <n>` | Set the iteration cap (default: 100) |

When enabled, the footer shows `auto-continue N/<max>`.

### Example

```text
/auto-continue-set keep iterating on train.py until val_bpb improves
```

Flips auto-continue on with that as the message. Walk away. Come back and `/auto-continue-off` (or hit Escape mid-turn) to stop.

## How it works

- Subscribes to `agent_end`. Every time the agent loop ends, it calls `pi.sendUserMessage(text)`, which re-enters the agent loop as if you had typed it.
- Subscribes to `input` and resets the counter whenever `event.source === "interactive"` — so your own typing doesn't count against the iteration cap.
- Checks `ctx.signal?.aborted` in `agent_end`. If the turn was aborted (Escape), it disables itself instead of firing another continue.

## Notes / gotchas

- `agent_end` fires on normal completion *and* on errors, so auto-continue will keep trying even after a failed turn. Usually what you want in a research loop, but a persistently broken turn will burn your 100-iteration cap fast.
- The counter and enabled flag live in memory per pi process. Restarting pi, `/new`, or `/fork` clears them — re-enable with `/auto-continue-set <your text>` after.
- The iteration cap defaults to 100 and can be changed at runtime with `/auto-continue-max <n>`. It resets to 100 on restart.
