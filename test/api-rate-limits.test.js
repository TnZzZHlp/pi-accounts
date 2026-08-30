import assert from "node:assert/strict";
import test from "node:test";

import {
	formatOpenAiRateLimitStatus,
	isGptModel,
	parseOpenAiRateLimits,
} from "../extensions/lib/api-rate-limits.js";

test("parses and formats standard OpenAI API request and token limits", () => {
	const snapshot = parseOpenAiRateLimits({
		"X-RateLimit-Remaining-Requests": "59",
		"x-ratelimit-reset-requests": "1s",
		"x-ratelimit-remaining-tokens": "149984",
		"x-ratelimit-reset-tokens": "6m0s",
	});
	assert.deepEqual(snapshot, {
		remainingRequests: 59,
		resetRequests: "1s",
		remainingTokens: 149984,
		resetTokens: "6m0s",
	});
	assert.equal(
		formatOpenAiRateLimitStatus(snapshot),
		"GPT API: requests 59 left, reset 1s | tokens 149,984 left, reset 6m0s",
	);
});

test("ignores unrelated response headers and recognizes GPT model ids", () => {
	assert.equal(parseOpenAiRateLimits({ "content-type": "application/json" }), undefined);
	assert.equal(isGptModel({ id: "gpt-5.6-terra" }), true);
	assert.equal(isGptModel({ id: "claude-sonnet" }), false);
});
