export const CODEX_PROVIDER = "openai-codex";
export const CODEX_API = "openai-codex-responses";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export const ACCOUNT_STORE_VERSION = 1;
export const ACCOUNT_STORE_FILENAME = "pi-accounts.json";
export const PI_AUTH_FILENAME = "auth.json";
export const STATUS_KEY = "pi-accounts";
export const LOGIN_WIDGET_KEY = "pi-accounts-login";

export const QUOTA_TTL_MS = 45_000;
export const QUOTA_POLL_INTERVAL_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
export const DEFAULT_LIMIT_COOLDOWN_MS = 5 * 60_000;
export const DEFAULT_UNAVAILABLE_COOLDOWN_MS = 60_000;

export const JWT_ACCOUNT_CLAIM = "https://api.openai.com/auth";
export const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";
