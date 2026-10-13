# Changelog

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
