# pi-auto-continue

A [pi](https://shittycodingagent.ai) extension that automatically sends a "continue" message every time the agent finishes a turn, so you don't have to babysit long-running work. Built for **autonomous overnight research loops** in the spirit of Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch): give the agent a brief, walk away, and let it iterate until morning.

This is a fork of [latent-variable/pi-auto-continue](https://github.com/latent-variable/pi-auto-continue) that adds the guard rails an unattended loop needs: failure detection with backoff, a context-window guard, a done sentinel, persistent state, and a sanity check on the iteration cap.

## What it does

Whenever the agent loop ends, the extension pushes your continue message back into the loop, just as if you had typed it. Around that core it adds:

| Guard                   | Behaviour                                                                                                                                                                       |
|-------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Iteration cap**       | Stops after `max` continues (default **1000**). Setting a cap above 5000 asks for confirmation so a typo can't authorise a million turns.                                       |
| **Failure breaker**     | A turn that ends in an error (dead API key, rate limit, provider outage) does not fire immediately. It waits 10s, then 30s, then 90s, and stops after 3 consecutive failures. A successful turn resets the streak. |
| **Context guard**       | If context usage is at or above 90% when a turn ends, the extension compacts first and only then continues. Set to 0 to disable.                                               |
| **Done sentinel**       | If the agent's reply contains `AUTO-CONTINUE: DONE`, the loop stops. Put that instruction in your brief and the agent can end the loop itself.                                  |
| **Escape**              | Aborting a turn with Escape disables the loop. If you want out, you want out.                                                                                                   |
| **Plays nice with pi**  | pi already retries transient provider errors with its own backoff. The extension waits while pi is retrying or compacting rather than queueing a duplicate message.               |
| **Persistence**         | State (on/off, message, cap, counters, thresholds) is written to the session as a custom entry, so it survives restart, `/resume`, `/fork` and `/reload`.                      |

Typing anything yourself resets the iteration and failure counters but keeps the loop armed.

## Install

```bash
pi install npm:@rivaborn/pi-auto-continue
```

Or directly from GitHub:

```bash
pi install git:github.com/rivaborn/pi-auto-continue
```

Or from a local clone:

```bash
pi install /path/to/pi-auto-continue
```

Then `/reload` inside pi if it's already running.

## Usage

One command, discoverable via `/auto` tab-completion, with subcommands that also tab-complete:

| Command                          | What it does                                                                        |
|----------------------------------|-------------------------------------------------------------------------------------|
| `/auto-continue on`              | Enable (uses the current continue text, default `"continue"`)                       |
| `/auto-continue off`             | Disable                                                                             |
| `/auto-continue set <text>`      | Set the continue message AND enable                                                 |
| `/auto-continue max <n>`         | Set the iteration cap (default 1000; above 5000 asks for confirmation)              |
| `/auto-continue failures <n>`    | Consecutive failed turns tolerated before stopping (default 3)                      |
| `/auto-continue context <pct>`   | Compact before continuing when context usage is at or above this percent (default 90, 0 = off) |
| `/auto-continue status`          | Show the current state (also the no-argument form)                                  |

When enabled, the footer shows `auto-continue N/<max>`, plus `(k fails)` while a failure streak is active.

### Example

```text
/auto-continue set keep iterating on train.py until val_bpb improves. When you are confident there is nothing left to try, reply with AUTO-CONTINUE: DONE.
```

Flips auto-continue on with that as the message. Walk away. Come back and `/auto-continue off` (or hit Escape mid-turn) to stop, or let the agent stop itself with the sentinel.

### Resuming after a restart

If pi restarts or you `/resume` a session where the loop was on, the extension restores its state and tells you so. It does **not** fire a continue on its own at that point. Send any message (even just `continue`) and the loop picks up where it left off. `/new` starts a fresh session with no state, which is the one case where you need to `/auto-continue set` again.

## Safety notes

pi runs tools without approval prompts. Auto-continue turns one unattended session into up to `max` unattended agent turns with whatever access that session has: the working directory, your shell, and any ssh or MCP tools you have loaded. Before leaving it overnight:

- Run it in a dedicated checkout or container and commit first.
- Unload tools the loop doesn't need (ssh packages in particular).
- Keep the failure breaker on. It is what stops a dead API key from burning the whole cap.
- Keep `max` honest. 1000 iterations is a lot of API calls.

## How it works

- Subscribes to `agent_end`. Inspects the last assistant message: `stopReason === "error"` (or an `errorMessage`) counts as a failure, `stopReason === "aborted"` or an aborted `ctx.signal` means the user hit Escape, and the done sentinel in the reply text ends the loop. Otherwise it increments the counter and schedules `pi.sendUserMessage(text)`.
- Before sending it checks `ctx.isIdle()`. pi reports not-idle while its own retry backoff or compaction is running, so the extension polls every 2s instead of queueing a second message. `agent_start` cancels any pending send, which covers pi's retry starting a new run.
- Checks `ctx.getContextUsage().percent` after each successful turn and calls `ctx.compact()` when it is at or above the threshold, continuing only once compaction completes.
- Subscribes to `input` and resets both counters when `event.source === "interactive"`.
- Persists state with `pi.appendEntry("auto-continue", state)` on every change and rehydrates on `session_start` from the newest such entry on the current branch.

## Development

```bash
npm install
npm run typecheck   # tsc against @earendil-works/pi-coding-agent types
npm test            # node --test, no build step (Node 22.18+ / 24 strips types natively)
```

Tests drive the extension with a fake `ExtensionAPI` and context, so they run without a pi process.

## Notes / gotchas

- `agent_end` fires on normal completion *and* on errors. The failure breaker exists precisely so a persistently broken turn doesn't burn the cap, but if you raise `failures` very high you reintroduce that risk.
- Counters reset whenever you type something yourself. If you come back, ask a quick question and walk away again, the loop resumes with a fresh budget.
- The sentinel match is exact and case-sensitive: `AUTO-CONTINUE: DONE`.
