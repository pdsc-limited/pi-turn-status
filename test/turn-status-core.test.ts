import { describe, expect, it } from "vitest";

import {
	DEFAULT_CONFIG,
	TURN_STATUS_ENTRY_TYPE,
	TURN_STATUS_VISIBILITY_ENTRY_TYPE,
	addUsage,
	aggregateTurnUsage,
	createTurnStatusPayload,
	cumulativeUsageFromBranch,
	formatDuration,
	formatMoney,
	formatStatus,
	formatTokenCount,
	formatTimestampUtc,
	isTurnStatusEntryV1,
	isVisibilityEntryV1,
	normalizeUsage,
	parseCommand,
	parseConfig,
	visibilityFromBranch,
	zeroUsage,
	type ToolError,
	type TurnStatusEntryV1,
	type UsageTotals,
} from "../src/turn-status-core.ts";

const usage = (overrides: Partial<Omit<UsageTotals, "cost">> & { cost?: Partial<UsageTotals["cost"]> } = {}): UsageTotals => {
	const { cost: costOverrides, ...fields } = overrides;
	return {
		input: 10,
		output: 20,
		cacheRead: 30,
		cacheWrite: 40,
		totalTokens: 100,
		...fields,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1, ...costOverrides },
	};
};

const status = (overrides: Partial<TurnStatusEntryV1> = {}): TurnStatusEntryV1 => ({
	...createTurnStatusPayload({
		visible: true,
		turnIndex: 0,
		startedAt: 1_000,
		endedAt: 2_500,
		usage: usage(),
		cumulativeUsage: usage(),
		stopReason: "stop",
		errorMessage: null,
		toolErrors: [],
	}),
	...overrides,
});

const custom = (customType: string, data: unknown): unknown => ({ type: "custom", customType, data });

describe("usage accounting", () => {
	it("normalizes every usage field and rejects absent, invalid, and nested malformed values", () => {
		expect(normalizeUsage(undefined)).toEqual(zeroUsage());
		expect(normalizeUsage({
			input: 1.5, output: -1, cacheRead: Number.NaN, cacheWrite: Infinity, totalTokens: 9,
			cost: { input: 0.01, output: "2", cacheRead: null, cacheWrite: -0.1, total: 3 },
		})).toEqual({
			input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 9,
			cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
		});
	});

	it("adds all token and nested cost fields without mutating either operand", () => {
		const left = usage();
		const right = usage({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14,
			cost: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 } });
		expect(addUsage(left, right)).toEqual(usage({ input: 12, output: 23, cacheRead: 34, cacheWrite: 45, totalTokens: 114,
			cost: { input: 2.1, output: 3.2, cacheRead: 4.3, cacheWrite: 5.4, total: 15 } }));
		expect(left).toEqual(usage());
		expect(right.cost.total).toBe(14);
		expect(normalizeUsage({ input: Number.MAX_VALUE }).input).toBe(Number.MAX_SAFE_INTEGER);
		expect(addUsage(
			normalizeUsage({ input: Number.MAX_SAFE_INTEGER }),
			normalizeUsage({ input: Number.MAX_SAFE_INTEGER }),
		).input).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("aggregates only assistant and toolResult records, including each nested tool usage", () => {
		const result = aggregateTurnUsage(
			{ role: "assistant", usage: usage({ totalTokens: 101 }) },
			[
				{ role: "toolResult", usage: usage({ input: 1, totalTokens: 2, cost: { total: 0.5 } }) },
				{ role: "toolResult", usage: { output: 7, totalTokens: 7, cost: { output: 0.25, total: 0.25 } } },
				{ role: "user", usage: usage({ totalTokens: 9 }) },
				{ role: "toolResult", usage: "bad" }, null,
			],
		);
		expect(result).toEqual({
			input: 11, output: 47, cacheRead: 60, cacheWrite: 80, totalTokens: 110,
			cost: { input: 0.2, output: 0.65, cacheRead: 0.6, cacheWrite: 0.8, total: 1.75 },
		});
	});
});

describe("durable-entry guards and branch reconstruction", () => {
	it("accepts complete status and visibility entries and rejects invalid scalar fields", () => {
		const entry = status();
		expect(isTurnStatusEntryV1(entry)).toBe(true);
		expect(isTurnStatusEntryV1({ ...entry, turnIndex: 1.5 })).toBe(false);
		expect(isTurnStatusEntryV1({ ...entry, turnIndex: -1 })).toBe(false);
		expect(isTurnStatusEntryV1({ ...entry, endedAt: Number.MAX_VALUE })).toBe(false);
		expect(isTurnStatusEntryV1({ ...entry, elapsedMs: -1 })).toBe(false);
		expect(isTurnStatusEntryV1({ ...entry, usage: { ...entry.usage, input: -1 } })).toBe(false);
		expect(isTurnStatusEntryV1({ ...entry, outcome: { ...entry.outcome, stopReason: 7 } })).toBe(false);
		expect(isVisibilityEntryV1({ schemaVersion: 1, visible: false, changedAt: 10 })).toBe(true);
		expect(isVisibilityEntryV1({ schemaVersion: 1, visible: "false", changedAt: 10 })).toBe(false);
	});

	it("rejects malformed tool errors so a guarded entry is safe for formatting", () => {
		const entry = status() as unknown as { outcome: { toolErrors: unknown[] } };
		entry.outcome.toolErrors = [null, { toolCallId: 7, toolName: "bash" }];
		expect(isTurnStatusEntryV1(entry)).toBe(false);
	});

	it("sums every valid status marker on the active branch regardless of visibility or turn index", () => {
		const first = status({ visible: false, turnIndex: 0, usage: usage({ totalTokens: 5, cost: { total: 0.5 } }) });
		const future = status({ turnIndex: 99, usage: usage({ input: 2, totalTokens: 7, cost: { input: 0.2, total: 0.7 } }) });
		const malformed = { ...status(), usage: { ...usage(), totalTokens: -1 } };
		expect(cumulativeUsageFromBranch([
			custom(TURN_STATUS_ENTRY_TYPE, first),
			custom(TURN_STATUS_ENTRY_TYPE, malformed),
			custom(TURN_STATUS_ENTRY_TYPE, future),
			custom("other", status()), { type: "message", data: first },
		])).toEqual(addUsage(first.usage, future.usage));
	});

	it("reconstructs visibility from the latest valid active-branch marker", () => {
		expect(visibilityFromBranch([
			custom(TURN_STATUS_VISIBILITY_ENTRY_TYPE, { schemaVersion: 1, visible: true, changedAt: 1 }),
			custom(TURN_STATUS_VISIBILITY_ENTRY_TYPE, { schemaVersion: 1, visible: "no", changedAt: 2 }),
			custom("other", { schemaVersion: 1, visible: false, changedAt: 3 }),
			custom(TURN_STATUS_VISIBILITY_ENTRY_TYPE, { schemaVersion: 1, visible: false, changedAt: 4 }),
		], false)).toBe(false);
		expect(visibilityFromBranch([custom(TURN_STATUS_VISIBILITY_ENTRY_TYPE, { visible: true })], true)).toBe(true);
	});
});

describe("configuration, commands, and payload normalization", () => {
	it("parses exact configuration shape without leaking the frozen default", () => {
		expect(parseConfig({})).toEqual({ config: { showByDefault: false } });
		expect(parseConfig({ showByDefault: true })).toEqual({ config: { showByDefault: true } });
		expect(parseConfig(null)).toEqual({ config: { ...DEFAULT_CONFIG }, warning: "Expected only a boolean showByDefault setting" });
		expect(parseConfig({ showByDefault: "true" })).toEqual({ config: { ...DEFAULT_CONFIG }, warning: "showByDefault must be a boolean" });
		expect(parseConfig({ showByDefault: false, extra: true }).warning).toBe("Expected only a boolean showByDefault setting");
	});

	it("parses whitespace and case-insensitive commands", () => {
		expect(parseCommand(" ")).toBe("toggle");
		expect(parseCommand(" SHOW ")).toBe("show");
		expect(parseCommand("hide")).toBe("hide");
		expect(parseCommand("show now")).toBe("invalid");
	});

	it("normalizes elapsed time, usage, whitespace-only errors, and copies tool errors", () => {
		const toolErrors: ToolError[] = [{ toolCallId: "call-1", toolName: "bash" }];
		const payload = createTurnStatusPayload({
			visible: false, turnIndex: 4, startedAt: 100, endedAt: 50,
			usage: { ...usage(), input: -1 }, cumulativeUsage: usage(), stopReason: null,
			errorMessage: "  provider\n  failed  ", toolErrors,
		});
		expect(payload.elapsedMs).toBe(0);
		expect(payload.usage.input).toBe(0);
		expect(payload.outcome).toEqual({ stopReason: null, errorMessage: "provider failed", toolErrors });
		expect(payload.outcome.toolErrors).not.toBe(toolErrors);
		const sanitized = createTurnStatusPayload({
			visible: true, turnIndex: 0, startedAt: 0, endedAt: 1,
			usage: zeroUsage(), cumulativeUsage: zeroUsage(), stopReason: "err\u001b[31mor",
			errorMessage: `secret\u001b]0;title\u0007\n${"x".repeat(2_100)}`,
			toolErrors: [{ toolCallId: "id\u0000bad", toolName: "\u001b[31mbash\u001b[0m" }],
		});
		expect(sanitized.outcome.stopReason).toBe("err or");
		expect(sanitized.outcome.errorMessage).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		expect(sanitized.outcome.errorMessage?.length).toBe(2_000);
		expect(sanitized.outcome.toolErrors).toEqual([{ toolCallId: "id bad", toolName: "bash" }]);
		expect(createTurnStatusPayload({
			visible: payload.visible, turnIndex: payload.turnIndex, startedAt: null, endedAt: payload.endedAt,
			usage: payload.usage, cumulativeUsage: payload.cumulativeUsage,
			stopReason: payload.outcome.stopReason, errorMessage: payload.outcome.errorMessage,
			toolErrors: payload.outcome.toolErrors,
		}).elapsedMs).toBeNull();
		expect(createTurnStatusPayload({
			visible: true, turnIndex: 0, startedAt: Number.NaN, endedAt: Number.MAX_VALUE,
			usage: zeroUsage(), cumulativeUsage: zeroUsage(), stopReason: null, errorMessage: null, toolErrors: [],
		})).toEqual(expect.objectContaining({ startedAt: null, endedAt: 0, elapsedMs: null }));
	});
});

describe("stable formatting", () => {
	it("formats timestamp, duration, token, and money boundaries deterministically", () => {
		expect(formatTimestampUtc(0)).toBe("1970-01-01 00:00:00.000Z");
		expect(formatTimestampUtc(Number.MAX_VALUE)).toBe("?");
		expect([formatDuration(null), formatDuration(999.5), formatDuration(1_000), formatDuration(59_999), formatDuration(60_000)])
		.toEqual(["?", "1000ms", "1.000s", "59.999s", "1m0.0s"]);
		expect([formatTokenCount(999.5), formatTokenCount(1_000), formatTokenCount(9_999), formatTokenCount(10_000), formatTokenCount(1_000_000), formatTokenCount(10_000_000)])
		.toEqual(["1000", "1.0k", "10.0k", "10k", "1.0m", "10m"]);
		expect([formatMoney(0.0099), formatMoney(0.01)]).toEqual(["$0.0099", "$0.01"]);
	});

	it("renders normal, error, and expanded statuses with stable line structure", () => {
		const normal = status();
		expect(formatStatus(normal, false)).toBe(
			"╰─ turn 1 │ 1970-01-01 00:00:01.000Z → 1970-01-01 00:00:02.500Z │ 1.500s │ turn in 10 out 20 cr 30 cw 40 total 100 │ Σ in 10 out 20 cr 30 cw 40 total 100 │ stop=stop",
		);
		const error = status({ startedAt: null, elapsedMs: null, outcome: { stopReason: "error", errorMessage: "x".repeat(161), toolErrors: [{ toolCallId: "c1", toolName: "bash" }] } });
		const expanded = formatStatus(error, true).split("\n");
		expect(expanded).toHaveLength(3);
		expect(expanded[0]).toContain("╰─ turn 1 │ ? → 1970-01-01 00:00:02.500Z │ ?");
		expect(expanded[0]).toContain(`error=${"x".repeat(159)}… │ tool-errors=1`);
		expect(expanded[1]).toBe("   cost turn $1.00 │ cumulative $1.00");
		expect(expanded[2]).toBe("   failed tools: bash (c1)");

		const historical = status({ outcome: {
			stopReason: "err\u001b[31mor",
			errorMessage: `bad\u001b]0;title\u0007 ${"x".repeat(3_000)}`,
			toolErrors: [{ toolCallId: "id\u0000bad", toolName: "\u001b[31mbash\u001b[0m" }],
		} });
		const rendered = formatStatus(historical, true);
		expect(rendered).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
		expect(rendered).toContain("stop=err or");
		expect(rendered).toContain("failed tools: bash (id bad)");
	});
});
