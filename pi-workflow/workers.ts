import { spawn, type ChildProcess } from "node:child_process";
import {
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { LiveWorkerSnapshot, ResolvedModel, WorkerResult } from "./types.js";
import { AGENT_DIR, DEFAULT_AGY_BIN } from "./constants.js";
import { throwIfAborted } from "./util.js";
import { getServices, getWorkerServices } from "./runtime.js";
import { assistantFailure, extractAssistantText } from "./session.js";
import type { WorkflowLiveProgress } from "./tui.js";

export type WorkerProgressCallback = (snapshot: LiveWorkerSnapshot) => void;

export async function runNativeWorker(
	cwd: string,
	resolved: ResolvedModel,
	task: string,
	writeEnabled: boolean,
	signal?: AbortSignal,
	progress?: WorkflowLiveProgress,
	phase = "worker",
	onProgress?: WorkerProgressCallback,
): Promise<WorkerResult> {
	throwIfAborted(signal);
	const baseServices = await getServices(cwd);
	const workerServices = await getWorkerServices(cwd);
	const runtime = baseServices.modelRuntime;
	const tools = writeEnabled
		? ["read", "grep", "find", "ls", "edit", "write"]
		: ["read", "grep", "find", "ls"];

	const { session } = await createAgentSession({
		cwd,
		agentDir: AGENT_DIR,
		modelRuntime: runtime,
		model: resolved.model,
		thinkingLevel: resolved.thinkingLevel,
		tools,
		resourceLoader: workerServices.resourceLoader,
		settingsManager: workerServices.settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});

	const emitProgress = () => {
		const snapshot = progress?.snapshot(resolved.spec.key);
		if (snapshot) onProgress?.(snapshot);
	};
	progress?.start(resolved.spec.key, phase);
	emitProgress();
	const unsubscribe = session.subscribe((event: any) => {
		progress?.onEvent(resolved.spec.key, event);
		emitProgress();
	});
	const onAbort = () => {
		void session.abort();
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		throwIfAborted(signal);
		await session.prompt(task);
		throwIfAborted(signal);
		const failure = assistantFailure(session);
		if (failure) throw new Error(failure);
		const result = {
			provider: resolved.spec.provider,
			model: resolved.spec.key,
			thinkingLevel: resolved.thinkingLevel,
			text: extractAssistantText(session),
		};
		progress?.finish(resolved.spec.key, "done");
		emitProgress();
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		progress?.finish(resolved.spec.key, signal?.aborted ? "aborted" : "failed", message);
		emitProgress();
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
	}
}

export async function runAgy(cwd: string, task: string, signal?: AbortSignal): Promise<WorkerResult> {
	throwIfAborted(signal);
	const binary = process.env.PI_AGY_BIN || DEFAULT_AGY_BIN;
	const args = [
		"--print",
		task,
		"--output-format",
		"json",
		"--mode",
		"plan",
		"--sandbox",
		"--dangerously-skip-permissions",
		"--print-timeout",
		"120s",
	];
	const permissionNotice = "headless mode cannot prompt for";

	return await new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(binary, args, {
			cwd,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};

		const onAbort = () => {
			child.kill();
			finish(() => reject(new Error("AGY aborted.")));
		};

		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, 125_000);

		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		};

		if (signal) {
			if (signal.aborted) {
				child.kill();
				finish(() => reject(new Error("AGY aborted.")));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			finish(() => reject(new Error(`AGY failed to start: ${error.message}`)));
		});
		child.once("close", (code) => {
			finish(() => {
				if (signal?.aborted) {
					reject(new Error("AGY aborted."));
					return;
				}
				if (timedOut) {
					reject(new Error("AGY exceeded the 125-second timeout."));
					return;
				}
				if (code !== 0) {
					reject(new Error(`AGY exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
					return;
				}
				if (`${stdout}\n${stderr}`.toLowerCase().includes(permissionNotice)) {
					reject(new Error("AGY headless execution was denied by its permission policy."));
					return;
				}
				if (!stdout.trim() && !stderr.trim()) {
					reject(new Error("AGY returned an empty headless result."));
					return;
				}
				resolve({ provider: "agy", text: stdout.trim() || stderr.trim() });
			});
		});
	});
}

