import { join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SupportedModelSpec, WorkflowMode } from "./types.js";

export const AGENT_DIR = getAgentDir();
export const RUNS_DIR = join(AGENT_DIR, "runs");
export const DEFAULT_AGY_BIN = join(
	process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
	"agy",
	"bin",
	"agy.exe",
);

/** Cap peer findings embedded into round-2 prompts. */
export const MAX_PEER_EMBED_CHARS = 12_000;
/** Cap synthesizer/result embeddings returned to the UI/tool. */
export const MAX_RESULT_EMBED_CHARS = 80_000;
/** Cap persisted artifact bodies. */
export const MAX_ARTIFACT_CHARS = 400_000;
/** Cap an in-flight worker answer retained for abort recovery. */
export const MAX_PARTIAL_RESULT_CHARS = 120_000;
/** Persist worker progress at most twice per second. */
export const PROGRESS_PERSIST_MS = 500;

/**
 * Exact native allowlist. Thinking levels are fixed for Codex models;
 * Cursor models default to medium (SDK clamps to model capabilities).
 */
export const SUPPORTED_MODELS: SupportedModelSpec[] = [
	{
		key: "cursor/composer-2.5",
		provider: "cursor",
		id: "composer-2.5",
		thinkingLevel: "off",
	},
	{
		key: "cursor/cursor-grok-4.5",
		provider: "cursor",
		id: "cursor-grok-4.5",
		thinkingLevel: "medium",
	},
	{
		key: "cursor/gpt-5.6-luna",
		provider: "cursor",
		id: "gpt-5.6-luna",
		thinkingLevel: "max",
	},
	{
		key: "cursor/auto",
		provider: "cursor",
		id: "auto",
		thinkingLevel: "off",
	},
	{
		key: "openai-codex/gpt-5.6-luna",
		provider: "openai-codex",
		id: "gpt-5.6-luna",
		thinkingLevel: "max",
	},
	{
		key: "openai-codex/gpt-5.6-sol",
		provider: "openai-codex",
		id: "gpt-5.6-sol",
		thinkingLevel: "medium",
	},
];

/**
 * Soft preferences only — never a hard mode→provider/model binding.
 * Auto selection may still pick any authenticated supported model.
 */
export const SOFT_DEFAULT_ORDER: Record<WorkflowMode, string[]> = {
	plan: [
		"cursor/gpt-5.6-luna",
		"cursor/composer-2.5",
		"cursor/cursor-grok-4.5",
		"openai-codex/gpt-5.6-luna",
		"openai-codex/gpt-5.6-sol",
		"cursor/auto",
	],
	review: [
		"cursor/gpt-5.6-luna",
		"cursor/composer-2.5",
		"cursor/cursor-grok-4.5",
		"openai-codex/gpt-5.6-luna",
		"openai-codex/gpt-5.6-sol",
		"cursor/auto",
	],
	build: [
		"cursor/composer-2.5",
		"cursor/cursor-grok-4.5",
		"cursor/gpt-5.6-luna",
		"cursor/auto",
		"openai-codex/gpt-5.6-sol",
		"openai-codex/gpt-5.6-luna",
	],
	agy: [],
};

/** Default 3-worker fusion set: all Cursor-provider models. */
export const DEFAULT_FUSION_ORDER = [
	"cursor/composer-2.5",
	"cursor/cursor-grok-4.5",
	"cursor/gpt-5.6-luna",
	"cursor/auto",
	"openai-codex/gpt-5.6-luna",
	"openai-codex/gpt-5.6-sol",
];

