import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LiveWorkerSnapshot, RunRecord } from "./types.js";
import { MAX_ARTIFACT_CHARS, PROGRESS_PERSIST_MS, RUNS_DIR } from "./constants.js";
import { runSaveChains } from "./state.js";
import { truncateText } from "./util.js";

export async function renameWithRetry(source: string, target: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			await rename(source, target);
			return;
		} catch (error) {
			lastError = error;
			const code = (error as any)?.code;
			if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error;
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function saveRun(run: RunRecord): Promise<void> {
	const previous = runSaveChains.get(run.id) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(async () => {
		const runDir = join(RUNS_DIR, run.id);
		await mkdir(runDir, { recursive: true });
		const target = join(runDir, "run.json");
		const temporary = join(runDir, `.run-${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
			await renameWithRetry(temporary, target);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	});
	runSaveChains.set(run.id, current);
	try {
		await current;
	} finally {
		if (runSaveChains.get(run.id) === current) runSaveChains.delete(run.id);
	}
}

export async function saveArtifact(run: RunRecord, filename: string, content: string): Promise<string> {
	const runDir = join(RUNS_DIR, run.id);
	const target = join(runDir, filename);
	await mkdir(dirname(target), { recursive: true });
	const { text } = truncateText(content, MAX_ARTIFACT_CHARS);
	await writeFile(target, text, "utf8");
	return filename;
}

export class RunProgressPersister {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private chain: Promise<void> = Promise.resolve();

	constructor(private readonly run: RunRecord) {}

	request(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.chain = this.chain.then(() => saveRun(this.run)).catch(() => undefined);
		}, PROGRESS_PERSIST_MS);
	}

	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.chain = this.chain.then(() => saveRun(this.run)).catch(() => undefined);
		}
		await this.chain;
	}
}

export class PartialArtifactWriter {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private latest: string | undefined;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly run: RunRecord,
		private readonly filename: string,
		private readonly model: string,
	) {}

	update(snapshot: LiveWorkerSnapshot): void {
		const lines = [
			`model: ${this.model}`,
			`phase: ${snapshot.phase}`,
			`status: ${snapshot.status}`,
			...(snapshot.latestTool ? [`latest_tool: ${snapshot.latestTool}`] : []),
			...(snapshot.error ? [`error: ${snapshot.error}`] : []),
			"",
			snapshot.text || "(no text emitted yet)",
		];
		this.latest = lines.join("\n");
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, PROGRESS_PERSIST_MS);
	}

	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const content = this.latest;
		if (content === undefined) {
			await this.chain;
			return;
		}
		this.latest = undefined;
		this.chain = this.chain
			.then(() => saveArtifact(this.run, this.filename, content))
			.catch(() => undefined);
		await this.chain;
	}

	async close(): Promise<void> {
		await this.flush();
		await this.chain;
	}
}

