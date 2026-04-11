# pi-auto-continue

A [pi](https://shittycodingagent.ai) extension that automatically sends a "continue" message every time the agent finishes a turn, so you don't have to babysit long-running work.

## Why

The motivating use case is **autonomous overnight research loops**, in the spirit of Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch): you give an agent a `program.md`-style brief, walk away, and let it iterate — edit code, run experiments, evaluate, keep or discard, repeat — until morning.

The problem with doing that on a local coding agent is that the agent politely stops after every turn and waits for you to type "continue." If you're asleep, it sits there doing nothing. Ralph-style shell loops around the CLI work but are fiddly to set up and don't share state with the running session.

`pi-auto-continue` solves that at the extension layer: pi itself pushes a user message back into the loop as soon as the agent stops, bounded by a safety counter. Point it at a text snippet or a live file of instructions, flip it on, and leave. The next morning you have a log of iterations instead of an idle prompt.

## What it does

Whenever the agent loop ends (the agent is done producing output and would normally wait for your next prompt), this extension injects a user message to kick it again. The message can be either:

- an inline string (e.g. `continue`), or
- the contents of a file you point it at (re-read every iteration, so you can edit it live)

A counter caps the number of auto-continues so runaway loops are bounded. Typing anything yourself resets the counter.

## Install

Symlink or copy this repo into pi's global extensions directory:

```bash
ln -s "$PWD" ~/.pi/agent/extensions/pi-auto-continue
```

Or register it explicitly in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/Users/linovaldovinos/Documents/LatentPlayground/pi-auto-continue/src/index.ts"
  ]
}
```

Then start pi (or run `/reload` if it's already running).

## Usage

Inside pi, use the `/auto-continue` command:

| Command | What it does |
|---|---|
| `/auto-continue` or `/auto-continue status` | Show current state |
| `/auto-continue on` | Enable auto-continue (resets counter to 0) |
| `/auto-continue off` | Disable auto-continue |
| `/auto-continue text <message>` | Set the continue message inline |
| `/auto-continue file <path>` | Read the continue message from a file (re-read every time) |
| `/auto-continue max <n>` | Set the iteration cap (default: 50) |
| `/auto-continue reset` | Reset the counter without toggling |

When enabled, the footer shows `auto-continue N/MAX`.

### Examples

```text
/auto-continue text keep going
/auto-continue on
```

```text
/auto-continue file ./loop-instructions.md
/auto-continue max 200
/auto-continue on
```

## How it works

- Subscribes to the `agent_end` event. Every time the agent loop ends, it calls `pi.sendUserMessage(...)` with the configured text, which re-enters the agent loop as if you had typed it.
- Subscribes to the `input` event and resets the counter whenever `event.source === "interactive"` (i.e. you typed something yourself).
- If the file mode is used, the file is read fresh on every iteration so you can edit instructions mid-loop.
- The max counter is a safety rail — if you want truly unbounded, set it very high.

## Notes / gotchas

- `agent_end` fires on normal completion *and* on errors, so auto-continue will keep trying even after a failed turn. That's usually what you want in a Ralph-style loop, but it means a persistently broken turn will burn your counter fast.
- The counter is in-memory per pi process. Restarting pi clears it.
- This extension does not persist its state across sessions — re-enable it after `/new`, `/fork`, or a restart.
