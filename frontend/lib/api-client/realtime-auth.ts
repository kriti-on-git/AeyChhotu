/* Shared holder for the Supabase-scoped READ token (the `realtime_token`
   field of E1/E2). Lives in its own module so both `endpoints.ts`
   (which sets it) and `realtime.ts` (which consumes it) can import it
   without an import cycle.

   The token's claims are what the RLS policies in
   backend/sql/001_init.sql scope on:
     - diners:  table_token claim → only their own table's rows
     - staff:   staff claim      → the whole floor
   With no token the policies match nothing, so the client degrades to
   REST-only instead of leaking rows to the public anon key. */

let readToken: string | null = null;
let onTokenChange: ((token: string | null) => void) | null = null;

/** Stores the token. Called by initializeSession (E1) and loginKDS (E2). */
export function setRealtimeAuth(token: string | null): void {
  readToken = token;
  onTokenChange?.(token);
}

/** Current token, or null when unconfigured / signed out. */
export function getRealtimeAuth(): string | null {
  return readToken;
}

/** realtime.ts subscribes so a token arriving after client creation is
    pushed into the open socket immediately (heartbeats pick it up too). */
export function onRealtimeAuthChange(handler: (token: string | null) => void): void {
  onTokenChange = handler;
}
