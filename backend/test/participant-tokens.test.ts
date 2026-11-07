import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Credential primitives. The database lifecycle (cap, expiry, revocation,
   seating binding) is covered by participant-tokens.integration.test.ts. */

import {
  MAX_ACTIVE_PARTICIPANT_TOKENS,
  PARTICIPANT_TOKEN_RE,
  PARTICIPANT_TOKEN_TTL_HOURS,
  generateParticipantToken,
  hashParticipantToken,
} from "../src/modules/table/table.participant-tokens.js";

describe("participant credential format", () => {
  it("is 32 random bytes encoded as base64url behind the pc_ prefix", () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const token = generateParticipantToken();
      assert.match(token, PARTICIPANT_TOKEN_RE);
      assert.equal(token.length, 46);
      tokens.add(token);
    }
    assert.equal(tokens.size, 200, "tokens must not repeat");
  });

  it("uses the documented 12-hour non-sliding lifetime and cap of five", () => {
    assert.equal(PARTICIPANT_TOKEN_TTL_HOURS, 12);
    assert.equal(MAX_ACTIVE_PARTICIPANT_TOKENS, 5);
  });
});

describe("participant credential hashing", () => {
  it("stores only a deterministic SHA-256 digest", () => {
    const token = generateParticipantToken();
    const hash = hashParticipantToken(token);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, hashParticipantToken(token));
    assert.equal(hash.includes(token.slice(3)), false);
    assert.notEqual(hash, hashParticipantToken(generateParticipantToken()));
  });
});
