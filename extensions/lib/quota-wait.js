import timers from "node:timers/promises";

import { DEFAULT_LIMIT_COOLDOWN_MS } from "./constants.js";

export async function waitForQuota(manager, plan, signal, selectionSignal) {
	const signals = [signal, selectionSignal].filter(Boolean);
	const waitSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
	const delay = Math.max(1, Math.min(plan.until - manager.now(), DEFAULT_LIMIT_COOLDOWN_MS));
	try {
		await timers.setTimeout(delay, undefined, { signal: waitSignal });
		signal?.throwIfAborted();
		if (!selectionSignal?.aborted) await manager.getQuotaWaitPlan({ refresh: true, signal: waitSignal });
	} catch (error) {
		signal?.throwIfAborted();
		if (!selectionSignal?.aborted) throw error;
	}
}
