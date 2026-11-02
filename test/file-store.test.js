import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import lockfile from "proper-lockfile";

import { updateJsonLocked } from "../extensions/lib/file-store.js";

for (const failure of ["removed", "changed"]) {
	test(`rejects an update without writing when its lock is ${failure}`, { timeout: 30_000 }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-accounts-lock-"));
		const path = join(dir, "accounts.json");
		let release;
		try {
			await assert.rejects(updateJsonLocked(path, { value: "original" }, async () => {
				if (failure === "removed") {
					await rm(`${path}.lock`, { recursive: true });
				} else {
					const changed = new Date(Date.now() + 60_000);
					await utimes(`${path}.lock`, changed, changed);
				}
				await delay(16_000);
				if (failure === "removed") {
					release = await lockfile.lock(path, { realpath: false });
				}
				return { value: "must not be written" };
			}), { code: "ECOMPROMISED" });
			assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { value: "original" });
			assert.equal((await stat(`${path}.lock`)).isDirectory(), true);
		} finally {
			await release?.();
			await rm(dir, { recursive: true, force: true });
		}
	});
}
