import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { LiveFlowItem, LiveWorkerSnapshot, LiveWorkerState, LiveWorkerStatus } from "./types.js";
import { MAX_PARTIAL_RESULT_CHARS } from "./constants.js";
import { truncateText } from "./util.js";
import { compactPreview, sanitizeTuiText } from "./sanitize.js";
import { assistantStreams, briefToolCall, collectAssistantStreams, formatLiveCount, padLiveColumn } from "./session.js";

export class WorkflowLiveProgress {
	private readonly states = new Map<string, LiveWorkerState>();
	private readonly widgetId = "pi-three-lane-workflow-live";
	private readonly ticker?: ReturnType<typeof setInterval>;
	private phase = "starting";
	private readonly startedAt = Date.now();

	constructor(private readonly ctx: any, private readonly runId: string) {
		if (ctx.mode === "tui") {
			this.render();
			this.ticker = setInterval(() => this.render(), 300);
		}
	}

	setPhase(phase: string): void {
		this.phase = phase;
		this.render();
	}

	start(model: string, phase: string): void {
		this.states.set(model, {
			model,
			phase,
			status: "working",
			startedAt: Date.now(),
			flow: [],
			toolCalls: 0,
			tokensIn: 0,
			tokensOut: 0,
			costUsd: 0,
		});
		this.render();
	}

	private pushFlow(state: LiveWorkerState, item: LiveFlowItem): void {
		if (!item.text.trim()) return;
		// Keep enough text for Disler-style wrapped column rendering; hard-cap only for memory.
		const maxChars = item.kind === "tool" ? 260 : 1200;
		state.flow.push({ ...item, text: compactPreview(item.text, maxChars) });
		if (state.flow.length > 32) state.flow.splice(0, state.flow.length - 32);
	}

	private recordUsage(state: LiveWorkerState, message: any): void {
		const usage = message?.usage;
		if (!usage) return;
		const input = Number(usage.input) || 0;
		const cacheRead = Number(usage.cacheRead) || 0;
		const cacheWrite = Number(usage.cacheWrite) || 0;
		const output = Number(usage.output) || 0;
		state.tokensIn += input + cacheRead + cacheWrite;
		state.tokensOut += output;
		state.costUsd += Number(usage.cost?.total) || 0;
	}

	onEvent(model: string, event: any): void {
		const state = this.states.get(model);
		if (!state || state.status !== "working") return;
		if (event?.type === "tool_execution_start") {
			state.toolCalls += 1;
			state.latestTool = briefToolCall(event);
			this.pushFlow(state, { kind: "tool", text: state.latestTool });
			this.render();
			return;
		}
		if (event?.type !== "message_update" && event?.type !== "message_end") return;
		if (event.message?.role !== "assistant") return;

		const full = collectAssistantStreams(event.message);
		const streams = assistantStreams(event.message);
		if (streams.text) state.streamText = streams.text;
		if (streams.thinking) state.streamThinking = streams.thinking;
		if (full.text) state.partialText = truncateText(full.text, MAX_PARTIAL_RESULT_CHARS).text;
		if (event.type === "message_end") {
			this.recordUsage(state, event.message);
			this.pushFlow(state, { kind: "thinking", text: full.thinking });
			this.pushFlow(state, { kind: "text", text: full.text });
			state.streamText = undefined;
			state.streamThinking = undefined;
		}
		this.render();
	}

	snapshot(model: string): LiveWorkerSnapshot | undefined {
		const state = this.states.get(model);
		if (!state) return undefined;
		return {
			model: state.model,
			phase: state.phase,
			status: state.status,
			text: state.partialText ?? "",
			latestTool: state.latestTool,
			error: state.error,
		};
	}

	finish(model: string, status: Exclude<LiveWorkerStatus, "pending" | "working">, error?: string): void {
		const state = this.states.get(model);
		if (!state) return;
		state.status = status;
		state.endedAt = Date.now();
		if (error) {
			state.error = compactPreview(error);
			state.streamText = undefined;
			state.streamThinking = undefined;
			this.pushFlow(state, { kind: "error", text: state.error });
		}
		state.streamThinking = undefined;
		this.render();
	}

	private displayStates(): LiveWorkerState[] {
		const phaseRoot = this.phase.split(" · ")[0];
		const current = [...this.states.values()].filter(
			(state) => state.phase === this.phase || state.phase.startsWith(`${phaseRoot} ·`),
		);
		if (current.length > 0) return current.slice(0, 3);
		const working = [...this.states.values()].filter((state) => state.status === "working");
		return (working.length > 0 ? working : [...this.states.values()]).slice(-3);
	}

	private statusGlyph(status: LiveWorkerStatus): string {
		return status === "working" ? "⏳" : status === "done" ? "✓" : status === "aborted" ? "⊘" : "✗";
	}

	private statusColor(status: LiveWorkerStatus): string {
		return status === "working" ? "accent" : status === "done" ? "success" : status === "aborted" ? "warning" : "error";
	}

	private wrapCol(text: string, width: number): string[] {
		const cleaned = sanitizeTuiText(text).trim();
		if (!cleaned) return [];
		try {
			return wrapTextWithAnsi(cleaned, Math.max(10, width));
		} catch {
			return cleaned.split(/\r?\n/);
		}
	}

	private thinkLines(text: string, width: number, theme: any): string[] {
		return this.wrapCol(text, Math.max(8, width - 2)).map((line, index) =>
			theme.italic(theme.fg("thinkingText", index === 0 ? `▹ ${line}` : `  ${line}`)),
		);
	}

	private columnLines(state: LiveWorkerState, width: number, theme: any): string[] {
		const end = state.endedAt ?? Date.now();
		const seconds = Math.floor((end - state.startedAt) / 1000);
		const model = state.model.split("/").pop() ?? state.model;
		const statusLabel =
			state.status === "pending"
				? "waiting"
				: state.status === "working"
					? `working ${seconds}s`
					: `${state.status} ${seconds}s`;
		const bits = [`${this.statusGlyph(state.status)} ${statusLabel}`];
		if (state.tokensIn || state.tokensOut) {
			bits.push(`in ${formatLiveCount(state.tokensIn)} out ${formatLiveCount(state.tokensOut)}`);
		}
		if (state.costUsd > 0) bits.push(`$${state.costUsd.toFixed(4)}`);
		const lines = [
			theme.bold(theme.fg("customMessageLabel", compactPreview(model, Math.max(8, width - 2)))),
			theme.fg(this.statusColor(state.status), compactPreview(bits.join(" · "), Math.max(8, width - 2))),
			theme.fg("dim", compactPreview(state.phase, Math.max(8, width - 2))),
		];

		// Disler-style: completed workers collapse to the summary line so the live widget
		// stays focused on in-flight flow instead of replaying finished transcript.
		if (state.status === "done") return lines;
		if (state.status === "failed" || state.status === "aborted") {
			if (state.error) {
				for (const line of this.wrapCol(`✗ ${state.error}`, Math.max(8, width - 2))) {
					lines.push(theme.fg("error", line));
				}
			}
			return lines;
		}

		const flowLines: string[] = [];
		for (const item of state.flow.slice(-20)) {
			if (item.kind === "tool") {
				flowLines.push(theme.fg("toolTitle", compactPreview(`▸ ${item.text}`, Math.max(8, width - 2))));
			} else if (item.kind === "thinking") {
				flowLines.push(...this.thinkLines(item.text, width, theme));
			} else if (item.kind === "error") {
				for (const line of this.wrapCol(`✗ ${item.text}`, Math.max(8, width - 2))) {
					flowLines.push(theme.fg("error", line));
				}
			} else {
				for (const line of this.wrapCol(item.text, Math.max(8, width - 2))) {
					flowLines.push(theme.fg("muted", line));
				}
			}
		}
		// Keep live reasoning visible for the whole turn (Disler behavior), even after
		// answer text starts streaming between widget ticks.
		if (state.streamThinking) flowLines.push(...this.thinkLines(state.streamThinking, width, theme));
		if (state.streamText) {
			for (const line of this.wrapCol(state.streamText, Math.max(8, width - 2))) {
				flowLines.push(theme.fg("text", line));
			}
		}
		lines.push(...flowLines.slice(-20));
		return lines;
	}

	private renderWidget(width: number, theme: any): string[] {
		const states = this.displayStates();
		const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
		const working = states.filter((state) => state.status === "working").length;
		const tools = states.reduce((total, state) => total + state.toolCalls, 0);
		const title = theme.bold(
			theme.fg(
				"customMessageLabel",
				compactPreview(`WORKFLOW LIVE · ${this.runId} · ${this.phase} · ${elapsed}s · ${working}/${states.length} active · ${tools} tools`, width),
			),
		);
		const lines = [title];
		if (states.length === 0) return lines;

		const separator = theme.fg("borderMuted", " │ ");
		const separatorWidth = visibleWidth(separator);
		const columnWidth = Math.max(1, Math.floor((Math.max(1, width) - separatorWidth * (states.length - 1)) / states.length));
		const columns = states.map((state) => this.columnLines(state, columnWidth, theme));
		const rowCount = Math.max(...columns.map((column) => column.length));
		for (let row = 0; row < rowCount; row++) {
			lines.push(
				columns
					.map((column) => padLiveColumn(column[row] ?? "", columnWidth))
					.join(separator),
			);
		}
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private render(): void {
		if (this.ctx.mode !== "tui") return;
		try {
			this.ctx.ui.setWidget(
				this.widgetId,
				(_tui: any, theme: any) => ({
					render: (width: number) => this.renderWidget(width, theme),
					invalidate: () => undefined,
				}),
				{ placement: "aboveEditor" },
			);
		} catch {
			// TUI progress is best-effort and must never break the workflow.
		}
	}

	dispose(): void {
		if (this.ticker) clearInterval(this.ticker);
		if (this.ctx.mode === "tui") {
			try {
				this.ctx.ui.setWidget(this.widgetId, undefined);
			} catch {
				// Ignore UI teardown failures.
			}
		}
	}
}

