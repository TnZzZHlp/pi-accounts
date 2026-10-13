export const SELECTION_ENTRY_TYPE = "pi-accounts-selection";

export class AccountSelection {
	constructor(onChange) {
		this.mode = "auto";
		this.accountId = null;
		this.revision = 0;
		this.intentRevision = 0;
		this.controller = new AbortController();
		this.onChange = onChange;
	}

	get signal() {
		return this.controller.signal;
	}

	snapshot() {
		return { mode: this.mode, accountId: this.accountId };
	}

	_wake() {
		const previous = this.controller;
		this.controller = new AbortController();
		this.revision++;
		previous.abort();
	}

	set(mode, accountId) {
		this.mode = mode;
		this.accountId = accountId;
		this.intentRevision++;
		this._wake();
		this.onChange?.(this.snapshot());
	}

	activate(accountId, options = {}) {
		if (this.accountId === accountId && !options.wake) return;
		this.accountId = accountId;
		if (options.wake) this._wake();
		this.onChange?.(this.snapshot());
	}

	restore(ctx) {
		let saved;
		for (const entry of ctx.sessionManager?.getBranch() ?? []) {
			if (entry.type !== "custom" || entry.customType !== SELECTION_ENTRY_TYPE) continue;
			const data = entry.data;
			const hasAccount = typeof data?.accountId === "string" && data.accountId.length > 0;
			if (
				(data?.mode === "auto" || data?.mode === "specified") &&
				(hasAccount || (data.mode === "auto" && data.accountId === null))
			) saved = data;
		}
		this.mode = saved?.mode ?? "auto";
		this.accountId = saved?.accountId ?? null;
		this.intentRevision++;
		this._wake();
	}
}
