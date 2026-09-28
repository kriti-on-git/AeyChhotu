import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for the hand-rolled HS256 JWT (src/lib/jwt.ts). This is the
   exact code that guards every staff action, so the tests pin down the
   security-relevant behaviour: signature verification, expiry, tamper
   rejection, and algorithm confusion. */

import { signReadToken, signToken, verifyToken, type ShiftClaims } from "../src/lib/jwt.js";

const SECRET = "unit-test-secret";
const OTHER_SECRET = "a-completely-different-secret";

const claims: ShiftClaims = {
  role: "kitchen",
  terminal_id: "11111111-2222-4333-8444-555555555555",
  iat: Math.floor(Date.now() / 1000) - 10,
  exp: Math.floor(Date.now() / 1000) + 600,
};

describe("signToken / verifyToken round-trip", () => {
  it("returns a three-part token and verifies back to the same claims", () => {
    const token = signToken(claims, SECRET);
    assert.equal(token.split(".").length, 3);

    const verified = verifyToken(token, SECRET);
    assert.ok(verified);
    assert.equal(verified.role, "kitchen");
    assert.equal(verified.terminal_id, claims.terminal_id);
    assert.equal(verified.exp, claims.exp);
  });

  it("produces a deterministic signature for identical input", () => {
    assert.equal(signToken(claims, SECRET), signToken(claims, SECRET));
  });
});

describe("verifyToken rejects", () => {
  it("a token signed with a different secret (wrong-key forgery)", () => {
    const token = signToken(claims, SECRET);
    assert.equal(verifyToken(token, OTHER_SECRET), null);
  });

  it("a tampered payload (signature stays the same)", () => {
    const token = signToken(claims, SECRET);
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...claims, role: "admin" }),
    ).toString("base64url");
    assert.equal(verifyToken(`${header}.${forgedPayload}.${signature}`, SECRET), null);
  });

  it("an expired token", () => {
    const expired: ShiftClaims = { ...claims, exp: Math.floor(Date.now() / 1000) - 1 };
    assert.equal(verifyToken(signToken(expired, SECRET), SECRET), null);
  });

  it("a token with no exp claim", () => {
    const noExp = { role: "kitchen", iat: claims.iat } as unknown as ShiftClaims;
    assert.equal(verifyToken(signToken(noExp, SECRET), SECRET), null);
  });

  it("a token with an empty role claim", () => {
    const noRole = { ...claims, role: "" } as unknown as ShiftClaims;
    assert.equal(verifyToken(signToken(noRole, SECRET), SECRET), null);
  });

  it("structurally broken tokens without throwing", () => {
    assert.equal(verifyToken("", SECRET), null);
    assert.equal(verifyToken("not.a.jwt", SECRET), null);
    assert.equal(verifyToken("only-two-parts", SECRET), null);
    assert.equal(verifyToken("a.b.c.d", SECRET), null);
  });

  it("a token whose payload is not valid JSON", () => {
    const good = signToken(claims, SECRET);
    const [header, , signature] = good.split(".");
    const garbage = Buffer.from("this is not json").toString("base64url");
    assert.equal(verifyToken(`${header}.${garbage}.${signature}`, SECRET), null);
  });
});

describe("algorithm-confusion hardening", () => {
  it("rejects an 'alg: none' token (empty signature) even with valid JSON", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    // An HMAC over this input with ANY secret must not equal the empty
    // signature a `none` token carries — verify it is refused outright.
    assert.equal(verifyToken(`${header}.${payload}.`, SECRET), null);
  });
});

describe("signReadToken (Supabase-scoped RLS tokens)", () => {
  it("embeds the table_token scope a diner RLS policy matches on", () => {
    const token = signReadToken(
      { sub: "device-1", role: "authenticated", table_token: "k7x2p", iat: claims.iat, exp: claims.exp },
      SECRET,
    );
    const verified = verifyToken(token, SECRET);
    assert.ok(verified);
    assert.equal((verified as unknown as { table_token?: string }).table_token, "k7x2p");
    assert.equal(verified.role, "authenticated");
  });
});
