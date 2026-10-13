import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AccountStore, readPiCodexCredential } from "../extensions/lib/account-store.js";
import { getCredentialAccountId } from "../extensions/lib/credentials.js";
import { assistantMessage, createCredential, errorMessage, NOW, quotaPayload } from "./helpers.js";

const MODEL = { provider: "openai-codex", id: "gpt-test", api: "openai-codex-responses" };
const HOUR = 60 * 60_000;
const FIXTURE = fileURLToPath(new URL("./fixtures/account-process.js", import.meta.url));

async function startProcess(agentDir, origin, sessionId) {
	const child = fork(FIXTURE, [agentDir, origin, ...(sessionId ? [sessionId] : [])], {
		env: { ...process.env, PI_ACCOUNTS_TEST_PROCESS: "1", PI_CODING_AGENT_DIR: agentDir },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	let output = "";
	let sequence = 0;
	const pending = new Map();
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { output += chunk; });
	const waitFor = (id) => new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`Process ${child.pid} timed out: ${output}`));
		}, 10_000);
		pending.set(id, {
			resolve: (value) => { clearTimeout(timeout); resolve(value); },
			reject: (error) => { clearTimeout(timeout); reject(error); },
		});
	});
	child.on("message", ({ id, value, error }) => {
		const response = pending.get(id);
		pending.delete(id);
		if (error) response?.reject(new Error(error));
		else response?.resolve(value);
	});
	const exited = new Promise((resolve) => {
		child.once("exit", (code, signal) => {
			for (const response of pending.values()) {
				response.reject(new Error(`Process ${child.pid} exited (${code ?? signal}): ${output}`));
			}
			pending.clear();
			resolve({ code, signal });
		});
	});
	const call = (action, value) => {
		const id = ++sequence;
		const result = waitFor(id);
		child.send({ id, action, value }, (error) => {
			if (error) {
				pending.get(id)?.reject(error);
				pending.delete(id);
			}
		});
		return result;
	};
	try {
		const initial = await waitFor(0);
		return {
			pid: String(child.pid),
			initial,
			call,
			async stop() {
				if (child.exitCode === null && child.signalCode === null) {
					try {
						await call("stop");
					} catch {
						child.kill("SIGKILL");
					}
				}
				await exited;
			},
		};
	} catch (error) {
		child.kill("SIGKILL");
		await exited;
		throw error;
	}
}

async function withProcesses(t, run) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-accounts-isolation-e2e-"));
	const store = new AccountStore(join(agentDir, "pi-accounts.json"));
	const authPath = join(agentDir, "auth.json");
	const credentials = ["alpha", "beta", "gamma"].map((id) => createCredential(id));
	const refreshTokens = new Map(credentials.map((credential) => [credential.accountId, credential.refresh]));
	const requests = [];
	const used = new Map();
	const failures = new Map();
	const processes = [];
	await store.modify((state) => {
		state.active = "alpha";
		state.accounts = credentials.map((credential) => ({
			alias: credential.accountId,
			accountId: credential.accountId,
			credential,
			addedAt: NOW,
			updatedAt: NOW,
		}));
		return state;
	});
	await writeFile(authPath, JSON.stringify({
		"openai-codex": credentials[0],
		unrelated: { type: "api_key", key: "keep-me" },
	}), { mode: 0o600 });

	const server = createServer(async (req, res) => {
		try {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
			const accountId = req.headers["chatgpt-account-id"] ?? body?.credential?.accountId;
			const processId = req.headers["x-test-process"];
			requests.push({ path: req.url, processId, accountId });
			res.setHeader("content-type", "application/json");
			if (req.url.endsWith("/usage")) {
				res.end(JSON.stringify(quotaPayload(used.get(accountId) ?? 10)));
			} else if (req.url === "/oauth/refresh") {
				await delay(25);
				if (body.credential.refresh !== refreshTokens.get(accountId)) {
					res.statusCode = 401;
					res.end("{}");
					return;
				}
				const refresh = `rotated-${accountId}-${body.now}`;
				refreshTokens.set(accountId, refresh);
				res.end(JSON.stringify(createCredential(accountId, { refresh, expires: body.now + HOUR })));
			} else if (req.url === "/responses") {
				assert.equal(getCredentialAccountId({ access: req.headers.authorization.slice("Bearer ".length) }), accountId);
				const failure = failures.get(`${processId}:${accountId}`);
				if (failure) {
					failures.delete(`${processId}:${accountId}`);
					res.statusCode = failure;
					res.end(JSON.stringify([{ type: "error", reason: "error", error: errorMessage("usage limit", MODEL) }]));
				} else {
					const message = assistantMessage(MODEL);
					res.end(JSON.stringify([
						{ type: "start", partial: { ...message, content: [] } },
						{ type: "done", reason: "stop", message },
					]));
				}
			} else {
				res.statusCode = 404;
				res.end("{}");
			}
		} catch (error) {
			res.statusCode = 500;
			res.end(JSON.stringify({ error: error.message }));
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	t.after(async () => {
		await Promise.all(processes.map((child) => child.stop()));
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(agentDir, { recursive: true, force: true });
	});
	const start = async (sessionId) => {
		const child = await startProcess(agentDir, origin, sessionId);
		processes.push(child);
		return child;
	};
	await run({ start, store, authPath, requests, used, failures, refreshTokens, credentials });
}

function responseAccounts(requests, processId) {
	return requests.filter((request) => request.path === "/responses" && request.processId === processId)
		.map((request) => request.accountId);
}

async function request(child) {
	const result = await child.call("request");
	assert.equal(result.result.stopReason, "stop");
	assert.deepEqual(result.events, ["start", "done"]);
}

test("end-to-end isolates and persists account modes across sessions, processes, and runtime replacements", { timeout: 30_000 }, async (t) => {
	await withProcesses(t, async ({ start, store, authPath, requests, failures, used }) => {
		const first = await start();
		const second = await start();
		assert.equal(first.initial.active, "alpha");
		assert.equal(second.initial.active, "alpha");
		await second.call("command", "use beta");
		await first.call("command", "use gamma");
		await Promise.all([request(first), request(second)]);
		assert.deepEqual(responseAccounts(requests, first.pid), ["gamma"]);
		assert.deepEqual(responseAccounts(requests, second.pid), ["beta"]);
		assert.equal((await store.load()).active, "alpha");
		assert.equal((await readPiCodexCredential(authPath)).accountId, "alpha");

		for (const reason of ["reload", "new", "resume"]) {
			const count = requests.length;
			const restored = await second.call("replace", reason);
			assert.equal(restored.active, reason === "new" ? "alpha" : "beta");
			assert.equal(restored.mode, reason === "new" ? "auto" : "specified");
			assert.equal(requests.length, count);
			await request(second);
			assert.equal(responseAccounts(requests, second.pid).at(-1), reason === "new" ? "alpha" : "beta");
		}
		const sessionId = second.initial.sessionId;
		await second.stop();
		const resumed = await start(sessionId);
		assert.equal(resumed.initial.mode, "specified");
		assert.equal(resumed.initial.active, "beta");
		await request(resumed);
		assert.equal(responseAccounts(requests, resumed.pid).at(-1), "beta");
		const restarted = await start();
		assert.equal(restarted.initial.active, "alpha");
		assert.equal((await first.call("view")).active, "gamma");
		assert.equal(resumed.initial.active, "beta");

		await first.call("command", "auto");
		failures.set(`${first.pid}:gamma`, 429);
		await request(first);
		assert.deepEqual(responseAccounts(requests, first.pid).slice(-2), ["gamma", "alpha"]);
		assert.equal((await resumed.call("view")).active, "beta");
		used.set("alpha", 100);
		assert.equal((await first.call("command", "auto")).active, "beta");
		assert.equal((await resumed.call("view")).active, "beta");
		assert.equal((await store.load()).active, "alpha");

		await first.call("add", { alias: "delta", credential: createCredential("delta") });
		assert.equal((await first.call("view")).active, "delta");
		assert.equal((await resumed.call("view")).active, "beta");
		assert.equal((await resumed.call("view")).accounts.length, 4);
		await first.call("command", "import");
		assert.equal((await first.call("view")).active, "alpha");
		assert.equal((await resumed.call("view")).active, "beta");

		await first.call("command", "rename beta personal");
		assert.equal((await resumed.call("view")).active, "personal");
		await request(resumed);
		assert.equal(responseAccounts(requests, resumed.pid).at(-1), "beta");
		await first.call("command", "remove alpha");
		assert.equal(await readPiCodexCredential(authPath), undefined);
		assert.equal((await resumed.call("view")).active, "personal");
		await request(resumed);
		assert.equal(responseAccounts(requests, resumed.pid).at(-1), "beta");
		assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")).unrelated, { type: "api_key", key: "keep-me" });
	});
});

test("end-to-end does not replace a removed specified account until auto mode is explicitly selected", { timeout: 30_000 }, async (t) => {
	await withProcesses(t, async ({ start, store, authPath, requests, used }) => {
		used.set("alpha", 100);
		const first = await start();
		const second = await start();
		await first.call("command", "use alpha");
		await second.call("command", "use beta");
		assert.equal((await first.call("view")).active, "alpha");
		assert.equal((await second.call("view")).active, "beta");

		await first.call("command", "remove beta");
		assert.equal((await first.call("view")).active, "alpha");
		assert.equal((await store.load()).active, "alpha");
		assert.equal((await readPiCodexCredential(authPath)).accountId, "alpha");

		const staleSelection = await second.call("ui-list");
		assert.equal(staleSelection.view.active, null);
		assert.equal(staleSelection.view.accounts.some((account) => account.active), false);
		assert.equal(staleSelection.view.mode, "specified");
		assert.equal(staleSelection.footer, "accounts: specified account unavailable; /accounts use or auto");

		await assert.rejects(second.call("request"), /specified Codex account was removed/);
		assert.deepEqual(responseAccounts(requests, second.pid), []);
		await second.call("command", "auto");
		await request(second);
		const repairedView = await second.call("view");
		assert.equal(repairedView.active, "gamma");
		assert.equal(responseAccounts(requests, second.pid).at(-1), "gamma");
		assert.match((await second.call("ui-list")).footer, /^auto · gamma ·/);
		assert.equal((await first.call("view")).active, "alpha");
		assert.equal((await store.load()).active, "alpha");
		assert.equal((await readPiCodexCredential(authPath)).accountId, "alpha");
	});
});

test("end-to-end shares rotating credentials without duplicate refresh or stale startup imports", { timeout: 30_000 }, async (t) => {
	await withProcesses(t, async ({ start, store, authPath, requests, credentials }) => {
		const first = await start();
		const second = await start();
		await Promise.all([first.call("advance", NOW + 2 * HOUR), second.call("advance", NOW + 2 * HOUR)]);
		await Promise.all([request(first), request(second)]);
		const refreshes = requests.filter((entry) => entry.path === "/oauth/refresh");
		assert.equal(refreshes.length, 1);
		assert.equal(refreshes[0].accountId, "alpha");
		const refreshed = (await store.load()).accounts.find((account) => account.accountId === "alpha").credential;
		assert.equal((await readPiCodexCredential(authPath)).refresh, refreshed.refresh);
		assert.notEqual(refreshed.refresh, credentials[0].refresh);

		await writeFile(authPath, JSON.stringify({ "openai-codex": credentials[0] }), { mode: 0o600 });
		const restarted = await start();
		assert.equal(restarted.initial.active, "alpha");
		assert.equal((await store.load()).accounts[0].credential.refresh, refreshed.refresh);
		assert.equal((await readPiCodexCredential(authPath)).refresh, refreshed.refresh);
		assert.equal(requests.filter((entry) => entry.path === "/oauth/refresh").length, 1);
	});
});

test("end-to-end authenticates the process account even if Pi's shared login cannot refresh", { timeout: 30_000 }, async (t) => {
	await withProcesses(t, async ({ start, requests, refreshTokens, authPath }) => {
		const child = await start();
		await child.call("command", "use gamma");
		refreshTokens.set("alpha", "revoked-alpha-refresh");
		await child.call("advance", NOW + 2 * HOUR);
		await request(child);
		assert.deepEqual(responseAccounts(requests, child.pid), ["gamma"]);
		assert.deepEqual(requests.filter((entry) => entry.path === "/oauth/refresh").map((entry) => entry.accountId), ["gamma"]);
		assert.equal((await readPiCodexCredential(authPath)).accountId, "alpha");
	});
});
