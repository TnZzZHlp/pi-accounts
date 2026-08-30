import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";

const LOCK_OPTIONS = {
	realpath: false,
	stale: 30_000,
	retries: {
		retries: 40,
		factor: 1.25,
		minTimeout: 10,
		maxTimeout: 250,
		randomize: true,
	},
};

async function ensureJsonFile(path, fallback, mode) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	let handle;
	try {
		handle = await open(path, "ax", mode);
		await handle.writeFile(`${JSON.stringify(fallback, null, 2)}\n`, "utf8");
		await handle.sync();
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
	} finally {
		await handle?.close();
	}
}

async function parseJsonFile(path) {
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		throw new Error(`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return JSON.parse(raw.replace(/^\uFEFF/, ""));
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function atomicWriteJson(path, value, requestedMode) {
	const parent = dirname(path);
	const tempPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let mode = requestedMode;
	try {
		const current = await stat(path);
		mode = current.mode & 0o777;
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	let handle;
	try {
		handle = await open(tempPath, "wx", mode);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(tempPath, path);
		await chmod(path, mode);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

export async function readJsonLocked(path, fallback = {}, options = {}) {
	const mode = options.mode ?? 0o600;
	await ensureJsonFile(path, fallback, mode);
	const release = await lockfile.lock(path, LOCK_OPTIONS);
	try {
		return await parseJsonFile(path);
	} finally {
		await release().catch(() => undefined);
	}
}

export async function updateJsonLocked(path, fallback, update, options = {}) {
	const mode = options.mode ?? 0o600;
	await ensureJsonFile(path, fallback, mode);
	const release = await lockfile.lock(path, LOCK_OPTIONS);
	try {
		const current = await parseJsonFile(path);
		const next = await update(current);
		if (next !== undefined) await atomicWriteJson(path, next, mode);
		return next === undefined ? current : next;
	} finally {
		await release().catch(() => undefined);
	}
}
