import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const DEFAULT_TEXT = "continue";
const DEFAULT_MAX = 100;

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let text = DEFAULT_TEXT;
	let max = DEFAULT_MAX;
	let count = 0;

	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(
			"auto-continue",
			enabled ? `auto-continue ${count}/${max}` : "",
		);
	};

	// Reset counter whenever the user types something themselves.
	pi.on("input", async (event, _ctx) => {
		if (event.source === "interactive") {
			count = 0;
		}
		return { action: "continue" };
	});

	// After each agent loop finishes, fire another "continue" if enabled.
	pi.on("agent_end", async (_event, ctx) => {
		if (!enabled) return;

		// User hit Escape (or otherwise aborted the turn). Break the loop —
		// they clearly want out, not "one more iteration".
		if (ctx.signal?.aborted) {
			enabled = false;
			updateStatus(ctx);
			ctx.ui.notify("auto-continue disabled (turn aborted)", "info");
			return;
		}

		if (count >= max) {
			ctx.ui.notify(`auto-continue: reached max ${max}, stopping`, "warning");
			enabled = false;
			updateStatus(ctx);
			return;
		}

		count += 1;
		updateStatus(ctx);

		// Defer so the current agent turn fully settles into idle before we
		// inject the next user message.
		setTimeout(() => {
			if (!enabled) return;
			try {
				pi.sendUserMessage(text);
			} catch (err) {
				ctx.ui.notify(`auto-continue: ${(err as Error).message}`, "error");
				enabled = false;
				updateStatus(ctx);
			}
		}, 0);
	});

	pi.registerCommand("auto-continue-on", {
		description: "Enable auto-continue.",
		handler: async (_args, ctx) => {
			enabled = true;
			count = 0;
			updateStatus(ctx);
			ctx.ui.notify(`auto-continue ON ("${text}")`, "success");
		},
	});

	pi.registerCommand("auto-continue-off", {
		description: "Disable auto-continue.",
		handler: async (_args, ctx) => {
			enabled = false;
			updateStatus(ctx);
			ctx.ui.notify("auto-continue OFF", "info");
		},
	});

	pi.registerCommand("auto-continue-set", {
		description: "Set message and enable.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /auto-continue-set <message>", "warning");
				return;
			}
			text = trimmed;
			enabled = true;
			count = 0;
			updateStatus(ctx);
			ctx.ui.notify(`auto-continue ON ("${text}")`, "success");
		},
	});

	pi.registerCommand("auto-continue-max", {
		description: "Set iteration cap.",
		handler: async (args, ctx) => {
			const n = Number.parseInt(args.trim(), 10);
			if (!Number.isFinite(n) || n <= 0) {
				ctx.ui.notify("Usage: /auto-continue-max <positive integer>", "warning");
				return;
			}
			max = n;
			updateStatus(ctx);
			ctx.ui.notify(`auto-continue max=${max}`, "success");
		},
	});
}
