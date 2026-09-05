import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { AccountManager } from "./lib/account-manager.js";
import { AccountStore } from "./lib/account-store.js";
import {
	formatOpenAiRateLimitStatus,
	isGptModel,
	parseOpenAiRateLimits,
} from "./lib/api-rate-limits.js";
import {
	ACCOUNT_STORE_FILENAME,
	CODEX_API,
	CODEX_PROVIDER,
	LOGIN_WIDGET_KEY,
	PI_AUTH_FILENAME,
	QUOTA_POLL_INTERVAL_MS,
	STATUS_KEY,
} from "./lib/constants.js";
import { asText, maskEmail, validateAlias } from "./lib/credentials.js";
import { BASE_PROVIDER_SYMBOL, createManagedProvider } from "./lib/managed-provider.js";
import {
	formatQuotaDetails,
	formatQuotaStatus,
	formatQuotaStatusBar,
	formatRemainingTime,
} from "./lib/quota.js";

export function resolvePiAgentDir(env = process.env, home = homedir()) {
	const configured = asText(env.PI_CODING_AGENT_DIR);
	if (!configured) return join(home, ".pi", "agent");
	if (configured === "~") return home;
	if (configured.startsWith("~/") || configured.startsWith("~\\")) {
		return resolve(home, configured.slice(2));
	}
	return isAbsolute(configured) ? configured : resolve(configured);
}

export function isCodexModel(model) {
	return model?.provider === CODEX_PROVIDER && model?.api === CODEX_API;
}

function notify(ctx, message, type = "info") {
	if (ctx.hasUI === false) return;
	ctx.ui.notify(message, type);
}

function activeAccount(view) {
	return view.accounts.find((account) => account.active) ?? view.accounts[0];
}

function formatFooter(view, now = Date.now()) {
	if (view.accounts.length === 0) return "accounts: /accounts add";
	const active = activeAccount(view);
	const quota = formatQuotaStatusBar(active.quota, now);
	if (quota) return `${active.alias} · ${quota}`;
	if (active.cooldown) {
		return `${active.alias} · ${active.cooldown.kind} ${formatRemainingTime(active.cooldown.until - now)}`;
	}
	return `${active.alias} · quota unavailable`;
}

function formatCodexStatus(view, now = Date.now()) {
	const active = activeAccount(view);
	if (!active) return undefined;
	const details = formatQuotaStatus(active.quota, now);
	if (!details) return undefined;
	const identity = [asText(active.email)?.slice(0, 80), asText(active.quota?.planType)?.slice(0, 24)]
		.filter(Boolean)
		.join(", ");
	return `Codex ${active.alias}${identity ? ` (${identity})` : ""}: ${details}`;
}

function modelKey(model) {
	return [model?.provider, model?.api, model?.id].map((value) => String(value ?? "")).join("\u0000");
}

function formatAccountList(view) {
	if (view.accounts.length === 0) return "No managed Codex accounts. Run /accounts add [alias].";
	const lines = view.accounts.map((account) => {
		const marker = account.active ? "*" : " ";
		const identity = maskEmail(account.email);
		const quota = formatQuotaDetails(account.quota);
		const cooldown = account.cooldown
			? `; ${account.cooldown.kind} for ${formatRemainingTime(account.cooldown.until - Date.now())}`
			: "";
		const error = account.quotaError ? `; quota check: ${account.quotaError}` : "";
		return `${marker} ${account.alias}${identity ? ` (${identity})` : ""}: ${quota}${cooldown}${error}`;
	});
	return [`Codex accounts (${view.accounts.length}):`, ...lines].join("\n");
}

function formatTuiAccount(account, now = Date.now()) {
	const marker = account.active ? "*" : " ";
	const identity = maskEmail(account.email);
	const quota = account.quota ? formatQuotaDetails(account.quota, now) : undefined;
	const availability =
		quota ??
		(account.cooldown
			? `${account.cooldown.kind} ${formatRemainingTime(account.cooldown.until - now)}`
			: "quota unavailable");
	return `${marker} ${account.alias}${identity ? ` (${identity})` : ""} · ${availability}`;
}

function formatAuthEvent(event) {
	if (event.type === "auth_url") {
		return [event.instructions, event.url].filter(Boolean);
	}
	if (event.type === "device_code") {
		return [
			"Open this URL in a browser:",
			event.verificationUri,
			`Device code: ${event.userCode}`,
		];
	}
	if (event.type === "info") {
		return [event.message, ...(event.links ?? []).map((link) => `${link.label ?? "Link"}: ${link.url}`)];
	}
	return [event.message];
}

function createLoginInteraction(ctx, controller) {
	return {
		signal: controller.signal,
		async prompt(prompt) {
			if (prompt.type === "select") {
				const labels = prompt.options.map((option) =>
					option.description ? `${option.label} — ${option.description}` : option.label,
				);
				const selected = await ctx.ui.select(prompt.message, labels, { signal: prompt.signal });
				if (selected === undefined) throw new Error("Login cancelled");
				const index = labels.indexOf(selected);
				if (index < 0) throw new Error("Login returned an unknown selection");
				return prompt.options[index].id;
			}
			const entered = await ctx.ui.input(prompt.message, prompt.placeholder, { signal: prompt.signal });
			if (entered === undefined) throw new Error("Login cancelled");
			return entered;
		},
		notify(event) {
			const lines = formatAuthEvent(event).filter(Boolean);
			ctx.ui.setWidget(LOGIN_WIDGET_KEY, lines, { placement: "aboveEditor" });
		},
	};
}

function parseCommand(args) {
	const parts = String(args ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	return { subcommand: parts.shift()?.toLowerCase(), args: parts };
}

function commandHelp() {
	return [
		"/accounts — open the interactive account manager",
		"/accounts list — list accounts and quota",
		"/accounts add [alias] — sign in to another ChatGPT Codex account",
		"/accounts import [alias] — import Pi's current openai-codex login",
		"/accounts use <alias> — manually select the account used next",
		"/accounts auto — select the next account with quota",
		"/accounts refresh — refresh quota for every account",
		"/accounts status — show detailed GPT quota status",
		"/accounts rename <old> <new> — rename an alias",
		"/accounts remove <alias> — remove a stored account",
	].join("\n");
}

export function createPiAccountsExtension(options = {}) {
	return function piAccountsExtension(pi) {
		const agentDir = options.agentDir ?? resolvePiAgentDir(options.env, options.home);
		const store = options.store ?? new AccountStore(options.storePath ?? join(agentDir, ACCOUNT_STORE_FILENAME));
		let currentContext;
		let baseProvider;
		let pollTimer;
		let shuttingDown = false;
		let apiRateLimits;
		let resetCreditInFlight = false;
		const now = () => options.now?.() ?? Date.now();

		const manager =
			options.manager ??
			new AccountManager({
				store,
				authPath: options.authPath ?? join(agentDir, PI_AUTH_FILENAME),
				fetchImpl: options.fetchImpl,
				now: options.now,
				quotaTtlMs: options.quotaTtlMs,
				refreshSkewMs: options.refreshSkewMs,
				onChange: () => {
					if (currentContext && !shuttingDown) void updateFooter(currentContext);
				},
			});

		async function updateFooter(ctx) {
			if (ctx.hasUI === false || shuttingDown) return undefined;
			try {
				ctx.ui.setStatus(STATUS_KEY, formatFooter(await manager.getView(), now()));
				return undefined;
			} catch (error) {
				return (
					asText(error instanceof Error ? error.message : String(error))?.slice(0, 200) ??
					"unknown footer status error"
				);
			}
		}

		async function showQuotaStatus(ctx) {
			if (!isGptModel(ctx.model)) {
				notify(ctx, "No GPT model is active.");
				return;
			}
			if (isCodexModel(ctx.model)) {
				await manager.refreshAll({ force: true, signal: ctx.signal });
				const view = await manager.getView();
				const footerError = await updateFooter(ctx);
				const details = formatCodexStatus(view, now());
				if (details) {
					notify(
						ctx,
						footerError ? `${details}\nFooter status error: ${footerError}` : details,
						footerError ? "warning" : "info",
					);
					return;
				}
				notify(ctx, "Codex quota data is unavailable.", "warning");
				return;
			}
			const details =
				apiRateLimits?.modelKey === modelKey(ctx.model)
					? formatOpenAiRateLimitStatus(apiRateLimits.snapshot)
					: undefined;
			notify(
				ctx,
				details ?? "GPT API quota data is unavailable. Send a request to refresh it.",
				details ? "info" : "warning",
			);
		}

		async function refreshModelRegistry(ctx) {
			try {
				await ctx.modelRegistry.refresh({ providers: [CODEX_PROVIDER] });
			} catch {
				// Static built-in models usually need no refresh; auth is re-read per request.
			}
		}

		async function showAccounts(ctx, force = false) {
			if (force) await manager.refreshAll({ force: true });
			const view = await manager.getView();
			await updateFooter(ctx);
			notify(ctx, formatAccountList(view), view.accounts.some((account) => account.quotaError) ? "warning" : "info");
		}

		async function addAccount(ctx, alias) {
			if (ctx.hasUI === false) throw new Error("/accounts add requires interactive or RPC UI");
			if (alias !== undefined) validateAlias(alias);
			const oauth = baseProvider?.auth?.oauth;
			if (!oauth) throw new Error("OpenAI Codex OAuth is unavailable; run /reload and try again");
			const controller = new AbortController();
			try {
				ctx.ui.setWidget(LOGIN_WIDGET_KEY, ["Starting ChatGPT Codex login…"], {
					placement: "aboveEditor",
				});
				const credential = await oauth.login(createLoginInteraction(ctx, controller));
				const account = await manager.addCredential(credential, alias);
				await refreshModelRegistry(ctx);
				await manager.refreshAll({ force: true }).catch(() => undefined);
				await updateFooter(ctx);
				notify(ctx, `Added and selected Codex account "${account.alias}".`);
			} finally {
				controller.abort();
				ctx.ui.setWidget(LOGIN_WIDGET_KEY, undefined);
			}
		}

		async function selectAccount(ctx, alias) {
			const account = await manager.use(alias);
			await refreshModelRegistry(ctx);
			await updateFooter(ctx);
			notify(
				ctx,
				`Selected Codex account "${account.alias}"${ctx.isIdle() ? "." : " for the next provider request."}`,
			);
			return account;
		}

		async function renameAccount(ctx, oldAlias, newAlias) {
			const account = await manager.rename(oldAlias, newAlias);
			await updateFooter(ctx);
			notify(ctx, `Renamed Codex account to "${account.alias}".`);
			return account;
		}

		async function consumeResetCredit(ctx, alias) {
			if (ctx.hasUI === false) throw new Error("Consuming a reset credit requires interactive or RPC UI");
			if (resetCreditInFlight) {
				notify(ctx, "A reset credit consumption is already in progress.", "warning");
				return;
			}
			resetCreditInFlight = true;
			try {
				const account = await manager.refreshAccount(alias, { force: true, signal: ctx.signal });
				if (!account) throw new Error(`Unknown account: ${alias}`);
				const available = account.quota?.resetCredits;
				if (available === undefined) {
					notify(ctx, `Cannot consume a reset credit for account "${account.alias}": available count is unknown.`, "warning");
					return;
				}
				if (available <= 0) {
					notify(ctx, `Account "${account.alias}" has no reset credits available.`, "warning");
					return;
				}
				const confirmed = await ctx.ui.confirm(
					"Consume Codex reset credit",
					`Consume one reset credit for account "${account.alias}"? This is an irreversible remote action.`,
				);
				if (!confirmed) {
					notify(ctx, "Reset credit consumption cancelled.");
					return;
				}
				const result = await manager.consumeResetCredit(account.alias, { signal: ctx.signal });
				if (!result.consumed) {
					notify(
						ctx,
						result.reason === "none"
							? `Account "${account.alias}" has no reset credits available.`
							: `Cannot consume a reset credit for account "${account.alias}": available count is unknown.`,
						"warning",
					);
					return;
				}
				await updateFooter(ctx);
				if (!result.refreshed) {
					notify(
						ctx,
						`Consumed one reset credit for account "${account.alias}", but usage refresh failed: ${result.refreshError}`,
						"warning",
					);
					return;
				}
				notify(
					ctx,
					`Consumed one reset credit for account "${account.alias}". ${formatQuotaDetails(result.snapshot, now())}`,
				);
			} finally {
				resetCreditInFlight = false;
			}
		}

		async function removeAccount(ctx, alias) {
			if (ctx.hasUI === false) throw new Error("Removing an account requires interactive or RPC UI");
			const confirmed = await ctx.ui.confirm(
				"Remove Codex account",
				`Delete the locally stored OAuth credentials for "${alias}"?`,
			);
			if (!confirmed) {
				notify(ctx, "Account removal cancelled.");
				return undefined;
			}
			const account = await manager.remove(alias);
			await refreshModelRegistry(ctx);
			await updateFooter(ctx);
			notify(ctx, `Removed Codex account "${account.alias}".`, "warning");
			return account;
		}

		async function showAccountActions(ctx, initialAlias) {
			let alias = initialAlias;
			while (true) {
				const view = await manager.getView();
				const account = view.accounts.find((candidate) => candidate.alias === alias);
				if (!account) return;
				const details = formatQuotaDetails(account.quota, now());
				const choices = [
					...(account.active ? [] : ["Use this account"]),
					"Consume one reset credit",
					"Rename account",
					"Remove account",
					"Back",
				];
				const choice = await ctx.ui.select(
					`Account "${account.alias}"${account.active ? " (active)" : ""} — ${details}`,
					choices,
				);
				if (choice === undefined || choice === "Back") return;
				if (choice === "Use this account") {
					await selectAccount(ctx, account.alias);
					return;
				}
				if (choice === "Consume one reset credit") {
					await consumeResetCredit(ctx, account.alias);
					continue;
				}
				if (choice === "Rename account") {
					const value = await ctx.ui.input("Rename Codex account", account.alias);
					if (value === undefined || value.trim() === "" || value === account.alias) continue;
					const renamed = await renameAccount(ctx, account.alias, value);
					alias = renamed.alias;
					return;
				}
				if (choice === "Remove account") {
					await removeAccount(ctx, account.alias);
					return;
				}
			}
		}

		async function showAccountTui(ctx) {
			if (ctx.hasUI === false) throw new Error("The account manager requires TUI or RPC UI");
			const refreshLabel = "Refresh all quotas";
			const autoLabel = "Auto-select an available account";
			const addLabel = "Add another Codex login";
			const importLabel = "Import Pi's current Codex login";
			const closeLabel = "Close";
			const initialView = await manager.getView();
			if (initialView.accounts.some((account) => !account.quota)) {
				await manager.refreshAll({ force: false });
				await updateFooter(ctx);
			}
			while (true) {
				const view = await manager.getView();
				const orderedAccounts = [...view.accounts].sort(
					(left, right) => Number(right.active) - Number(left.active),
				);
				const accountOptions = new Map(
					orderedAccounts.map((account) => [formatTuiAccount(account, now()), account.alias]),
				);
				const choice = await ctx.ui.select("Codex account manager", [
					...accountOptions.keys(),
					refreshLabel,
					autoLabel,
					addLabel,
					importLabel,
					closeLabel,
				]);
				if (choice === undefined || choice === closeLabel) return;
				try {
					const alias = accountOptions.get(choice);
					if (alias) {
						await showAccountActions(ctx, alias);
						continue;
					}
					if (choice === refreshLabel) {
						notify(ctx, "Refreshing Codex account quotas…");
						await manager.refreshAll({ force: true });
						await updateFooter(ctx);
						continue;
					}
					if (choice === autoLabel) {
						const account = await manager.chooseAuto();
						await refreshModelRegistry(ctx);
						await updateFooter(ctx);
						notify(ctx, `Auto-selected Codex account "${account.alias}".`);
						continue;
					}
					if (choice === addLabel) {
						const value = await ctx.ui.input("Add Codex account", "optional alias");
						if (value !== undefined) await addAccount(ctx, asText(value));
						continue;
					}
					if (choice === importLabel) {
						const value = await ctx.ui.input("Import current Codex login", "optional alias");
						if (value === undefined) continue;
						const account = await manager.importCurrent(asText(value), { makeActive: true });
						await updateFooter(ctx);
						notify(ctx, `Imported and selected Codex account "${account.alias}".`);
					}
				} catch (error) {
					notify(ctx, error instanceof Error ? error.message : String(error), "error");
				}
			}
		}

		async function handleAccountCommand(rawArgs, ctx) {
			currentContext = ctx;
			const parsed = parseCommand(rawArgs);
			try {
				switch (parsed.subcommand) {
					case undefined:
					case "tui":
					case "menu":
					case "manage":
						await showAccountTui(ctx);
						return;
					case "list":
					case "ls":
						await showAccounts(ctx, false);
						return;
					case "status":
						await showQuotaStatus(ctx);
						return;
					case "refresh":
						await showAccounts(ctx, true);
						return;
					case "add":
					case "login":
						if (parsed.args.length > 1) throw new Error("Usage: /accounts add [alias]");
						await addAccount(ctx, parsed.args[0]);
						return;
					case "import": {
						if (parsed.args.length > 1) throw new Error("Usage: /accounts import [alias]");
						const account = await manager.importCurrent(parsed.args[0], { makeActive: true });
						await updateFooter(ctx);
						notify(ctx, `Imported and selected Codex account "${account.alias}".`);
						return;
					}
					case "use": {
						if (parsed.args.length !== 1) throw new Error("Usage: /accounts use <alias>");
						await selectAccount(ctx, parsed.args[0]);
						return;
					}
					case "auto": {
						const account = await manager.chooseAuto();
						await refreshModelRegistry(ctx);
						await updateFooter(ctx);
						notify(ctx, `Auto-selected Codex account "${account.alias}".`);
						return;
					}
					case "rename": {
						if (parsed.args.length !== 2) throw new Error("Usage: /accounts rename <old> <new>");
						await renameAccount(ctx, parsed.args[0], parsed.args[1]);
						return;
					}
					case "remove":
					case "delete": {
						if (parsed.args.length !== 1) throw new Error("Usage: /accounts remove <alias>");
						await removeAccount(ctx, parsed.args[0]);
						return;
					}
					case "help":
					case "--help":
					case "-h":
						notify(ctx, commandHelp());
						return;
					default:
						throw new Error(`Unknown /accounts subcommand: ${parsed.subcommand}\n${commandHelp()}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, message, "error");
			}
		}

		async function getArgumentCompletions(argumentPrefix) {
			const prefix = String(argumentPrefix ?? "");
			const tokens = prefix.trimStart().split(/\s+/);
			const subcommands = [
				"tui",
				"list",
				"refresh",
				"status",
				"add",
				"import",
				"use",
				"auto",
				"rename",
				"remove",
				"help",
			];
			if (tokens.length <= 1 && !prefix.endsWith(" ")) {
				const needle = tokens[0]?.toLowerCase() ?? "";
				return subcommands
					.filter((command) => command.startsWith(needle))
					.map((command) => ({ value: command, label: command }));
			}
			const command = tokens[0]?.toLowerCase();
			if (!["use", "remove", "delete", "rename"].includes(command)) return null;
			const view = await manager.getView();
			const needle = (tokens.at(-1) ?? "").toLocaleLowerCase("en-US");
			return view.accounts
				.filter((account) => account.alias.toLocaleLowerCase("en-US").startsWith(needle))
				.map((account) => ({ value: account.alias, label: account.alias }));
		}

		const commandOptions = {
			description: "Manage multiple ChatGPT Codex accounts and quota failover",
			getArgumentCompletions,
			handler: handleAccountCommand,
		};
		pi.registerCommand("accounts", commandOptions);

		pi.on("session_start", async (_event, ctx) => {
			shuttingDown = false;
			currentContext = ctx;
			apiRateLimits = undefined;
			const provider = ctx.modelRegistry.getProvider(CODEX_PROVIDER);
			if (!provider) {
				notify(ctx, "pi-accounts could not find Pi's openai-codex provider.", "error");
				return;
			}
			baseProvider = provider[BASE_PROVIDER_SYMBOL] ?? provider;
			try {
				manager.setProvider(baseProvider);
				await manager.initialize({ checkQuota: true });
				pi.registerProvider(createManagedProvider(baseProvider, manager));
				await refreshModelRegistry(ctx);
				await updateFooter(ctx);
				if (pollTimer) clearInterval(pollTimer);
				pollTimer = setInterval(() => {
					void manager.refreshAll({ force: false }).then(() => updateFooter(ctx));
				}, options.pollIntervalMs ?? QUOTA_POLL_INTERVAL_MS);
				pollTimer.unref?.();
			} catch (error) {
				notify(ctx, `pi-accounts initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				await updateFooter(ctx);
			}
		});

		pi.on("before_agent_start", async (_event, ctx) => {
			currentContext = ctx;
			if (!isCodexModel(ctx.model)) return;
			try {
				await manager.ensureReady({ checkQuota: true, signal: ctx.signal });
				await updateFooter(ctx);
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "warning");
			}
		});

		pi.on("model_select", async (_event, ctx) => {
			currentContext = ctx;
			apiRateLimits = undefined;
			await updateFooter(ctx);
		});

		pi.on("after_provider_response", (event, ctx) => {
			currentContext = ctx;
			if (ctx.hasUI === false || !isGptModel(ctx.model) || isCodexModel(ctx.model)) return;
			const snapshot = parseOpenAiRateLimits(event.headers);
			if (snapshot) apiRateLimits = { modelKey: modelKey(ctx.model), snapshot };
		});

		pi.on("agent_end", (_event, ctx) => {
			currentContext = ctx;
			if (isCodexModel(ctx.model)) {
				void manager.refreshAll({ force: false }).then(() => updateFooter(ctx));
			}
		});

		pi.on("session_shutdown", (_event, ctx) => {
			shuttingDown = true;
			apiRateLimits = undefined;
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = undefined;
			if (ctx.hasUI !== false) {
				ctx.ui.setWidget(LOGIN_WIDGET_KEY, undefined);
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		});

		return { manager };
	};
}

export default createPiAccountsExtension();
