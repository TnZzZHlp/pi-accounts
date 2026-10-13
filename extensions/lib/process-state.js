import { resolve } from "node:path";

const PROCESS_STATE_SYMBOL = Symbol.for("pi-accounts.process-state.v1");

export function createAccountRuntime() {
	return {
		activeAccountId: null,
		initialized: false,
		quota: new Map(),
		cooldowns: new Map(),
		queue: Promise.resolve(),
	};
}

export function getProcessAccountRuntime(storePath, authPath) {
	const states = globalThis[PROCESS_STATE_SYMBOL] ??= new Map();
	const key = JSON.stringify([resolve(storePath), resolve(authPath)]);
	if (!states.has(key)) states.set(key, createAccountRuntime());
	return states.get(key);
}
