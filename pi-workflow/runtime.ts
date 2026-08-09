import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSessionServices, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NativeProvider, ResolvedModel, SupportedModelSpec, ThinkingLevel, WorkflowMode } from "./types.js";
import { AGENT_DIR, DEFAULT_FUSION_ORDER, SOFT_DEFAULT_ORDER, SUPPORTED_MODELS } from "./constants.js";
import { servicesByCwd, workerServicesByCwd } from "./state.js";
import { findSupportedSpec, listSupportedKeys, modelKey, parseModelRef, throwIfAborted } from "./util.js";

export async function getServices(cwd: string): Promise<any> {
	const existing = servicesByCwd.get(cwd);
	if (existing) return existing;
	const services = createAgentSessionServices({ cwd, agentDir: AGENT_DIR });
	servicesByCwd.set(cwd, services);
	return services;
}

/**
 * Nested workers run in a clean-room resource loader. In particular, they do not
 * load this workflow extension again, which prevents recursive routing/policy
 * injection and avoids confusing provider-native tool names with Pi tools.
 */
export function isLexicallyInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function normalizeWorkerPath(rawPath: string): string | undefined {
	let value = rawPath.trim().replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (value.startsWith("@")) value = value.slice(1);
	if (process.platform === "win32" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
		const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
		if (match) value = `${match[1].toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}`;
	}
	if (value === "~") value = homedir();
	else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) value = join(homedir(), value.slice(2));
	if (/^file:\/\//i.test(value)) {
		try {
			value = fileURLToPath(value);
		} catch {
			return undefined;
		}
	}
	return value;
}

export async function isWorkspacePath(cwd: string, rawPath: unknown): Promise<boolean> {
	if (typeof rawPath !== "string" || !rawPath.trim()) return false;
	const normalized = normalizeWorkerPath(rawPath);
	if (!normalized) return false;
	const root = resolve(cwd);
	const target = resolve(root, normalized);
	if (!isLexicallyInside(root, target)) return false;

	let realRoot: string;
	try {
		realRoot = await realpath(root);
	} catch {
		return false;
	}
	try {
		if ((await lstat(target)).isSymbolicLink()) return false;
		return isLexicallyInside(realRoot, await realpath(target));
	} catch {
		// Reject dangling symlink targets before checking their parent.
		try {
			if ((await lstat(target)).isSymbolicLink()) return false;
		} catch {
			// Target may be a genuinely new file.
		}
		// New files do not have a realpath yet. Check the nearest existing parent
		// so a symlink/junction cannot redirect the eventual write outside root.
		let parent = dirname(target);
		while (isLexicallyInside(root, parent)) {
			try {
				if ((await lstat(parent)).isSymbolicLink()) return false;
			} catch {
				// Parent may not exist yet; continue toward the nearest existing one.
			}
			try {
				return isLexicallyInside(realRoot, await realpath(parent));
			} catch {
				const next = dirname(parent);
				if (next === parent) break;
				parent = next;
			}
		}
		return false;
	}
}

export async function getWorkerServices(cwd: string): Promise<any> {
	const existing = workerServicesByCwd.get(cwd);
	if (existing) return existing;
	const pending = (async () => {
		const base = await getServices(cwd);
		return createAgentSessionServices({
			cwd,
			agentDir: AGENT_DIR,
			modelRuntime: base.modelRuntime,
			settingsManager: base.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					{
						name: "workflow-worker-write-guard",
						factory: (pi: ExtensionAPI) => {
							pi.on("tool_call", async (event: any, ctx: any) => {
								if (!["edit", "write", "bash"].includes(event.toolName)) return;
								if (event.toolName === "bash") {
									return { block: true, reason: "Nested workflow workers cannot execute shell commands." };
								}
								const rawPath = event.input?.path ?? event.input?.file_path;
								if (!(await isWorkspacePath(ctx.cwd, rawPath))) {
									return { block: true, reason: "Nested workflow writes must stay inside the real worker workspace." };
								}
							});
						},
					},
				],
			},
		});
	})();
	let services: Promise<any>;
	services = pending.catch((error) => {
		if (workerServicesByCwd.get(cwd) === services) workerServicesByCwd.delete(cwd);
		throw error;
	});
	workerServicesByCwd.set(cwd, services);
	return services;
}

export function matchAvailableModel(available: any[], spec: SupportedModelSpec): any | undefined {
	const aliases: Record<string, string[]> = {
		"cursor-grok-4.5": ["cursor-grok-4.5", "grok-4.5"],
		"gpt-5.6-luna": ["gpt-5.6-luna"],
		"composer-2.5": ["composer-2.5"],
	};
	const ids = aliases[spec.id] ?? [spec.id];
	return available.find(
		(model: any) => model.provider === spec.provider && ids.includes(String(model.id ?? "")),
	);
}

export async function listAuthenticatedSupported(runtime: any, signal?: AbortSignal): Promise<ResolvedModel[]> {
	throwIfAborted(signal);
	const available = await runtime.getAvailable(undefined, signal ? { signal } : undefined);
	const resolved: ResolvedModel[] = [];
	for (const spec of SUPPORTED_MODELS) {
		const model = matchAvailableModel(available as any[], spec);
		if (model) {
			resolved.push({
				spec,
				model,
				thinkingLevel: spec.thinkingLevel,
			});
		}
	}
	return resolved;
}

export async function resolveModel(
	runtime: any,
	options: {
		requested?: string;
		providerHint?: NativeProvider;
		mode: WorkflowMode;
		signal?: AbortSignal;
	},
): Promise<ResolvedModel> {
	const authenticated = await listAuthenticatedSupported(runtime, options.signal);
	if (authenticated.length === 0) {
		throw new Error(
			`No authenticated supported models are available. Supported allowlist: ${listSupportedKeys()}. Run /login cursor and/or /login codex in Pi first.`,
		);
	}

	if (options.requested) {
		const spec = findSupportedSpec(options.requested);
		if (!spec) {
			throw new Error(
				`Model "${options.requested}" is not in the supported allowlist (${listSupportedKeys()}).`,
			);
		}
		const hit = authenticated.find((item) => item.spec.key === spec.key);
		if (!hit) {
			const available = authenticated.map((item) => item.spec.key).join(", ");
			throw new Error(
				`Requested ${spec.key}, but it is not authenticated/available. Available supported models: ${available || "(none)"}.`,
			);
		}
		return hit;
	}

	const pool = options.providerHint
		? authenticated.filter((item) => item.spec.provider === options.providerHint)
		: authenticated;
	if (pool.length === 0) {
		const available = authenticated.map((item) => item.spec.key).join(", ");
		throw new Error(
			`No authenticated ${options.providerHint} model from the allowlist is available. Available supported models: ${available}.`,
		);
	}

	const preference = [
		...(SOFT_DEFAULT_ORDER[options.mode] ?? []),
		...DEFAULT_FUSION_ORDER,
	];
	for (const key of preference) {
		const hit = pool.find((item) => item.spec.key === key);
		if (hit) return hit;
	}
	return pool[0];
}

export async function resolveFusionModels(
	runtime: any,
	options: {
		fusion?: string[];
		providerHint?: NativeProvider;
		mode: WorkflowMode;
		signal?: AbortSignal;
	},
): Promise<ResolvedModel[]> {
	const authenticated = await listAuthenticatedSupported(runtime, options.signal);
	if (authenticated.length < 2) {
		throw new Error(
			`Fusion requires at least 2 authenticated supported models. Available: ${
				authenticated.map((item) => item.spec.key).join(", ") || "(none)"
			}.`,
		);
	}

	if (options.fusion && options.fusion.length > 0) {
		if (options.fusion.length < 2 || options.fusion.length > 3) {
			throw new Error("Fusion accepts 2-3 unique models.");
		}
		const resolved: ResolvedModel[] = [];
		const seen = new Set<string>();
		for (const ref of options.fusion) {
			const model = await resolveModel(runtime, {
				requested: ref,
				mode: options.mode,
				signal: options.signal,
			});
			if (seen.has(model.spec.key)) {
				throw new Error(`Fusion models must be unique; duplicate: ${model.spec.key}`);
			}
			seen.add(model.spec.key);
			resolved.push(model);
		}
		return resolved;
	}

	const pool = options.providerHint
		? authenticated.filter((item) => item.spec.provider === options.providerHint)
		: authenticated;
	const ordered: ResolvedModel[] = [];
	const seen = new Set<string>();
	for (const key of [...DEFAULT_FUSION_ORDER, ...pool.map((item) => item.spec.key)]) {
		const hit = pool.find((item) => item.spec.key === key) ?? authenticated.find((item) => item.spec.key === key);
		if (!hit || seen.has(hit.spec.key)) continue;
		seen.add(hit.spec.key);
		ordered.push(hit);
		if (ordered.length === 3) break;
	}
	if (ordered.length < 2) {
		throw new Error("Could not auto-select 2 supported models for fusion.");
	}
	return ordered.slice(0, Math.min(3, ordered.length));
}

