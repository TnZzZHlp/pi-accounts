import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { setImmediate as nextTick, setTimeout as pollDelay } from "node:timers/promises";
import test from "node:test";

import { createPiAccountsExtension } from "../extensions/pi-accounts.js";
import { assistantMessage, createCredential, errorMessage, NOW } from "./helpers.js";

const MODEL = { provider: "openai-codex", id: "gpt-test", api: "openai-codex-responses" };
const MINUTE = 60_000;
const CONTEXT = { messages: [{ role: "user", content: "Continue the original task" }] };

async function until(predicate) {
	for (let attempt = 0; attempt < 10_000; attempt++) {
		if (predicate()) return;
		await pollDelay(1);
	}
	throw new Error("End-to-end request did not reach the expected state");
}

async function withSession(t, scenario, run) {
	let now = NOW;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const advance = (milliseconds) => {
		now += milliseconds;
		t.mock.timers.tick(milliseconds);
	};
	const clockDriver = setInterval(() => t.mock.timers.tick(1), 1);
	t.after(() => clearInterval(clockDriver));
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-wait-e2e-"));
	const requests = [];
	const statuses = [];
	const handlers = new Map();
	const accounts = new Map((scenario.accounts ?? ["alpha", "beta"]).map((alias) => [alias, createCredential(alias)]));
	let managed;
	const server = createServer(async (req, res) => {
		const alias = req.headers["chatgpt-account-id"];
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
		requests.push({ path: req.url, method: req.method, alias, body });
		res.setHeader("content-type", "application/json");
		if (req.url.endsWith("/usage")) {
			res.statusCode = scenario.quotaStatus?.(alias, now) ?? 200;
			res.end(JSON.stringify(scenario.quota(alias, now)));
		} else if (req.url === "/responses") {
			const response = scenario.response?.(alias, now) ?? { status: 200 };
			res.statusCode = response.status;
			for (const [key, value] of Object.entries(response.headers ?? {})) res.setHeader(key, value);
			const message = assistantMessage(MODEL);
			const events = [{ type: "start", partial: { ...message, content: [] } }];
			if (response.partial) events.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: message });
			events.push(response.status === 200
				? { type: "done", reason: "stop", message }
				: { type: "error", reason: "error", error: errorMessage(response.message ?? "usage limit", MODEL) });
			res.end(JSON.stringify(events));
		} else {
			res.statusCode = 500;
			res.end("{}");
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const base = {
		id: "openai-codex",
		name: "OpenAI Codex",
		auth: { oauth: { refresh: async (credential) => ({ ...credential, expires: now + 60 * MINUTE }) } },
		getModels: () => [MODEL],
		stream(_model, context, options) {
			return {
				async *[Symbol.asyncIterator]() {
					const alias = [...accounts].find(([, credential]) => credential.access === options.apiKey)?.[0];
					const response = await fetch(`${origin}/responses`, {
						method: "POST",
						headers: { "chatgpt-account-id": alias },
						body: JSON.stringify(context),
						signal: options.signal,
					});
					await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, MODEL);
					for (const event of await response.json()) yield event;
				},
			};
		},
		streamSimple(model, context, options) {
			return this.stream(model, context, options);
		},
	};
	const ctx = {
		model: MODEL,
		hasUI: true,
		modelRegistry: { getProvider: () => base, refresh: async () => ({}) },
		ui: {
			setStatus: (key, text) => statuses.push({ key, text }),
			setWidget() {},
			notify() {},
		},
	};
	const { manager } = createPiAccountsExtension({
		agentDir: dir,
		now: () => now,
		fetchImpl: (url, init) => fetch(`${origin}${new URL(url).pathname}`, init),
		pollIntervalMs: 24 * 60 * MINUTE,
	})({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand() {},
		registerProvider: (provider) => { managed = provider; },
	});
	let pendingViews = 0;
	const getView = manager.getView.bind(manager);
	manager.getView = async () => {
		pendingViews++;
		try {
			return await getView();
		} finally {
			pendingViews--;
		}
	};
	const controller = new AbortController();
	try {
		for (const [alias, credential] of accounts) await manager.addCredential(credential, alias);
		await manager.use("alpha");
		await handlers.get("session_start")({}, ctx);
		await handlers.get("before_agent_start")({}, ctx);
		await run({
			manager, requests, statuses, controller, advance,
			shutdown: () => handlers.get("session_shutdown")({}, ctx),
			start: (method = "streamSimple") => {
				const stream = managed[method](MODEL, CONTEXT, { signal: controller.signal });
				return { result: stream.result(), events: Array.fromAsync(stream) };
			},
			waiting: () => statuses.filter((entry) => entry.key === "pi-accounts-wait" && entry.text),
		});
		assert.equal(requests.some((request) => request.path.includes("reset-credits")), false);
	} finally {
		controller.abort();
		handlers.get("session_shutdown")({}, ctx);
		await manager.queue.catch(() => undefined);
		await until(() => pendingViews === 0);
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		clearInterval(clockDriver);
		t.mock.timers.reset();
		await rm(dir, { recursive: true, force: true });
	}
}

function quota(primaryReset, secondaryReset, now, unknown = false) {
	const window = (reset) => ({
		used_percent: reset > now ? 100 : 10,
		...(unknown ? {} : { reset_at: reset }),
	});
	return {
		rate_limit: { primary_window: window(primaryReset), secondary_window: window(secondaryReset) },
		rate_limit_reset_credits: { available_count: 2 },
	};
}

test("end-to-end waits for the earliest fully usable account and preserves the request", { timeout: 10_000 }, async (t) => {
	await withSession(t, {
		quota: (alias, now) => alias === "alpha"
			? quota(NOW + 10 * MINUTE, NOW + 30 * MINUTE, now)
			: quota(NOW + 20 * MINUTE, NOW - 1, now),
	}, async ({ manager, requests, start, waiting, statuses, advance }) => {
		const pending = start();
		await until(() => waiting().length > 0);
		assert.match(waiting()[0].text, /beta · 20m/);
		assert.equal(requests.some((request) => request.path === "/responses"), false);
		assert.equal((await manager.getView()).accounts.length, 2);
		advance(20 * MINUTE);
		assert.equal((await pending.result).stopReason, "stop");
		assert.deepEqual((await pending.events).map((event) => event.type), ["start", "done"]);
		const calls = requests.filter((request) => request.path === "/responses");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].alias, "beta");
		assert.deepEqual(calls[0].body, CONTEXT);
		assert.equal(statuses.filter((entry) => entry.key === "pi-accounts-wait").at(-1).text, undefined);
	});
});

test("end-to-end records the final quota failure, waits, and retries without duplicate start events", { timeout: 10_000 }, async (t) => {
	await withSession(t, {
		quota: () => ({ rate_limit: { allowed: true } }),
		response: (_alias, now) => now < NOW + MINUTE
			? { status: 429, headers: { "retry-after": "60" } }
			: { status: 200 },
	}, async ({ requests, start, waiting, advance }) => {
		const pending = start("stream");
		await until(() => waiting().length > 0);
		assert.equal(requests.filter((request) => request.path === "/responses").length, 2);
		advance(MINUTE);
		assert.equal((await pending.result).stopReason, "stop");
		assert.deepEqual((await pending.events).map((event) => event.type), ["start", "done"]);
		assert.equal(requests.filter((request) => request.path === "/responses").length, 3);
	});
});

test("end-to-end rechecks unknown reset times after five minutes", { timeout: 10_000 }, async (t) => {
	await withSession(t, {
		quota: (_alias, now) => quota(NOW + 5 * MINUTE, NOW - 1, now, true),
	}, async ({ requests, start, waiting, advance }) => {
		const pending = start();
		await until(() => waiting().length > 0);
		assert.match(waiting()[0].text, /5m/);
		const initialChecks = requests.length;
		advance(5 * MINUTE);
		assert.equal((await pending.result).stopReason, "stop");
		await pending.events;
		assert.ok(requests.length > initialChecks);
	});
});

test("end-to-end honors backend permission when percentages disagree", { timeout: 10_000 }, async (t) => {
	await withSession(t, {
		quota: (_alias, now) => ({
			rate_limit: {
				allowed: now >= NOW + 5 * MINUTE,
				primary_window: { used_percent: now < NOW + 5 * MINUTE ? 25 : 100 },
			},
		}),
	}, async ({ start, waiting, advance }) => {
		const pending = start();
		await until(() => waiting().length > 0);
		assert.match(waiting()[0].text, /next quota check/);
		advance(5 * MINUTE);
		assert.equal((await pending.result).stopReason, "stop");
		await pending.events;
	});
});

test("end-to-end probes the provider after reset when quota metadata becomes unavailable", { timeout: 10_000 }, async (t) => {
	await withSession(t, {
		quota: (_alias, now) => ({
			rate_limit: {
				primary_window: {
					used_percent: 100,
					reset_after_seconds: Math.max(0, (NOW + MINUTE - now) / 1000),
				},
			},
		}),
		quotaStatus: (_alias, now) => now >= NOW + MINUTE ? 503 : 200,
	}, async ({ requests, start, waiting, advance }) => {
		const pending = start();
		await until(() => waiting().length > 0);
		assert.equal(requests.some((request) => request.path === "/responses"), false);
		advance(MINUTE);
		assert.equal((await pending.result).stopReason, "stop");
		await pending.events;
		assert.equal(requests.filter((request) => request.path === "/responses").length, 1);
	});
});

test("end-to-end preserves a blocking weekly window absent from failure headers", { timeout: 10_000 }, async (t) => {
	await withSession(t, {
		accounts: ["alpha"],
		quota: (_alias, now) => ({
			...quota(NOW + 10 * MINUTE, NOW + 30 * MINUTE, now),
			rate_limit: {
				...quota(NOW + 10 * MINUTE, NOW + 30 * MINUTE, now).rate_limit,
				allowed: true,
			},
		}),
		response: (_alias, now) => now < NOW + 30 * MINUTE ? {
			status: 429,
			headers: {
				"retry-after": "60",
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-reset-at": String((NOW + 10 * MINUTE) / 1000),
			},
		} : { status: 200 },
	}, async ({ requests, start, waiting, advance }) => {
		const pending = start();
		await until(() => waiting().length > 0);
		assert.match(waiting()[0].text, /alpha · 30m/);
		advance(30 * MINUTE);
		assert.equal((await pending.result).stopReason, "stop");
		assert.deepEqual((await pending.events).map((event) => event.type), ["start", "done"]);
		assert.equal(requests.filter((request) => request.path === "/responses").length, 2);
	});
});

for (const cancel of ["request", "shutdown"]) {
	test(`end-to-end cancels a multi-week wait through ${cancel}`, { timeout: 10_000 }, async (t) => {
		await withSession(t, {
			quota: (_alias, now) => quota(NOW + 60 * 24 * 60 * MINUTE, NOW - 1, now),
		}, async ({ requests, controller, shutdown, start, waiting, statuses, advance }) => {
			const pending = start();
			await until(() => waiting().length > 0);
			advance(5 * MINUTE);
			await until(() => waiting().length > 1);
			assert.equal(requests.some((request) => request.path === "/responses"), false);
			if (cancel === "request") controller.abort();
			else shutdown();
			assert.equal((await pending.result).stopReason, "aborted");
			assert.deepEqual((await pending.events).map((event) => event.type), ["error"]);
			assert.equal(statuses.filter((entry) => entry.key === "pi-accounts-wait").at(-1).text, undefined);
			await nextTick();
			const count = requests.length;
			advance(5 * MINUTE);
			await nextTick();
			assert.equal(requests.length, count);
		});
	});
}

for (const failure of ["partial", "authentication"]) {
	test(`end-to-end does not wait or replay after ${failure} failures`, { timeout: 10_000 }, async (t) => {
		await withSession(t, {
			quota: () => ({ rate_limit: { allowed: true } }),
			response: () => failure === "partial"
				? { status: 429, partial: true }
				: { status: 401, message: "invalid token" },
		}, async ({ requests, start, waiting }) => {
			const pending = start();
			assert.equal((await pending.result).stopReason, "error");
			await pending.events;
			assert.equal(waiting().length, 0);
			assert.equal(requests.filter((request) => request.path === "/responses").length, failure === "partial" ? 1 : 2);
		});
	});
}
