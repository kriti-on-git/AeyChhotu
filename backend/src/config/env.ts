import "dotenv/config";

/* Central env validation. This module fails loudly (clear message + exit 1)
   the moment a required variable is missing, so a misconfigured server never
   starts half-working. */

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      [
        `[config] FATAL: required environment variable "${name}" is missing or empty.`,
        `[config] Copy backend/.env.example to backend/.env and fill it in.`,
        `[config] Server refusing to start.`,
      ].join("\n"),
    );
    process.exit(1);
  }
  return value;
}

function requireStaffPin(): string {
  const pin = process.env.STAFF_PIN?.trim();
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    console.error(
      [
        `[config] FATAL: STAFF_PIN must be a 4-6 digit numeric string — it is missing or invalid.`,
        `[config] Copy backend/.env.example to backend/.env and fill it in.`,
        `[config] Server refusing to start.`,
      ].join("\n"),
    );
    process.exit(1);
  }
  return pin;
}

const portRaw = process.env.PORT ?? "4000";
const port = Number(portRaw);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[config] FATAL: PORT must be a valid TCP port number, got "${portRaw}".`);
  process.exit(1);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port,
  /** Only origin allowed by CORS. */
  clientUrl: requireEnv("CLIENT_URL"),
  /** Postgres/Supabase connection string — fails loudly if missing. */
  databaseUrl: requireEnv("DATABASE_URL"),
  /** Kitchen shift PIN checked by POST /api/v1/auth/kds-login (E2). */
  staffPin: requireStaffPin(),
  /** HMAC secret used to sign/verify the KDS bearer tokens issued by E2. */
  kdsTokenSecret: requireEnv("KDS_TOKEN_SECRET"),
} as const;
