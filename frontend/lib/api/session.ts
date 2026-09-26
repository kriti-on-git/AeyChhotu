/* Anonymous diner session. The randomised table token is cached in
   localStorage so a refresh or an accidental tab close restores the live
   cart instead of orphaning the session (docs/ui-ux-blueprint.txt → strategy 3). */

const TOKEN_KEY = "aeychhotu.table_token";
const NAME_KEY = "aeychhotu.diner_name";
const DEVICE_KEY = "aeychhotu.device_id";

export const DEFAULT_DISPLAY_NAME = "Guest";

function read(key: string): string | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Ignore blocked storage; the session simply will not be restored. */
  }
}

export function createId(prefix: string) {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);

  return `${prefix}_${random}`;
}

export function getStoredTableToken() {
  return read(TOKEN_KEY);
}

export function storeTableToken(token: string) {
  write(TOKEN_KEY, token);
}

export function getStoredDisplayName() {
  return read(NAME_KEY) ?? DEFAULT_DISPLAY_NAME;
}

export function storeDisplayName(name: string) {
  write(NAME_KEY, name.trim() || DEFAULT_DISPLAY_NAME);
}

export function getDeviceId() {
  const existing = read(DEVICE_KEY);
  if (existing) return existing;

  const created = createId("dev");
  write(DEVICE_KEY, created);
  return created;
}
