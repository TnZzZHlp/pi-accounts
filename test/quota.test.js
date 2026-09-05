import assert from "node:assert/strict";
import test from "node:test";

import {
	consumeCodexResetCredit,
	fetchCodexUsage,
	formatQuotaCompact,
	formatQuotaDetails,
	formatQuotaFooter,
	formatQuotaStatus,
	formatQuotaStatusBar,
	formatRemainingTime,
	getQuotaResetAt,
	isQuotaExhausted,
	parseCodexRateLimitHeaders,
	parseCodexUsage,
} from "../extensions/lib/quota.js";
import {
	deriveAccountAlias,
	extractChatGptAccountEmail,
	extractChatGptAccountId,
	maskEmail,
	validateAlias,
} from "../extensions/lib/credentials.js";
import { createAccessToken, createCredential, NOW, quotaPayload } from "./helpers.js";

test("normalizes and formats five-hour and seven-day Codex quota", () => {
	const snapshot = parseCodexUsage(quotaPayload(25, 83));
	assert.equal(formatQuotaCompact(snapshot, NOW), "5h 75% · 7d 17%");
	assert.equal(
		formatQuotaDetails(snapshot, NOW),
		"5h 75% (reset 1h) | 7d 17% (reset 1d)",
	);
	assert.equal(
		formatQuotaFooter(snapshot, NOW),
		"5h 75% · 7d 17% · 1h",
	);
	assert.equal(formatQuotaStatusBar(snapshot, NOW), "1h 75% · 1d 17%");
	assert.equal(
		formatQuotaStatus({ ...snapshot, resetCredits: 2 }, NOW),
		"5h 75% left, reset 1h | 7d 17% left, reset 1d | reset credits 2",
	);
	assert.equal(isQuotaExhausted(snapshot), false);
	assert.equal(formatRemainingTime((2 * 24 * 60 + 3 * 60 + 4) * 60_000), "2d 3h 4m");
});

test("treats either exhausted quota window as unavailable until its reset", () => {
	const snapshot = parseCodexUsage(quotaPayload(100, 20));
	assert.equal(isQuotaExhausted(snapshot), true);
	assert.equal(getQuotaResetAt(snapshot, NOW), NOW + 60 * 60_000);
});

test("parses legacy Codex response headers", () => {
	const snapshot = parseCodexRateLimitHeaders({
		"x-codex-primary-used-percent": "50",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-at": String(NOW / 1000 + 3600),
	});
	assert.equal(formatQuotaCompact(snapshot, NOW), "5h 50%");
});

test("formats status-bar windows by their reset times", () => {
	const snapshot = parseCodexUsage({
		rate_limit: {
			primary_window: {
				used_percent: 4,
				limit_window_seconds: 5 * 60 * 60,
				reset_at: NOW / 1000 + 4 * 60 * 60 + 3 * 60,
			},
			secondary_window: {
				used_percent: 10,
				limit_window_seconds: 7 * 24 * 60 * 60,
				reset_after_seconds: 3 * 24 * 60 * 60 + 2 * 60 * 60,
			},
		},
	});
	assert.equal(formatQuotaStatusBar(snapshot, NOW), "4h 3m 96% · 3d 2h 90%");
});

test("labels single Codex windows by their reported duration", () => {
	assert.equal(
		formatQuotaFooter(
			{
				primary: {
					usedPercent: 4,
					windowSeconds: 7 * 24 * 60 * 60,
					resetAt: NOW + (4 * 24 * 60 + 2 * 60 + 3) * 60_000,
				},
			},
			NOW,
		),
		"7d 96% · 5d",
	);
	assert.equal(formatQuotaFooter({ primary: {} }, NOW), undefined);
});

test("consumes one reset credit with the selected account authentication", async () => {
	const credential = createCredential("account-alpha");
	const calls = [];
	const response = await consumeCodexResetCredit(credential, {
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return { ok: true, status: 200, json: async () => ({ code: "reset", windows_reset: 2 }) };
		},
	});
	assert.equal(calls.length, 1);
	assert.match(calls[0].url, /rate-limit-reset-credits\/consume$/);
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.headers.Authorization, `Bearer ${credential.access}`);
	assert.equal(calls[0].init.headers["chatgpt-account-id"], "account-alpha");
	assert.equal(calls[0].init.headers["Content-Type"], "application/json");
	const body = JSON.parse(calls[0].init.body);
	assert.match(body.redeem_request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	assert.equal("credit_id" in body, false);
	assert.deepEqual(response, { code: "reset", windowsReset: 2 });
});

test("does not retry failed reset-credit requests or accept business failures", async () => {
	const credential = createCredential("account-alpha");
	let calls = 0;
	await assert.rejects(
		consumeCodexResetCredit(credential, {
			fetchImpl: async () => {
				calls++;
				return { ok: false, status: 403, json: async () => ({}) };
			},
		}),
		(error) =>
			error.name === "ResetCreditRequestError" &&
			error.status === 403 &&
			error.outcome === "rejected",
	);
	assert.equal(calls, 1);

	await assert.rejects(
		consumeCodexResetCredit(credential, {
			fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: "no_credit" }) }),
		}),
		(error) =>
			error.name === "ResetCreditRequestError" &&
			error.code === "no_credit" &&
			error.outcome === "rejected",
	);

	await assert.rejects(
		consumeCodexResetCredit(credential, {
			fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: "future_status" }) }),
		}),
		(error) =>
			error.name === "ResetCreditRequestError" &&
			error.code === "future_status" &&
			error.outcome === "unknown" &&
			/may already have been consumed/.test(error.message),
	);
});

test("marks network, server, and malformed reset-credit responses as unknown", async () => {
	const credential = createCredential("account-alpha");
	const scenarios = [
		{
			name: "network",
			fetchImpl: async () => {
				throw new Error("offline");
			},
		},
		{
			name: "server",
			fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
		},
		{
			name: "malformed JSON",
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				json: async () => {
					throw new SyntaxError("invalid JSON");
				},
			}),
		},
	];

	for (const scenario of scenarios) {
		let calls = 0;
		await assert.rejects(
			consumeCodexResetCredit(credential, {
				fetchImpl: async (...args) => {
					calls++;
					return scenario.fetchImpl(...args);
				},
			}),
			(error) => {
				assert.equal(error.name, "ResetCreditRequestError", scenario.name);
				assert.equal(error.outcome, "unknown", scenario.name);
				assert.match(error.message, /may already have been consumed/);
				assert.match(error.message, /Do not retry now/);
				return true;
			},
		);
		assert.equal(calls, 1, `${scenario.name} must issue exactly one POST`);
	}
});

test("fetches quota with the selected account token and id", async () => {
	const credential = createCredential("account-alpha");
	const calls = [];
	const snapshot = await fetchCodexUsage(credential, {
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return { ok: true, status: 200, json: async () => quotaPayload(10, 20) };
		},
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].init.headers.Authorization, `Bearer ${credential.access}`);
	assert.equal(calls[0].init.headers["chatgpt-account-id"], "account-alpha");
	assert.equal(formatQuotaCompact(snapshot, NOW), "5h 90% · 7d 80%");
});

test("extracts account identity and derives unique safe aliases", () => {
	const token = createAccessToken("account-123", "Alpha.User@example.com");
	assert.equal(extractChatGptAccountId(token), "account-123");
	assert.equal(extractChatGptAccountEmail(token), "Alpha.User@example.com");
	assert.equal(deriveAccountAlias({ access: token }, ["Alpha.User"]), "Alpha.User-2");
	assert.equal(maskEmail("Alpha.User@example.com"), "Al****@example.com");
	assert.equal(validateAlias("工作号-2"), "工作号-2");
	assert.throws(() => validateAlias("two words"), /Account alias/);
});
