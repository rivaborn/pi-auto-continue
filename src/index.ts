import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type Source = { kind: "text"; value: string } | { kind: "file"; path: string };

const DEFAULT_TEXT = "continue";
const DEFAULT_MAX = 50;

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let source: Source = { kind: "text", value: DEFAULT_TEXT };
	let max = DEFAULT_MAX;
	let count = 0;

	const describeSource = () =>
		source.kind === "text" ? `text="${source.value}"` : `file=${source.path}`;

	const updateStatus = (ctx: ExtensionContext) => {
		if (enabled) {
			ctx.ui.setStatus("auto-continue", `auto-continue ${count}/${max}`);
		} else {
			ctx.ui.setStatus("auto-continue", "");
		}
	};

	const resolveContinueText = (): string => {
		if (source.kind === "text") return source.value;
		try {
			const text = readFileSync(source.path, "utf8").trim();
			return text || DEFAULT_TEXT;
		} catch (err) {
			throw new Error(`auto-continue: cannot read ${source.path}: ${(err as Error).message}`);
		}
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

		if (count >= max) {
			ctx.ui.notify(`auto-continue: reached max ${max}, stopping`, "warning");
			enabled = false;
			updateStatus(ctx);
			return;
		}

		let text: string;
		try {
			text = resolveContinueText();
		} catch (err) {
			ctx.ui.notify((err as Error).message, "error");
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

	pi.registerCommand("auto-continue", {
		description:
			"Auto-send a continue message after each agent turn. Subcommands: on|off|status|text <msg>|file <path>|max <n>|reset",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			const value = trimmed.slice(sub.length).trim();

			switch (sub) {
				case "":
				case "status": {
					ctx.ui.notify(
						`auto-continue: ${enabled ? "ON" : "OFF"} | ${describeSource()} | ${count}/${max}`,
						"info",
					);
					return;
				}
				case "on": {
					enabled = true;
					count = 0;
					updateStatus(ctx);
					ctx.ui.notify(`auto-continue enabled (${describeSource()}, max=${max})`, "success");
					return;
				}
				case "off": {
					enabled = false;
					updateStatus(ctx);
					ctx.ui.notify("auto-continue disabled", "info");
					return;
				}
				case "reset": {
					count = 0;
					updateStatus(ctx);
					ctx.ui.notify("auto-continue counter reset", "info");
					return;
				}
				case "text": {
					if (!value) {
						ctx.ui.notify("Usage: /auto-continue text <message>", "warning");
						return;
					}
					source = { kind: "text", value };
					ctx.ui.notify(`auto-continue text set: "${value}"`, "success");
					return;
				}
				case "file": {
					if (!value) {
						ctx.ui.notify("Usage: /auto-continue file <path>", "warning");
						return;
					}
					const path = resolve(ctx.cwd, value);
					try {
						readFileSync(path, "utf8");
					} catch (err) {
						ctx.ui.notify(`Cannot read ${path}: ${(err as Error).message}`, "error");
						return;
					}
					source = { kind: "file", path };
					ctx.ui.notify(`auto-continue file set: ${path}`, "success");
					return;
				}
				case "max": {
					const n = Number.parseInt(rest[0] ?? "", 10);
					if (!Number.isFinite(n) || n <= 0) {
						ctx.ui.notify("Usage: /auto-continue max <positive integer>", "warning");
						return;
					}
					max = n;
					updateStatus(ctx);
					ctx.ui.notify(`auto-continue max=${max}`, "success");
					return;
				}
				default: {
					ctx.ui.notify(
						`Unknown subcommand "${sub}". Use: on|off|status|text|file|max|reset`,
						"warning",
					);
				}
			}
		},
	});
}
