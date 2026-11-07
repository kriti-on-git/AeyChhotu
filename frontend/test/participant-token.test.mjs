import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

/* The browser half of Phase 5.2 credentials:
     - the raw `pc_` value lives in sessionStorage only;
     - clearing seating clears it;
     - apiRequest adds `X-Participant-Token`, never a query parameter.
   `fetch` is stubbed; no server is contacted. */

class MemoryStorage {
  values = new Map();
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}

const localStorage = new MemoryStorage();
const sessionStorage = new MemoryStorage();
globalThis.window = {
  localStorage,
  sessionStorage,
  location: { pathname: "/table/k7x2p", hostname: "localhost" },
};

process.env.NEXT_PUBLIC_API_URL = "https://api.test";

const {
  clearParticipantCredential,
  getParticipantToken,
  getStoredParticipant,
  storeParticipantCredential,
} = await import("../lib/api/session.ts");
const { apiRequest } = await import("../lib/api-client/apiClient.ts");

const TOKEN = "pc_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const ID = "11111111-1111-4111-8111-111111111111";

let calls = [];
const realFetch = globalThis.fetch;

function stubFetch() {
  calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: { ...(init?.headers ?? {}) },
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    };
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearParticipantCredential();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("participant credential storage", () => {
  it("stores the token in sessionStorage and never in localStorage", () => {
    storeParticipantCredential({
      participant_id: ID,
      participant_token: TOKEN,
      participant_expires_at: "2026-11-07T22:00:00.000Z",
    });

    assert.equal(getParticipantToken(), TOKEN);
    assert.deepEqual(getStoredParticipant(), {
      participantId: ID,
      participantToken: TOKEN,
      expiresAt: "2026-11-07T22:00:00.000Z",
    });

    const localDump = [...localStorage.values.entries()].flat().join(" ");
    assert.equal(localDump.includes(TOKEN), false, "token must not survive the tab");
    assert.equal(
      [...sessionStorage.values.values()].some((value) => value === TOKEN),
      true,
    );
  });

  it("clears the credential when a grant has no token (locked table)", () => {
    storeParticipantCredential({
      participant_id: ID,
      participant_token: TOKEN,
      participant_expires_at: null,
    });
    storeParticipantCredential({
      participant_id: null,
      participant_token: null,
      participant_expires_at: null,
    });

    assert.equal(getParticipantToken(), null);
    assert.equal(getStoredParticipant(), null);
    assert.equal(sessionStorage.values.size, 0);
  });
});

describe("apiRequest participant auth", () => {
  it("sends X-Participant-Token and keeps it out of the URL", async () => {
    storeParticipantCredential({
      participant_id: ID,
      participant_token: TOKEN,
      participant_expires_at: null,
    });

    await apiRequest("/api/v1/sessions/k7x2p/members", { participantAuth: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers["X-Participant-Token"], TOKEN);
    assert.equal(calls[0]?.url.includes(TOKEN), false);
    assert.equal(calls[0]?.url.includes("participant"), false);
  });

  it("does not attach the credential to unauthenticated requests", async () => {
    storeParticipantCredential({
      participant_id: ID,
      participant_token: TOKEN,
      participant_expires_at: null,
    });

    await apiRequest("/api/v1/menu");
    assert.equal(calls[0]?.headers["X-Participant-Token"], undefined);
  });

  it("omits the header, without failing, when no credential is stored", async () => {
    await apiRequest("/api/v1/sessions/k7x2p", { participantAuth: true });
    assert.equal(calls[0]?.headers["X-Participant-Token"], undefined);
  });
});
