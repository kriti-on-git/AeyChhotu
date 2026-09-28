import { createHmac, timingSafeEqual } from "node:crypto";

/* Minimal HS256 JWT (sign + verify) built on node:crypto — no external
   dependency. Shift tokens are issued by POST /api/v1/auth/kds-login after
   the STAFF_PIN match and carry explicit role claims:
     { role: "kitchen", terminal_id, iat, exp }
   This is NOT the Supabase service_role key and never leaves the server
   in any response body other than as the bearer token itself. */

export interface ShiftClaims {
  /** Explicit role claim enforced by requireRole(). */
  role: string;
  /** staff_terminals.id of the master terminal the shift signed into. */
  terminal_id: string | null;
  iat: number;
  exp: number;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Raw HS256 JWS over the given claims (shared by both token kinds). */
function signClaims(claims: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function signToken(claims: ShiftClaims, secret: string): string {
  return signClaims(claims as unknown as Record<string, unknown>, secret);
}

/** Claims for the Supabase-scoped READ tokens (E1 diner / E2 staff).
    `role` must be a real Postgres role so PostgREST/Realtime accept the
    token; `table_token` / `staff` are the two branches the RLS policies
    in sql/001_init.sql match on. Never carries a secret — only scope. */
export interface ReadTokenClaims {
  sub: string;
  role: "authenticated";
  table_token?: string;
  staff?: string;
  iat: number;
  exp: number;
}

/** Signed with SUPABASE_JWT_SECRET (NOT KDS_TOKEN_SECRET) so Supabase
    itself validates the signature and forwards the claims to RLS. */
export function signReadToken(claims: ReadTokenClaims, secret: string): string {
  return signClaims(claims as unknown as Record<string, unknown>, secret);
}

/** Returns the claims when signature and expiry are valid, else null.
   The role value itself is NOT judged here — requireRole() turns a
   valid-but-wrong role into a 403 (not a 401). */
export function verifyToken(token: string, secret: string): ShiftClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  const expected = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");

  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ShiftClaims;
    if (typeof claims.role !== "string" || claims.role.length === 0) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}
