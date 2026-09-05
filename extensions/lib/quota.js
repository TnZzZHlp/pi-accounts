import { randomUUID } from "node:crypto";

import {
	CODEX_RESET_CREDITS_CONSUME_URL,
	CODEX_USAGE_URL,
	REQUEST_TIMEOUT_MS,
} from "./constants.js";
import {
	asFiniteNumber,
	asRecord,
	asText,
	extractChatGptAccountEmail,
	getCredentialAccountId,
	normalizeOAuthCredential,
} from "./credentials.js";

export class QuotaRequestError extends Error {
	constructor(message, status) {
		super(message);
		this.name = "QuotaRequestError";
		this.status = status;
	}
}

export class ResetCreditRequestError extends QuotaRequestError {
	constructor(message, status, code, outcome = "unknown") {
		super(message, status);
		this.name = "ResetCreditRequestError";
		this.code = code;
		this.outcome = outcome;
	}
}

function clampPercent(value) {
	return Math.max(0, Math.min(100, value));
}

function normalizeResetAt(value) {
	const timestamp = asFiniteNumber(value);
	if (timestamp === undefined || timestamp <= 0) return undefined;
	return timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
}

function parseWindow(value) {
	const window = asRecord(value);
	if (!window) return undefined;
	const usedPercent = asFiniteNumber(window.used_percent ?? window.usedPercent);
	if (usedPercent === undefined) return undefined;
	const seconds = asFiniteNumber(window.limit_window_seconds ?? window.limitWindowSeconds);
	const minutes = asFiniteNumber(
		window.window_minutes ?? window.windowMinutes ?? window.windowDurationMins,
	);
	return {
		usedPercent: clampPercent(usedPercent),
		resetAt: normalizeResetAt(
			window.reset_at ?? window.resets_at ?? window.resetAt ?? window.resetsAt,
		),
		resetAfterSeconds: asFiniteNumber(window.reset_after_seconds ?? window.resetAfterSeconds),
		windowSeconds: seconds ?? (minutes === undefined ? undefined : minutes * 60),
	};
}

export function parseCodexUsage(payload) {
	const data = asRecord(payload);
	if (!data) return undefined;
	const rateLimit = asRecord(data.rate_limit) ?? asRecord(data.rateLimit);
	const resetCredits =
		asRecord(data.rate_limit_reset_credits) ?? asRecord(data.rateLimitResetCredits);
	const availableResetCredits = asFiniteNumber(
		resetCredits?.available_count ?? resetCredits?.availableCount,
	);
	const snapshot = {
		email: asText(data.email ?? data.account_email ?? data.accountEmail),
		planType: asText(data.plan_type ?? data.planType),
		primary: parseWindow(
			rateLimit?.primary_window ?? rateLimit?.primaryWindow ?? rateLimit?.primary,
		),
		secondary: parseWindow(
			rateLimit?.secondary_window ?? rateLimit?.secondaryWindow ?? rateLimit?.secondary,
		),
		resetCredits:
			availableResetCredits === undefined || availableResetCredits < 0
				? undefined
				: Math.floor(availableResetCredits),
	};
	if (!snapshot.primary && !snapshot.secondary && snapshot.resetCredits === undefined) return undefined;
	return snapshot;
}

function getHeader(headers, name) {
	const record = asRecord(headers);
	if (!record) return undefined;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(record)) {
		if (key.toLowerCase() === expected) return asText(value);
	}
	return undefined;
}

export function parseCodexRateLimitHeaders(headers) {
	return parseCodexUsage({
		rate_limit: {
			primary_window: {
				used_percent: getHeader(headers, "x-codex-primary-used-percent"),
				window_minutes: getHeader(headers, "x-codex-primary-window-minutes"),
				reset_at: getHeader(headers, "x-codex-primary-reset-at"),
			},
			secondary_window: {
				used_percent: getHeader(headers, "x-codex-secondary-used-percent"),
				window_minutes: getHeader(headers, "x-codex-secondary-window-minutes"),
				reset_at: getHeader(headers, "x-codex-secondary-reset-at"),
			},
		},
	});
}

function getWindowResetAt(window, now) {
	return (
		window?.resetAt ??
		(window?.resetAfterSeconds === undefined ? undefined : now + window.resetAfterSeconds * 1000)
	);
}

export function getQuotaResetAt(snapshot, now = Date.now()) {
	const exhaustedResets = [snapshot?.primary, snapshot?.secondary]
		.filter((window) => window?.usedPercent >= 100)
		.map((window) => getWindowResetAt(window, now))
		.filter((value) => value !== undefined && value > now);
	return exhaustedResets.length > 0 ? Math.min(...exhaustedResets) : undefined;
}

export function isQuotaExhausted(snapshot) {
	return [snapshot?.primary, snapshot?.secondary].some(
		(window) => window && asFiniteNumber(window.usedPercent) !== undefined && window.usedPercent >= 100,
	);
}

export function quotaRemainingPercent(window) {
	const used = asFiniteNumber(window?.usedPercent);
	return used === undefined ? undefined : Math.round(clampPercent(100 - used));
}

export function formatWindowLength(seconds, fallback) {
	if (seconds === undefined || seconds <= 0) return fallback;
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${Math.round(seconds)}s`;
}

export function formatRemainingTime(milliseconds) {
	const totalMinutes = Math.ceil(Math.max(0, milliseconds) / 60_000);
	if (totalMinutes === 0) return "now";
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	const parts = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	return parts.join(" ");
}

function formatWindow(window, fallback, now, includeReset) {
	const remaining = quotaRemainingPercent(window);
	if (remaining === undefined) return undefined;
	const label = formatWindowLength(window.windowSeconds, fallback);
	if (!includeReset) return `${label} ${remaining}%`;
	const resetAt = getWindowResetAt(window, now);
	return `${label} ${remaining}%${resetAt ? ` (reset ${formatRemainingTime(resetAt - now)})` : ""}`;
}

function formatWindowVerbose(window, fallback, now) {
	const remaining = quotaRemainingPercent(window);
	if (remaining === undefined) return undefined;
	const label = formatWindowLength(window.windowSeconds, fallback);
	const resetAt = getWindowResetAt(window, now);
	return `${label} ${remaining}% left${resetAt ? `, reset ${formatRemainingTime(resetAt - now)}` : ""}`;
}

function formatResetTimeCompact(milliseconds) {
	const totalMinutes = Math.max(1, Math.ceil(Math.max(0, milliseconds) / 60_000));
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const totalHours = Math.ceil(totalMinutes / 60);
	if (totalHours < 24) return `${totalHours}h`;
	return `${Math.ceil(totalHours / 24)}d`;
}

export function formatQuotaCompact(snapshot, now = Date.now()) {
	if (!snapshot) return undefined;
	const windows = [
		formatWindow(snapshot.primary, "primary", now, false),
		formatWindow(snapshot.secondary, "secondary", now, false),
	].filter(Boolean);
	return windows.length > 0 ? windows.join(" · ") : undefined;
}

function formatWindowForStatusBar(window, fallback, now) {
	const remaining = quotaRemainingPercent(window);
	if (remaining === undefined) return undefined;
	const resetAt = getWindowResetAt(window, now);
	const label =
		resetAt === undefined
			? formatWindowLength(window.windowSeconds, fallback)
			: formatRemainingTime(resetAt - now);
	return `${label} ${remaining}%`;
}

export function formatQuotaStatusBar(snapshot, now = Date.now()) {
	if (!snapshot) return undefined;
	const windows = [
		formatWindowForStatusBar(snapshot.primary, "primary", now),
		formatWindowForStatusBar(snapshot.secondary, "secondary", now),
	].filter(Boolean);
	return windows.length > 0 ? windows.join(" · ") : undefined;
}

export function formatQuotaFooter(snapshot, now = Date.now()) {
	const quota = formatQuotaCompact(snapshot, now);
	if (!quota) return undefined;
	const resetAt = [snapshot?.primary, snapshot?.secondary]
		.map((window) => (window ? getWindowResetAt(window, now) : undefined))
		.filter((value) => value !== undefined && value > now)
		.sort((left, right) => left - right)[0];
	return resetAt ? `${quota} · ${formatResetTimeCompact(resetAt - now)}` : quota;
}

export function formatQuotaStatus(snapshot, now = Date.now()) {
	if (!snapshot) return undefined;
	const parts = [
		formatWindowVerbose(snapshot.primary, "primary", now),
		formatWindowVerbose(snapshot.secondary, "secondary", now),
	].filter(Boolean);
	if (snapshot.resetCredits !== undefined) parts.push(`reset credits ${snapshot.resetCredits}`);
	return parts.length > 0 ? parts.join(" | ") : undefined;
}

export function formatQuotaDetails(snapshot, now = Date.now()) {
	if (!snapshot) return "quota unavailable";
	const windows = [
		formatWindow(snapshot.primary, "primary", now, true),
		formatWindow(snapshot.secondary, "secondary", now, true),
	].filter(Boolean);
	if (snapshot.resetCredits !== undefined) windows.push(`reset credits ${snapshot.resetCredits}`);
	return windows.length > 0 ? windows.join(" | ") : "quota unavailable";
}

function combineSignals(signal, timeoutMs) {
	const signals = [signal, timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined].filter(Boolean);
	if (signals.length === 0) return undefined;
	return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

export async function fetchCodexUsage(credentialValue, options = {}) {
	const credential = normalizeOAuthCredential(credentialValue);
	const accountId = getCredentialAccountId(credential);
	if (!accountId) throw new Error("Could not extract the ChatGPT account id from the OAuth token");
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this runtime");
	const response = await fetchImpl(options.url ?? CODEX_USAGE_URL, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${credential.access}`,
			"chatgpt-account-id": accountId,
			originator: "pi",
		},
		signal: combineSignals(options.signal, options.timeoutMs ?? REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new QuotaRequestError(`Codex quota request failed (${response.status})`, response.status);
	}
	const snapshot = parseCodexUsage(await response.json());
	if (!snapshot) throw new Error("Codex quota response did not contain usage data");
	return {
		...snapshot,
		email: snapshot.email ?? extractChatGptAccountEmail(credential.access),
	};
}

function isDefiniteResetCreditRejection(status) {
	return Number.isInteger(status) && status >= 400 && status < 500;
}

function unknownResetCreditError(reason, status, code, cause) {
	const error = new ResetCreditRequestError(
		`Codex reset credit result is unknown${reason ? ` (${reason})` : ""}; the credit may already have been consumed. Do not retry now; verify the result with the service provider first.`,
		status,
		code,
		"unknown",
	);
	if (cause !== undefined) error.cause = cause;
	return error;
}

export async function consumeCodexResetCredit(credentialValue, options = {}) {
	const credential = normalizeOAuthCredential(credentialValue);
	const accountId = getCredentialAccountId(credential);
	if (!accountId) throw new Error("Could not extract the ChatGPT account id from the OAuth token");
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this runtime");
	const redeemRequestId = randomUUID();
	let response;
	try {
		response = await fetchImpl(options.url ?? CODEX_RESET_CREDITS_CONSUME_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${credential.access}`,
				"chatgpt-account-id": accountId,
				originator: "pi",
			},
			body: JSON.stringify({ redeem_request_id: redeemRequestId }),
			signal: combineSignals(options.signal, options.timeoutMs ?? REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw unknownResetCreditError("the request failed", undefined, undefined, error);
	}

	if (!response?.ok) {
		if (isDefiniteResetCreditRejection(response?.status)) {
			throw new ResetCreditRequestError(
				`Codex reset credit request was rejected (${response.status})`,
				response.status,
				undefined,
				"rejected",
			);
		}
		throw unknownResetCreditError(
			`the provider returned HTTP ${response?.status ?? "an unknown status"}`,
			response?.status,
		);
	}

	let payload;
	try {
		payload = asRecord(await response.json());
	} catch (error) {
		throw unknownResetCreditError("the provider response could not be parsed", response.status, undefined, error);
	}
	if (!payload) {
		throw unknownResetCreditError("the provider response was not a JSON object", response.status);
	}

	const code = asText(payload.code);
	if (code === "reset") {
		return {
			code,
			windowsReset: asFiniteNumber(payload.windows_reset ?? payload.windowsReset),
		};
	}
	if (code === "no_credit") {
		throw new ResetCreditRequestError(
			"Codex reset credit request was rejected: no reset credit is available",
			response.status,
			code,
			"rejected",
		);
	}
	throw unknownResetCreditError(
		`the provider returned unknown response code ${code ?? "unknown"}`,
		response.status,
		code,
	);
}

export function parseRetryAfter(headers, now = Date.now()) {
	const retryAfterMs = asFiniteNumber(getHeader(headers, "retry-after-ms"));
	if (retryAfterMs !== undefined && retryAfterMs >= 0) return now + retryAfterMs;
	const retryAfter = getHeader(headers, "retry-after");
	const seconds = asFiniteNumber(retryAfter);
	if (seconds !== undefined && seconds >= 0) return now + seconds * 1000;
	if (retryAfter) {
		const timestamp = Date.parse(retryAfter);
		if (Number.isFinite(timestamp) && timestamp > now) return timestamp;
	}
	return undefined;
}
