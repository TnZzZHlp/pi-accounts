import { NoManagedAccountsError } from "./account-manager.js";

const SOURCE = "Managed Codex accounts";

export function createManagedAuth(baseAuth, manager, lifecycle = {}) {
	const resolve = async (signal) => {
		const signals = [signal, lifecycle.signal].filter(Boolean);
		signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
		if ((await manager.getAccountCount()) === 0) return undefined;
		const account = await manager.prepareAttempt({
			checkQuota: false,
			allowExhausted: true,
			signal,
		});
		return { auth: { apiKey: account.credential.access }, source: SOURCE };
	};

	return {
		...baseAuth,
		apiKey: {
			...baseAuth?.apiKey,
			name: SOURCE,
			check: async () => (await manager.getAccountCount()) > 0
				? { type: "oauth", source: SOURCE }
				: undefined,
			resolve: ({ signal }) => resolve(signal),
		},
		oauth: baseAuth?.oauth && {
			...baseAuth.oauth,
			refresh: async (credential) => credential,
			toAuth: async () => {
				const result = await resolve();
				if (!result) throw new NoManagedAccountsError();
				return result.auth;
			},
		},
	};
}
