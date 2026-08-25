import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	Theme,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	TURN_STATUS_ENTRY_TYPE,
	TURN_STATUS_VISIBILITY_ENTRY_TYPE,
	type TurnStatusEntryV1,
} from "../src/turn-status-core.ts";
import { registerTurnStatus, type TurnStatusDependencies } from "../extensions/turn-status.ts";

type EventName = "session_start" | "session_tree" | "session_shutdown" | "turn_start" | "turn_end";
type StatusEvent = SessionStartEvent | SessionTreeEvent | SessionShutdownEvent | TurnStartEvent | TurnEndEvent;
type AppendedEntry = { customType: string; data: unknown };

class TurnStatusHarness {
	readonly appended: AppendedEntry[] = [];
	readonly notifications: Array<{ message: string; level: string }> = [];
	readonly handlers = new Map<EventName, ExtensionHandler<StatusEvent>[]>();
	readonly renderers = new Map<string, EntryRenderer>();
	command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	readonly api: ExtensionAPI;

	constructor() {
		this.api = {
			on: ((event: EventName, handler: ExtensionHandler<StatusEvent>) => {
				const handlers = this.handlers.get(event) ?? [];
				handlers.push(handler);
				this.handlers.set(event, handlers);
			}) as ExtensionAPI["on"],
			registerEntryRenderer: ((type: string, renderer: EntryRenderer) => this.renderers.set(type, renderer)) as ExtensionAPI["registerEntryRenderer"],
			registerCommand: ((_name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
				this.command = command;
			}) as ExtensionAPI["registerCommand"],
			appendEntry: ((customType: string, data: unknown) => this.appended.push({ customType, data })) as ExtensionAPI["appendEntry"],
		} as ExtensionAPI;
	}

	context(options: { branch?: unknown[]; trusted?: boolean; hasUI?: boolean } = {}): ExtensionContext {
		const branch = options.branch ?? [];
		const hasUI = options.hasUI ?? true;
		return {
			cwd: "/synthetic/project",
			hasUI,
			mode: hasUI ? "tui" : "print",
			isProjectTrusted: () => options.trusted ?? true,
			sessionManager: { getBranch: () => branch },
			ui: { notify: (message: string, level: string) => this.notifications.push({ message, level }) },
		} as unknown as ExtensionContext;
	}

	async emit(event: StatusEvent, ctx = this.context()): Promise<void> {
		for (const handler of this.handlers.get(event.type as EventName) ?? []) await handler(event, ctx);
	}

	async runCommand(args: string, ctx = this.context()): Promise<void> {
		if (!this.command) throw new Error("turn-status command was not registered");
		await this.command.handler(args, ctx as ExtensionCommandContext);
	}
}

const dependencies = (now = 2_500, readTextFile: TurnStatusDependencies["readTextFile"] = async () => "{}") => ({
	now: () => now,
	readTextFile,
});

const assistant = (usage: object, stopReason = "stop", errorMessage: string | null = null) => ({
	role: "assistant",
	usage,
	stopReason,
	errorMessage,
});
const usage = { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, totalTokens: 30, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
const turnStart = (turnIndex: number, timestamp: number): TurnStartEvent => ({ type: "turn_start", turnIndex, timestamp });
const turnEnd = (turnIndex: number, message = assistant(usage), toolResults: unknown[] = []): TurnEndEvent =>
	({ type: "turn_end", turnIndex, message, toolResults } as unknown as TurnEndEvent);
const statusEntries = (harness: TurnStatusHarness): TurnStatusEntryV1[] => harness.appended
	.filter((entry) => entry.customType === TURN_STATUS_ENTRY_TYPE)
	.map((entry) => entry.data as TurnStatusEntryV1);
const custom = (customType: string, data: unknown) => ({ type: "custom", customType, data });

describe("turn-status adapter", () => {
	it("registers only lifecycle, renderer, and command APIs", () => {
		const harness = new TurnStatusHarness();
		registerTurnStatus(harness.api, dependencies());

		expect([...harness.handlers.keys()].sort()).toEqual(["session_shutdown", "session_start", "session_tree", "turn_end", "turn_start"]);
		expect(harness.renderers.has(TURN_STATUS_ENTRY_TYPE)).toBe(true);
		expect(harness.command?.description).toContain("toggle");
		expect(harness.command?.getArgumentCompletions?.(" S ")).toEqual([{ value: "show", label: "show" }]);
		expect(harness.command?.getArgumentCompletions?.("x")).toEqual([]);
		expect(harness.appended).toEqual([]);
		// The deliberately minimal API/context expose neither model-context nor footer methods.
		expect("sendMessage" in harness.api).toBe(false);
		expect("setFooter" in harness.context().ui).toBe(false);
	});

	it("appends a hidden marker without UI and records timing, usage, cumulative usage, and errors", async () => {
		const harness = new TurnStatusHarness();
		registerTurnStatus(harness.api, dependencies(2_500));
		const context = harness.context({ hasUI: false });
		await harness.emit(turnStart(4, 1_000), context);
		await harness.emit(turnEnd(4, assistant(usage, "error", "  provider\n failed "), [
			{ role: "toolResult", usage: { ...usage, input: 2, totalTokens: 5 }, isError: true, toolCallId: "call-1", toolName: "lookup" },
			{ role: "toolResult", isError: false, toolCallId: "call-2", toolName: "ok" },
		]), context);

		expect(statusEntries(harness)).toEqual([expect.objectContaining({
			visible: false, turnIndex: 4, startedAt: 1_000, endedAt: 2_500, elapsedMs: 1_500,
			usage: expect.objectContaining({ input: 12, output: 40, totalTokens: 35 }),
			cumulativeUsage: expect.objectContaining({ input: 12, output: 40, totalTokens: 35 }),
			outcome: { stopReason: "error", errorMessage: "provider failed", toolErrors: [{ toolCallId: "call-1", toolName: "lookup" }] },
		})]);
		expect(harness.notifications).toEqual([]);
	});

	it("loads trusted config, ignores untrusted config, and warns for missing or invalid trusted config", async () => {
		const trusted = new TurnStatusHarness();
		let requestedPath = "";
		registerTurnStatus(trusted.api, dependencies(1, async (path) => { requestedPath = path; return '{"showByDefault":true}'; }));
		await trusted.emit({ type: "session_start", reason: "startup" }, trusted.context());
		await trusted.emit(turnEnd(0), trusted.context());
		expect(requestedPath).toBe("/synthetic/project/.pi/turn-status.json");
		expect(statusEntries(trusted)[0]?.visible).toBe(true);

		const untrusted = new TurnStatusHarness();
		registerTurnStatus(untrusted.api, dependencies(1, async () => { throw new Error("must not read"); }));
		await untrusted.emit({ type: "session_start", reason: "startup" }, untrusted.context({ trusted: false }));
		await untrusted.emit(turnEnd(0), untrusted.context({ trusted: false }));
		expect(statusEntries(untrusted)[0]?.visible).toBe(false);

		for (const [readTextFile, warning] of [
			[async () => { const error = Object.assign(new Error("missing"), { code: "ENOENT" }); throw error; }, undefined],
			[async () => "{bad json", "Invalid JSON"],
			[async () => '{"showByDefault":"yes"}', "showByDefault must be a boolean"],
		] as const) {
			const harness = new TurnStatusHarness();
			registerTurnStatus(harness.api, dependencies(1, readTextFile));
			await harness.emit({ type: "session_start", reason: "startup" }, harness.context());
			await harness.emit(turnEnd(0), harness.context());
			expect(statusEntries(harness)[0]?.visible).toBe(false);
			if (warning === undefined) expect(harness.notifications).toEqual([]);
			else expect(harness.notifications).toEqual([expect.objectContaining({ message: expect.stringContaining(warning), level: "warning" })]);
		}
		expect(trusted.notifications).toEqual([]);
	});

	it("renders nothing for hidden or invalid data and renders collapsed and expanded visible markers", async () => {
		const harness = new TurnStatusHarness();
		registerTurnStatus(harness.api, dependencies());
		await harness.emit(turnEnd(0));
		const renderer = harness.renderers.get(TURN_STATUS_ENTRY_TYPE);
		if (!renderer) throw new Error("renderer was not registered");
		const theme = { fg: (_color: string, text: string) => text } as Theme;
		const entry = { type: "custom", customType: TURN_STATUS_ENTRY_TYPE, data: statusEntries(harness)[0] } as Parameters<typeof renderer>[0];
		expect(renderer(entry, { expanded: false }, theme)).toBeUndefined();
		expect(renderer({ ...entry, data: { nope: true } }, { expanded: false }, theme)).toBeUndefined();
		const visibleEntry = { ...entry, data: { ...statusEntries(harness)[0]!, visible: true } };
		const collapsed = renderer(visibleEntry, { expanded: false }, theme);
		const expanded = renderer(visibleEntry, { expanded: true }, theme);
		expect(collapsed).toBeInstanceOf(Text);
		expect((collapsed as Text).render(300).join("\n")).toContain("turn 1");
		expect((expanded as Text).render(300).join("\n")).toContain("cost turn");
	});

	it("handles show/hide/toggle/invalid and records only actual visibility changes", async () => {
		const harness = new TurnStatusHarness();
		registerTurnStatus(harness.api, dependencies(99));
		await harness.runCommand("show");
		await harness.runCommand(" SHOW ");
		await harness.runCommand("");
		await harness.runCommand("hide");
		await harness.runCommand("wat");
		await harness.runCommand("show", harness.context({ hasUI: false }));

		expect(harness.appended).toEqual([
			{ customType: TURN_STATUS_VISIBILITY_ENTRY_TYPE, data: { schemaVersion: 1, visible: true, changedAt: 99 } },
			{ customType: TURN_STATUS_VISIBILITY_ENTRY_TYPE, data: { schemaVersion: 1, visible: false, changedAt: 99 } },
			{ customType: TURN_STATUS_VISIBILITY_ENTRY_TYPE, data: { schemaVersion: 1, visible: true, changedAt: 99 } },
		]);
		expect(harness.notifications).toEqual([
			{ message: "Turn status shown", level: "info" }, { message: "Turn status shown", level: "info" },
			{ message: "Turn status hidden", level: "info" }, { message: "Turn status hidden", level: "info" },
			{ message: "Usage: /turn-status [show|hide]", level: "warning" },
		]);
	});

	it("reconstructs visibility and cumulative usage on start/tree and clears unfinished starts on shutdown", async () => {
		const harness = new TurnStatusHarness();
		registerTurnStatus(harness.api, dependencies(500));
		const prior = custom(TURN_STATUS_ENTRY_TYPE, {
			schemaVersion: 1, visible: true, turnIndex: 0, startedAt: 1, endedAt: 2, elapsedMs: 1, usage,
			cumulativeUsage: usage, outcome: { stopReason: "stop", errorMessage: null, toolErrors: [] },
		});
		const branch = [prior, custom(TURN_STATUS_VISIBILITY_ENTRY_TYPE, { schemaVersion: 1, visible: true, changedAt: 3 })];
		const context = harness.context({ branch });
		await harness.emit({ type: "session_start", reason: "resume" }, context);
		await harness.emit(turnEnd(1), context);
		await harness.emit({ type: "session_tree", newLeafId: "new", oldLeafId: "old" }, harness.context({ branch: [prior] }));
		await harness.emit(turnEnd(2), harness.context({ branch: [prior] }));
		await harness.emit(turnStart(3, 100), context);
		await harness.emit({ type: "session_shutdown", reason: "reload" }, context);
		await harness.emit(turnEnd(3), context);

		const entries = statusEntries(harness);
		expect(entries.map((entry) => [entry.visible, entry.cumulativeUsage.input, entry.startedAt])).toEqual([
			[true, 20, null], [false, 20, null], [false, 20, null],
		]);
	});
});
