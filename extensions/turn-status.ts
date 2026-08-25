import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	DEFAULT_CONFIG,
	TURN_STATUS_ENTRY_TYPE,
	TURN_STATUS_SCHEMA_VERSION,
	TURN_STATUS_VISIBILITY_ENTRY_TYPE,
	addUsage,
	aggregateTurnUsage,
	createTurnStatusPayload,
	cumulativeUsageFromBranch,
	formatStatus,
	isTurnStatusEntryV1,
	parseCommand,
	parseConfig,
	visibilityFromBranch,
	type ToolError,
	type TurnStatusConfig,
} from "../src/turn-status-core.ts";

export interface TurnStatusDependencies {
	now(): number;
	readTextFile(path: string): Promise<string>;
}

const productionDependencies: TurnStatusDependencies = {
	now: Date.now,
	readTextFile: (path) => readFile(path, "utf8"),
};

function errorCode(error: unknown): string | undefined {
	return error !== null && typeof error === "object" && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function notifyWarning(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

function styleStatus(theme: Theme, hasError: boolean, value: string): string {
	const [firstLine = "", ...details] = value.split("\n");
	const separatorIndex = firstLine.indexOf(" │ ");
	if (separatorIndex < 0) return theme.fg(hasError ? "error" : "dim", value);

	const marker = firstLine.slice(0, separatorIndex);
	const metadata = firstLine.slice(separatorIndex);
	const styledFirstLine = theme.fg(hasError ? "error" : "accent", marker) + theme.fg("dim", metadata);
	return [styledFirstLine, ...details.map((line) => theme.fg("dim", line))].join("\n");
}

export function registerTurnStatus(
	pi: ExtensionAPI,
	dependencies: TurnStatusDependencies = productionDependencies,
): void {
	let projectDefault = DEFAULT_CONFIG.showByDefault;
	let visible = projectDefault;
	const startsByTurnIndex = new Map<number, number>();

	const reconstructVisibility = (ctx: ExtensionContext): void => {
		visible = visibilityFromBranch(ctx.sessionManager.getBranch(), projectDefault);
	};

	const loadProjectConfig = async (ctx: ExtensionContext): Promise<TurnStatusConfig> => {
		if (!ctx.isProjectTrusted()) return { ...DEFAULT_CONFIG };
		const configPath = join(ctx.cwd, CONFIG_DIR_NAME, "turn-status.json");
		let raw: string;
		try {
			raw = await dependencies.readTextFile(configPath);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") {
				notifyWarning(ctx, `Could not read ${configPath}; turn status remains hidden`);
			}
			return { ...DEFAULT_CONFIG };
		}

		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			notifyWarning(ctx, `Invalid JSON in ${configPath}; turn status remains hidden`);
			return { ...DEFAULT_CONFIG };
		}
		const parsed = parseConfig(value);
		if (parsed.warning) notifyWarning(ctx, `Invalid ${configPath}: ${parsed.warning}; turn status remains hidden`);
		return parsed.config;
	};

	pi.registerEntryRenderer(TURN_STATUS_ENTRY_TYPE, (entry, { expanded }, theme) => {
		if (!isTurnStatusEntryV1(entry.data) || !entry.data.visible) return undefined;
		const hasError = entry.data.outcome.stopReason === "error" ||
			entry.data.outcome.stopReason === "aborted" || entry.data.outcome.toolErrors.length > 0;
		return new Text(styleStatus(theme, hasError, formatStatus(entry.data, expanded)), 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		startsByTurnIndex.clear();
		projectDefault = (await loadProjectConfig(ctx)).showByDefault;
		reconstructVisibility(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		startsByTurnIndex.clear();
		reconstructVisibility(ctx);
	});

	pi.on("session_shutdown", () => {
		startsByTurnIndex.clear();
	});

	pi.on("turn_start", (event) => {
		startsByTurnIndex.set(event.turnIndex, event.timestamp);
	});

	pi.on("turn_end", (event, ctx) => {
		const endedAt = dependencies.now();
		const startedAt = startsByTurnIndex.get(event.turnIndex) ?? null;
		startsByTurnIndex.delete(event.turnIndex);
		const usage = aggregateTurnUsage(event.message, event.toolResults);
		const cumulativeUsage = addUsage(cumulativeUsageFromBranch(ctx.sessionManager.getBranch()), usage);
		const assistant = event.message.role === "assistant" ? event.message : undefined;
		const toolErrors: ToolError[] = event.toolResults
			.filter((result) => result.isError)
			.map((result) => ({ toolCallId: result.toolCallId, toolName: result.toolName }));

		pi.appendEntry(TURN_STATUS_ENTRY_TYPE, createTurnStatusPayload({
			visible,
			turnIndex: event.turnIndex,
			startedAt,
			endedAt,
			usage,
			cumulativeUsage,
			stopReason: assistant?.stopReason ?? null,
			errorMessage: assistant?.errorMessage ?? null,
			toolErrors,
		}));
	});

	pi.registerCommand("turn-status", {
		description: "Show, hide, or toggle per-turn status markers",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			return ["show", "hide"]
				.filter((value) => value.startsWith(normalized))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const command = parseCommand(args);
			if (command === "invalid") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /turn-status [show|hide]", "warning");
				return;
			}
			const nextVisible = command === "show" ? true : command === "hide" ? false : !visible;
			if (nextVisible !== visible) {
				visible = nextVisible;
				pi.appendEntry(TURN_STATUS_VISIBILITY_ENTRY_TYPE, {
					schemaVersion: TURN_STATUS_SCHEMA_VERSION,
					visible,
					changedAt: dependencies.now(),
				});
			}
			if (ctx.hasUI) ctx.ui.notify(`Turn status ${visible ? "shown" : "hidden"}`, "info");
		},
	});
}

export default function turnStatusExtension(pi: ExtensionAPI): void {
	registerTurnStatus(pi);
}
