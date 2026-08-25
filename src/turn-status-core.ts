export const TURN_STATUS_ENTRY_TYPE = "turn-status";
export const TURN_STATUS_VISIBILITY_ENTRY_TYPE = "turn-status.visibility";
export const TURN_STATUS_SCHEMA_VERSION = 1 as const;

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface ToolError {
	toolCallId: string;
	toolName: string;
}

export interface TurnStatusEntryV1 {
	schemaVersion: 1;
	visible: boolean;
	turnIndex: number;
	startedAt: number | null;
	endedAt: number;
	elapsedMs: number | null;
	usage: UsageTotals;
	cumulativeUsage: UsageTotals;
	outcome: {
		stopReason: string | null;
		errorMessage: string | null;
		toolErrors: ToolError[];
	};
}

export interface TurnStatusVisibilityEntryV1 {
	schemaVersion: 1;
	visible: boolean;
	changedAt: number;
}

export interface TurnStatusConfig {
	showByDefault: boolean;
}

export const DEFAULT_CONFIG: Readonly<TurnStatusConfig> = Object.freeze({ showByDefault: false });

interface CustomEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

const safeNumber = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(value, Number.MAX_SAFE_INTEGER)
		: 0;

const isValidTimestamp = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15;

const ANSI_ESCAPE_PATTERN = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/g;
const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_IDENTIFIER_LENGTH = 200;

function sanitizeText(value: string, maxLength: number): string {
	const sanitized = value
		.replace(ANSI_ESCAPE_PATTERN, " ")
		.replace(CONTROL_CHARACTER_PATTERN, " ")
		.replace(/\s+/g, " ")
		.trim();
	return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength - 1)}…` : sanitized;
}

export function zeroUsage(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function normalizeUsage(value: unknown): UsageTotals {
	const usage = asRecord(value);
	const cost = asRecord(usage?.cost);
	return {
		input: safeNumber(usage?.input),
		output: safeNumber(usage?.output),
		cacheRead: safeNumber(usage?.cacheRead),
		cacheWrite: safeNumber(usage?.cacheWrite),
		totalTokens: safeNumber(usage?.totalTokens),
		cost: {
			input: safeNumber(cost?.input),
			output: safeNumber(cost?.output),
			cacheRead: safeNumber(cost?.cacheRead),
			cacheWrite: safeNumber(cost?.cacheWrite),
			total: safeNumber(cost?.total),
		},
	};
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
	const add = (left: number, right: number): number => Math.min(left + right, Number.MAX_SAFE_INTEGER);
	return {
		input: add(a.input, b.input),
		output: add(a.output, b.output),
		cacheRead: add(a.cacheRead, b.cacheRead),
		cacheWrite: add(a.cacheWrite, b.cacheWrite),
		totalTokens: add(a.totalTokens, b.totalTokens),
		cost: {
			input: add(a.cost.input, b.cost.input),
			output: add(a.cost.output, b.cost.output),
			cacheRead: add(a.cost.cacheRead, b.cost.cacheRead),
			cacheWrite: add(a.cost.cacheWrite, b.cost.cacheWrite),
			total: add(a.cost.total, b.cost.total),
		},
	};
}

export function aggregateTurnUsage(message: unknown, toolResults: readonly unknown[]): UsageTotals {
	let result = zeroUsage();
	const assistant = asRecord(message);
	if (assistant?.role === "assistant") result = addUsage(result, normalizeUsage(assistant.usage));
	for (const toolResult of toolResults) {
		const resultRecord = asRecord(toolResult);
		if (resultRecord?.role === "toolResult") result = addUsage(result, normalizeUsage(resultRecord.usage));
	}
	return result;
}

function isUsageTotals(value: unknown): value is UsageTotals {
	const usage = asRecord(value);
	const cost = asRecord(usage?.cost);
	return Boolean(
		usage && cost &&
		[usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens,
			cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total].every(
				(number) => typeof number === "number" && Number.isFinite(number) && number >= 0,
			),
	);
}

export function isTurnStatusEntryV1(value: unknown): value is TurnStatusEntryV1 {
	const entry = asRecord(value);
	const outcome = asRecord(entry?.outcome);
	return Boolean(
		entry?.schemaVersion === 1 && typeof entry.visible === "boolean" &&
		typeof entry.turnIndex === "number" && Number.isInteger(entry.turnIndex) && entry.turnIndex >= 0 &&
		(entry.startedAt === null || isValidTimestamp(entry.startedAt)) &&
		isValidTimestamp(entry.endedAt) &&
		(entry.elapsedMs === null || (typeof entry.elapsedMs === "number" && Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0)) &&
		isUsageTotals(entry.usage) && isUsageTotals(entry.cumulativeUsage) && outcome &&
		(outcome.stopReason === null || typeof outcome.stopReason === "string") &&
		(outcome.errorMessage === null || typeof outcome.errorMessage === "string") &&
		Array.isArray(outcome.toolErrors) && outcome.toolErrors.every((error) => {
			const toolError = asRecord(error);
			return typeof toolError?.toolCallId === "string" && typeof toolError.toolName === "string";
		}),
	);
}

export function isVisibilityEntryV1(value: unknown): value is TurnStatusVisibilityEntryV1 {
	const entry = asRecord(value);
	return Boolean(
		entry?.schemaVersion === 1 && typeof entry.visible === "boolean" &&
		typeof entry.changedAt === "number" && Number.isFinite(entry.changedAt),
	);
}

function customEntry(entry: unknown, customType: string): unknown {
	const candidate = entry as CustomEntryLike;
	return candidate?.type === "custom" && candidate.customType === customType ? candidate.data : undefined;
}

export function cumulativeUsageFromBranch(entries: readonly unknown[]): UsageTotals {
	let cumulative = zeroUsage();
	for (const entry of entries) {
		const data = customEntry(entry, TURN_STATUS_ENTRY_TYPE);
		if (isTurnStatusEntryV1(data)) cumulative = addUsage(cumulative, data.usage);
	}
	return cumulative;
}

export function visibilityFromBranch(entries: readonly unknown[], defaultVisible: boolean): boolean {
	let visible = defaultVisible;
	for (const entry of entries) {
		const data = customEntry(entry, TURN_STATUS_VISIBILITY_ENTRY_TYPE);
		if (isVisibilityEntryV1(data)) visible = data.visible;
	}
	return visible;
}

export type ConfigParseResult = { config: TurnStatusConfig; warning?: string };

export function parseConfig(value: unknown): ConfigParseResult {
	const record = asRecord(value);
	if (!record || Object.keys(record).some((key) => key !== "showByDefault")) {
		return { config: { ...DEFAULT_CONFIG }, warning: "Expected only a boolean showByDefault setting" };
	}
	if (record.showByDefault === undefined) return { config: { ...DEFAULT_CONFIG } };
	if (typeof record.showByDefault !== "boolean") {
		return { config: { ...DEFAULT_CONFIG }, warning: "showByDefault must be a boolean" };
	}
	return { config: { showByDefault: record.showByDefault } };
}

export type TurnStatusCommand = "show" | "hide" | "toggle" | "invalid";

export function parseCommand(args: string): TurnStatusCommand {
	const normalized = args.trim().toLowerCase();
	if (normalized === "") return "toggle";
	if (normalized === "show" || normalized === "hide") return normalized;
	return "invalid";
}

export interface CreatePayloadInput {
	visible: boolean;
	turnIndex: number;
	startedAt: number | null;
	endedAt: number;
	usage: UsageTotals;
	cumulativeUsage: UsageTotals;
	stopReason: string | null;
	errorMessage: string | null;
	toolErrors: ToolError[];
}

export function createTurnStatusPayload(input: CreatePayloadInput): TurnStatusEntryV1 {
	const startedAt = input.startedAt !== null && isValidTimestamp(input.startedAt) ? input.startedAt : null;
	const endedAt = isValidTimestamp(input.endedAt) ? input.endedAt : 0;
	return {
		schemaVersion: 1,
		visible: input.visible,
		turnIndex: input.turnIndex,
		startedAt,
		endedAt,
		elapsedMs: startedAt === null ? null : Math.max(0, endedAt - startedAt),
		usage: normalizeUsage(input.usage),
		cumulativeUsage: normalizeUsage(input.cumulativeUsage),
		outcome: {
			stopReason: input.stopReason === null ? null : sanitizeText(input.stopReason, MAX_IDENTIFIER_LENGTH),
			errorMessage: input.errorMessage === null ? null : sanitizeText(input.errorMessage, MAX_ERROR_MESSAGE_LENGTH),
			toolErrors: input.toolErrors.map(({ toolCallId, toolName }) => ({
				toolCallId: sanitizeText(toolCallId, MAX_IDENTIFIER_LENGTH),
				toolName: sanitizeText(toolName, MAX_IDENTIFIER_LENGTH),
			})),
		},
	};
}

export function formatTimestampUtc(timestamp: number): string {
	if (!isValidTimestamp(timestamp)) return "?";
	return new Date(timestamp).toISOString().replace("T", " ");
}

export function formatDuration(milliseconds: number | null): string {
	if (milliseconds === null) return "?";
	if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(3)}s`;
	const minutes = Math.floor(milliseconds / 60_000);
	const seconds = ((milliseconds % 60_000) / 1000).toFixed(1);
	return `${minutes}m${seconds}s`;
}

export function formatTokenCount(value: number): string {
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}

export function formatMoney(value: number): string {
	return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function usageText(prefix: string, usage: UsageTotals): string {
	return `${prefix} in ${formatTokenCount(usage.input)} out ${formatTokenCount(usage.output)} ` +
		`cr ${formatTokenCount(usage.cacheRead)} cw ${formatTokenCount(usage.cacheWrite)} ` +
		`total ${formatTokenCount(usage.totalTokens)}`;
}

export function formatStatus(entry: TurnStatusEntryV1, expanded: boolean): string {
	const start = entry.startedAt === null ? "?" : formatTimestampUtc(entry.startedAt);
	const end = formatTimestampUtc(entry.endedAt);
	const stopReason = entry.outcome.stopReason === null
		? "unknown"
		: sanitizeText(entry.outcome.stopReason, MAX_IDENTIFIER_LENGTH);
	const errorMessage = entry.outcome.errorMessage === null
		? null
		: sanitizeText(entry.outcome.errorMessage, MAX_ERROR_MESSAGE_LENGTH);
	const lines = [
		`╰─ turn ${entry.turnIndex + 1} │ ${start} → ${end} │ ${formatDuration(entry.elapsedMs)} │ ` +
		`${usageText("turn", entry.usage)} │ ${usageText("Σ", entry.cumulativeUsage)} │ ` +
		`stop=${stopReason}`,
	];
	if (errorMessage) {
		const error = errorMessage.length > 160
			? `${errorMessage.slice(0, 159)}…`
			: errorMessage;
		lines[0] += ` │ error=${error}`;
	}
	if (entry.outcome.toolErrors.length > 0) lines[0] += ` │ tool-errors=${entry.outcome.toolErrors.length}`;
	if (expanded) {
		lines.push(
			`   cost turn ${formatMoney(entry.usage.cost.total)} │ cumulative ${formatMoney(entry.cumulativeUsage.cost.total)}`,
		);
		if (entry.outcome.toolErrors.length > 0) {
			const displayed = entry.outcome.toolErrors.slice(0, 10);
			const omitted = entry.outcome.toolErrors.length - displayed.length;
			lines.push(`   failed tools: ${displayed.map((error) =>
				`${sanitizeText(error.toolName, MAX_IDENTIFIER_LENGTH)} (${sanitizeText(error.toolCallId, MAX_IDENTIFIER_LENGTH)})`).join(", ")}` +
				(omitted > 0 ? `, … ${omitted} more` : ""));
		}
	}
	return lines.join("\n");
}
