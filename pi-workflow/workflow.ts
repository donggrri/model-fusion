import type { ResolvedModel, RunRecord, WorkflowExecutionResult, WorkflowRequest } from "./types.js";
import { AGENT_DIR, MAX_RESULT_EMBED_CHARS, RUNS_DIR } from "./constants.js";
import { activeRun, setActiveRun } from "./state.js";
import { createRunId, throwIfAborted, truncateText, verifyEvidence } from "./util.js";
import { getServices, resolveModel } from "./runtime.js";
import { PartialArtifactWriter, RunProgressPersister, saveArtifact, saveRun } from "./persistence.js";
import { notify, sanitizeRunForOutput, setStatus } from "./session.js";
import { WorkflowLiveProgress } from "./tui.js";
import { AUTONOMOUS_ORCHESTRATION_POLICY, buildAgyPrompt, buildPrompt } from "./prompts.js";
import { runAgy, runNativeWorker } from "./workers.js";
import { executeFusion } from "./fusion.js";
import { join } from "node:path";

export function ensureWriteAuthorization(request: WorkflowRequest, resolved?: ResolvedModel): void {
	if (!request.writeEnabled) return;

	if (request.mode !== "build") {
		throw new Error("Writes are only allowed for mode=build with write=true.");
	}
	if (request.fusion && request.fusion.length > 0) {
		throw new Error("Fusion workflows are read-only. Writes are not allowed for fusion.");
	}
	if (resolved && resolved.spec.provider !== "cursor") {
		throw new Error("Only a Cursor worker may write. Codex/AGY/fusion writes are rejected.");
	}
	if (request.provider === "openai-codex") {
		throw new Error("openai-codex cannot write. Use a Cursor model for build+write.");
	}
}

export async function executeWorkflow(ctx: any, request: WorkflowRequest): Promise<WorkflowExecutionResult> {
	if (activeRun?.status === "running") {
		throw new Error(`Another workflow is already running: ${activeRun.id}`);
	}

	const wantsFusion = Boolean(request.fusion && request.fusion.length > 0);
	const run: RunRecord = {
		id: createRunId(),
		mode: request.mode,
		provider: request.mode === "agy" ? "agy" : wantsFusion ? "fusion" : request.provider ?? "auto",
		task: request.task,
		status: "running",
		writeEnabled: false,
		phase: "starting",
		requestedModel: request.model,
		requestedFusion: request.fusion,
		requestedSynthesizer: request.synthesizer,
		providerHint: request.provider,
		startedAt: new Date().toISOString(),
	};
	// Acquire the top-level workflow lock synchronously, before confirmation or I/O.
	setActiveRun(run);
	const progress = new WorkflowLiveProgress(ctx, run.id);
	const persist = new RunProgressPersister(run);

	const onAbort = () => {
		run.aborted = true;
		run.status = "failed";
		run.error = "Workflow aborted.";
		run.phase = "aborted";
		void saveRun(run).catch(() => undefined);
	};
	request.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		if (request.writeEnabled) {
			ensureWriteAuthorization(request);
		}
		if (request.writeEnabled && request.mode === "build" && !wantsFusion) {
			if (!ctx.hasUI) {
				throw new Error("Write-enabled workflows require interactive user confirmation.");
			}
			const ok = await ctx.ui.confirm(
				"Allow workspace edits?",
				"One Cursor worker may edit files in the current workspace using guarded edit/write tools. Shell execution is disabled.",
			);
			if (!ok) throw new Error("The write-enabled workflow was cancelled.");
		}

		await saveRun(run);
		throwIfAborted(request.signal);

		if (request.mode === "agy") {
			if (request.writeEnabled) {
				throw new Error("AGY workflows are read-only.");
			}
			run.writeEnabled = false;
			run.provider = "agy";
			run.phase = "agy";
			progress.setPhase("agy · independent critique");
			progress.start("agy", "agy · independent critique");
			await saveRun(run);
			setStatus(ctx, `agy / ${run.id}`);
			let result: WorkerResult;
			try {
				result = await runAgy(ctx.cwd, buildAgyPrompt(request.task), request.signal);
				if (!result.text.trim()) {
					progress.finish("agy", "failed", "AGY returned an empty result.");
					throw new Error("AGY returned an empty result.");
				}
				progress.finish("agy", "done");
			} catch (error) {
				progress.finish("agy", request.signal?.aborted ? "aborted" : "failed", error instanceof Error ? error.message : String(error));
				throw error;
			}
			throwIfAborted(request.signal);
			run.status = "completed";
			run.finishedAt = new Date().toISOString();
			run.phase = "completed";
			await saveRun(run);
			await saveArtifact(run, "agy-review.json", result.text || "(empty result)");
			throwIfAborted(request.signal);
			setStatus(ctx, `completed / agy / ${run.id}`);
			return { run, result };
		}

		if (wantsFusion) {
			ensureWriteAuthorization({ ...request, writeEnabled: request.writeEnabled || false });
			if (request.writeEnabled) {
				throw new Error("Fusion workflows are read-only. Omit write=true / --write.");
			}
			const fusionResult = await executeFusion(ctx, run, { ...request, writeEnabled: false }, progress, persist);
			setStatus(ctx, `completed / fusion / ${run.id}`);
			return fusionResult;
		}

		const services = await getServices(ctx.cwd);
		const resolved = await resolveModel(services.modelRuntime, {
			requested: request.model,
			providerHint: request.provider,
			mode: request.mode,
			signal: request.signal,
		});

		const writeEnabled = request.mode === "build" && request.writeEnabled === true;
		if (writeEnabled) {
			ensureWriteAuthorization(request, resolved);
		}

		run.provider = resolved.spec.provider;
		run.model = resolved.spec.key;
		run.thinkingLevel = resolved.thinkingLevel;
		run.writeEnabled = writeEnabled;
		run.phase = "single";
		progress.setPhase(`${request.mode} · single worker`);
		const artifact: WorkerArtifact = {
			role: "single",
			model: resolved.spec.key,
			thinkingLevel: resolved.thinkingLevel,
			status: "working",
			text: "",
		};
		run.workers = [artifact];
		await saveRun(run);
		setStatus(ctx, `${request.mode} / ${resolved.spec.key} / ${run.id}`);
		const partialWriter = new PartialArtifactWriter(
			run,
			join("partial", "single.md"),
			resolved.spec.key,
		);
		const onProgress: WorkerProgressCallback = (snapshot) => {
			artifact.status = snapshot.status === "done" ? "completed" : snapshot.status === "working" ? "working" : snapshot.status;
			artifact.text = snapshot.text;
			artifact.error = snapshot.error;
			partialWriter.update(snapshot);
			persist.request();
		};
		let result: WorkerResult | undefined;
		try {
			result = await runNativeWorker(
				ctx.cwd,
				resolved,
				buildPrompt(request.mode, request.task, writeEnabled),
				writeEnabled,
				request.signal,
				progress,
				`${request.mode} worker`,
				onProgress,
			);
		} finally {
			await partialWriter.close();
		}
		throwIfAborted(request.signal);
		if (!result) throw new Error("Worker returned no result.");
		if (!result.text.trim()) {
			artifact.status = "failed";
			artifact.error = "Worker returned no final answer.";
			progress.finish(resolved.spec.key, "failed", artifact.error);
			const failedSnapshot = progress.snapshot(resolved.spec.key);
			if (failedSnapshot) onProgress(failedSnapshot);
			throw new Error(artifact.error);
		}
		artifact.status = "completed";
		artifact.text = result.text || artifact.text;
		artifact.artifactPath = "result.md";
		run.workers = [artifact];
		run.status = "completed";
		run.finishedAt = new Date().toISOString();
		run.phase = "completed";
		await saveRun(run);
		await saveArtifact(run, "result.md", result.text || "(empty result)");
		throwIfAborted(request.signal);
		setStatus(ctx, `completed / ${request.mode} / ${run.id}`);
		const embedded = truncateText(result.text || "(empty result)", MAX_RESULT_EMBED_CHARS);
		return {
			run,
			result: {
				provider: resolved.spec.provider,
				model: resolved.spec.key,
				thinkingLevel: resolved.thinkingLevel,
				text: embedded.text,
			},
		};
	} catch (error) {
		run.status = "failed";
		run.finishedAt = new Date().toISOString();
		run.error = error instanceof Error ? error.message : String(error);
		if (request.signal?.aborted) run.aborted = true;
		run.phase = run.aborted ? "aborted" : "failed";
		await saveRun(run);
		setStatus(ctx, `failed / ${request.mode} / ${run.id}`);
		throw error;
	} finally {
		try {
			await persist.flush();
			if (request.signal?.aborted) {
				run.aborted = true;
				run.status = "failed";
				run.error = "Workflow aborted during finalization.";
				run.phase = "aborted";
				await saveRun(run).catch(() => undefined);
				throwIfAborted(request.signal);
			}
		} finally {
			request.signal?.removeEventListener("abort", onAbort);
			progress.dispose();
			setActiveRun(undefined);
		}
	}
}

