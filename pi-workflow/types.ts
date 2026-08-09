export type WorkflowMode = "plan" | "build" | "review" | "agy";
export type NativeProvider = "openai-codex" | "cursor";
export type RunStatus = "running" | "completed" | "failed";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SupportedModelSpec {
	key: string;
	provider: NativeProvider;
	id: string;
	thinkingLevel: ThinkingLevel;
}

export interface ResolvedModel {
	spec: SupportedModelSpec;
	model: any;
	thinkingLevel: ThinkingLevel;
}

export interface TruncationInfo {
	originalChars: number;
	keptChars: number;
	truncated: boolean;
}

export interface WorkerArtifact {
	role: "single" | "fusion-round-1" | "fusion-round-2" | "synthesizer";
	model: string;
	thinkingLevel?: ThinkingLevel;
	status: "pending" | "working" | "completed" | "failed" | "aborted";
	text: string;
	error?: string;
	truncation?: TruncationInfo;
	artifactPath?: string;
}

export interface RunRecord {
	id: string;
	mode: WorkflowMode;
	provider: string;
	model?: string;
	models?: string[];
	fusion?: boolean;
	synthesizer?: string;
	thinkingLevel?: ThinkingLevel;
	task: string;
	status: RunStatus;
	writeEnabled: boolean;
	phase?: string;
	requestedModel?: string;
	requestedFusion?: string[];
	requestedSynthesizer?: string;
	providerHint?: NativeProvider;
	workers?: WorkerArtifact[];
	startedAt: string;
	finishedAt?: string;
	error?: string;
	aborted?: boolean;
	quality?: "full" | "partial";
	verification?: EvidenceVerification;
}

export interface EvidenceVerification {
	citationHints: number;
	directEvidenceHints: number;
	uncertaintyHints: number;
	unsafeCommandMentions: string[];
	warnings: string[];
}

export interface WorkerResult {
	provider: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	text: string;
}

export interface WorkflowExecutionResult {
	run: RunRecord;
	result: WorkerResult;
}

export interface ParsedWorkflowArgs {
	mode: WorkflowMode;
	task: string;
	writeEnabled: boolean;
	provider?: NativeProvider;
	model?: string;
	fusion?: string[];
	synthesizer?: string;
}

export interface WorkflowRequest {
	mode: WorkflowMode;
	task: string;
	writeEnabled: boolean;
	provider?: NativeProvider;
	model?: string;
	fusion?: string[];
	synthesizer?: string;
	signal?: AbortSignal;
}

export type LiveWorkerStatus = "pending" | "working" | "done" | "failed" | "aborted";
export type LiveFlowKind = "tool" | "thinking" | "text" | "error";

export interface LiveFlowItem {
	kind: LiveFlowKind;
	text: string;
}

export interface LiveWorkerState {
	model: string;
	phase: string;
	status: LiveWorkerStatus;
	startedAt: number;
	endedAt?: number;
	latestTool?: string;
	streamText?: string;
	streamThinking?: string;
	partialText?: string;
	error?: string;
	flow: LiveFlowItem[];
	toolCalls: number;
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
}

export interface LiveWorkerSnapshot {
	model: string;
	phase: string;
	status: LiveWorkerStatus;
	text: string;
	latestTool?: string;
	error?: string;
}
