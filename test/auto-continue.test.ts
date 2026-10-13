import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAutoContinue, DONE_SENTINEL, ENTRY_TYPE } from "../src/index.ts";

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

	it("offers subcommand completions", () => {
		const f = fakePi();
		createAutoContinue(f.pi, FAST);
		const cmd = f.commands.get("auto-continue")!;
		const all = cmd.getArgumentCompletions!("") as { value: string }[];
		assert.ok(all.length >= 7);
		const s = cmd.getArgumentCompletions!("se") as { value: string }[];
		assert.deepEqual(s.map((x) => x.value), ["set "]);
		assert.equal(cmd.getArgumentCompletions!("zzz"), null);
	});
});
