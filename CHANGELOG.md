# Changelog

## 0.3.0 (2026-11-10)

### Added

- **Interval loop.** `/loop <interval> <prompt>` sends the prompt now and then every interval (start to start), like Claude Code's `/loop 5m <prompt>`. `/loop off` and `/loop status`. The same is available as `/auto-continue every <interval> [text]`; without text it only changes the interval, and `every off` returns to back-to-back. The minimum interval is 10s. A send is due at last send + interval, or immediately if the turn ran past that. It never interrupts a running turn. The footer shows the interval and the next send time. `intervalMs` is persisted; entries from 0.2.0 restore as back-to-back.

## 0.2.0 (2026-10-12)

First release of the [rivaborn fork](https://github.com/rivaborn/pi-auto-continue). Adds the guard rails an unattended loop needs.

### Added

- **Failure breaker.** A turn ending in an error (`stopReason: "error"` or an `errorMessage`) no longer fires `continue` immediately. Backoff of 10s / 30s / 90s between attempts, and the loop disables itself after 3 consecutive failures (`/auto-continue failures <n>`). A successful turn resets the streak. A run with no assistant reply counts as a failure.
- **Context guard.** At or above 90% context usage the extension compacts before continuing (`/auto-continue context <pct>`, 0 disables).
- **Done sentinel.** A reply containing `AUTO-CONTINUE: DONE` stops the loop.
- **Persistent state.** On/off, message, cap, counters and thresholds are stored as a custom session entry and restored on `session_start`, so they survive restart, `/resume`, `/fork` and `/reload`. Restoring never fires a continue by itself.
- **Confirmation on large caps.** `/auto-continue max <n>` above 5000 asks before applying.
- **Busy-aware sending.** Waits while pi's own retry backoff or compaction is running instead of queueing a duplicate message; a new `agent_start` cancels any pending send.
- Test suite (`npm test`, Node's built-in runner, no pi process needed), `npm run typecheck`, and a GitHub Actions workflow.

### Changed

- **Single command.** `/auto-continue on|off|set <text>|max <n>|failures <n>|context <pct>|status` with subcommand tab-completion replaces `/auto-continue-on`, `-off`, `-set` and `-max`.
- **Default iteration cap** raised from 100 to 1000.
- Package renamed to `@rivaborn/pi-auto-continue`; peer dependency and type import moved to `@earendil-works/pi-coding-agent`.

### Fixed

- `ctx.ui.notify` was called with a `"success"` level that pi does not accept; now `"info"`.

## 0.1.0

Original release by [latent-variable](https://github.com/latent-variable/pi-auto-continue): `/auto-continue-on`, `-off`, `-set`, `-max`; cap of 100; Escape aborts the loop.
