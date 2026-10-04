import timers from "node:timers/promises";

import { NoManagedAccountsError } from "./account-manager.js";
import { CODEX_API, DEFAULT_LIMIT_COOLDOWN_MS } from "./constants.js";

export const BASE_PROVIDER_SYMBOL = Symbol.for("pi-accounts.base-provider");

class RelayMessageEventStream {
	constructor() {
		this.queue = [];
		this.waiting = [];
		this.done = false;
		this.finalResult = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event) {
		if (this.done) return;
		if (event?.type === "done" || event?.type === "error") {
			this.done = true;
			this.resolveFinalResult(event.type === "done" ? event.message : event.error);
		}
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}

	end(result) {
		if (!this.done && result !== undefined) this.resolveFinalResult(result);
		this.done = true;
		while (this.waiting.length > 0) this.waiting.shift()({ value: undefined, done: true });
	}

	async *[Symbol.asyncIterator]() {
		while (true) {
			if (this.queue.length > 0) yield this.queue.shift();
			else if (this.done) return;
			else {
				const next = await new Promise((resolve) => this.waiting.push(resolve));
				if (next.done) return;
				yield next.value;
			}
		}
	}

	result() {
		return this.finalResult;
	}
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function errorEvent(model, error, aborted = false) {
	const message = error instanceof Error ? error.message : String(error);
	return {
		type: "error",
		reason: aborted ? "aborted" : "error",
		error: {
			role: "assistant",
			content: [],
			api: model.api ?? CODEX_API,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: aborted ? "aborted" : "error",
			errorMessage: message,
			timestamp: Date.now(),
		},
	};
}

function terminalMessage(event) {
	return event?.type === "error" ? event.error?.errorMessage : undefined;
}

export function classifySwitchableFailure(status, message) {
	if (status === 429) return "quota";
	if (status === 401 || status === 403) return "unavailable";
	const text = String(message ?? "").toLowerCase();
	if (
		/usage[ _-]?limit|rate[ _-]?limit|quota|too many requests|limit (?:has been )?reached|exceeded your current/.test(
			text,
		)
	) {
		return "quota";
	}
	if (/unauthori[sz]ed|invalid (?:access )?token|token (?:has )?expired|authentication failed/.test(text)) {
		return "unavailable";
	}
	return undefined;
}

function isMeaningfulEvent(event) {
	return !["start", "done", "error"].includes(event?.type);
}

function relayManagedStream(baseProvider, method, manager, model, context, options = {}, lifecycle = {}) {
	const signals = [options.signal, lifecycle.signal].filter(Boolean);
	const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
	options = { ...options, signal };
	const relay = new RelayMessageEventStream();
	let partial;
	const reportWait = (plan) => {
		try {
			lifecycle.onWait?.(plan);
		} catch {}
	};
	const onAbort = () => {
		const terminal = errorEvent(model, signal.reason ?? new Error("Codex request cancelled"), true);
		if (partial) {
			terminal.error = { ...partial, stopReason: "aborted", errorMessage: terminal.error.errorMessage };
		}
		relay.push(terminal);
		relay.end();
		reportWait(undefined);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	void (async () => {
		const attemptedAliases = new Set();
		let startForwarded = false;
		let lastTerminal;
		try {
			signal?.throwIfAborted();
			if ((await manager.getAccountCount()) === 0) throw new Error("No Codex account is configured; run /account add");
			while (true) {
				signal?.throwIfAborted();
				let account;
				try {
					account = await manager.prepareAttempt({
						excludeAliases: attemptedAliases,
						checkQuota: true,
						allowExhausted: false,
						signal: options.signal,
					});
				} catch (error) {
					signal?.throwIfAborted();
					if (error instanceof NoManagedAccountsError) {
						const plan = await manager.getQuotaWaitPlan({ signal });
						if (plan) {
							reportWait(plan);
							const delay = Math.max(1, Math.min(plan.until - manager.now(), DEFAULT_LIMIT_COOLDOWN_MS));
							await timers.setTimeout(delay, undefined, { signal });
							await manager.getQuotaWaitPlan({ refresh: true, signal });
							attemptedAliases.clear();
							continue;
						}
					}
					if (lastTerminal) {
						relay.push(lastTerminal);
						relay.end();
						return;
					}
					throw error;
				}
				signal?.throwIfAborted();
				reportWait(undefined);
				attemptedAliases.add(account.alias);
				let responseStatus;
				let responseHeaders;
				let meaningfulOutput = false;
				let terminal;
				const originalOnResponse = options.onResponse;
				const attemptOptions = {
					...options,
					apiKey: account.credential.access,
					maxRetries: 0,
					onResponse: async (response, responseModel) => {
						responseStatus = response.status;
						responseHeaders = response.headers;
						await originalOnResponse?.(response, responseModel);
					},
				};

				let attemptStream;
				try {
					attemptStream = baseProvider[method](model, context, attemptOptions);
					for await (const event of attemptStream) {
						if (event.type === "start") {
							if (!startForwarded) {
								startForwarded = true;
								partial = event.partial;
								relay.push(event);
							}
							continue;
						}
						if (event.type === "done") {
							await manager.noteSuccess(account.alias, { headers: responseHeaders });
							relay.push(event);
							relay.end();
							return;
						}
						if (event.type === "error") {
							terminal = event;
							break;
						}
						if (isMeaningfulEvent(event)) meaningfulOutput = true;
						partial = event.partial ?? partial;
						relay.push(event);
					}
				} catch (error) {
					terminal = errorEvent(model, error);
				}
				terminal ??= errorEvent(model, new Error("Codex provider stream ended without a result"));
				lastTerminal = terminal;
				const failureKind = classifySwitchableFailure(responseStatus, terminalMessage(terminal));
				signal?.throwIfAborted();
				if (failureKind === "quota") {
					await manager.noteLimited(account.alias, {
						headers: responseHeaders,
						reason: terminalMessage(terminal),
					});
				} else if (failureKind === "unavailable") {
					await manager.noteUnavailable(account.alias, { reason: terminalMessage(terminal) });
				}
				if (!failureKind || meaningfulOutput || terminal.reason === "aborted") {
					relay.push(terminal);
					relay.end();
					return;
				}
			}
		} catch (error) {
			relay.push(errorEvent(model, error, signal?.aborted));
			relay.end();
		} finally {
			signal?.removeEventListener("abort", onAbort);
			reportWait(undefined);
		}
	})();
	return relay;
}

export function createManagedProvider(providerValue, manager, lifecycle = {}) {
	const baseProvider = providerValue?.[BASE_PROVIDER_SYMBOL] ?? providerValue;
	if (!baseProvider?.id || typeof baseProvider.stream !== "function") {
		throw new Error("Cannot wrap an invalid openai-codex provider");
	}
	const provider = {
		id: baseProvider.id,
		name: baseProvider.name,
		baseUrl: baseProvider.baseUrl,
		headers: baseProvider.headers,
		auth: baseProvider.auth,
		getModels: () => baseProvider.getModels(),
		stream: (model, context, options) =>
			relayManagedStream(baseProvider, "stream", manager, model, context, options, lifecycle),
		streamSimple: (model, context, options) =>
			relayManagedStream(baseProvider, "streamSimple", manager, model, context, options, lifecycle),
	};
	if (typeof baseProvider.refreshModels === "function") {
		provider.refreshModels = (context) => baseProvider.refreshModels(context);
	}
	if (typeof baseProvider.filterModels === "function") {
		provider.filterModels = (models, credential) => baseProvider.filterModels(models, credential);
	}
	if (typeof baseProvider.fetchDeferred === "function") {
		provider.fetchDeferred = (model, handle, options) =>
			relayManagedStream(
				{
					fetchDeferred: (requestModel, _context, requestOptions) =>
						baseProvider.fetchDeferred(requestModel, handle, requestOptions),
				},
				"fetchDeferred",
				manager,
				model,
				undefined,
				options,
				lifecycle,
			);
	}
	if (typeof baseProvider.cancelDeferred === "function") {
		provider.cancelDeferred = async (model, handle, options = {}) => {
			const account = await manager.prepareAttempt({ signal: options.signal, allowExhausted: true });
			return baseProvider.cancelDeferred(model, handle, {
				...options,
				apiKey: account.credential.access,
			});
		};
	}
	Object.defineProperty(provider, BASE_PROVIDER_SYMBOL, {
		value: baseProvider,
		enumerable: false,
		configurable: false,
		writable: false,
	});
	return provider;
}
