import { JWT_ACCOUNT_CLAIM, JWT_PROFILE_CLAIM } from "./constants.js";

export function asRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function asFiniteNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function asText(value) {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return text || undefined;
}

export function decodeJwtPayload(accessToken) {
	if (typeof accessToken !== "string") return undefined;

	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return undefined;
		return asRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
	} catch {
		return undefined;
	}
}

export function extractChatGptAccountId(accessToken) {
	const claim = asRecord(decodeJwtPayload(accessToken)?.[JWT_ACCOUNT_CLAIM]);
	return asText(claim?.chatgpt_account_id);
}

export function extractChatGptAccountEmail(accessToken) {
	const claim = asRecord(decodeJwtPayload(accessToken)?.[JWT_PROFILE_CLAIM]);
	return asText(claim?.email);
}

export function normalizeOAuthCredential(value) {
	const credential = asRecord(value);
	if (
		credential?.type !== "oauth" ||
		!asText(credential.access) ||
		!asText(credential.refresh) ||
		asFiniteNumber(credential.expires) === undefined
	) {
		throw new Error("Expected a valid OAuth credential");
	}

	const normalized = structuredClone(credential);
	normalized.type = "oauth";
	normalized.access = credential.access;
	normalized.refresh = credential.refresh;
	normalized.expires = Number(credential.expires);
	const accountId = asText(credential.accountId) ?? extractChatGptAccountId(credential.access);
	if (accountId) normalized.accountId = accountId;
	return normalized;
}

export function getCredentialAccountId(credential) {
	return asText(credential?.accountId) ?? extractChatGptAccountId(credential?.access);
}

export function getCredentialEmail(credential) {
	return extractChatGptAccountEmail(credential?.access);
}

export function validateAlias(alias) {
	const value = asText(alias);
	if (!value || !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,31}$/u.test(value)) {
		throw new Error("Account alias must be 1-32 letters, numbers, dots, underscores, or hyphens");
	}
	return value;
}

export function aliasKey(alias) {
	return validateAlias(alias).toLocaleLowerCase("en-US");
}

function cleanDerivedAlias(value) {
	const cleaned = value
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/^[^\p{L}\p{N}]+/u, "")
		.slice(0, 32)
		.replace(/[^\p{L}\p{N}]+$/u, "");
	return cleaned || undefined;
}

export function deriveAccountAlias(credential, existingAliases = []) {
	const email = getCredentialEmail(credential);
	const accountId = getCredentialAccountId(credential);
	const base =
		cleanDerivedAlias(email?.split("@", 1)[0] ?? "") ??
		cleanDerivedAlias(accountId?.slice(-8) ?? "") ??
		"account";
	const existing = new Set(existingAliases.map((alias) => alias.toLocaleLowerCase("en-US")));

	if (!existing.has(base.toLocaleLowerCase("en-US"))) return base;
	for (let suffix = 2; suffix < 10_000; suffix++) {
		const candidate = `${base.slice(0, Math.max(1, 32 - String(suffix).length - 1))}-${suffix}`;
		if (!existing.has(candidate.toLocaleLowerCase("en-US"))) return candidate;
	}
	throw new Error("Could not derive a unique account alias");
}

export function maskEmail(email) {
	const value = asText(email);
	if (!value) return undefined;
	const at = value.indexOf("@");
	if (at <= 0) return value;
	const local = value.slice(0, at);
	const domain = value.slice(at + 1);
	const visible = local.length <= 2 ? local[0] ?? "" : local.slice(0, 2);
	return `${visible}${"*".repeat(Math.max(1, Math.min(4, local.length - visible.length)))}@${domain}`;
}
