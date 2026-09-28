import {
	DEFAULT_LIMIT_COOLDOWN_MS,
	DEFAULT_UNAVAILABLE_COOLDOWN_MS,
	QUOTA_TTL_MS,
	TOKEN_REFRESH_SKEW_MS,
} from "./constants.js";
import {
	aliasKey,
	asText,
	deriveAccountAlias,
	getCredentialAccountId,
	getCredentialEmail,
	normalizeOAuthCredential,
	validateAlias,
} from "./credentials.js";
import {
	findAccount,
	readPiCodexCredential,
	writePiCodexCredential,
} from "./account-store.js";
import {
	consumeCodexResetCredit,
	fetchCodexResetCreditExpiries,
	fetchCodexUsage,
	getQuotaResetAt,
	isQuotaExhausted,
	parseCodexRateLimitHeaders,
	parseRetryAfter,
	QuotaRequestError,
} from "./quota.js";

export class NoManagedAccountsError extends Error {
	constructor(message = "No managed Codex accounts are available") {
		super(message);
		this.name = "NoManagedAccountsError";
	}
}

function cloneAccount(account) {
	return account ? structuredClone(account) : undefined;
}

export class AccountManager {
	constructor(options) {
		this.store = options.store;
		this.authPath = options.authPath;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.now = options.now ?? Date.now;
		this.quotaTtlMs = options.quotaTtlMs ?? QUOTA_TTL_MS;
		this.refreshSkewMs = options.refreshSkewMs ?? TOKEN_REFRESH_SKEW_MS;
		this.onChange = options.onChange;
		this.provider = undefined;
		this.quota = new Map();
		this.cooldowns = new Map();
		this.queue = Promise.resolve();
	}

	setProvider(provider) {
		if (!provider?.auth?.oauth) {
			throw new Error("The openai-codex provider does not expose OAuth support");
		}
		this.provider = provider;
	}

	_emitChange() {
		try {
			this.onChange?.();
		} catch {
			// Footer updates must never break authentication or model requests.
		}
	}

	_serialized(task) {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}

	_getOAuth() {
		const oauth = this.provider?.auth?.oauth;
		if (!oauth) throw new Error("OpenAI Codex OAuth is unavailable; reload Pi and try again");
		return oauth;
	}

	async initialize(options = {}) {
		return this._serialized(async () => {
			await this._importCurrent(undefined, { makeActive: false });
			const state = await this.store.load();
			if (state.accounts.length === 0) {
				this._emitChange();
				return this._viewFromState(state);
			}
			try {
				await this._select({ checkQuota: options.checkQuota !== false, allowExhausted: true });
			} catch {
				const current = findAccount(state, state.active ?? state.accounts[0].alias);
				if (current) await this._activate(current.alias);
			}
			this._emitChange();
			return this._viewFromState(await this.store.load());
		});
	}

	async importCurrent(alias, options = {}) {
		return this._serialized(async () => {
			const account = await this._importCurrent(alias, { makeActive: options.makeActive !== false });
			if (!account) throw new Error("Pi does not currently have an openai-codex OAuth login to import");
			if (options.makeActive !== false) await this._activate(account.alias);
			this._emitChange();
			return cloneAccount(findAccount(await this.store.load(), account.alias));
		});
	}

	async _importCurrent(alias, options = {}) {
		const credential = await readPiCodexCredential(this.authPath);
		if (!credential) return undefined;
		const accountId = getCredentialAccountId(credential);
		if (!accountId) throw new Error("The current openai-codex token does not contain a ChatGPT account id");
		const outcome = await this.store.modify((state) => {
			const existing = state.accounts.find((account) => account.accountId === accountId);
			const now = this.now();
			if (existing) {
				existing.credential = { ...credential, accountId };
				existing.email = getCredentialEmail(credential) ?? existing.email;
				existing.updatedAt = now;
				if (!state.active || options.makeActive) state.active = existing.alias;
				return { state, result: existing.alias };
			}
			const requestedAlias = alias === undefined ? undefined : validateAlias(alias);
			const resolvedAlias =
				requestedAlias ?? deriveAccountAlias(credential, state.accounts.map((account) => account.alias));
			if (state.accounts.some((account) => aliasKey(account.alias) === aliasKey(resolvedAlias))) {
				throw new Error(`Account alias already exists: ${resolvedAlias}`);
			}
			state.accounts.push({
				alias: resolvedAlias,
				accountId,
				email: getCredentialEmail(credential),
				credential: { ...credential, accountId },
				addedAt: now,
				updatedAt: now,
			});
			if (!state.active || options.makeActive) state.active = resolvedAlias;
			return { state, result: resolvedAlias };
		});
		return cloneAccount(findAccount(outcome.state, outcome.result));
	}

	async addCredential(credentialValue, requestedAlias) {
		return this._serialized(async () => {
			const credential = normalizeOAuthCredential(credentialValue);
			const accountId = getCredentialAccountId(credential);
			if (!accountId) throw new Error("The OAuth token does not contain a ChatGPT account id");
			const outcome = await this.store.modify((state) => {
				const now = this.now();
				const existing = state.accounts.find((account) => account.accountId === accountId);
				let resolvedAlias;
				if (existing) {
					resolvedAlias = requestedAlias === undefined ? existing.alias : validateAlias(requestedAlias);
					const collision = state.accounts.find(
						(account) =>
							account.accountId !== accountId && aliasKey(account.alias) === aliasKey(resolvedAlias),
					);
					if (collision) throw new Error(`Account alias already exists: ${resolvedAlias}`);
					existing.alias = resolvedAlias;
					existing.credential = { ...credential, accountId };
					existing.email = getCredentialEmail(credential) ?? existing.email;
					existing.updatedAt = now;
				} else {
					resolvedAlias =
						requestedAlias === undefined
							? deriveAccountAlias(credential, state.accounts.map((account) => account.alias))
							: validateAlias(requestedAlias);
					if (state.accounts.some((account) => aliasKey(account.alias) === aliasKey(resolvedAlias))) {
						throw new Error(`Account alias already exists: ${resolvedAlias}`);
					}
					state.accounts.push({
						alias: resolvedAlias,
						accountId,
						email: getCredentialEmail(credential),
						credential: { ...credential, accountId },
						addedAt: now,
						updatedAt: now,
					});
				}
				state.active = resolvedAlias;
				return { state, result: resolvedAlias };
			});
			this.cooldowns.delete(aliasKey(outcome.result));
			const account = findAccount(outcome.state, outcome.result);
			await writePiCodexCredential(this.authPath, account.credential);
			this._emitChange();
			return cloneAccount(account);
		});
	}

	async use(alias) {
		return this._serialized(async () => {
			const account = await this._activate(alias);
			this.cooldowns.delete(aliasKey(account.alias));
			this._emitChange();
			return cloneAccount(account);
		});
	}

	async rename(oldAlias, newAliasValue) {
		return this._serialized(async () => {
			const newAlias = validateAlias(newAliasValue);
			const outcome = await this.store.modify((state) => {
				const account = findAccount(state, oldAlias);
				if (!account) throw new Error(`Unknown account: ${oldAlias}`);
				const collision = state.accounts.find(
					(candidate) =>
						candidate.accountId !== account.accountId && aliasKey(candidate.alias) === aliasKey(newAlias),
				);
				if (collision) throw new Error(`Account alias already exists: ${newAlias}`);
				const previousAlias = account.alias;
				account.alias = newAlias;
				account.updatedAt = this.now();
				if (state.active && aliasKey(state.active) === aliasKey(previousAlias)) state.active = newAlias;
				return { state, result: { previousAlias, alias: newAlias } };
			});
			const previousKey = aliasKey(outcome.result.previousAlias);
			const runtimeQuota = this.quota.get(previousKey);
			const cooldown = this.cooldowns.get(previousKey);
			this.quota.delete(previousKey);
			this.cooldowns.delete(previousKey);
			if (runtimeQuota) this.quota.set(aliasKey(newAlias), runtimeQuota);
			if (cooldown) this.cooldowns.set(aliasKey(newAlias), cooldown);
			this._emitChange();
			return cloneAccount(findAccount(outcome.state, newAlias));
		});
	}

	async remove(alias) {
		return this._serialized(async () => {
			const outcome = await this.store.modify((state) => {
				const account = findAccount(state, alias);
				if (!account) throw new Error(`Unknown account: ${alias}`);
				state.accounts = state.accounts.filter((candidate) => candidate.accountId !== account.accountId);
				if (state.active && aliasKey(state.active) === aliasKey(account.alias)) {
					state.active = state.accounts[0]?.alias ?? null;
				}
				return { state, result: account };
			});
			this.quota.delete(aliasKey(outcome.result.alias));
			this.cooldowns.delete(aliasKey(outcome.result.alias));
			const active = outcome.state.active ? findAccount(outcome.state, outcome.state.active) : undefined;
			await writePiCodexCredential(this.authPath, active?.credential);
			this._emitChange();
			return cloneAccount(outcome.result);
		});
	}

	async _activate(alias) {
		const outcome = await this.store.modify((state) => {
			const account = findAccount(state, alias);
			if (!account) throw new Error(`Unknown account: ${alias}`);
			state.active = account.alias;
			return { state, result: account.alias };
		});
		const account = findAccount(outcome.state, outcome.result);
		await writePiCodexCredential(this.authPath, account.credential);
		return account;
	}

	_isCoolingDown(alias) {
		const key = aliasKey(alias);
		const cooldown = this.cooldowns.get(key);
		if (!cooldown) return undefined;
		if (cooldown.until <= this.now()) {
			this.cooldowns.delete(key);
			return undefined;
		}
		return cooldown;
	}

	async _refreshCredential(accountValue, options = {}) {
		const requestedAccount = cloneAccount(accountValue);
		if (!options.force && requestedAccount.credential.expires > this.now() + this.refreshSkewMs) {
			return requestedAccount;
		}
		try {
			// Keep the provider refresh call inside the cross-process store lock. OAuth
			// providers may rotate refresh tokens, so two Pi processes must not exchange
			// the same stale token concurrently.
			const outcome = await this.store.modify(async (state) => {
				const current = findAccount(state, requestedAccount.alias);
				if (!current) throw new Error(`Unknown account: ${requestedAccount.alias}`);
				const stillFresh = current.credential.expires > this.now() + this.refreshSkewMs;
				const anotherProcessRefreshed =
					stillFresh &&
					(current.credential.access !== requestedAccount.credential.access ||
						current.credential.refresh !== requestedAccount.credential.refresh ||
						current.credential.expires !== requestedAccount.credential.expires);
				if ((!options.force && stillFresh) || anotherProcessRefreshed) {
					return { state, result: current.alias };
				}
				const refreshed = normalizeOAuthCredential(
					await this._getOAuth().refresh(
						current.credential,
						options.signal ?? new AbortController().signal,
					),
				);
				const refreshedAccountId = getCredentialAccountId(refreshed);
				if (!refreshedAccountId || refreshedAccountId !== current.accountId) {
					throw new Error("OAuth refresh returned credentials for a different ChatGPT account");
				}
				current.credential = { ...refreshed, accountId: refreshedAccountId };
				current.email = getCredentialEmail(refreshed) ?? current.email;
				current.updatedAt = this.now();
				return { state, result: current.alias };
			});
			const account = findAccount(outcome.state, outcome.result);
			if (outcome.state.active && aliasKey(outcome.state.active) === aliasKey(account.alias)) {
				await writePiCodexCredential(this.authPath, account.credential);
			}
			this.cooldowns.delete(aliasKey(account.alias));
			this._emitChange();
			return cloneAccount(account);
		} catch (error) {
			this.cooldowns.set(aliasKey(requestedAccount.alias), {
				kind: "unavailable",
				until: this.now() + DEFAULT_UNAVAILABLE_COOLDOWN_MS,
				reason: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async _updateAccountEmail(alias, email) {
		if (!asText(email)) return;
		await this.store.modify((state) => {
			const account = findAccount(state, alias);
			if (account && account.email !== email) {
				account.email = email;
				account.updatedAt = this.now();
			}
			return state;
		});
	}

	async _fetchQuota(accountValue, options = {}) {
		const key = aliasKey(accountValue.alias);
		const cached = this.quota.get(key);
		if (!options.force && cached && this.now() - cached.checkedAt < this.quotaTtlMs) {
			const snapshot = cached.snapshot;
			if (
				!options.includeResetCreditDetails ||
				!snapshot ||
				snapshot.resetCreditDetailsChecked
			) {
				return snapshot;
			}
			const refreshed = await this._fetchResetCreditDetails(accountValue, snapshot, options);
			this.quota.set(key, { ...cached, snapshot: refreshed });
			return refreshed;
		}
		let account;
		try {
			account = await this._refreshCredential(accountValue, { signal: options.signal });
			let snapshot;
			try {
				snapshot = await fetchCodexUsage(account.credential, {
					fetchImpl: this.fetchImpl,
					signal: options.signal,
				});
			} catch (error) {
				if (error instanceof QuotaRequestError && (error.status === 401 || error.status === 403)) {
					account = await this._refreshCredential(account, { force: true, signal: options.signal });
					snapshot = await fetchCodexUsage(account.credential, {
						fetchImpl: this.fetchImpl,
						signal: options.signal,
					});
				} else {
					throw error;
				}
			}
			if (options.includeResetCreditDetails) {
				snapshot = await this._fetchResetCreditDetails(account, snapshot, options);
			}
			this.quota.set(key, { snapshot, checkedAt: this.now(), error: undefined });
			await this._updateAccountEmail(account.alias, snapshot.email);
			if (isQuotaExhausted(snapshot)) {
				this.cooldowns.set(key, {
					kind: "quota",
					until: getQuotaResetAt(snapshot, this.now()) ?? this.now() + DEFAULT_LIMIT_COOLDOWN_MS,
					reason: "subscription quota exhausted",
				});
			} else if (this.cooldowns.get(key)?.kind === "quota") {
				this.cooldowns.delete(key);
			}
			this._emitChange();
			return snapshot;
		} catch (error) {
			if (options.signal?.aborted) throw error;
			this.quota.set(key, {
				snapshot: cached?.snapshot,
				checkedAt: this.now(),
				error: error instanceof Error ? error.message : String(error),
			});
			this._emitChange();
			if (options.throwOnError) throw error;
			return cached?.snapshot;
		}
	}

	async _fetchResetCreditDetails(account, snapshot, options = {}) {
		const resetCreditExpiries = await fetchCodexResetCreditExpiries(
			account.credential,
			snapshot.resetCredits,
			{ fetchImpl: this.fetchImpl, signal: options.signal },
		);
		return { ...snapshot, resetCreditExpiries, resetCreditDetailsChecked: true };
	}

	_orderAccounts(state) {
		if (!state.active) return [...state.accounts];
		const index = state.accounts.findIndex((account) => aliasKey(account.alias) === aliasKey(state.active));
		if (index < 0) return [...state.accounts];
		return [...state.accounts.slice(index), ...state.accounts.slice(0, index)];
	}

	async _select(options = {}) {
		const state = await this.store.load();
		if (state.accounts.length === 0) throw new NoManagedAccountsError();
		const excluded = new Set([...(options.excludeAliases ?? [])].map(aliasKey));
		const order = this._orderAccounts(state);
		for (const original of order) {
			if (excluded.has(aliasKey(original.alias)) || this._isCoolingDown(original.alias)) continue;
			let account;
			try {
				account = await this._refreshCredential(original, { signal: options.signal });
			} catch {
				continue;
			}
			if (options.checkQuota !== false) {
				const snapshot = await this._fetchQuota(account, { signal: options.signal });
				if (isQuotaExhausted(snapshot)) continue;
			}
			return cloneAccount(await this._activate(account.alias));
		}

		if (options.allowExhausted) {
			for (const original of order) {
				if (excluded.has(aliasKey(original.alias))) continue;
				try {
					const account = await this._refreshCredential(original, { signal: options.signal });
					return cloneAccount(await this._activate(account.alias));
				} catch {
					// Try the next credential even if all quota snapshots are exhausted.
				}
			}
		}
		throw new NoManagedAccountsError("Every managed Codex account is exhausted or unavailable");
	}

	async prepareAttempt(options = {}) {
		return this._serialized(() =>
			this._select({
				...options,
				checkQuota: options.checkQuota !== false,
				allowExhausted: options.allowExhausted !== false,
			}),
		);
	}

	async ensureReady(options = {}) {
		return this._serialized(() =>
			this._select({
				checkQuota: options.checkQuota !== false,
				allowExhausted: true,
				signal: options.signal,
			}),
		);
	}

	async refreshAccount(alias, options = {}) {
		return this._serialized(async () => {
			const state = await this.store.load();
			const account = findAccount(state, alias);
			if (!account) throw new Error(`Unknown account: ${alias}`);
			await this._fetchQuota(account, {
				force: options.force !== false,
				signal: options.signal,
				includeResetCreditDetails: options.includeResetCreditDetails,
				throwOnError: options.throwOnError !== false,
			});
			const view = this._viewFromState(await this.store.load());
			return view.accounts.find((candidate) => aliasKey(candidate.alias) === aliasKey(alias));
		});
	}

	async refreshAll(options = {}) {
		return this._serialized(async () => {
			const state = await this.store.load();
			for (const account of state.accounts) {
				await this._fetchQuota(account, {
					force: options.force !== false,
					signal: options.signal,
					includeResetCreditDetails: options.includeResetCreditDetails,
				});
			}
			if (state.accounts.length > 0) {
				try {
					await this._select({ checkQuota: true, allowExhausted: true, signal: options.signal });
				} catch {
					// Preserve the last active account so the footer can report why none is usable.
				}
			}
			this._emitChange();
			return this._viewFromState(await this.store.load());
		});
	}

	async consumeResetCredit(alias, options = {}) {
		return this._serialized(async () => {
			let state = await this.store.load();
			let account = findAccount(state, alias);
			if (!account) throw new Error(`Unknown account: ${alias}`);
			const snapshot = await this._fetchQuota(account, {
				force: true,
				signal: options.signal,
				throwOnError: true,
			});
			if (snapshot?.resetCredits === undefined) return { consumed: false, reason: "unknown" };
			if (snapshot.resetCredits <= 0) return { consumed: false, reason: "none" };

			state = await this.store.load();
			account = findAccount(state, alias);
			if (!account) throw new Error(`Unknown account: ${alias}`);
			const credentialAccount = await this._refreshCredential(account, { signal: options.signal });
			const response = await consumeCodexResetCredit(credentialAccount.credential, {
				fetchImpl: this.fetchImpl,
				signal: options.signal,
			});
			const key = aliasKey(credentialAccount.alias);
			this.quota.delete(key);
			if (this.cooldowns.get(key)?.kind === "quota") this.cooldowns.delete(key);
			try {
				const refreshedSnapshot = await this._fetchQuota(credentialAccount, {
					force: true,
					signal: options.signal,
					includeResetCreditDetails: true,
					throwOnError: true,
				});
				return {
					consumed: true,
					refreshed: true,
					response,
					snapshot: refreshedSnapshot,
				};
			} catch (error) {
				this.quota.delete(key);
				return {
					consumed: true,
					refreshed: false,
					response,
					refreshError: error instanceof Error ? error.message : String(error),
				};
			}
		});
	}

	async chooseAuto(options = {}) {
		await this.refreshAll({ force: true, signal: options.signal });
		return this.prepareAttempt({ checkQuota: true, allowExhausted: true, signal: options.signal });
	}

	async noteLimited(alias, details = {}) {
		return this._serialized(async () => {
			const key = aliasKey(alias);
			const now = this.now();
			const headerSnapshot = parseCodexRateLimitHeaders(details.headers);
			if (headerSnapshot) this.quota.set(key, { snapshot: headerSnapshot, checkedAt: now });
			const snapshot = headerSnapshot ?? this.quota.get(key)?.snapshot;
			const until =
				parseRetryAfter(details.headers, now) ??
				getQuotaResetAt(snapshot, now) ??
				now + DEFAULT_LIMIT_COOLDOWN_MS;
			this.cooldowns.set(key, {
				kind: "quota",
				until,
				reason: asText(details.reason) ?? "provider rate limit",
			});
			this._emitChange();
			return until;
		});
	}

	async noteUnavailable(alias, details = {}) {
		return this._serialized(async () => {
			this.cooldowns.set(aliasKey(alias), {
				kind: "unavailable",
				until: this.now() + DEFAULT_UNAVAILABLE_COOLDOWN_MS,
				reason: asText(details.reason) ?? "account authentication failed",
			});
			this._emitChange();
		});
	}

	async noteSuccess(alias, details = {}) {
		return this._serialized(async () => {
			const key = aliasKey(alias);
			const snapshot = parseCodexRateLimitHeaders(details.headers);
			if (snapshot) this.quota.set(key, { snapshot, checkedAt: this.now() });
			if (this.cooldowns.get(key)?.kind === "unavailable") this.cooldowns.delete(key);
			this._emitChange();
		});
	}

	async getAccountCount() {
		return (await this.store.load()).accounts.length;
	}

	_viewFromState(state) {
		return {
			active: state.active,
			accounts: state.accounts.map((account) => {
				const key = aliasKey(account.alias);
				const quota = this.quota.get(key);
				const cooldown = this._isCoolingDown(account.alias);
				return {
					alias: account.alias,
					accountId: account.accountId,
					email: account.email,
					active: !!state.active && aliasKey(state.active) === key,
					quota: quota?.snapshot,
					quotaCheckedAt: quota?.checkedAt,
					quotaError: quota?.error,
					cooldown: cooldown ? structuredClone(cooldown) : undefined,
				};
			}),
		};
	}

	async getView() {
		await this.queue.catch(() => undefined);
		return this._viewFromState(await this.store.load());
	}
}
