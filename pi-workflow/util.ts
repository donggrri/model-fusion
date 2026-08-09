import { randomUUID } from "node:crypto";
import type { EvidenceVerification, NativeProvider, TruncationInfo } from "./types.js";
import { SUPPORTED_MODELS } from "./constants.js";
import { compactPreview } from "./sanitize.js";

export function createRunId(): string {
	return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

export function slugifyModelKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9._-]+/g, "__");
}

export function researchLabel(index: number): string {
	return `Research ${String.fromCharCode(65 + index)}`;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		const reason = signal.reason;
		throw reason instanceof Error ? reason : new Error("Workflow aborted.");
	}
}

export function truncateText(text: string, maxChars: number): { text: string; truncation: TruncationInfo } {
	const originalChars = text.length;
	if (originalChars <= maxChars) {
		return {
			text,
			truncation: { originalChars, keptChars: originalChars, truncated: false },
		};
	}
	const keptChars = Math.max(0, maxChars);
	const head = Math.floor(keptChars * 0.8);
	const tail = Math.max(0, keptChars - head - 64);
	const sliced =
		tail > 0
			? `${text.slice(0, head)}\n\n...[truncated ${originalChars - keptChars} chars]...\n\n${text.slice(-tail)}`
			: `${text.slice(0, keptChars)}\n\n...[truncated]...`;
	return {
		text: sliced,
		truncation: { originalChars, keptChars: sliced.length, truncated: true },
	};
}

export function verifyEvidence(text: string): EvidenceVerification {
	const citationHints = (
		text.match(/[A-Za-z0-9_.~\\/-]+\.[A-Za-z0-9_-]+(?::\d+(?:-\d+)?)?|\bline\s+\d+(?:-\d+)?\b/gi) ?? []
	).length;
	const directEvidenceHints = (text.match(/direct evidence|directly observed|로그상|직접 증거/gi) ?? []).length;
	const uncertaintyHints = (text.match(/uncertain|uncertainty|cannot determine|not proven|추론|불확실|입증되지/gi) ?? []).length;
	const unsafeCommandMentions = text
		.split("\n")
		.filter((line) =>
			/\b(?:mkfs(?:\.[a-z0-9]+)?|fsck(?:\.[a-z0-9]+)?|e2fsck|dd|wipefs|cryptsetup\s+(?:repair|luksFormat)|dmsetup\s+(?:create|remove|reload)|keyctl\s+(?:read|pipe)|caam-keygen\s+create)\b/i.test(line) &&
			!/do not|don't|avoid|never|禁止|금지|실행하지|run only|only from/i.test(line),
		)
		.map((line) => compactPreview(line, 180));
	const warnings: string[] = [];
	if (citationHints === 0) warnings.push("No file/line citation hints were found in the consensus.");
	if (directEvidenceHints === 0) warnings.push("The consensus does not clearly label direct evidence.");
	if (uncertaintyHints === 0) warnings.push("The consensus does not clearly disclose uncertainty.");
	if (unsafeCommandMentions.length > 0) warnings.push("Potentially destructive commands appear as recommendations; manual review required.");
	return { citationHints, directEvidenceHints, uncertaintyHints, unsafeCommandMentions, warnings };
}

export function parseModelRef(raw: string): { provider?: NativeProvider; id: string; full?: string } {
	const value = raw.trim();
	if (!value) return { id: "" };
	const slash = value.indexOf("/");
	if (slash === -1) return { id: value };
	const provider = value.slice(0, slash);
	const id = value.slice(slash + 1);
	if (provider === "openai-codex" || provider === "cursor") {
		return { provider, id, full: `${provider}/${id}` };
	}
	return { id: value };
}

export function findSupportedSpec(ref: string): SupportedModelSpec | undefined {
	const parsed = parseModelRef(ref);
	const aliases: Record<string, string> = {
		"grok-4.5": "cursor-grok-4.5",
		"cursor/grok-4.5": "cursor/cursor-grok-4.5",
	};
	const rawNeedle = (parsed.full ?? parsed.id).toLowerCase();
	const needle = aliases[rawNeedle] ?? rawNeedle;
	return SUPPORTED_MODELS.find((spec) =>
		spec.key.toLowerCase() === needle || (!parsed.provider && spec.id.toLowerCase() === needle),
	);
}

export function listSupportedKeys(): string {
	return SUPPORTED_MODELS.map((spec) => spec.key).join(", ");
}

