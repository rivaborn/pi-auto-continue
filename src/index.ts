import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Custom session-entry type used to persist loop state across restart/resume/fork. */
export const ENTRY_TYPE = "auto-continue";

/** If the agent's last reply contains this exact string, the loop stops. */
export const DONE_SENTINEL = "AUTO-CONTINUE: DONE";

export const DEFAULTS = {
	text: "continue",
	max: 1000,
	/** Consecutive failed turns tolerated before the loop disables itself. */
	maxFailures: 3,
	/** Context-window usage (percent) above which we compact before continuing. 0 disables. */
	contextThreshold: 90,
	/** `/auto-continue max <n>` above this value asks for confirmation. */
	confirmAbove: 5000,
	/** Backoff before the next continue after a failed turn; last value repeats. */
	failureDelaysMs: [10_000, 30_000, 90_000],
	/** Poll interval while pi is busy (its own retry/compaction) and we cannot send yet. */
	busyPollMs: 2_000,
} as const;

export interface AutoContinueOptions {
	failureDelaysMs?: readonly number[];
	busyPollMs?: number;
	confirmAbove?: number;
}

/** State persisted to the session file via pi.appendEntry(). */
export interface AutoContinueState {
	enabled: boolean;
	text: string;
	max: number;
	count: number;
	failures: number;
	maxFailures: number;
	contextThreshold: number;
}

// Structural view of the parts of an assistant message we care about. pi-coding-agent does not
// re-export the pi-ai AssistantMessage type, and we only need these fields.
interface AssistantLike {
	role: "assistant";
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

const SUBCOMMANDS = [
	{ value: "on", label: "on", description: "Enable with the current message" },
	{ value: "off", label: "off", description: "Disable" },
	{ value: "set ", label: "set <text>", description: "Set the continue message and enable" },
	{ value: "max ", label: "max <n>", description: `Iteration cap (default ${DEFAULTS.max})` },
	{ value: "failures ", label: "failures <n>", description: `Consecutive failures tolerated (default ${DEFAULTS.maxFailures})` },
	{ value: "context ", label: "context <percent>", description: `Compact above this context usage (default ${DEFAULTS.contextThreshold}, 0=off)` },
	{ value: "status", label: "status", description: "Show current state" },
];

function lastAssistant(messages: AgentEndEvent["messages"]): AssistantLike | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string };
		if (m.role === "assistant") return messages[i] as unknown as AssistantLike;
	}
	return undefined;
}

function assistantText(msg: AssistantLike | undefined): string {
	if (!msg) return "";
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.join("\n");
}

function isFailedTurn(msg: AssistantLike | undefined): boolean {
	if (!msg) return true; // the run ended without the model replying at all
	return msg.stopReason === "error" || Boolean(msg.errorMessage);
}

function parsePositiveInt(raw: string): number | undefined {
	const n = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function createAutoContinue(pi: ExtensionAPI, options: AutoContinueOptions = {}) {
	const failureDelaysMs = options.failureDelaysMs ?? DEFAULTS.failureDelaysMs;
	const busyPollMs = options.busyPollMs ?? DEFAULTS.busyPollMs;
	const confirmAbove = options.confirmAbove ?? DEFAULTS.confirmAbove;

	const state: AutoContinueState = {
		enabled: false,
		text: DEFAULTS.text,
		max: DEFAULTS.max,
		count: 0,
		failures: 0,
		maxFailures: DEFAULTS.maxFailures,
		contextThreshold: DEFAULTS.contextThreshold,
	};

	let pending: ReturnType<typeof setTimeout> | undefined;

	const clearPending = () => {
		if (pending !== undefined) {
			clearTimeout(pending);
			pending = undefined;
		}
	};

	const persist = () => {
		try {
			pi.appendEntry(ENTRY_TYPE, { ...state });
		} catch {
			// Persistence is best-effort (e.g. no session yet). The loop still works in memory.
		}
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!state.enabled) {
			ctx.ui.setStatus(ENTRY_TYPE, "");
			return;
		}
		const fails = state.failures > 0 ? ` (${state.failures} fail${state.failures === 1 ? "" : "s"})` : "";
		ctx.ui.setStatus(ENTRY_TYPE, `auto-continue ${state.count}/${state.max}${fails}`);
	};

	const disable = (ctx: ExtensionContext, reason: string, level: "info" | "warning" | "error" = "info") => {
		clearPending();
		state.enabled = false;
		persist();
		updateStatus(ctx);
		ctx.ui.notify(`auto-continue OFF: ${reason}`, level);
	};

	const statusText = () => {
		const ctxLine = state.contextThreshold > 0 ? `${state.contextThreshold}%` : "off";
		return [
			`auto-continue ${state.enabled ? "ON" : "OFF"}`,
			`message: "${state.text}"`,
			`iterations: ${state.count}/${state.max}`,
			`consecutive failures: ${state.failures}/${state.maxFailures}`,
			`compact above: ${ctxLine}`,
			`stop sentinel: "${DONE_SENTINEL}"`,
		].join("\n");
	};

	/** Send the continue message once pi is idle; re-poll while pi is retrying or compacting. */
	const sendWhenIdle = (ctx: ExtensionContext) => {
		if (!state.enabled) return;
		if (!ctx.isIdle()) {
			pending = setTimeout(() => sendWhenIdle(ctx), busyPollMs);
			return;
		}
		pending = undefined;
		try {
			pi.sendUserMessage(state.text);
		} catch (err) {
			disable(ctx, `could not send message (${(err as Error).message})`, "error");
		}
	};

	const schedule = (ctx: ExtensionContext, delayMs: number) => {
		clearPending();
		pending = setTimeout(() => sendWhenIdle(ctx), delayMs);
	};

	/** Decide whether to send immediately, after compaction, or not at all. */
	const continueAfterSuccess = (ctx: ExtensionContext) => {
		const usage = state.contextThreshold > 0 ? ctx.getContextUsage() : undefined;
		if (usage?.percent != null && usage.percent >= state.contextThreshold) {
			ctx.ui.notify(`auto-continue: context at ${Math.round(usage.percent)}%, compacting before next iteration`, "info");
			let settled = false;
			ctx.compact({
				onComplete: () => {
					if (settled) return;
					settled = true;
					schedule(ctx, 0);
				},
				onError: (err) => {
					if (settled) return;
					settled = true;
					disable(ctx, `compaction failed (${err.message})`, "error");
				},
			});
			return;
		}
		schedule(ctx, 0);
	};

	// --- events -----------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		clearPending();
		// Rehydrate from the newest auto-continue entry on the current branch, if any.
		let found: AutoContinueState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && (entry as { customType?: string }).customType === ENTRY_TYPE) {
				found = (entry as { data?: AutoContinueState }).data;
			}
		}
		if (found) {
			Object.assign(state, found);
		} else {
			Object.assign(state, { enabled: false, count: 0, failures: 0 });
		}
		updateStatus(ctx);
		if (state.enabled) {
			ctx.ui.notify(`auto-continue restored: ON (${state.count}/${state.max}). Send any message to resume the loop, or /auto-continue off.`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		clearPending();
	});

	// A run started (ours, the user's, or pi's own retry). Nothing to inject while it runs.
	pi.on("agent_start", async () => {
		clearPending();
	});

	// The user typed something themselves: reset the counters, keep the loop armed.
	pi.on("input", async (event) => {
		if (event.source === "interactive" && (state.count !== 0 || state.failures !== 0)) {
			state.count = 0;
			state.failures = 0;
			persist();
		}
		return { action: "continue" };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state.enabled) return;

		const last = lastAssistant(event.messages);

		// User hit Escape (or the turn was otherwise aborted). They want out.
		if (ctx.signal?.aborted || last?.stopReason === "aborted") {
			disable(ctx, "turn aborted");
			return;
		}

		if (isFailedTurn(last)) {
			state.failures += 1;
			persist();
			updateStatus(ctx);
			if (state.failures >= state.maxFailures) {
				disable(ctx, `${state.failures} consecutive failed turns (${last?.errorMessage ?? "no reply"})`, "warning");
				return;
			}
			const delay = failureDelaysMs[Math.min(state.failures - 1, failureDelaysMs.length - 1)] ?? 0;
			ctx.ui.notify(`auto-continue: turn failed (${state.failures}/${state.maxFailures}), retrying in ${Math.round(delay / 1000)}s`, "warning");
			schedule(ctx, delay);
			return;
		}

		state.failures = 0;

		if (assistantText(last).includes(DONE_SENTINEL)) {
			disable(ctx, "agent signalled done", "info");
			return;
		}

		if (state.count >= state.max) {
			disable(ctx, `reached max ${state.max} iterations`, "warning");
			return;
		}

		state.count += 1;
		persist();
		updateStatus(ctx);
		continueAfterSuccess(ctx);
	});

	// --- command ----------------------------------------------------------------

	pi.registerCommand("auto-continue", {
		description: "Auto-send a message whenever the agent stops: on | off | set <text> | max <n> | failures <n> | context <pct> | status",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trimStart().toLowerCase();
			const items = SUBCOMMANDS.filter((s) => s.value.startsWith(p));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const space = trimmed.indexOf(" ");
			const sub = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
			const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

			switch (sub) {
				case "":
				case "status":
					ctx.ui.notify(statusText(), "info");
					return;

				case "on":
					state.enabled = true;
					state.count = 0;
					state.failures = 0;
					persist();
					updateStatus(ctx);
					ctx.ui.notify(`auto-continue ON ("${state.text}", max ${state.max})`, "info");
					return;

				case "off":
					disable(ctx, "by user");
					return;

				case "set":
					if (!rest) {
						ctx.ui.notify("Usage: /auto-continue set <message>", "warning");
						return;
					}
					state.text = rest;
					state.enabled = true;
					state.count = 0;
					state.failures = 0;
					persist();
					updateStatus(ctx);
					ctx.ui.notify(`auto-continue ON ("${state.text}", max ${state.max})`, "info");
					return;

				case "max": {
					const n = parsePositiveInt(rest);
					if (n === undefined) {
						ctx.ui.notify("Usage: /auto-continue max <positive integer>", "warning");
						return;
					}
					if (n > confirmAbove) {
						const ok = await ctx.ui.confirm("auto-continue", `Allow up to ${n} unattended iterations?`);
						if (!ok) {
							ctx.ui.notify(`auto-continue: max unchanged (${state.max})`, "info");
							return;
						}
					}
					state.max = n;
					persist();
					updateStatus(ctx);
					ctx.ui.notify(`auto-continue max=${state.max}`, "info");
					return;
				}

				case "failures": {
					const n = parsePositiveInt(rest);
					if (n === undefined) {
						ctx.ui.notify("Usage: /auto-continue failures <positive integer>", "warning");
						return;
					}
					state.maxFailures = n;
					persist();
					ctx.ui.notify(`auto-continue: stop after ${n} consecutive failed turns`, "info");
					return;
				}

				case "context": {
					const n = Number.parseInt(rest, 10);
					if (!Number.isFinite(n) || n < 0 || n > 100) {
						ctx.ui.notify("Usage: /auto-continue context <0-100>  (0 disables the compaction guard)", "warning");
						return;
					}
					state.contextThreshold = n;
					persist();
					ctx.ui.notify(n === 0 ? "auto-continue: compaction guard off" : `auto-continue: compact above ${n}% context`, "info");
					return;
				}

				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Use: on | off | set <text> | max <n> | failures <n> | context <pct> | status`, "warning");
			}
		},
	});

	// Exposed for tests.
	return { state, hasPending: () => pending !== undefined };
}

export default function (pi: ExtensionAPI) {
	createAutoContinue(pi);
}
