import assert from "node:assert/strict";
import test from "node:test";

import {
	fetchCodexUsage,
	formatQuotaCompact,
	formatQuotaDetails,
	formatQuotaFooter,
	formatQuotaStatus,
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
