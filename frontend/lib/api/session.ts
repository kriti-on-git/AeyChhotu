/* Anonymous diner session. The randomised table token is cached in
   localStorage so a refresh or an accidental tab close restores the live
   cart instead of orphaning the session (docs/ui-ux-blueprint.txt → strategy 3). */

const TOKEN_KEY = "aeychhotu.table_token";
const NAME_KEY = "aeychhotu.diner_name";
const DEVICE_KEY = "aeychhotu.device_id";
/* Phase 5.2 participant credential. Deliberately SESSION-scoped: it dies
   with the tab, is never written to localStorage, never placed in a URL and
   never logged. A refresh inside the same tab keeps it; a new tab obtains a
   fresh one through the existing join/reconnect flow. */
const PARTICIPANT_TOKEN_KEY = "aeychhotu.participant_token";
const PARTICIPANT_ID_KEY = "aeychhotu.participant_id";
const PARTICIPANT_EXPIRY_KEY = "aeychhotu.participant_expires_at";

/* There is deliberately no "Guest" fallback: the session gate asks every
   diner for a name before it calls an endpoint, so a stored name is the only
   valid identity. An empty string means "not confirmed yet" and the gate
   keeps the menu closed until it is. */

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

export function getStoredDisplayName(): string {
  return read(NAME_KEY)?.trim() ?? "";
}

/** Saves the name the gate confirmed. An empty value clears it rather than
    writing a made-up label, so no screen can inherit an anonymous identity. */
export function storeDisplayName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(NAME_KEY);
      } catch {
        /* ignore blocked storage */
      }
    }
    return;
  }
  write(NAME_KEY, trimmed);
}

function readSession(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* Storage blocked: the next request simply asks for a fresh credential. */
  }
}

function clearSessionKeys() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PARTICIPANT_TOKEN_KEY);
    window.sessionStorage.removeItem(PARTICIPANT_ID_KEY);
    window.sessionStorage.removeItem(PARTICIPANT_EXPIRY_KEY);
  } catch {
    /* Nothing else to clear. */
  }
}

export interface StoredParticipantCredential {
  participantId: string;
  participantToken: string;
  expiresAt: string | null;
}

/** The credential the session layer attaches to roster/heartbeat and future
    conversation calls. Never put this value in a query string or a log. */
export function getParticipantToken(): string | null {
  return readSession(PARTICIPANT_TOKEN_KEY);
}

export function getStoredParticipant(): StoredParticipantCredential | null {
  const participantToken = readSession(PARTICIPANT_TOKEN_KEY);
  const participantId = readSession(PARTICIPANT_ID_KEY);
  if (!participantToken || !participantId) return null;
  return {
    participantId,
    participantToken,
    expiresAt: readSession(PARTICIPANT_EXPIRY_KEY),
  };
}

/** Store a granted credential. A locked table never reaches this function:
    its reply carries nulls. */
export function storeParticipantCredential(input: {
  participant_id: string | null;
  participant_token: string | null;
  participant_expires_at: string | null;
}) {
  if (!input.participant_id || !input.participant_token) {
    clearParticipantCredential();
    return;
  }
  writeSession(PARTICIPANT_ID_KEY, input.participant_id);
  writeSession(PARTICIPANT_TOKEN_KEY, input.participant_token);
  if (input.participant_expires_at) {
    writeSession(PARTICIPANT_EXPIRY_KEY, input.participant_expires_at);
  }
}

export function clearParticipantCredential() {
  clearSessionKeys();
}

export function getDeviceId() {
  const existing = read(DEVICE_KEY);
  if (existing) return existing;

  const created = createId("dev");
  write(DEVICE_KEY, created);
  return created;
}
