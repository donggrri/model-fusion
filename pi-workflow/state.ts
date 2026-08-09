import type { RunRecord } from "./types.js";

export let activeRun: RunRecord | undefined;
export function setActiveRun(run: RunRecord | undefined): void {
	activeRun = run;
}

export const servicesByCwd = new Map<string, Promise<any>>();
export const workerServicesByCwd = new Map<string, Promise<any>>();
export const runSaveChains = new Map<string, Promise<void>>();
