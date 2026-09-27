/* KDS shift token storage.
   Browser: httpOnly-less copy of the bearer token in localStorage so the
   client can inject `Authorization: Bearer` (the httpOnly kds_token cookie
   set by the server stays unreadable by JS and works same-origin only).
   SSR/Node: an in-memory fallback keeps the module safe during prerender
   and lets integration tests run outside a browser. */

const TOKEN_KEY = "aeychhotu.kds_token";

let memoryToken: string | null = null;

function hasWebStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getKdsToken(): string | null {
  if (hasWebStorage()) {
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch {
      return memoryToken;
    }
  }
  return memoryToken;
}

export function storeKdsToken(token: string): void {
  memoryToken = token;
  if (hasWebStorage()) {
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* Private mode / quota: the in-memory copy still serves this tab. */
    }
  }
}

/** Used by the global 401 guard and by an explicit staff logout. */
export function clearKdsToken(): void {
  memoryToken = null;
  if (hasWebStorage()) {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* Nothing else to wipe. */
    }
  }
}
