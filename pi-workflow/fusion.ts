import type { ResolvedModel, RunRecord, WorkerArtifact, WorkflowExecutionResult, WorkflowRequest } from "./types.js";
import {
	MAX_PEER_EMBED_CHARS,
	MAX_RESULT_EMBED_CHARS,
	RUNS_DIR,
} from "./constants.js";
import { researchLabel, slugifyModelKey, truncateText, verifyEvidence, throwIfAborted } from "./util.js";
import { getServices, resolveFusionModels, resolveModel } from "./runtime.js";
import { PartialArtifactWriter, RunProgressPersister, saveArtifact, saveRun } from "./persistence.js";
import { setStatus } from "./session.js";
import type { WorkflowLiveProgress } from "./tui.js";
import {
	buildFusionRound1Prompt,
	buildFusionRound2Prompt,
	buildSynthesizerPrompt,
} from "./prompts.js";
import { runNativeWorker } from "./workers.js";
import { join } from "node:path";

export async function executeFusion(
	ctx: any,
	run: RunRecord,
	request: WorkflowRequest,
	progress: WorkflowLiveProgress,
	persist: RunProgressPersister,
): Promise<WorkflowExecutionResult> {
	const services = await getServices(ctx.cwd);
	const runtime = services.modelRuntime;
	const workers = await resolveFusionModels(runtime, {
		fusion: request.fusion,
		providerHint: request.provider,
		mode: request.mode,
		signal: request.signal,
	});
	const labels = new Map(workers.map((worker, index) => [worker.spec.key, researchLabel(index)]));

	const synthesizerResolved = request.synthesizer
		? await resolveModel(runtime, {
				requested: request.synthesizer,
				mode: request.mode,
				signal: request.signal,
			})
		: workers[0];
	if (!workers.some((worker) => worker.spec.key === synthesizerResolved.spec.key)) {
		throw new Error("The fusion synthesizer must be one of the selected 2-3 fusion models.");
	}

	run.fusion = true;
	run.writeEnabled = false;
	run.models = workers.map((worker) => worker.spec.key);
	run.model = synthesizerResolved.spec.key;
	run.synthesizer = synthesizerResolved.spec.key;
	run.thinkingLevel = synthesizerResolved.thinkingLevel;
	run.provider = "fusion";
	run.phase = "fusion-round-1";
	run.quality = "full";
	progress.setPhase("round 1 · independent research");
	await saveRun(run);
	setStatus(ctx, `fusion-r1 / ${run.models.join("+")} / ${run.id}`);

	const round1Artifacts: WorkerArtifact[] = workers.map((worker) => ({
		role: "fusion-round-1",
		model: worker.spec.key,
		thinkingLevel: worker.thinkingLevel,
		status: "working",
		text: "",
	}));
	run.workers = [...round1Artifacts];
	await saveRun(run);
	const round1Settled = await Promise.allSettled(
		workers.map(async (worker, index) => {
			const artifact = round1Artifacts[index];
			const partialWriter = new PartialArtifactWriter(
				run,
				join("partial", "round-1", `${slugifyModelKey(worker.spec.key)}.md`),
				worker.spec.key,
			);
			const onProgress: WorkerProgressCallback = (snapshot) => {
				artifact.status = snapshot.status === "done" ? "completed" : snapshot.status === "working" ? "working" : snapshot.status;
				artifact.text = snapshot.text;
				artifact.error = snapshot.error;
				partialWriter.update(snapshot);
				persist.request();
			};
			const prompt = buildFusionRound1Prompt(
				request.mode,
				request.task,
				labels.get(worker.spec.key) ?? researchLabel(index),
				index === 0 ? "timeline and direct evidence" : index === 1 ? "source and system dependency" : "adversarial alternative hypotheses",
			);
			try {
				const result = await runNativeWorker(
					ctx.cwd,
					worker,
					prompt,
					false,
					request.signal,
					progress,
					"round 1 · research",
					onProgress,
				);
				artifact.text = result.text || artifact.text;
				artifact.status = result.text.trim() ? "completed" : "failed";
				if (!result.text.trim()) {
					artifact.error = "Worker returned no final answer.";
					progress.finish(worker.spec.key, "failed", artifact.error);
					const failedSnapshot = progress.snapshot(worker.spec.key);
					if (failedSnapshot) onProgress(failedSnapshot);
				}
				const path = await saveArtifact(
					run,
					join("round-1", `${slugifyModelKey(worker.spec.key)}.md`),
					result.text || "(empty result)",
				);
				artifact.artifactPath = path;
				return artifact;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const aborted = request.signal?.aborted || /abort/i.test(message);
				artifact.status = aborted ? "aborted" : "failed";
				artifact.error = message;
				await saveArtifact(
					run,
					join("round-1", `${slugifyModelKey(worker.spec.key)}.md`),
					`ERROR: ${message}\n`,
				);
				return artifact;
			} finally {
				await partialWriter.close();
			}
		}),
	);

	round1Settled.forEach((settled, index) => {
		if (settled.status === "rejected") {
			const artifact = round1Artifacts[index];
			artifact.status = "failed";
			artifact.error = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
		}
	});
	for (const artifact of round1Artifacts) {
		if (artifact.status === "completed" && !artifact.text.trim()) {
			artifact.status = "failed";
			artifact.error = "Worker completed without a usable answer.";
		}
	}
	run.workers = [...round1Artifacts];
	await saveRun(run);
	throwIfAborted(request.signal);

	const successfulRound1 = round1Artifacts.filter((item) => item.status === "completed" && item.text.trim());
	const minimumRound1Quorum = 2;
	if (successfulRound1.length < minimumRound1Quorum) {
		run.quality = "partial";
		await saveArtifact(run, "errors.json", `${JSON.stringify(round1Artifacts, null, 2)}\n`);
		throw new Error(`Fusion round 1 quorum failed: ${successfulRound1.length}/${workers.length} workers succeeded; at least ${minimumRound1Quorum} are required.`);
	}
	if (successfulRound1.length < workers.length) run.quality = "partial";

	run.phase = "fusion-round-2";
	progress.setPhase("round 2 · peer critique");
	await saveRun(run);
	setStatus(ctx, `fusion-r2 / ${successfulRound1.length} workers / ${run.id}`);

	const round2Artifacts: WorkerArtifact[] = successfulRound1.map((own) => ({
		role: "fusion-round-2",
		model: own.model,
		thinkingLevel: workers.find((item) => item.spec.key === own.model)?.thinkingLevel,
		status: "working",
		text: "",
	}));
	run.workers = [...round1Artifacts, ...round2Artifacts];
	await saveRun(run);
	const round2Settled = await Promise.allSettled(
		successfulRound1.map(async (own, index) => {
			const artifact = round2Artifacts[index];
			const worker = workers.find((item) => item.spec.key === own.model);
			if (!worker) throw new Error(`Missing resolved worker for ${own.model}`);

			const peers = successfulRound1.filter((item) => item.model !== own.model);
			const peerBlocks = peers
				.map((peer) => {
					const { text, truncation } = truncateText(peer.text || "(empty)", MAX_PEER_EMBED_CHARS);
					return [
						`### ${labels.get(peer.model) ?? "Peer research"}`,
						truncation.truncated
							? `(truncated from ${truncation.originalChars} to ${truncation.keptChars} chars)`
							: "(full)",
						text,
					].join("\n");
				})
				.join("\n\n");

			const ownEmbedded = truncateText(own.text || "(empty)", MAX_PEER_EMBED_CHARS).text;
			const prompt = buildFusionRound2Prompt(
				request.mode,
				request.task,
				labels.get(own.model) ?? "Research worker",
				ownEmbedded,
				peerBlocks || "(no successful peers)",
			);
			const partialWriter = new PartialArtifactWriter(
				run,
				join("partial", "round-2", `${slugifyModelKey(own.model)}.md`),
				own.model,
			);
			const onProgress: WorkerProgressCallback = (snapshot) => {
				artifact.status = snapshot.status === "done" ? "completed" : snapshot.status === "working" ? "working" : snapshot.status;
				artifact.text = snapshot.text;
				artifact.error = snapshot.error;
				partialWriter.update(snapshot);
				persist.request();
			};

			try {
				const result = await runNativeWorker(
					ctx.cwd,
					worker,
					prompt,
					false,
					request.signal,
					progress,
					"round 2 · peer critique",
					onProgress,
				);
				artifact.text = result.text || artifact.text;
				artifact.status = result.text.trim() ? "completed" : "failed";
				if (!result.text.trim()) {
					artifact.error = "Peer critique returned no final answer.";
					progress.finish(own.model, "failed", artifact.error);
					const failedSnapshot = progress.snapshot(own.model);
					if (failedSnapshot) onProgress(failedSnapshot);
				}
				const path = await saveArtifact(
					run,
					join("round-2", `${slugifyModelKey(own.model)}.md`),
					result.text || "(empty result)",
				);
				artifact.artifactPath = path;
				artifact.truncation = truncateText(result.text || "", MAX_PEER_EMBED_CHARS).truncation;
				return artifact;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const aborted = request.signal?.aborted || /abort/i.test(message);
				artifact.status = aborted ? "aborted" : "failed";
				artifact.error = message;
				await saveArtifact(
					run,
					join("round-2", `${slugifyModelKey(own.model)}.md`),
					`ERROR: ${message}\n`,
				);
				return artifact;
			} finally {
				await partialWriter.close();
			}
		}),
	);

	round2Settled.forEach((settled, index) => {
		if (settled.status === "rejected") {
			const artifact = round2Artifacts[index];
			artifact.status = "failed";
			artifact.error = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
		}
	});
	for (const artifact of round2Artifacts) {
		if (artifact.status === "completed" && !artifact.text.trim()) {
			artifact.status = "failed";
			artifact.error = "Peer critique completed without a usable answer.";
		}
	}
	run.workers = [...round1Artifacts, ...round2Artifacts];
	await saveRun(run);
	throwIfAborted(request.signal);

	const successfulRound2 = round2Artifacts.filter((item) => item.status === "completed" && item.text.trim());
	const failures = [...round1Artifacts, ...round2Artifacts]
		.filter((item) => item.status !== "completed")
		.map((item) => `${item.role} ${labels.get(item.model) ?? "research worker"}: ${item.error ?? item.status}`);
	if (successfulRound2.length < 2 || failures.length > 0) run.quality = "partial";

	if (successfulRound1.length + successfulRound2.length === 0) {
		await saveArtifact(run, "errors.json", `${JSON.stringify({ round1Artifacts, round2Artifacts }, null, 2)}\n`);
		throw new Error("Fusion produced no usable worker output.");
	}

	run.phase = "fusion-synthesize";
	progress.setPhase("round 3 · consensus synthesis");
	await saveRun(run);
	setStatus(ctx, `fusion-synth / ${synthesizerResolved.spec.key} / ${run.id}`);

	const round1Blocks = successfulRound1
		.map((item) => {
			const { text, truncation } = truncateText(item.text, MAX_PEER_EMBED_CHARS);
			return `### ${labels.get(item.model) ?? "Research"}${truncation.truncated ? " (truncated)" : ""}\n${text}`;
		})
		.join("\n\n");
	const round2Blocks = successfulRound2.length > 0
		? successfulRound2
				.map((item) => {
					const { text, truncation } = truncateText(item.text, MAX_PEER_EMBED_CHARS);
					return `### ${labels.get(item.model) ?? "Research"}${truncation.truncated ? " (truncated)" : ""}\n${text}`;
				})
				.join("\n\n")
		: "(No usable round-2 peer critiques were produced. Use round-1 findings only and mark the result partial.)";

	const synthPrompt = buildSynthesizerPrompt(
		request.mode,
		request.task,
		round1Blocks,
		round2Blocks,
		failures,
	);
	const synthArtifact: WorkerArtifact = {
		role: "synthesizer",
		model: synthesizerResolved.spec.key,
		thinkingLevel: synthesizerResolved.thinkingLevel,
		status: "working",
		text: "",
	};
	run.workers = [...round1Artifacts, ...round2Artifacts, synthArtifact];
	await saveRun(run);
	const synthWriter = new PartialArtifactWriter(
		run,
		join("partial", "consensus.md"),
		synthesizerResolved.spec.key,
	);
	const synthProgress: WorkerProgressCallback = (snapshot) => {
		synthArtifact.status = snapshot.status === "done" ? "completed" : snapshot.status === "working" ? "working" : snapshot.status;
		synthArtifact.text = snapshot.text;
		synthArtifact.error = snapshot.error;
		synthWriter.update(snapshot);
		persist.request();
	};
	let synthResult: WorkerResult | undefined;
	try {
		synthResult = await runNativeWorker(
			ctx.cwd,
			synthesizerResolved,
			synthPrompt,
			false,
			request.signal,
			progress,
			"round 3 · synthesize consensus",
			synthProgress,
		);
	} finally {
		await synthWriter.close();
	}
	throwIfAborted(request.signal);
	if (!synthResult) throw new Error("Fusion synthesizer returned no result.");
	if (!synthResult.text.trim()) {
		synthArtifact.status = "failed";
		synthArtifact.error = "Fusion synthesizer returned an empty consensus.";
		progress.finish(synthesizerResolved.spec.key, "failed", synthArtifact.error);
		const failedSnapshot = progress.snapshot(synthesizerResolved.spec.key);
		if (failedSnapshot) synthProgress(failedSnapshot);
		run.quality = "partial";
		throw new Error("Fusion synthesizer returned an empty consensus.");
	}
	const finalConsensusText = run.quality === "partial"
		? `**Fusion quality: PARTIAL — one or more workers/critique rounds failed or returned no usable output.**\n\n${synthResult.text || "(empty consensus)"}`
		: synthResult.text || "(empty consensus)";
	const consensusPath = await saveArtifact(run, "consensus.md", finalConsensusText);
	run.verification = verifyEvidence(finalConsensusText);
	await saveArtifact(run, "verification.json", `${JSON.stringify(run.verification, null, 2)}\n`);
	if (failures.length > 0) {
		await saveArtifact(run, "errors.json", `${JSON.stringify({ failures, round1Artifacts, round2Artifacts }, null, 2)}\n`);
	}

	synthArtifact.status = "completed";
	synthArtifact.text = finalConsensusText || synthArtifact.text;
	synthArtifact.artifactPath = consensusPath;
	synthArtifact.truncation = truncateText(synthResult.text || "", MAX_RESULT_EMBED_CHARS).truncation;
	run.workers = [...round1Artifacts, ...round2Artifacts, synthArtifact];
	throwIfAborted(request.signal);
	run.phase = "completed";
	run.status = "completed";
	run.finishedAt = new Date().toISOString();
	await saveRun(run);
	throwIfAborted(request.signal);

	const embedded = truncateText(finalConsensusText, MAX_RESULT_EMBED_CHARS);
	return {
		run,
		result: {
			provider: "fusion",
			model: `fusion:${workers.map((worker) => worker.spec.key).join("+")}>${synthesizerResolved.spec.key}`,
			thinkingLevel: synthesizerResolved.thinkingLevel,
			text: embedded.text,
		},
	};
}

