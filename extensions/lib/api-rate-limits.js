import { asFiniteNumber, asRecord, asText } from "./credentials.js";

function getHeader(headers, name) {
	const record = asRecord(headers);
	if (!record) return undefined;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(record)) {
		if (key.toLowerCase() === expected) return asText(value);
	}
	return undefined;
}

export function parseOpenAiRateLimits(headers) {
	const snapshot = {
		remainingRequests: asFiniteNumber(getHeader(headers, "x-ratelimit-remaining-requests")),
		resetRequests: getHeader(headers, "x-ratelimit-reset-requests"),
		remainingTokens: asFiniteNumber(getHeader(headers, "x-ratelimit-remaining-tokens")),
		resetTokens: getHeader(headers, "x-ratelimit-reset-tokens"),
	};
	if (
		snapshot.remainingRequests === undefined &&
		snapshot.resetRequests === undefined &&
		snapshot.remainingTokens === undefined &&
		snapshot.resetTokens === undefined
	) {
		return undefined;
	}
	return snapshot;
}

function formatCount(value) {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

export function formatOpenAiRateLimitStatus(snapshot) {
	if (!snapshot) return undefined;
	const parts = [];
	if (snapshot.remainingRequests !== undefined || snapshot.resetRequests !== undefined) {
		let text = "requests";
		if (snapshot.remainingRequests !== undefined) {
			text += ` ${formatCount(snapshot.remainingRequests)} left`;
		}
		if (snapshot.resetRequests) {
			text += `${snapshot.remainingRequests === undefined ? "" : ","} reset ${snapshot.resetRequests.slice(0, 24)}`;
		}
		parts.push(text);
	}
	if (snapshot.remainingTokens !== undefined || snapshot.resetTokens !== undefined) {
		let text = "tokens";
		if (snapshot.remainingTokens !== undefined) {
			text += ` ${formatCount(snapshot.remainingTokens)} left`;
		}
		if (snapshot.resetTokens) {
			text += `${snapshot.remainingTokens === undefined ? "" : ","} reset ${snapshot.resetTokens.slice(0, 24)}`;
		}
		parts.push(text);
	}
	return parts.length > 0 ? `GPT API: ${parts.join(" | ")}` : undefined;
}

export function isGptModel(model) {
	return typeof model?.id === "string" && /^gpt-/i.test(model.id);
}
