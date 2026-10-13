import { setTimeout } from "node:timers/promises";
import { join } from "node:path";

import { readPiCodexCredential } from "../../extensions/lib/account-store.js";
import { getCredentialAccountId } from "../../extensions/lib/credentials.js";
import { NOW } from "../helpers.js";

const MODEL = { provider: "openai-codex", id: "gpt-test", api: "openai-codex-responses" };

async function runAccountProcess(agentDir, origin) {
	let now = NOW;
	let generation = 0;
	let manager;
	let provider;
	let handlers;
	let commands;
	let ctx;
	let pendingViews = 0;
	let notifications;
	let statuses;
	const base = {
		id: "openai-codex",
		name: "OpenAI Codex",
		auth: {
			oauth: {
				async refresh(credential) {
					const response = await fetch(`${origin}/oauth/refresh`, {
						method: "POST",
						headers: { "content-type": "application/json", "x-test-process": String(process.pid) },
						body: JSON.stringify({ credential, now }),
					});
					if (!response.ok) throw new Error("Invalid refresh token");
					return response.json();
				},
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [MODEL],
		stream(_model, context, options) {
			return {
				async *[Symbol.asyncIterator]() {
					const response = await fetch(`${origin}/responses`, {
						method: "POST",
						headers: {
							"chatgpt-account-id": getCredentialAccountId({ access: options.apiKey }),
							"authorization": `Bearer ${options.apiKey}`,
							"x-test-process": String(process.pid),
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

	async function shutdown() {
		handlers?.get("session_shutdown")?.({}, ctx);
		await manager?.queue;
		while (pendingViews > 0) await setTimeout(1);
	}

	async function load(reason = "startup") {
		const moduleUrl = new URL("../../extensions/pi-accounts.js", import.meta.url);
		moduleUrl.searchParams.set("runtime", String(generation++));
		const { createPiAccountsExtension } = await import(moduleUrl.href);
		handlers = new Map();
		commands = new Map();
		notifications = [];
		statuses = new Map();
		ctx = {
			hasUI: true,
			model: MODEL,
			isIdle: () => true,
			modelRegistry: { getProvider: () => base, refresh: async () => ({}) },
			ui: {
				setStatus: (key, value) => statuses.set(key, value),
				setWidget() {},
				confirm: async () => true,
				notify: (message, type) => notifications.push({ message, type }),
			},
		};
		({ manager } = createPiAccountsExtension({
			agentDir,
			now: () => now,
			quotaTtlMs: 60_000,
			pollIntervalMs: 24 * 60 * 60_000,
			fetchImpl: (url, init) => fetch(`${origin}${new URL(url).pathname}`, {
				...init,
				headers: { ...init.headers, "x-test-process": String(process.pid) },
			}),
		})({
			on: (name, handler) => handlers.set(name, handler),
			registerCommand: (name, command) => commands.set(name, command),
			registerProvider: (value) => { provider = value; },
		}));
		const getView = manager.getView.bind(manager);
		manager.getView = async () => {
			pendingViews++;
			try {
				return await getView();
			} finally {
				pendingViews--;
			}
		};
		await handlers.get("session_start")({ reason }, ctx);
		const error = notifications.find((entry) => entry.type === "error");
		if (error) throw new Error(error.message);
		return manager.getView();
	}

	async function dispatch(action, value) {
		switch (action) {
			case "view": return manager.getView();
			case "refresh-account": {
				await manager.refreshAccount(value, { force: true });
				return { view: await manager.getView(), footer: statuses.get("pi-accounts") };
			}
			case "ui-list": {
				await commands.get("accounts").handler("list", ctx);
				return { view: await manager.getView(), footer: statuses.get("pi-accounts") };
			}
			case "command": {
				notifications.length = 0;
				await commands.get("accounts").handler(value, ctx);
				const error = notifications.find((entry) => entry.type === "error");
				if (error) throw new Error(error.message);
				return manager.getView();
			}
			case "add":
				await manager.addCredential(value.credential, value.alias);
				return manager.getView();
			case "replace":
				await shutdown();
				return load(value);
			case "advance":
				now = value;
				return null;
			case "request": {
				await handlers.get("before_agent_start")({}, ctx);
				let stored = await readPiCodexCredential(join(agentDir, "auth.json"));
				let auth;
				if (stored) {
					if (stored.expires <= now + 5 * 60_000) {
						stored = await provider.auth.oauth.refresh(stored, new AbortController().signal);
					}
					auth = await provider.auth.oauth.toAuth(stored);
				} else {
					auth = (await provider.auth.apiKey.resolve({ signal: new AbortController().signal })).auth;
				}
				const stream = provider.streamSimple(MODEL, { messages: [{ role: "user", content: "Continue" }] }, auth);
				const events = await Array.fromAsync(stream);
				return {
					result: await stream.result(),
					events: events.map((event) => event.type),
					view: await manager.getView(),
					footer: statuses.get("pi-accounts"),
				};
			}
			case "stop":
				await shutdown();
				return null;
			default: throw new Error(`Unknown process action: ${action}`);
		}
	}

	const initialView = await load();
	process.send({ id: 0, value: initialView });
	let queue = Promise.resolve();
	process.on("message", ({ id, action, value }) => {
		queue = queue.then(async () => {
			try {
				process.send({ id, value: await dispatch(action, value) }, () => {
					if (action === "stop") process.disconnect();
				});
			} catch (error) {
				process.send({ id, error: error.message });
			}
		});
	});
}

if (process.env.PI_ACCOUNTS_TEST_PROCESS === "1") {
	await runAccountProcess(process.argv[2], process.argv[3]);
}
