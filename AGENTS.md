# Project guidance

## Overview and layout

`pi-accounts` is a Pi coding-agent extension for multiple ChatGPT Codex OAuth accounts, quota display, account selection, and automatic failover. It also displays standard OpenAI API rate limits for other GPT models.

- `extensions/pi-accounts.js`: extension factory/default entry point, Pi lifecycle hooks, `/accounts` commands, TUI, and status display.
- `extensions/lib/account-manager.js`: credential import/refresh, account operations, selection, quota caching, and cooldowns.
- `extensions/lib/account-selection.js`: session/branch selection state, intent revisions, and cancellation signals.
- `extensions/lib/process-state.js`: process-local runtime shared by resolved store/auth paths.
- `extensions/lib/account-store.js` and `file-store.js`: validated account persistence, Pi auth synchronization, file locks, and atomic writes.
- `extensions/lib/managed-provider.js` and `managed-auth.js`: provider/auth wrapping, stream relay, and failover.
- `extensions/lib/quota.js`, `quota-wait.js`, `api-rate-limits.js`: Codex usage/reset credits, cancellable waits, and API response-header parsing.
- `extensions/lib/credentials.js` and `constants.js`: credential/alias utilities and shared settings.
- `test/`: Node tests; `test/fixtures/account-process.js` supports child-process integration tests; `test/helpers.js` supplies synthetic credentials and events.
- `README.md`: Chinese installation and usage documentation.

## Development commands

Requires Node.js `>=22.19.0`. This is plain JavaScript ESM (`type: module`); `proper-lockfile` is the only direct dependency. Pi provides its provider and UI interfaces at runtime.

Run from the repository root:

- `npm install`: documented dependency installation.
- `npm test`: runs `node --test`.
- `npm run test:coverage`: configured as `node --test --experimental-test-coverage`.
- `node --test test/account-manager.test.js`: run an individual test file.
- `pi -e /absolute/path/to/pi-accounts`: documented one-session local extension loading; `/reload` reloads an existing interactive session.

There are no build, lint, formatter, or type-check scripts/configurations in the tracked repository. The test suite passed locally on Node.js v25.9.0; live Pi/OAuth compatibility and coverage execution were not verified. README names Pi 0.84.4 as its baseline, not a manifest-pinned dependency.

## Coding and testing conventions

- Match existing tab indentation, double quotes, semicolons, named exports, and explicit `.js` relative imports; use `node:` imports for built-ins.
- Keep account/persistence/provider logic in dedicated `extensions/lib/` modules rather than expanding command handlers.
- Preserve dependency-injection seams such as `fetchImpl`, `now`, paths, and provider interfaces.
- Tests use `node:test` and `node:assert/strict`. Follow the existing `test/*.test.js` layout; integration tests use temporary directories, local HTTP servers, child processes, and synthetic credentials rather than real accounts.
- Clean up temporary files, servers, processes, and timers. Use existing test patterns for selection races, aborts, and concurrent token refresh.

## Safety constraints and pitfalls

- Account credentials live in `~/.pi/agent/pi-accounts.json`, or under `PI_CODING_AGENT_DIR`; Pi's `auth.json` is alongside it. Never log, commit, or copy real OAuth tokens or auth files into fixtures/docs. Use isolated temporary agent directories when exercising account operations.
- Preserve locked read-modify-write operations, atomic replacement, and restrictive permissions (new credential files default to `0600`, directories to `0700`). OAuth refresh must remain inside the cross-process account-store lock because refresh tokens rotate.
- Do not switch Pi's shared login merely because managed accounts rotate. Auth synchronization is account-ID scoped, must not overwrite newer credentials, and must preserve unrelated providers.
- Selection is session/branch scoped; quota caches, cooldowns, and the serialization queue are process-local runtime state. Preserve selection revisions/intent guards so stale asynchronous work cannot override newer user choices.
- Current source/tests differ from older README semantics: `/accounts use` pins the specified account and waits on its quota rather than failing over to another account; `/accounts auto` enables rotation. Automatic mode can wait for exhausted accounts to recover. Keep waits cancellable by request/shutdown and responsive to selection changes.
- Always pass the selected account's access token explicitly to provider attempts. Never replay a request after meaningful streamed output; preserve terminal errors, cancellation, and single-start stream behavior.
- Consuming a reset credit is an irreversible remote action. Keep explicit UI confirmation and the in-flight guard. Never automatically retry consumption after a network/server/malformed-response failure: its outcome may be unknown and the credit may already be consumed.
- Quota endpoints and Pi provider interfaces are upstream-sensitive. Keep optional reset-credit detail failures from breaking ordinary quota checks; verify changes against the existing integration tests rather than assuming README behavior is current.
