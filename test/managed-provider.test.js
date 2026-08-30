import assert from "node:assert/strict";
import test from "node:test";

import {
	classifySwitchableFailure,
	createManagedProvider,
} from "../extensions/lib/managed-provider.js";
import {
	assistantMessage,
	createCredential,
	errorMessage,
	iterableEvents,
} from "./helpers.js";

const MODEL = { provider: "openai-codex", id: "gpt-test", api: "openai-codex-responses" };

function createManager() {
	const accounts = [
		{ alias: "alpha", credential: createCredential("alpha") },
		{ alias: "beta", credential: createCredential("beta") },
	];
	const notes = [];
	return {
		notes,
		async getAccountCount() {
			return accounts.length;
		},
		async prepareAttempt(options) {
			return accounts.find((account) => !options.excludeAliases.has(account.alias));
		},
		async noteLimited(alias, details) {
			notes.push({ type: "limited", alias, details });
		},
		async noteUnavailable(alias, details) {
			notes.push({ type: "unavailable", alias, details });
		},
		async noteSuccess(alias) {
			notes.push({ type: "success", alias });
		},
	};
}

test("retries a 429 with the next account before exposing an error", async () => {
	const manager = createManager();
	const calls = [];
	const base = {
		id: "openai-codex",
		name: "OpenAI Codex",
		auth: { oauth: {} },
		getModels: () => [MODEL],
		stream(_model, _context, options) {
			calls.push({ token: options.apiKey, maxRetries: options.maxRetries });
			if (options.apiKey === createCredential("alpha").access) {
				return iterableEvents(
					[{ type: "error", reason: "error", error: errorMessage("You've hit your usage limit", MODEL) }],
					() => options.onResponse?.({ status: 429, headers: { "retry-after": "60" } }, MODEL),
				);
			}
			const message = assistantMessage(MODEL);
			return iterableEvents([
				{ type: "start", partial: message },
				{ type: "done", reason: "stop", message },
			]);
		},
		streamSimple(model, context, options) {
			return this.stream(model, context, options);
		},
	};
	const wrapper = createManagedProvider(base, manager);
	const events = [];
	for await (const event of wrapper.stream(MODEL, { messages: [] }, {})) events.push(event);
	assert.deepEqual(events.map((event) => event.type), ["start", "done"]);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((call) => call.maxRetries), [0, 0]);
	assert.notEqual(calls[0].token, calls[1].token);
	assert.deepEqual(manager.notes.map((note) => [note.type, note.alias]), [
		["limited", "alpha"],
		["success", "beta"],
	]);
});

test("does not retry after meaningful output has already streamed", async () => {
	const manager = createManager();
	let calls = 0;
	const partial = assistantMessage(MODEL);
	const base = {
		id: "openai-codex",
		name: "OpenAI Codex",
		auth: { oauth: {} },
		getModels: () => [MODEL],
		stream() {
			calls++;
			return iterableEvents([
				{ type: "start", partial },
				{ type: "text_delta", contentIndex: 0, delta: "partial", partial },
				{ type: "error", reason: "error", error: errorMessage("usage limit", MODEL) },
			]);
		},
		streamSimple(model, context, options) {
			return this.stream(model, context, options);
		},
	};
	const events = [];
	for await (const event of createManagedProvider(base, manager).stream(MODEL, { messages: [] }, {})) {
		events.push(event.type);
	}
	assert.deepEqual(events, ["start", "text_delta", "error"]);
	assert.equal(calls, 1);
});

test("classifies quota and authentication failures conservatively", () => {
	assert.equal(classifySwitchableFailure(429), "quota");
	assert.equal(classifySwitchableFailure(undefined, "Usage limit reached"), "quota");
	assert.equal(classifySwitchableFailure(401), "unavailable");
	assert.equal(classifySwitchableFailure(undefined, "socket closed"), undefined);
});
