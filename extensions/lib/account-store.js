import { ACCOUNT_STORE_VERSION, CODEX_PROVIDER } from "./constants.js";
import {
	aliasKey,
	asFiniteNumber,
	asRecord,
	asText,
	getCredentialAccountId,
	getCredentialEmail,
	normalizeOAuthCredential,
	validateAlias,
} from "./credentials.js";
import { readJsonLocked, updateJsonLocked } from "./file-store.js";

export function emptyAccountState() {
	return {
		version: ACCOUNT_STORE_VERSION,
		active: null,
		accounts: [],
	};
}

function normalizeAccount(value) {
	const account = asRecord(value);
	if (!account) throw new Error("Invalid account entry in pi-accounts.json");
	const credential = normalizeOAuthCredential(account.credential);
	const accountId = asText(account.accountId) ?? getCredentialAccountId(credential);
	if (!accountId) throw new Error("A managed account is missing its ChatGPT account id");
	const addedAt = asFiniteNumber(account.addedAt) ?? Date.now();
	const updatedAt = asFiniteNumber(account.updatedAt) ?? addedAt;
	return {
		alias: validateAlias(account.alias),
		accountId,
		email: asText(account.email) ?? getCredentialEmail(credential),
		credential: { ...credential, accountId },
		addedAt,
		updatedAt,
	};
}

export function normalizeAccountState(value) {
	const state = asRecord(value);
	if (!state) throw new Error("Invalid pi-accounts.json: expected an object");
	if (state.version !== ACCOUNT_STORE_VERSION) {
		throw new Error(
			`Unsupported pi-accounts.json version ${String(state.version)} (expected ${ACCOUNT_STORE_VERSION})`,
		);
	}
	if (!Array.isArray(state.accounts)) {
		throw new Error("Invalid pi-accounts.json: accounts must be an array");
	}
	const accounts = state.accounts.map(normalizeAccount);
	const aliases = new Set();
	const accountIds = new Set();
	for (const account of accounts) {
		const key = aliasKey(account.alias);
		if (aliases.has(key)) throw new Error(`Duplicate account alias: ${account.alias}`);
		if (accountIds.has(account.accountId)) throw new Error(`Duplicate ChatGPT account id: ${account.accountId}`);
		aliases.add(key);
		accountIds.add(account.accountId);
	}
	let active = state.active === null || state.active === undefined ? null : validateAlias(state.active);
	if (active && !aliases.has(aliasKey(active))) active = accounts[0]?.alias ?? null;
	return {
		version: ACCOUNT_STORE_VERSION,
		active,
		accounts,
	};
}

export function findAccount(state, alias) {
	const key = aliasKey(alias);
	return state.accounts.find((account) => aliasKey(account.alias) === key);
}

export class AccountStore {
	constructor(path) {
		this.path = path;
	}

	async load() {
		return normalizeAccountState(await readJsonLocked(this.path, emptyAccountState()));
	}

	async modify(mutator) {
		let result;
		const state = await updateJsonLocked(this.path, emptyAccountState(), async (raw) => {
			const current = normalizeAccountState(raw);
			const outcome = await mutator(structuredClone(current));
			if (asRecord(outcome) && "state" in outcome) {
				result = outcome.result;
				return normalizeAccountState(outcome.state);
			}
			return normalizeAccountState(outcome ?? current);
		});
		return { state: normalizeAccountState(state), result };
	}
}

export async function readPiCodexCredential(authPath) {
	const auth = await readJsonLocked(authPath, {});
	const record = asRecord(auth);
	if (!record) throw new Error("Invalid auth.json: expected an object");
	const credential = record[CODEX_PROVIDER];
	if (credential === undefined) return undefined;
	return normalizeOAuthCredential(credential);
}

export async function writePiCodexCredential(authPath, credentialValue) {
	await updateJsonLocked(authPath, {}, async (raw) => {
		const auth = asRecord(raw);
		if (!auth) throw new Error("Invalid auth.json: expected an object");
		const next = structuredClone(auth);
		if (credentialValue === undefined) {
			delete next[CODEX_PROVIDER];
		} else {
			next[CODEX_PROVIDER] = normalizeOAuthCredential(credentialValue);
		}
		return next;
	});
}
