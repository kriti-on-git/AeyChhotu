/* Table module — Supabase read-token issuer.

   The diner's browser hands this token to Supabase; its `table_token` claim is
   what the RLS policies match on. It is issued only after a session is
   GRANTED, never on a `locked` reply, and carries READ scope only — every
   write still goes through this backend. */

import { signReadToken } from "../../lib/jwt.js";
import type { ReadTokenIssuer } from "./table.types.js";

const READ_TOKEN_TTL_SECONDS = 12 * 60 * 60; // one long dining session

export function createReadTokenIssuer(secret: string | null): ReadTokenIssuer {
  if (!secret) return () => null;

  return (table) => {
    const now = Math.floor(Date.now() / 1000);
    return signReadToken(
      {
        sub: table.id,
        role: "authenticated",
        table_token: table.code,
        iat: now,
        exp: now + READ_TOKEN_TTL_SECONDS,
      },
      secret,
    );
  };
}
