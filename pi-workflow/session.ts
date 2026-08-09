import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunRecord } from "./types.js";
import { compactPreview, sanitizeTuiText } from "./sanitize.js";

export function extractAssistantText(session: any): string {
	const messages = Array.isArray(session.state?.messages) ? session.state.messages : [];
	const assistant = [...messages].reverse().find((message: any) => message?.role === "assistant");
	if (!assistant || !Array.isArray(assistant.content)) return "";
	return assistant.content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => part.text ?? "")
		.join("")
		.trim();
}

export function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(sanitizeTuiText(message), level);
}

export function setStatus(ctx: any, message: string): void {
	if (ctx.hasUI) ctx.ui.setStatus("pi-three-lane-workflow", sanitizeTuiText(message));
}

export function latestAssistantMessage(session: any): any | undefined {
	const messages = Array.isArray(session.state?.messages) ? session.state.messages : [];
	return [...messages].reverse().find((message: any) => message?.role === "assistant");
}

export function assistantFailure(session: any): string | undefined {
	const assistant = latestAssistantMessage(session);
	if (!assistant) return "Worker produced no assistant message.";
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
		return assistant.errorMessage || `Worker stopped with ${assistant.stopReason}.`;
	}
	return undefined;
}

export function sanitizeRunForOutput(run: RunRecord): RunRecord {
	return {
		...run,
		task: sanitizeTuiText(run.task),
		model: run.model ? sanitizeTuiText(run.model) : run.model,
		models: run.models?.map((model) => sanitizeTuiText(model)),
		synthesizer: run.synthesizer ? sanitizeTuiText(run.synthesizer) : run.synthesizer,
		requestedModel: run.requestedModel ? sanitizeTuiText(run.requestedModel) : run.requestedModel,
		requestedFusion: run.requestedFusion?.map((model) => sanitizeTuiText(model)),
		requestedSynthesizer: run.requestedSynthesizer ? sanitizeTuiText(run.requestedSynthesizer) : run.requestedSynthesizer,
		error: run.error ? sanitizeTuiText(run.error) : run.error,
		workers: run.workers?.map((worker) => ({
			...worker,
			model: sanitizeTuiText(worker.model),
			text: sanitizeTuiText(worker.text),
			error: worker.error ? sanitizeTuiText(worker.error) : worker.error,
		})),
		verification: run.verification
			? {
					...run.verification,
					unsafeCommandMentions: run.verification.unsafeCommandMentions.map((item) => sanitizeTuiText(item)),
					warnings: run.verification.warnings.map((item) => sanitizeTuiText(item)),
				}
			: run.verification,
	};
}

export function collectAssistantStreams(message: any): { text: string; thinking: string } {
	let text = "";
	let thinking = "";
	for (const part of message?.content ?? []) {
		if (part?.type === "text" && typeof part.text === "string") text += part.text;
		if (part?.type === "thinking" && typeof part.thinking === "string") thinking += part.thinking;
	}
	return { text, thinking };
}

export function assistantStreams(message: any): { text: string; thinking: string } {
	const streams = collectAssistantStreams(message);
	return { text: compactPreview(streams.text), thinking: compactPreview(streams.thinking) };
}

export function briefToolCall(event: any): string {
	const args = event?.args ?? {};
	const detail = args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.command ?? "";
	return compactPreview(`${event?.toolName ?? "tool"}${detail ? ` ${String(detail)}` : ""}`, 120);
}

export function formatLiveCount(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export function padLiveColumn(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(1, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

