import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountManager } from "../extensions/lib/account-manager.js";
import {
	AccountStore,
	readPiCodexCredential,
} from "../extensions/lib/account-store.js";
import { createAccessToken, createCredential, NOW, quotaPayload } from "./helpers.js";

async function withManager(run, options = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-accounts-test-"));
	const storePath = join(dir, "pi-accounts.json");
	const authPath = join(dir, "auth.json");
	await writeFile(authPath, JSON.stringify(options.auth ?? {}), { mode: 0o600 });
	const calls = [];
	const manager = new AccountManager({
		store: new AccountStore(storePath),
		authPath,
		now: () => NOW,
		quotaTtlMs: 0,
		fetchImpl: async (_url, init) => {
			const token = init.headers.Authorization.slice("Bearer ".length);
			calls.push(token);
			const used = options.usedByToken?.get(token) ?? 10;
			return { ok: true, status: 200, json: async () => quotaPayload(used, 10) };
		},
	});
	manager.setProvider({
		auth: {
			oauth: {
				async refresh(credential) {
					return { ...credential, expires: NOW + 60 * 60_000 };
				},
			},
		},
	});
	try {
		await run({ manager, authPath, storePath, calls });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("imports Pi's current Codex login without exposing or changing other providers", async () => {
	const credential = createCredential("alpha", { email: "alpha@example.com" });
	await withManager(
		async ({ manager, authPath, storePath }) => {
			const view = await manager.initialize();
			assert.equal(view.active, "alpha");
			assert.equal(view.accounts[0].email, "alpha@example.com");
			const auth = JSON.parse(await readFile(authPath, "utf8"));
			assert.deepEqual(auth.unrelated, { type: "api_key", key: "keep-me" });
			assert.equal(auth["openai-codex"].refresh, credential.refresh);
			if (process.platform !== "win32") {
				assert.equal((await stat(storePath)).mode & 0o077, 0);
			}
		},
		{
			auth: {
				unrelated: { type: "api_key", key: "keep-me" },
				"openai-codex": credential,
			},
		},
	);
});

test("automatically rotates from an exhausted active account and syncs auth.json", async () => {
	const alpha = createCredential("alpha");
	const beta = createCredential("beta");
	const usedByToken = new Map([
		[alpha.access, 100],
		[beta.access, 20],
	]);
	await withManager(
		async ({ manager, authPath }) => {
			await manager.addCredential(alpha, "work");
			await manager.addCredential(beta, "personal");
			await manager.use("work");
			const selected = await manager.ensureReady({ checkQuota: true });
			assert.equal(selected.alias, "personal");
			assert.equal((await readPiCodexCredential(authPath)).accountId, "beta");
			const view = await manager.getView();
			assert.equal(view.active, "personal");
			assert.equal(view.accounts.find((account) => account.alias === "work").quota.primary.usedPercent, 100);
		},
		{ usedByToken },
	);
});

test("manual use selects the requested account for the next request", async () => {
	await withManager(async ({ manager, authPath }) => {
		await manager.addCredential(createCredential("alpha"), "alpha");
		await manager.addCredential(createCredential("beta"), "beta");
		const selected = await manager.use("alpha");
		assert.equal(selected.alias, "alpha");
		assert.equal((await readPiCodexCredential(authPath)).accountId, "alpha");
	});
});

test("removing the active account selects the next account and deleting the last logs out Codex only", async () => {
	await withManager(async ({ manager, authPath }) => {
		await manager.addCredential(createCredential("alpha"), "alpha");
		await manager.addCredential(createCredential("beta"), "beta");
		await manager.remove("beta");
		assert.equal((await manager.getView()).active, "alpha");
		assert.equal((await readPiCodexCredential(authPath)).accountId, "alpha");
		await manager.remove("alpha");
		assert.equal(await readPiCodexCredential(authPath), undefined);
	});
});

test("serializes rotating OAuth refresh tokens across concurrent Pi processes", async () => {
	await withManager(async ({ manager, authPath, storePath }) => {
		await manager.addCredential(
			createCredential("alpha", { expires: NOW - 1 }),
			"alpha",
		);
		const staleAccount = (await new AccountStore(storePath).load()).accounts[0];
		let refreshCalls = 0;
		const provider = {
			auth: {
				oauth: {
					async refresh(credential) {
						refreshCalls += 1;
						await new Promise((resolve) => setTimeout(resolve, 20));
						return {
							...credential,
							access: createAccessToken("alpha"),
							refresh: "rotated-refresh-alpha",
							expires: NOW + 60 * 60_000,
						};
					},
				},
			},
		};
		const otherProcess = new AccountManager({
			store: new AccountStore(storePath),
			authPath,
			now: () => NOW,
		});
		manager.setProvider(provider);
		otherProcess.setProvider(provider);

		const [first, second] = await Promise.all([
			manager._refreshCredential(staleAccount, { force: true }),
			otherProcess._refreshCredential(staleAccount, { force: true }),
		]);

		assert.equal(refreshCalls, 1);
		assert.equal(first.credential.refresh, "rotated-refresh-alpha");
		assert.equal(second.credential.refresh, "rotated-refresh-alpha");
		assert.equal((await readPiCodexCredential(authPath)).refresh, "rotated-refresh-alpha");
	});
});
