export const NOW = 2_000_000_000_000;

export function createAccessToken(accountId, email = `${accountId}@example.com`) {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
			"https://api.openai.com/profile": { email },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

export function createCredential(accountId, options = {}) {
	return {
		type: "oauth",
		access: options.access ?? createAccessToken(accountId, options.email),
		refresh: options.refresh ?? `refresh-${accountId}`,
		expires: options.expires ?? NOW + 60 * 60_000,
		accountId,
	};
}

export function quotaPayload(usedPrimary, usedSecondary = 10) {
	return {
		rate_limit: {
			primary_window: {
				used_percent: usedPrimary,
				limit_window_seconds: 5 * 60 * 60,
				reset_at: NOW / 1000 + 60 * 60,
			},
			secondary_window: {
				used_percent: usedSecondary,
				limit_window_seconds: 7 * 24 * 60 * 60,
				reset_at: NOW / 1000 + 24 * 60 * 60,
			},
		},
	};
}

export function assistantMessage(model = {}) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api ?? "openai-codex-responses",
		provider: model.provider ?? "openai-codex",
		model: model.id ?? "gpt-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: NOW,
	};
}

export function errorMessage(text, model = {}) {
	return {
		...assistantMessage(model),
		content: [],
		stopReason: "error",
		errorMessage: text,
	};
}

export function iterableEvents(events, setup) {
	return {
		async *[Symbol.asyncIterator]() {
			await setup?.();
			for (const event of events) yield event;
		},
	};
}
