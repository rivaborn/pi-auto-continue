import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAutoContinue, DONE_SENTINEL, ENTRY_TYPE, formatInterval, parseInterval } from "../src/index.ts";

// ---- minimal fakes for the slice of pi's ExtensionAPI / ExtensionContext we use ----

type Handler = (event: any, ctx: any) => any;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions?: (p: string) => any }>();
	const sent: string[] = [];
	const entries: { customType: string; data: any }[] = [];
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand: (name: string, opts: any) => {
			commands.set(name, opts);
		},
		sendUserMessage: (text: string) => {
			sent.push(text);
		},
		appendEntry: (customType: string, data: any) => {
			entries.push({ customType, data });
		},
	};
	const emit = async (event: string, payload: any, ctx: any) => {
		for (const h of handlers.get(event) ?? []) await h({ type: event, ...payload }, ctx);
	};
	return { pi: pi as any, emit, commands, sent, entries };
}

function fakeCtx(overrides: Partial<{
	aborted: boolean;
	idle: boolean;
	percent: number | null;
	confirm: boolean;
	branch: any[];
}> = {}) {
	const notices: { msg: string; level: string }[] = [];
	const statuses: string[] = [];
	const compactCalls: any[] = [];
	const ctx = {
		signal: overrides.aborted === undefined ? undefined : { aborted: overrides.aborted },
		isIdle: () => overrides.idle ?? true,
		getContextUsage: () => (overrides.percent === undefined ? undefined : { tokens: 0, contextWindow: 100, percent: overrides.percent }),
		compact: (opts: any) => {
			compactCalls.push(opts);
		},
		sessionManager: { getBranch: () => overrides.branch ?? [] },
		ui: {
			notify: (msg: string, level = "info") => {
				notices.push({ msg, level });
			},
			setStatus: (_key: string, text: string) => {
				statuses.push(text);
			},
			confirm: async () => overrides.confirm ?? true,
		},
	};
	return { ctx, notices, statuses, compactCalls };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "text", text }],
	...extra,
});

async function enable(f: ReturnType<typeof fakePi>, ctx: any, text = "go") {
	await f.commands.get("auto-continue")!.handler(`set ${text}`, ctx);
}

// Short delays so failure backoff is observable without waiting.
const FAST = { failureDelaysMs: [20, 40], busyPollMs: 5 };

describe("auto-continue", () => {
	it("is off by default and sends nothing on agent_end", async () => {
		const f = fakePi();
		createAutoContinue(f.pi, FAST);
		const { ctx } = fakeCtx();
		await f.emit("agent_end", { messages: [assistant("hi")] }, ctx);
		await tick();
		assert.deepEqual(f.sent, []);
	});

	it("sends the continue text after a successful turn and counts it", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx, statuses } = fakeCtx();
		await enable(f, ctx, "keep going");
		await f.emit("agent_end", { messages: [assistant("done some work")] }, ctx);
		await tick();
		assert.deepEqual(f.sent, ["keep going"]);
		assert.equal(ac.state.count, 1);
		assert.equal(statuses.at(-1), "auto-continue 1/1000");
	});

	it("stops at the iteration cap", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx, notices } = fakeCtx();
		await enable(f, ctx);
		await f.commands.get("auto-continue")!.handler("max 2", ctx);
		for (let i = 0; i < 3; i++) {
			await f.emit("agent_end", { messages: [assistant("x")] }, ctx);
			await tick();
		}
		assert.equal(f.sent.length, 2);
		assert.equal(ac.state.enabled, false);
		assert.match(notices.at(-1)!.msg, /reached max 2/);
	});

	it("disables when the turn was aborted (Escape)", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx } = fakeCtx({ aborted: true });
		await enable(f, ctx);
		await f.emit("agent_end", { messages: [assistant("partial")] }, ctx);
		await tick();
		assert.equal(ac.state.enabled, false);
		assert.deepEqual(f.sent, []);
	});

	it("backs off after a failed turn and disables after maxFailures consecutive failures", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx, notices } = fakeCtx();
		await enable(f, ctx);
		await f.commands.get("auto-continue")!.handler("failures 2", ctx);

		const failed = assistant("", { stopReason: "error", errorMessage: "401 invalid api key" });

		await f.emit("agent_end", { messages: [failed] }, ctx);
		assert.equal(ac.state.failures, 1);
		assert.deepEqual(f.sent, [], "must not fire immediately after a failure");
		assert.equal(ac.hasPending(), true);
		await tick(40);
		assert.deepEqual(f.sent, ["go"], "fires after the backoff delay");

		await f.emit("agent_end", { messages: [failed] }, ctx);
		await tick(60);
		assert.equal(ac.state.enabled, false);
		assert.equal(f.sent.length, 1, "no further send once disabled");
		assert.match(notices.at(-1)!.msg, /2 consecutive failed turns/);
		assert.match(notices.at(-1)!.msg, /invalid api key/);
	});

	it("resets the failure streak after a successful turn", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx } = fakeCtx();
		await enable(f, ctx);
		await f.emit("agent_end", { messages: [assistant("", { stopReason: "error", errorMessage: "boom" })] }, ctx);
		await tick(40);
		assert.equal(ac.state.failures, 1);
		await f.emit("agent_end", { messages: [assistant("ok")] }, ctx);
		await tick();
		assert.equal(ac.state.failures, 0);
		assert.equal(f.sent.length, 2);
	});

	it("treats a run with no assistant reply as a failure", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx } = fakeCtx();
		await enable(f, ctx);
		await f.emit("agent_end", { messages: [] }, ctx);
		assert.equal(ac.state.failures, 1);
	});

	it("waits while pi is busy (its own retry/compaction) instead of queueing a duplicate", async () => {
		const f = fakePi();
		createAutoContinue(f.pi, FAST);
		const busy = { idle: false };
		const { ctx } = fakeCtx();
		ctx.isIdle = () => busy.idle;
		await enable(f, ctx);
		await f.emit("agent_end", { messages: [assistant("x")] }, ctx);
		await tick(15);
		assert.deepEqual(f.sent, [], "nothing sent while busy");
		busy.idle = true;
		await tick(15);
		assert.deepEqual(f.sent, ["go"]);
	});

	it("cancels a pending send when a new run starts", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx } = fakeCtx();
		await enable(f, ctx);
		await f.emit("agent_end", { messages: [assistant("", { stopReason: "error", errorMessage: "rate limited" })] }, ctx);
		assert.equal(ac.hasPending(), true);
		await f.emit("agent_start", {}, ctx); // pi's own retry kicked in
		assert.equal(ac.hasPending(), false);
		await tick(60);
		assert.deepEqual(f.sent, []);
	});

	it("stops when the agent emits the done sentinel", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx, notices } = fakeCtx();
		await enable(f, ctx);
		await f.emit("agent_end", { messages: [assistant(`All experiments finished.\n${DONE_SENTINEL}`)] }, ctx);
		await tick();
		assert.equal(ac.state.enabled, false);
		assert.deepEqual(f.sent, []);
		assert.match(notices.at(-1)!.msg, /signalled done/);
	});

	it("compacts before continuing when context usage is above the threshold", async () => {
		const f = fakePi();
		createAutoContinue(f.pi, FAST);
		const { ctx, compactCalls } = fakeCtx({ percent: 95 });
		await enable(f, ctx);
		await f.emit("agent_end", { messages: [assistant("x")] }, ctx);
		await tick();
		assert.equal(compactCalls.length, 1);
		assert.deepEqual(f.sent, [], "waits for compaction");
		compactCalls[0].onComplete({});
		await tick();
		assert.deepEqual(f.sent, ["go"]);
	});

	it("does not compact when the guard is disabled with context 0", async () => {
		const f = fakePi();
		createAutoContinue(f.pi, FAST);
		const { ctx, compactCalls } = fakeCtx({ percent: 95 });
		await enable(f, ctx);
		await f.commands.get("auto-continue")!.handler("context 0", ctx);
		await f.emit("agent_end", { messages: [assistant("x")] }, ctx);
		await tick();
		assert.equal(compactCalls.length, 0);
		assert.deepEqual(f.sent, ["go"]);
	});

	it("resets counters on interactive input but keeps the loop armed", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx } = fakeCtx();
		await enable(f, ctx);
		await f.emit("agent_end", { messages: [assistant("x")] }, ctx);
		await tick();
		assert.equal(ac.state.count, 1);
		const res = await f.emit("input", { text: "hello", source: "interactive" }, ctx);
		assert.equal(ac.state.count, 0);
		assert.equal(ac.state.enabled, true);
		// extension-sourced input (our own continue) must not reset
		ac.state.count = 5;
		await f.emit("input", { text: "go", source: "extension" }, ctx);
		assert.equal(ac.state.count, 5);
		void res;
	});

	it("asks for confirmation above the max ceiling and respects a decline", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, { ...FAST, confirmAbove: 100 });
		const yes = fakeCtx({ confirm: true });
		const no = fakeCtx({ confirm: false });
		const cmd = f.commands.get("auto-continue")!;
		await cmd.handler("max 50", no.ctx);
		assert.equal(ac.state.max, 50, "below the ceiling needs no confirmation");
		await cmd.handler("max 500", no.ctx);
		assert.equal(ac.state.max, 50, "declined");
		await cmd.handler("max 500", yes.ctx);
		assert.equal(ac.state.max, 500);
	});

	it("persists state as a custom entry and rehydrates it on session_start", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx } = fakeCtx();
		await enable(f, ctx, "iterate");
		await f.commands.get("auto-continue")!.handler("max 7", ctx);
		await f.emit("agent_end", { messages: [assistant("x")] }, ctx);
		await tick();
		const last = f.entries.at(-1)!;
		assert.equal(last.customType, ENTRY_TYPE);
		assert.equal(last.data.count, 1);
		assert.equal(last.data.max, 7);

		// Fresh extension instance (what /reload or a restart does), same session branch.
		const g = fakePi();
		const ac2 = createAutoContinue(g.pi, FAST);
		const branch = f.entries.map((e) => ({ type: "custom", customType: e.customType, data: e.data }));
		const restored = fakeCtx({ branch });
		await g.emit("session_start", { reason: "resume" }, restored.ctx);
		assert.equal(ac2.state.enabled, true);
		assert.equal(ac2.state.text, "iterate");
		assert.equal(ac2.state.max, 7);
		assert.equal(ac2.state.count, 1);
		assert.match(restored.notices.at(-1)!.msg, /restored/);
		void ac;
	});

	it("starts clean on a session with no entry", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx } = fakeCtx({ branch: [{ type: "message" }] });
		await f.emit("session_start", { reason: "new" }, ctx);
		assert.equal(ac.state.enabled, false);
	});

	it("parses and formats intervals", () => {
		assert.equal(parseInterval("30s"), 30_000);
		assert.equal(parseInterval("5m"), 300_000);
		assert.equal(parseInterval("1h30m"), 5_400_000);
		assert.equal(parseInterval("90"), 90_000);
		assert.equal(parseInterval("off"), 0);
		assert.equal(parseInterval("5x"), undefined);
		assert.equal(parseInterval("5m check"), undefined);
		assert.equal(formatInterval(5_400_000), "1h30m");
		assert.equal(formatInterval(0), "off");
	});

	it("/loop sends the prompt now, then waits the interval (start to start) after each turn", async () => {
		const f = fakePi();
		const clock = { t: 1_000_000 };
		const ac = createAutoContinue(f.pi, { ...FAST, minIntervalMs: 0, now: () => clock.t });
		const { ctx, statuses } = fakeCtx();
		await f.commands.get("loop")!.handler("60s check the build", ctx);
		await tick();
		assert.deepEqual(f.sent, ["check the build"], "first send is immediate");
		assert.equal(ac.state.enabled, true);
		assert.equal(ac.state.intervalMs, 60_000);

		// Turn took 20s; the next send is due 40s later, not immediately.
		clock.t += 20_000;
		await f.emit("agent_end", { messages: [assistant("built ok")] }, ctx);
		await tick();
		assert.deepEqual(f.sent, ["check the build"], "waits for the interval");
		assert.equal(ac.hasPending(), true);
		assert.match(statuses.at(-1)!, /every 1m, next /);
		await f.commands.get("loop")!.handler("off", ctx);
	});

	it("sends right after the turn when the turn outran the interval", async () => {
		const f = fakePi();
		const clock = { t: 0 };
		createAutoContinue(f.pi, { ...FAST, minIntervalMs: 0, now: () => clock.t });
		const { ctx } = fakeCtx();
		await f.commands.get("loop")!.handler("10s go", ctx);
		await tick();
		clock.t += 15_000;
		await f.emit("agent_end", { messages: [assistant("x")] }, ctx);
		await tick();
		assert.deepEqual(f.sent, ["go", "go"]);
	});

	it("fires the interval send when the wait elapses", async () => {
		const f = fakePi();
		const clock = { t: 0 };
		createAutoContinue(f.pi, { ...FAST, minIntervalMs: 0, now: () => clock.t });
		const { ctx } = fakeCtx();
		await f.commands.get("loop")!.handler("1s go", ctx);
		await tick();
		clock.t += 980; // 20ms of the interval left
		await f.emit("agent_end", { messages: [assistant("x")] }, ctx);
		await tick(5);
		assert.equal(f.sent.length, 1);
		await tick(40);
		assert.equal(f.sent.length, 2);
	});

	it("a user turn during the wait does not stack sends; the loop re-times off the last auto send", async () => {
		const f = fakePi();
		const clock = { t: 0 };
		const ac = createAutoContinue(f.pi, { ...FAST, minIntervalMs: 0, now: () => clock.t });
		const { ctx } = fakeCtx();
		await f.commands.get("loop")!.handler("1m go", ctx);
		await tick();
		clock.t += 5_000;
		await f.emit("agent_end", { messages: [assistant("x")] }, ctx);
		assert.equal(ac.hasPending(), true);
		await f.emit("agent_start", {}, ctx); // user typed something
		assert.equal(ac.hasPending(), false);
		await f.emit("agent_end", { messages: [assistant("answered user")] }, ctx);
		assert.equal(ac.hasPending(), true);
		await tick();
		assert.deepEqual(f.sent, ["go"]);
		await f.commands.get("loop")!.handler("off", ctx);
	});

	it("rejects a bad or too-short interval and /loop off stops", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST); // default 10s minimum
		const { ctx, notices } = fakeCtx();
		const loop = f.commands.get("loop")!;
		await loop.handler("5s go", ctx);
		assert.equal(ac.state.enabled, false);
		assert.match(notices.at(-1)!.msg, /minimum 10s/);
		await loop.handler("soon go", ctx);
		assert.equal(ac.state.enabled, false);
		await loop.handler("5m", ctx);
		assert.match(notices.at(-1)!.msg, /Usage: \/loop/);
		await loop.handler("5m go", ctx);
		assert.equal(ac.state.enabled, true);
		await loop.handler("off", ctx);
		assert.equal(ac.state.enabled, false);
		assert.equal(ac.hasPending(), false);
	});

	it("/auto-continue every <interval> changes only the interval; every off is back-to-back", async () => {
		const f = fakePi();
		const ac = createAutoContinue(f.pi, FAST);
		const { ctx } = fakeCtx();
		const cmd = f.commands.get("auto-continue")!;
		await cmd.handler("every 15m", ctx);
		assert.equal(ac.state.intervalMs, 900_000);
		assert.equal(ac.state.enabled, false);
		assert.deepEqual(f.sent, []);
		await cmd.handler("every off", ctx);
		assert.equal(ac.state.intervalMs, 0);
	});

	it("persists the interval and restores old entries without one as back-to-back", async () => {
		const f = fakePi();
		createAutoContinue(f.pi, FAST);
		const { ctx } = fakeCtx();
		await f.commands.get("loop")!.handler("5m go", ctx);
		assert.equal(f.entries.at(-1)!.data.intervalMs, 300_000);

		const g = fakePi();
		const ac2 = createAutoContinue(g.pi, FAST);
		ac2.state.intervalMs = 123;
		const old = { enabled: true, text: "x", max: 10, count: 2, failures: 0, maxFailures: 3, contextThreshold: 90 };
		await g.emit("session_start", {}, fakeCtx({ branch: [{ type: "custom", customType: ENTRY_TYPE, data: old }] }).ctx);
		assert.equal(ac2.state.intervalMs, 0);
		assert.equal(ac2.state.count, 2);
	});

	it("offers subcommand completions", () => {
		const f = fakePi();
		createAutoContinue(f.pi, FAST);
		const cmd = f.commands.get("auto-continue")!;
		const all = cmd.getArgumentCompletions!("") as { value: string }[];
		assert.ok(all.length >= 8);
		const s = cmd.getArgumentCompletions!("se") as { value: string }[];
		assert.deepEqual(s.map((x) => x.value), ["set "]);
		assert.equal(cmd.getArgumentCompletions!("zzz"), null);
	});
});
