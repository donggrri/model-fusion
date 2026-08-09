import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { listSupportedKeys } from "./util.js";
import { DEFAULT_FUSION_ORDER, SOFT_DEFAULT_ORDER, SUPPORTED_MODELS } from "./constants.js";
import { activeRun } from "./state.js";
import {
	parseArgs,
	AUTONOMOUS_ORCHESTRATION_POLICY,
	normalizeWorkflowMode,
	normalizeProvider,
	normalizeStringList,
} from "./prompts.js";
import { notify, sanitizeRunForOutput, setStatus } from "./session.js";
import { sanitizeTuiText } from "./sanitize.js";
import { executeWorkflow } from "./workflow.js";
import type { RunRecord, WorkerResult, WorkflowMode, WorkflowRequest } from "./types.js";

export default function (pi: ExtensionAPI) {
	// The main Pi session remains the conductor. It classifies each incoming request
	// and invokes the existing lanes only when their extra cost is justified.
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${AUTONOMOUS_ORCHESTRATION_POLICY}`,
	}));

	pi.registerEntryRenderer("workflow-result", (entry, _options, theme) => {
		const data = entry.data as {
			id: string;
			mode: WorkflowMode;
			provider: string;
			model?: string;
			text: string;
		};
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const label = sanitizeTuiText(`Workflow completed: ${data.id} (${data.model ?? data.provider})`);
		box.addChild(
			new Text(
				`${theme.bold(label)}\n\n${sanitizeTuiText(data.text || "(empty result)")}`,
			),
		);
		return box;
	});

	pi.registerCommand("workflow", {
		description:
			"Run a Pi-native workflow: plan, build, review, or agy. Optional --model/--fusion/--synthesizer.",
		handler: async (rawArgs, ctx) => {
			const { mode, task, writeEnabled, provider, model, fusion, synthesizer } = parseArgs(rawArgs);
			if (!task) {
				notify(
					ctx,
					"Usage: /workflow <plan|build|review|agy> [--write] [--provider=cursor|openai-codex] [--model=provider/id] [--fusion=m1,m2[,m3]] [--synthesizer=provider/id] <task>",
					"warning",
				);
				return;
			}

			try {
				const { run, result } = await executeWorkflow(ctx, {
					mode,
					task,
					writeEnabled,
					provider,
					model,
					fusion,
					synthesizer,
				});
				pi.appendEntry("workflow-result", {
					id: run.id,
					mode: run.mode,
					provider: run.provider,
					model: result.model,
					text: sanitizeTuiText(result.text || "(empty result)"),
				});
				notify(ctx, `Workflow completed: ${run.id} (${result.model ?? "agy"})`, "info");
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("workflow-status", {
		description: "Show the active workflow run",
		handler: async (_args, ctx) => {
			if (!activeRun) {
				notify(ctx, "No workflow is currently running.", "info");
				return;
			}
			const phase = activeRun.phase ? ` / ${activeRun.phase}` : "";
			const model = activeRun.model ? ` / ${activeRun.model}` : "";
			notify(
				ctx,
				`${activeRun.status}: ${activeRun.mode} / ${activeRun.provider}${model}${phase} / ${activeRun.id}`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: "run_workflow",
		label: "Run workflow",
		description:
			"Main Conductor tool. Run a nested plan/build/review/AGY lane, optionally with an explicit supported model or a 2-3 model read-only fusion. TUI runs show live per-worker thinking/output previews and tool calls without adding them to model context. Do not ask the user to create another Pi session.",
		promptSnippet: "Run the Pi-native model-flexible Codex/Cursor/AGY workflow (optional fusion)",
		promptGuidelines: [
			"Choose freely among authenticated supported models: cursor/composer-2.5, cursor/cursor-grok-4.5, cursor/gpt-5.6-luna (max), cursor/auto, openai-codex/gpt-5.6-luna (max), openai-codex/gpt-5.6-sol (medium). Mode does not hard-bind the provider. Default fusion prefers the three Cursor models.",
			"Use mode=plan for uncertain requirements or architecture; mode=review for verification; mode=agy for an independent critic.",
			"Use mode=build only for a bounded implementation task; set write=true only when edits are explicitly requested, and only with one Cursor worker.",
			"For difficult research, architecture, security analysis, or ambiguous RCA, prefer fusion with 2-3 unique supported models; an optional synthesizer must be one of those models. Fusion is always read-only.",
			"Legacy provider remains a compatibility hint only; prefer model=provider/id or fusion=[...] when you care about the exact worker.",
		],
		parameters: Type.Object({
			mode: Type.Optional(Type.String({ description: "plan, build, review, or agy" })),
			task: Type.String({ description: "The focused task or review question" }),
			write: Type.Optional(
				Type.Boolean({
					description: "Allow one Cursor build worker to edit files (rejected for Codex/AGY/fusion)",
				}),
			),
			provider: Type.Optional(
				Type.String({
					description: "Legacy compatibility hint: openai-codex or cursor",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Full model id from the allowlist, e.g. cursor/composer-2.5 or cursor/gpt-5.6-luna",
				}),
			),
			fusion: Type.Optional(
				Type.Union([
					Type.Array(Type.String(), {
						description: "2-3 unique supported models for read-only research fusion",
					}),
					Type.String({
						description: "Comma-separated 2-3 unique supported models for read-only fusion",
					}),
				]),
			),
			synthesizer: Type.Optional(
				Type.String({
					description: "Optional consensus synthesizer; must be one of the selected fusion models",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as {
				mode?: unknown;
				task?: unknown;
				write?: unknown;
				provider?: unknown;
				model?: unknown;
				fusion?: unknown;
				synthesizer?: unknown;
			};
			if (typeof input.task !== "string" || !input.task.trim()) {
				throw new Error("run_workflow requires a non-empty task.");
			}
			const mode = normalizeWorkflowMode(input.mode);
			const provider = normalizeProvider(input.provider);
			const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
			const fusion = normalizeStringList(input.fusion);
			const synthesizer =
				typeof input.synthesizer === "string" && input.synthesizer.trim()
					? input.synthesizer.trim()
					: undefined;
			const writeEnabled = mode === "build" && input.write === true;

			let run: RunRecord;
			let result: WorkerResult;
			try {
				({ run, result } = await executeWorkflow(ctx, {
					mode,
					task: input.task.trim(),
					writeEnabled,
					provider,
					model,
					fusion,
					synthesizer,
					signal,
				}));
			} catch (error) {
				const message = sanitizeTuiText(error instanceof Error ? error.message : String(error));
				throw new Error(message);
			}
			return {
				content: [
					{
						type: "text",
						text: sanitizeTuiText(`Workflow ${run.id} completed via ${result.model ?? "agy"}.\n\n${result.text || "(empty result)"}`),
					},
				],
				details: { run: sanitizeRunForOutput(run) },
			};
		},
	});

	pi.registerTool({
		name: "workflow_capabilities",
		label: "Workflow capabilities",
		description: "Show the configured model-flexible workflow, allowlist, and fusion capabilities.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [
					{
						type: "text",
						text: [
							"Supported native models (allowlist):",
							"- cursor/composer-2.5 (thinking off; model default)",
							"- cursor/cursor-grok-4.5 (thinking medium)",
							"- cursor/gpt-5.6-luna (thinking max)",
							"- cursor/auto (thinking off; model default)",
							"- openai-codex/gpt-5.6-luna (thinking max)",
							"- openai-codex/gpt-5.6-sol (thinking medium)",
							"",
							"No rigid mode→provider binding. Soft defaults only; Pi may choose any authenticated allowlisted model.",
							"Fusion default: cursor/composer-2.5 + cursor/cursor-grok-4.5 + cursor/gpt-5.6-luna (2-3 unique models, round-1 parallel research, round-2 peer critique, then consensus).",
							"TUI visibility: live model status, elapsed time, recent tool call, and streaming thinking/output preview (up to 20 lines) in a context-free widget.",
							"Writes: only mode=build + write=true + one Cursor worker with user confirmation. Codex/AGY/fusion are read-only.",
							"Automatic Conductor tool: run_workflow (model, fusion, synthesizer, legacy provider hint).",
							"Manual commands: /workflow plan|build|review|agy [--model=...] [--fusion=m1,m2[,m3]] [--synthesizer=...] [--provider=...] [--write], /workflow-status",
							"Recommend fusion for difficult research, architecture, security, or ambiguous RCA.",
						].join("\n"),
					},
				],
				details: {
					supportedModels: SUPPORTED_MODELS.map((spec) => ({
						model: spec.key,
						thinkingLevel: spec.thinkingLevel,
					})),
					softDefaults: SOFT_DEFAULT_ORDER,
					fusion: {
						minModels: 2,
						maxModels: 3,
						readOnly: true,
						rounds: ["independent-research", "peer-critique", "synthesizer-consensus"],
					},
				},
			};
		},
	});
}

