import { timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import { signToken, type ShiftClaims } from "../lib/jwt.js";
import { iso } from "../lib/util.js";
import { pool } from "../db/pool.js";

/* Module 1 — Shift Authentication Engine.
   ZERO-EXPOSURE RULE: the raw STAFF_PIN, signing secrets and internal
   config values never appear in a response payload or a log line — only
   their names (e.g. "STAFF_PIN") or derived artifacts (the signed token)
   leave this module. */

const TOKEN_TTL_SECONDS = 8 * 60 * 60; // one 8-hour shift

/** Constant-time-ish PIN comparison (both sides fixed length). */
function pinMatches(attempt: string, expected: string): boolean {
  const a = Buffer.from(attempt);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ShiftLoginResult {
  token: string;
  token_type: "Bearer";
  expires_in: number;
  role: string;
  terminal_id: string | null;
  message: string;
}

/* E2 — POST /api/v1/auth/kds-login.
   Validates the payload pin against STAFF_PIN and issues a signed JWT
   carrying the explicit role claim `role: "kitchen"` plus the master
   terminal binding resolved from staff_terminals. */
export async function authenticateShift(pin: string): Promise<ShiftLoginResult> {
  if (!pinMatches(pin, env.staffPin)) {
    // Message is static — the attempted pin is never echoed anywhere.
    throw new AppError(401, "INVALID_PIN", "Invalid staff access configuration credentials.");
  }

  const terminal = await pool.query<{ id: string }>(
    `SELECT id
       FROM staff_terminals
      WHERE role = 'kitchen' AND is_active = true
      ORDER BY created_at, id
      LIMIT 1`,
  );

  const now = Math.floor(Date.now() / 1000);
  const claims: ShiftClaims = {
    role: "kitchen",
    terminal_id: terminal.rows[0]?.id ?? null,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };

  return {
    token: signToken(claims, env.kdsTokenSecret),
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    role: claims.role,
    terminal_id: claims.terminal_id,
    message: "Shift successfully armed. Tap screen to authorize chimes.",
  };
}

export interface SessionIdentity {
  authenticated: true;
  role: string;
  terminal_id: string | null;
  issued_at: string;
  expires_at: string;
  source: "header" | "cookie";
}

/* GET /api/v1/auth/me — decodes the active bearer token (or cookie) into
   the current terminal session identity. Claims only; no secrets. */
export function sessionIdentity(claims: ShiftClaims, source: "header" | "cookie"): SessionIdentity {
  return {
    authenticated: true,
    role: claims.role,
    terminal_id: claims.terminal_id,
    issued_at: iso(new Date(claims.iat * 1000)),
    expires_at: iso(new Date(claims.exp * 1000)),
    source,
  };
}
