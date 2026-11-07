import "dotenv/config";

import { ConfigError, loadConfig, type AppConfig } from "../infrastructure/config/ConfigManager.js";

/* LEGACY ADAPTER — transitional, deliberately kept.

   `env` is imported directly by the existing routes, services and middleware.
   Those imports are business-layer work (phase 2B+), so this module keeps the
   exact shape they rely on while delegating validation to the single
   ConfigManager. Two behaviours are preserved on purpose:

     * validation still happens at import time, before anything initializes;
     * a bad configuration still prints a loud, actionable message and exits 1,
       so a misconfigured deploy fails the same way it always has.

   New code should NOT import this module: it receives the frozen AppConfig
   through InitContext, which makes the dependency explicit and testable.

   When the last legacy importer is migrated, this file is deleted and the
   exit(1) moves to main.ts. */

function formatConfigIssues(error: ConfigError): string {
  return [
    "[config] FATAL: server configuration is invalid.",
    ...error.issues.map((issue) => `[config]   - ${issue}`),
    "[config] Copy backend/.env.example to backend/.env and fill it in.",
    "[config] Server refusing to start.",
  ].join("\n");
}

function loadOrExit(): AppConfig {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(formatConfigIssues(err));
      process.exit(1);
    }
    throw err;
  }
}

const config = loadOrExit();

export const env = {
  nodeEnv: config.nodeEnv,
  port: config.port,
  /** First allow-listed origin — used for logging and back-compat. */
  clientUrl: config.clientUrls[0] as string,
  /** Every origin allowed by CORS (CLIENT_URL, comma-separated). */
  clientUrls: config.clientUrls,
  cookieSameSite: config.cookieSameSite,
  cookieSecure: config.cookieSecure,
  databaseUrl: config.databaseUrl,
  staffPin: config.staffPin,
  adminPin: config.adminPin,
  kdsTokenSecret: config.kdsTokenSecret,
  supabaseJwtSecret: config.supabaseJwtSecret,
  geminiApiKey: config.geminiApiKey,
} as const;
