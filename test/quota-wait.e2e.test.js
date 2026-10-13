import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { setImmediate as nextTick, setTimeout as pollDelay } from "node:timers/promises";
import test from "node:test";

import { createPiAccountsExtension } from "../extensions/pi-accounts.js";
import { SELECTION_ENTRY_TYPE } from "../extensions/lib/account-selection.js";
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
	const commands = new Map();
	const branches = new Map([["main", []]]);
	let currentBranch = "main";
	const accounts = new Map((scenario.accounts ?? ["alpha", "beta"]).map((alias) => [alias, createCredential(alias)]));
	let managed;
	const server = createServer(async (req, res) => {
		const alias = req.headers["chatgpt-account-id"];
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
		const authorization = req.headers.authorization;
		requests.push({
			path: req.url,
			method: req.method,
			alias,
			body,
			token: typeof authorization === "string" ? authorization.replace(/^Bearer /, "") : undefined,
		});
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
		auth: {
			oauth: {
				refresh: async (credential) => {
					const refreshed = scenario.refreshCredential
						? await scenario.refreshCredential(credential, now)
						: { ...credential, expires: now + 60 * MINUTE };
					const alias = credential.accountId;
					if (accounts.has(alias)) accounts.set(alias, refreshed);
					return refreshed;
				},
			},
		},
		getModels: () => [MODEL],
		stream(_model, context, options) {
			return {
				async *[Symbol.asyncIterator]() {
					const alias = [...accounts].find(([, credential]) => credential.access === options.apiKey)?.[0];
					const response = await fetch(`${origin}/responses`, {
						method: "POST",
						headers: {
							"chatgpt-account-id": alias,
							authorization: `Bearer ${options.apiKey}`,
						},
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
		sessionManager: scenario.sessionBranches ? { getBranch: () => branches.get(currentBranch) } : undefined,
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
		quotaTtlMs: scenario.quotaTtlMs,
		fetchImpl: (url, init) => {
			const handled = scenario.fetchQuota?.(url, init, now);
			return handled ?? fetch(`${origin}${new URL(url).pathname}`, init);
		},
		pollIntervalMs: scenario.pollIntervalMs ?? 24 * 60 * MINUTE,
	})({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerProvider: (provider) => { managed = provider; },
		appendEntry: scenario.sessionBranches
			? (customType, data) => branches.get(currentBranch).push({ type: "custom", customType, data })
			: undefined,
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
		if (scenario.mode === "specified") await commands.get("accounts").handler("use alpha", ctx);
		await handlers.get("before_agent_start")({}, ctx);
		await run({
			manager, requests, statuses, controller, advance, accounts, dir, handlers, branches,
			selectBranch: (name) => {
				if (!branches.has(name)) branches.set(name, []);
				currentBranch = name;
				return {
					...ctx,
					sessionManager: { getBranch: () => branches.get(name) },
				};
			},
			command: (args) => commands.get("accounts").handler(args, ctx),
			agentEnd: () => handlers.get("agent_end")({}, ctx),
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

test("end-to-end waits for the specified account even while another account is usable", { timeout: 10_000 }, async (t) => {
	await withSession(t, {
		mode: "specified",
		quota: (alias, now) => alias === "alpha"
			? quota(NOW + 10 * MINUTE, NOW - 1, now)
			: { rate_limit: { allowed: true } },
	}, async ({ manager, requests, start, waiting, advance }) => {
		const pending = start();
		await until(() => waiting().length > 0);
		assert.match(waiting()[0].text, /alpha · 10m/);
		assert.equal((await manager.getView()).mode, "specified");
		const betaChecks = requests.filter((request) => request.alias === "beta").length;
		advance(5 * MINUTE);
		await until(() => waiting().length > 1);
		assert.equal(requests.some((request) => request.path === "/responses"), false);
		assert.equal(requests.filter((request) => request.alias === "beta").length, betaChecks);
		advance(5 * MINUTE);
		assert.equal((await pending.result).stopReason, "stop");
		assert.deepEqual((await pending.events).map((event) => event.type), ["start", "done"]);
		const calls = requests.filter((request) => request.path === "/responses");
		assert.deepEqual(calls.map((request) => request.alias), ["alpha"]);
		assert.deepEqual(calls[0].body, CONTEXT);
	});
});

test("end-to-end uses credentials refreshed during a specified quota check", { timeout: 10_000 }, async (t) => {
	const original = createCredential("alpha");
	const refreshedAccess = "synthetic-refreshed-alpha-token";
	let enabled = false;
	let rejectedOldToken = false;
	let refreshCount = 0;
	await withSession(t, {
		mode: "specified",
		quotaTtlMs: 0,
		quota: () => ({ rate_limit: { allowed: true } }),
		refreshCredential: (credential, now) => {
			refreshCount++;
			return { ...credential, access: refreshedAccess, expires: now + 60 * MINUTE };
		},
		fetchQuota: (url, init) => {
			if (
				enabled &&
				!rejectedOldToken &&
				url.endsWith("/usage") &&
				init.headers["chatgpt-account-id"] === "alpha" &&
				init.headers.Authorization === `Bearer ${original.access}`
			) {
				rejectedOldToken = true;
				return { ok: false, status: 401 };
			}
			return undefined;
		},
	}, async ({ manager, requests, start }) => {
		enabled = true;
		const pending = start();
		assert.equal((await pending.result).stopReason, "stop");
		assert.deepEqual((await pending.events).map((event) => event.type), ["start", "done"]);
		assert.equal(rejectedOldToken, true);
		assert.equal(refreshCount, 1);
		assert.equal((await manager.store.load()).accounts.find((account) => account.alias === "alpha").credential.access, refreshedAccess);
		const response = requests.find((request) => request.path === "/responses");
		assert.equal(response.token, refreshedAccess);
		assert.deepEqual(response.body, CONTEXT);
	});
});

for (const operation of ["add", "import"]) {
	for (const choice of ["auto", "use beta"]) {
		test(`end-to-end keeps newer ${choice} intent over queued ${operation}`, { timeout: 10_000 }, async (t) => {
			const gamma = createCredential("gamma");
			await withSession(t, {
				quota: () => ({ rate_limit: { allowed: true } }),
			}, async ({ manager, accounts, dir }) => {
				accounts.set("gamma", gamma);
				if (operation === "import") {
					await writeFile(join(dir, "auth.json"), JSON.stringify({ "openai-codex": gamma }));
				}
				let beginModify;
				const modifyStarted = new Promise((resolve) => { beginModify = resolve; });
				let releaseModify;
				const modifyGate = new Promise((resolve) => { releaseModify = resolve; });
				const modify = manager.store.modify.bind(manager.store);
				let held = false;
				manager.store.modify = async (...args) => {
					if (!held) {
						held = true;
						beginModify();
						await modifyGate;
					}
					return modify(...args);
				};
				const olderOperation = operation === "add"
					? manager.addCredential(gamma, "gamma")
					: manager.importCurrent(undefined, { makeActive: true });
				await modifyStarted;
				let newerOperation;
				if (choice === "auto") newerOperation = manager.chooseAuto();
				else newerOperation = manager.use("beta");
				if (choice === "use beta") await newerOperation;
				const chosenSignal = manager.selection.signal;
				releaseModify();
				await olderOperation;
				if (choice === "auto") await newerOperation;
				assert.equal(manager.selection.mode, choice === "auto" ? "auto" : "specified");
				assert.equal(manager.selection.signal, chosenSignal);
				assert.equal(manager.selection.accountId, choice === "auto"
					? createCredential("alpha").accountId
					: createCredential("beta").accountId);
				assert.ok((await manager.store.load()).accounts.some((account) => account.accountId === gamma.accountId));
			});
		});
	}
}

test("end-to-end rechecks only the specified account when its reset time is unknown", { timeout: 10_000 }, async (t) => {
	await withSession(t, {
		mode: "specified",
		quota: (alias, now) => alias === "alpha"
			? quota(NOW + 5 * MINUTE, NOW - 1, now, true)
			: { rate_limit: { allowed: true } },
	}, async ({ requests, start, waiting, advance }) => {
		const pending = start();
		await until(() => waiting().length > 0);
		assert.match(waiting()[0].text, /alpha · 5m.*next quota check/);
		advance(5 * MINUTE);
		assert.equal((await pending.result).stopReason, "stop");
		await pending.events;
		assert.deepEqual(requests.filter((request) => request.path === "/responses").map((request) => request.alias), ["alpha"]);
	});
});

for (const operation of ["add", "import"]) {
	test(`end-to-end restores a specified branch before queued ${operation} completes`, { timeout: 10_000 }, async (t) => {
		const gamma = createCredential("gamma");
		const beta = createCredential("beta");
		await withSession(t, {
			sessionBranches: true,
			quota: () => ({ rate_limit: { allowed: true } }),
		}, async ({ manager, accounts, dir, handlers, branches, selectBranch }) => {
			accounts.set("gamma", gamma);
			branches.set("specified", [{
				type: "custom",
				customType: SELECTION_ENTRY_TYPE,
				data: { mode: "specified", accountId: beta.accountId },
			}]);
			if (operation === "import") {
				await writeFile(join(dir, "auth.json"), JSON.stringify({ "openai-codex": gamma }));
			}
			let beginModify;
			const modifyStarted = new Promise((resolve) => { beginModify = resolve; });
			let releaseModify;
			const modifyGate = new Promise((resolve) => { releaseModify = resolve; });
			const modify = manager.store.modify.bind(manager.store);
			let held = false;
			manager.store.modify = async (...args) => {
				if (!held) {
					held = true;
					beginModify();
					await modifyGate;
				}
				return modify(...args);
			};
			const oldOperation = operation === "add"
				? manager.addCredential(gamma, "gamma")
				: manager.importCurrent(undefined, { makeActive: true });
			await modifyStarted;
			const oldSignal = manager.selection.signal;
			const targetContext = selectBranch("specified");
			const switching = handlers.get("session_tree")({}, targetContext);
			assert.equal(oldSignal.aborted, true);
			assert.equal(manager.selection.mode, "specified");
			assert.equal(manager.selection.accountId, beta.accountId);
			const branchSignal = manager.selection.signal;
			releaseModify();
			await oldOperation;
			await switching;
			const view = await manager.getView();
			assert.equal(view.mode, "specified");
			assert.equal(view.active, "beta");
			assert.equal(manager.selection.signal, branchSignal);
			assert.ok((await manager.store.load()).accounts.some((account) => account.accountId === gamma.accountId));
			const targetEntries = branches.get("specified");
			assert.deepEqual(targetEntries.map((entry) => entry.data), [{ mode: "specified", accountId: beta.accountId }]);
			assert.equal(targetEntries.some((entry) => entry.data?.accountId === gamma.accountId), false);
		});
	});
}

test("end-to-end restores a branch before an in-flight automatic selection can publish", { timeout: 10_000 }, async (t) => {
	let beginQuota;
	const quotaStarted = new Promise((resolve) => { beginQuota = resolve; });
	let releaseQuota;
	let enabled = false;
	let blocked = false;
	await withSession(t, {
		sessionBranches: true,
		quotaTtlMs: 0,
		quota: () => ({ rate_limit: { allowed: true } }),
		fetchQuota: (url, init) => {
			if (enabled && !blocked && url.endsWith("/usage") && init.headers["chatgpt-account-id"] === "alpha") {
				blocked = true;
				beginQuota();
				return new Promise((resolve) => {
					releaseQuota = () => resolve({ ok: true, json: async () => ({ rate_limit: { allowed: true } }) });
				});
			}
			return undefined;
		},
	}, async ({ manager, handlers, branches, selectBranch }) => {
		enabled = true;
		const beta = createCredential("beta");
		branches.set("specified", [{
			type: "custom",
			customType: SELECTION_ENTRY_TYPE,
			data: { mode: "specified", accountId: beta.accountId },
		}]);
		const oldSignal = manager.selection.signal;
		const oldSelection = manager.prepareAttempt({ checkQuota: true, allowExhausted: false });
		await quotaStarted;
		const targetContext = selectBranch("specified");
		const switching = handlers.get("session_tree")({}, targetContext);
		assert.equal(oldSignal.aborted, true);
		assert.equal(manager.selection.mode, "specified");
		assert.equal(manager.selection.accountId, beta.accountId);
		releaseQuota();
		await assert.rejects(oldSelection, (error) => error.name === "AbortError");
		await switching;
		const view = await manager.getView();
		assert.equal(view.mode, "specified");
		assert.equal(view.active, "beta");
		assert.deepEqual(branches.get("specified").map((entry) => entry.data), [{ mode: "specified", accountId: beta.accountId }]);
	});
});

for (const operation of ["add", "import"]) {
	test(`end-to-end wakes an automatic quota wait after ${operation} selects a new account`, { timeout: 10_000 }, async (t) => {
		const gamma = createCredential("gamma");
		await withSession(t, {
			quota: (alias, now) => alias === "gamma"
				? { rate_limit: { allowed: true } }
				: quota(NOW + 30 * MINUTE, NOW + 30 * MINUTE, now),
		}, async ({ manager, requests, start, waiting, accounts, dir }) => {
			accounts.set("gamma", gamma);
			const pending = start();
			await until(() => waiting().length > 0);
			const oldSignal = manager.selection.signal;
			if (operation === "add") {
				await manager.addCredential(gamma, "gamma");
			} else {
				await writeFile(join(dir, "auth.json"), JSON.stringify({ "openai-codex": gamma }));
				const account = await manager.importCurrent(undefined, { makeActive: true });
				assert.equal(account.alias, "gamma");
			}
			assert.equal(oldSignal.aborted, true);
			assert.equal((await pending.result).stopReason, "stop");
			assert.deepEqual((await pending.events).map((event) => event.type), ["start", "done"]);
			const calls = requests.filter((request) => request.path === "/responses");
			assert.deepEqual(calls.map((request) => request.alias), ["gamma"]);
			assert.deepEqual(calls[0].body, CONTEXT);
		});
	});
}

test("end-to-end keeps specified selection when another account is added or imported", { timeout: 10_000 }, async (t) => {
	const gamma = createCredential("gamma");
	await withSession(t, {
		mode: "specified",
		quota: () => ({ rate_limit: { allowed: true } }),
	}, async ({ manager, accounts, dir }) => {
		accounts.set("gamma", gamma);
		const originalSignal = manager.selection.signal;
		await manager.addCredential(gamma, "gamma");
		assert.equal(manager.selection.mode, "specified");
		assert.equal(manager.selection.accountId, createCredential("alpha").accountId);
		assert.equal(manager.selection.signal, originalSignal);
		await writeFile(join(dir, "auth.json"), JSON.stringify({ "openai-codex": gamma }));
		await manager.importCurrent(undefined, { makeActive: true });
		assert.equal(manager.selection.mode, "specified");
		assert.equal(manager.selection.accountId, createCredential("alpha").accountId);
		assert.equal(manager.selection.signal, originalSignal);
	});
});

for (const change of ["use beta", "auto"]) {
	test(`end-to-end interrupts a quota refresh on ${change} and ignores its obsolete 503`, { timeout: 10_000 }, async (t) => {
		let beginRefresh;
		const refreshStarted = new Promise((resolve) => { beginRefresh = resolve; });
		let releaseRefresh;
		let refreshSignal;
		let blocked = false;
		await withSession(t, {
			mode: "specified",
			quota: (alias, now) => alias === "alpha"
				? quota(NOW + 30 * MINUTE, NOW + 30 * MINUTE, now)
				: { rate_limit: { allowed: true } },
			fetchQuota: (url, init, now) => {
				if (!blocked && url.endsWith("/usage") && init.headers["chatgpt-account-id"] === "alpha" && now >= NOW + 5 * MINUTE) {
					blocked = true;
					refreshSignal = init.signal;
					beginRefresh();
					return new Promise((resolve) => { releaseRefresh = () => resolve({ ok: false, status: 503 }); });
				}
				return undefined;
			},
		}, async ({ manager, requests, start, waiting, command, advance }) => {
			const pending = start();
			await until(() => waiting().length > 0);
			advance(5 * MINUTE);
			await refreshStarted;
			const oldSelectionSignal = manager.selection.signal;
			const switching = command(change);
			await until(() => oldSelectionSignal.aborted);
			assert.equal(refreshSignal.aborted, true);
			assert.equal(manager.selection.mode, change === "auto" ? "auto" : "specified");
			if (change === "use beta") assert.equal(manager.selection.accountId, createCredential("beta").accountId);
			releaseRefresh();
			await switching;
			assert.equal((await pending.result).stopReason, "stop");
			assert.deepEqual((await pending.events).map((event) => event.type), ["start", "done"]);
			const calls = requests.filter((request) => request.path === "/responses");
			assert.deepEqual(calls.map((request) => request.alias), ["beta"]);
			assert.deepEqual(calls[0].body, CONTEXT);
			const alpha = (await manager.getView()).accounts.find((account) => account.alias === "alpha");
			assert.equal(alpha.quotaError, undefined);
		});
	});
}

for (const trigger of ["poll", "agent_end"]) {
	test(`end-to-end handles selection cancellation in the background ${trigger} refresh`, { timeout: 10_000 }, async (t) => {
		let beginRefresh;
		const refreshStarted = new Promise((resolve) => { beginRefresh = resolve; });
		let refreshSignal;
		let enabled = false;
		let blocked = false;
		const unhandled = [];
		const onUnhandled = (error) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			await withSession(t, {
				quota: () => ({ rate_limit: { allowed: true } }),
				pollIntervalMs: trigger === "poll" ? 10 : 24 * 60 * MINUTE,
				fetchQuota: (url, init) => {
					if (!enabled || blocked || !url.endsWith("/usage") || init.headers["chatgpt-account-id"] !== "alpha") return undefined;
					blocked = true;
					refreshSignal = init.signal;
					beginRefresh();
					return new Promise((_resolve, reject) => {
						const abort = () => reject(init.signal.reason);
						if (init.signal.aborted) abort();
						else init.signal.addEventListener("abort", abort, { once: true });
					});
				},
			}, async ({ manager, agentEnd, advance }) => {
				enabled = true;
				advance(MINUTE);
				if (trigger === "agent_end") agentEnd();
				await refreshStarted;
				const selectionSignal = manager.selection.signal;
				await manager.use("beta");
				assert.equal(selectionSignal.aborted, true);
				assert.equal(refreshSignal.aborted, true);
				await manager.queue.catch(() => undefined);
				await nextTick();
				await nextTick();
				assert.deepEqual(unhandled, []);
			});
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
}

test("end-to-end leaves selection and a quota wait unchanged after an invalid account command", { timeout: 10_000 }, async (t) => {
	await withSession(t, {
		mode: "specified",
		quota: (alias, now) => alias === "alpha"
			? quota(NOW + 30 * MINUTE, NOW + 30 * MINUTE, now)
			: { rate_limit: { allowed: true } },
	}, async ({ manager, requests, start, waiting, controller }) => {
		const pending = start();
		await until(() => waiting().length > 0);
		const selectionSignal = manager.selection.signal;
		await assert.rejects(manager.use("missing"), /Unknown account: missing/);
		assert.equal(manager.selection.mode, "specified");
		assert.equal(manager.selection.accountId, createCredential("alpha").accountId);
		assert.equal(manager.selection.signal, selectionSignal);
		controller.abort();
		assert.equal((await pending.result).stopReason, "aborted");
		await pending.events;
		assert.equal(requests.some((request) => request.path === "/responses"), false);
	});
});

test("end-to-end switches an automatic wait to the specified account instead of the earliest reset", { timeout: 10_000 }, async (t) => {
	await withSession(t, {
		quota: (alias, now) => quota(NOW + (alias === "alpha" ? 10 : 20) * MINUTE, NOW - 1, now),
	}, async ({ requests, start, waiting, command, advance }) => {
		const pending = start();
		await until(() => waiting().length > 0);
		assert.match(waiting()[0].text, /alpha · 10m/);
		await command("use beta");
		await until(() => waiting().length > 1);
		assert.match(waiting().at(-1).text, /beta · 20m/);
		advance(10 * MINUTE);
		await until(() => waiting().length > 2);
		assert.equal(requests.some((request) => request.path === "/responses"), false);
		advance(10 * MINUTE);
		assert.equal((await pending.result).stopReason, "stop");
		await pending.events;
		assert.deepEqual(requests.filter((request) => request.path === "/responses").map((request) => request.alias), ["beta"]);
	});
});

test("end-to-end retries a specified account's 429 without trying an available alternate", { timeout: 10_000 }, async (t) => {
	await withSession(t, {
		mode: "specified",
		quota: () => ({ rate_limit: { allowed: true } }),
		response: (alias, now) => alias === "alpha" && now < NOW + MINUTE
			? { status: 429, headers: { "retry-after": "60" } }
			: { status: 200 },
	}, async ({ requests, start, waiting, advance }) => {
		const pending = start();
		await until(() => waiting().length > 0);
		assert.deepEqual(requests.filter((request) => request.path === "/responses").map((request) => request.alias), ["alpha"]);
		advance(MINUTE);
		assert.equal((await pending.result).stopReason, "stop");
		assert.deepEqual((await pending.events).map((event) => event.type), ["start", "done"]);
		assert.deepEqual(requests.filter((request) => request.path === "/responses").map((request) => request.alias), ["alpha", "alpha"]);
	});
});

for (const change of ["use beta", "auto"]) {
	test(`end-to-end wakes a quota wait immediately after ${change}`, { timeout: 10_000 }, async (t) => {
		await withSession(t, {
			mode: "specified",
			quota: (alias, now) => alias === "alpha"
				? quota(NOW + 30 * 24 * 60 * MINUTE, NOW - 1, now)
				: { rate_limit: { allowed: true } },
		}, async ({ manager, requests, start, waiting, command }) => {
			const pending = start();
			await until(() => waiting().length > 0);
			await command(change);
			assert.equal((await pending.result).stopReason, "stop");
			assert.deepEqual((await pending.events).map((event) => event.type), ["start", "done"]);
			const calls = requests.filter((request) => request.path === "/responses");
			assert.deepEqual(calls.map((request) => request.alias), ["beta"]);
			assert.deepEqual(calls[0].body, CONTEXT);
			assert.equal((await manager.getView()).mode, change === "auto" ? "auto" : "specified");
		});
	});
}

for (const failure of ["quota-query", "request-network"]) {
	test(`end-to-end reports specified ${failure} failures without switching or waiting`, { timeout: 10_000 }, async (t) => {
		await withSession(t, {
			mode: "specified",
			quota: () => ({ rate_limit: { allowed: true } }),
			quotaStatus: () => failure === "quota-query" ? 503 : 200,
			response: () => ({ status: 503, message: "socket closed" }),
		}, async ({ requests, start, waiting }) => {
			const pending = start();
			assert.equal((await pending.result).stopReason, "error");
			await pending.events;
			assert.equal(waiting().length, 0);
			assert.deepEqual(requests.filter((request) => request.path === "/responses").map((request) => request.alias),
				failure === "quota-query" ? [] : ["alpha"]);
		});
	});
}

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

for (const [cancel, mode] of [["request", "auto"], ["shutdown", "auto"], ["request", "specified"], ["shutdown", "specified"]]) {
	test(`end-to-end cancels a multi-week ${mode} wait through ${cancel}`, { timeout: 10_000 }, async (t) => {
		await withSession(t, {
			mode,
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

for (const [failure, mode] of [["partial", "auto"], ["authentication", "auto"], ["partial", "specified"], ["authentication", "specified"]]) {
	test(`end-to-end does not wait or replay after ${mode} ${failure} failures`, { timeout: 10_000 }, async (t) => {
		await withSession(t, {
			mode,
			quota: () => ({ rate_limit: { allowed: true } }),
			response: () => failure === "partial"
				? { status: 429, partial: true }
				: { status: 401, message: "invalid token" },
		}, async ({ requests, start, waiting }) => {
			const pending = start();
			assert.equal((await pending.result).stopReason, "error");
			await pending.events;
			assert.equal(waiting().length, 0);
			assert.equal(requests.filter((request) => request.path === "/responses").length, failure === "partial" || mode === "specified" ? 1 : 2);
		});
	});
}
