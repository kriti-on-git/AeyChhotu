/* ConfigurationManager — the single authoritative reader of environment
   variables for the new foundation.

   DESIGN RULES
   * Validation happens ONCE, before anything is initialized: `loadConfig`
     throws a ConfigError describing every problem, so a misconfigured server
     never half-starts.
   * This module never calls process.exit(). Deciding to die is the caller's
     job (the legacy config/env.ts adapter keeps the old loud exit; the app
     bootstrap surfaces the error and lets main exit).
   * The returned object is deeply frozen: configuration is immutable for the
     lifetime of the process, which is what makes it safe to hand to every
     component's InitContext.
   * Secret VALUES never appear in an error message — only variable names and
     non-secret values (PORT, COOKIE_SAME_SITE).

   BEHAVIOUR PRESERVATION: every rule below mirrors backend/src/config/env.ts
   as it existed before this refactor (same defaults, same 4-6 digit PIN rule,
   same derived `cookieSecure`, same comma-separated CORS list with trailing
   slashes stripped, same Supabase JWT / Gemini key optionality). */

export type SameSitePolicy = "Strict" | "Lax" | "None";
export type ImageStorageDriver = "postgres" | "supabase";

/** Express `trust proxy` value. Deliberately never a blind `true`: trusting
    every forwarded header lets a client spoof req.ip and evade IP limits. */
export type TrustProxyConfig = false | number | string;

/** Optional Supabase-backed dish-photo storage (sql/010). Declared here so
    the media module can receive it through InitContext later instead of
    reading process.env from inside a service. */
export interface ImageStorageConfig {
  readonly driver: ImageStorageDriver;
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly bucket: string;
}

export interface AppConfig {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly port: number;
  /** CORS allow-list (CLIENT_URL, comma-separated). Never empty. */
  readonly clientUrls: readonly string[];
  readonly cookieSameSite: SameSitePolicy;
  readonly cookieSecure: boolean;
  readonly databaseUrl: string;
  readonly staffPin: string;
  readonly adminPin: string;
  readonly kdsTokenSecret: string;
  /** How many proxy hops (or which loopback/subnet) set X-Forwarded-For. */
  readonly trustProxy: TrustProxyConfig;
  readonly supabaseJwtSecret: string | null;
  readonly geminiApiKey: string | null;
  /** Text model for server-owned conversations. Never a client input. */
  readonly geminiTextModel: string;
  readonly imageStorage: ImageStorageConfig;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = [...issues];
  }
}

const DEFAULT_PORT = 4000;
const DEFAULT_IMAGE_BUCKET = "menu-images";
const SAME_SITE_VALUES = ["strict", "lax", "none"] as const;
const PIN_RE = /^\d{4,6}$/;

/** Reads a variable as a trimmed non-empty string, or undefined. */
function read(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = source[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(source: NodeJS.ProcessEnv, name: string, issues: string[]): string {
  const value = read(source, name);
  if (!value) {
    issues.push(`${name} is required but missing or empty.`);
    return "";
  }
  return value;
}

/* Both PINs are the same shape and both fail the same way. They stay two
   separate calls so the error names the variable that is actually wrong. */
function requirePin(source: NodeJS.ProcessEnv, name: string, issues: string[]): string {
  const value = read(source, name);
  if (!value) {
    issues.push(`${name} is required but missing or empty.`);
    return "";
  }
  if (!PIN_RE.test(value)) {
    issues.push(`${name} must be a 4-6 digit numeric string.`);
    return "";
  }
  return value;
}

function parsePort(source: NodeJS.ProcessEnv, issues: string[]): number {
  const raw = read(source, "PORT");
  if (!raw) return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push(`PORT must be a valid TCP port number (1-65535), got "${raw}".`);
    return DEFAULT_PORT;
  }
  return port;
}

/* A browser's Origin header never carries a trailing slash, so
   `https://x.com/` would never match — strip them on the way in. */
function parseClientUrls(source: NodeJS.ProcessEnv, issues: string[]): string[] {
  const raw = read(source, "CLIENT_URL");
  if (!raw) {
    issues.push("CLIENT_URL must list at least one origin (comma-separated).");
    return [];
  }

  const urls = raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  if (urls.length === 0) {
    issues.push("CLIENT_URL must list at least one origin (comma-separated).");
    return [];
  }
  return urls;
}

/*   strict (default) — frontend and API share a site; the cookie is never
                      sent cross-site, which is the safest default.
     lax              — top-level navigations may carry it.
     none             — required when the API lives on a DIFFERENT site. */
function parseSameSite(source: NodeJS.ProcessEnv, issues: string[]): SameSitePolicy {
  const raw = (read(source, "COOKIE_SAME_SITE") ?? "strict").toLowerCase();

  if (!SAME_SITE_VALUES.includes(raw as (typeof SAME_SITE_VALUES)[number])) {
    issues.push(
      `COOKIE_SAME_SITE must be one of ${SAME_SITE_VALUES.join(", ")} — got "${raw}".`,
    );
    return "Strict";
  }

  if (raw === "strict") return "Strict";
  if (raw === "lax") return "Lax";
  return "None";
}

/* The deployment's proxy chain is configuration, not a guess. Render (and the
   documented reverse-proxy setup) puts exactly one hop in front of the API,
   so production defaults to `1`. Local development defaults to `loopback`, so
   X-Forwarded-For from a browser is never trusted. Setting TRUST_PROXY=true
   is allowed but explicit: it means "trust every hop", which is only correct
   when the API is unreachable except through a trusted proxy. */
function parseTrustProxy(
  source: NodeJS.ProcessEnv,
  nodeEnv: string,
  issues: string[],
): TrustProxyConfig {
  const raw = read(source, "TRUST_PROXY");
  if (raw === undefined) return nodeEnv === "production" ? 1 : "loopback";

  const lower = raw.toLowerCase();
  if (lower === "false" || lower === "off" || lower === "0") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (lower === "true") {
    issues.push(
      "TRUST_PROXY=true trusts every forwarded header; set the number of proxy hops instead.",
    );
    return false;
  }
  return raw;
}

/* The fifth of the app's env vars that used to be read straight from
   process.env inside services/menu-image.service.ts. Selecting "supabase"
   without a URL and a service-role key silently falls back to Postgres, which
   is the same degraded (working) deployment the service already logs about —
   a configuration problem, but not a reason to refuse to boot. */
function parseImageStorage(source: NodeJS.ProcessEnv): ImageStorageConfig {
  const supabaseUrl = (read(source, "SUPABASE_URL") ?? "").replace(/\/+$/, "");
  const serviceRoleKey = read(source, "SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bucket = read(source, "SUPABASE_MENU_BUCKET") ?? DEFAULT_IMAGE_BUCKET;
  const requested = (read(source, "IMAGE_STORAGE") ?? "").toLowerCase() === "supabase";

  const driver: ImageStorageDriver =
    requested && supabaseUrl !== "" && serviceRoleKey !== "" ? "supabase" : "postgres";

  return { driver, supabaseUrl, serviceRoleKey, bucket };
}

/**
 * Validate an environment source and return a frozen AppConfig.
 * @throws ConfigError listing every problem found, not just the first.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const issues: string[] = [];

  const nodeEnv = read(source, "NODE_ENV") ?? "development";
  const trustProxy = parseTrustProxy(source, nodeEnv, issues);
  const port = parsePort(source, issues);
  const clientUrls = parseClientUrls(source, issues);
  const cookieSameSite = parseSameSite(source, issues);
  const databaseUrl = requireString(source, "DATABASE_URL", issues);
  const staffPin = requirePin(source, "STAFF_PIN", issues);
  const adminPin = requirePin(source, "ADMIN_PIN", issues);
  const kdsTokenSecret = requireString(source, "KDS_TOKEN_SECRET", issues);

  // Fail with the complete picture: one restart should be enough to fix it.
  if (issues.length > 0) throw new ConfigError(issues);

  /* Secure is mandatory in production, and mandatory for SameSite=None in
     ANY environment because browsers silently drop the cookie otherwise. */
  const cookieSecure = nodeEnv === "production" || cookieSameSite === "None";

  const config: AppConfig = {
    nodeEnv,
    isProduction: nodeEnv === "production",
    port,
    clientUrls: Object.freeze([...clientUrls]),
    cookieSameSite,
    cookieSecure,
    databaseUrl,
    staffPin,
    adminPin,
    kdsTokenSecret,
    trustProxy,
    supabaseJwtSecret: read(source, "SUPABASE_JWT_SECRET") ?? null,
    geminiApiKey: read(source, "GEMINI_API_KEY") ?? null,
    geminiTextModel: read(source, "GEMINI_TEXT_MODEL") ?? "gemini-2.5-flash",
    imageStorage: Object.freeze(parseImageStorage(source)),
  };

  // Deep freeze: nested object and array are frozen above, the view is here.
  return Object.freeze(config);
}
