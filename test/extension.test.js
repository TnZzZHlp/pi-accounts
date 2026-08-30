import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPiAccountsExtension, resolvePiAgentDir } from "../extensions/pi-accounts.js";
import { createCredential, NOW, quotaPayload } from "./helpers.js";

test("registers commands, logs in another account, updates the footer, and supports manual selection", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-accounts-extension-"));
	const alpha = createCredential("alpha", { email: "alpha@example.com" });
	const beta = createCredential("beta", { email: "beta@example.com" });
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": alpha }), { mode: 0o600 });

	const events = new Map();
	const commands = new Map();
	const providers = [];
	const statuses = [];
	const notifications = [];
	const widgets = [];
	const baseProvider = {
		id: "openai-codex",
		name: "OpenAI Codex",
		auth: {
			oauth: {
				async login(interaction) {
					const method = await interaction.prompt({
						type: "select",
						message: "Login method",
						options: [{ id: "device", label: "Device code" }],
					});
					assert.equal(method, "device");
					interaction.notify({
						type: "device_code",
						verificationUri: "https://example.test/device",
						userCode: "ABCD-EFGH",
					});
					return beta;
				},
				async refresh(credential) {
					return credential;
				},
			},
		},
		getModels: () => [],
		stream() {
			throw new Error("not used");
		},
		streamSimple() {
			throw new Error("not used");
		},
	};
	const pi = {
		on(name, handler) {
			events.set(name, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerProvider(provider) {
			providers.push(provider);
		},
	};
	const ctx = {
		hasUI: true,
		model: { provider: "openai-codex", id: "gpt-test", api: "openai-codex-responses" },
		signal: undefined,
		isIdle: () => true,
		modelRegistry: {
			getProvider: () => baseProvider,
			refresh: async () => ({}),
		},
		ui: {
			setStatus(key, text) {
				statuses.push({ key, text });
			},
			notify(message, type) {
				notifications.push({ message, type });
			},
			setWidget(key, content) {
				widgets.push({ key, content });
			},
			select(_title, options) {
				return Promise.resolve(options[0]);
			},
			input() {
				return Promise.resolve("");
			},
			confirm() {
				return Promise.resolve(true);
			},
		},
	};

	try {
		createPiAccountsExtension({
			agentDir,
			now: () => NOW,
			quotaTtlMs: 0,
			pollIntervalMs: 60 * 60_000,
			fetchImpl: async (_url, init) => {
				const isBeta = init.headers["chatgpt-account-id"] === "beta";
				return { ok: true, status: 200, json: async () => quotaPayload(isBeta ? 30 : 20, 10) };
			},
		})(pi);

		assert.equal(commands.has("account"), true);
		assert.equal(commands.has("accounts"), true);
		await events.get("session_start")({}, ctx);
		assert.equal(providers.length, 1);
		assert.equal(providers[0].id, "openai-codex");
		assert.match(statuses.at(-1).text, /^alpha · 5h 80% · 7d 90%$/);

		await commands.get("account").handler("add beta", ctx);
		assert.equal(widgets.some((entry) => entry.content?.includes("Device code: ABCD-EFGH")), true);
		assert.match(statuses.at(-1).text, /^beta · 5h 70% · 7d 90%$/);
		assert.equal(notifications.some((entry) => /Added and selected Codex account "beta"/.test(entry.message)), true);

		await commands.get("account").handler("use alpha", ctx);
		assert.match(statuses.at(-1).text, /^alpha · 5h 80% · 7d 90%$/);
		await commands.get("accounts").handler("list", ctx);
		assert.equal(notifications.some((entry) => /Codex accounts \(2\)/.test(entry.message)), true);
	} finally {
		events.get("session_shutdown")?.({}, ctx);
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("resolves the Pi agent directory from the supported environment variable", () => {
	assert.equal(resolvePiAgentDir({}, "/home/tester"), "/home/tester/.pi/agent");
	assert.equal(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "~/custom" }, "/home/tester"), "/home/tester/custom");
});
