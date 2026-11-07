import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for the single error→envelope mapping (phase 2A). The contract
   body is what every client parses, so each branch is pinned — including the
   rule that an internal failure leaks nothing. */

import { AppError } from "../src/errors/app-error.js";
import { toHttpErrorResponse } from "../src/errors/http-error-response.js";

describe("toHttpErrorResponse — contract errors", () => {
  it("renders an AppError with its status, code and message", () => {
    const result = toHttpErrorResponse(
      new AppError(409, "DUPLICATE_ORDER", "Order already sent"),
    );

    assert.equal(result.status, 409);
    assert.equal(result.unexpected, false);
    assert.deepEqual(result.body, {
      success: false,
      error: { code: "DUPLICATE_ORDER", message: "Order already sent" },
    });
  });

  it("spreads AppError details into the error object", () => {
    const result = toHttpErrorResponse(
      new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
        fields: { pin: "PIN must be 4 to 6 digits." },
      }),
    );

    assert.deepEqual(result.body.error["fields"], {
      pin: "PIN must be 4 to 6 digits.",
    });
  });
});

describe("toHttpErrorResponse — body-parser failures", () => {
  it("maps malformed JSON to a 400 VALIDATION_ERROR", () => {
    const result = toHttpErrorResponse(new SyntaxError("Unexpected token"));

    assert.equal(result.status, 400);
    assert.equal(result.unexpected, false);
    assert.equal(result.body.error["code"], "VALIDATION_ERROR");
    assert.equal(result.body.error["message"], "Request body is not valid JSON.");
  });

  it("maps an oversized body to 413 PAYLOAD_TOO_LARGE", () => {
    const tooLarge = Object.assign(new Error("too big"), { type: "entity.too.large" });
    const result = toHttpErrorResponse(tooLarge);

    assert.equal(result.status, 413);
    assert.equal(result.unexpected, false);
    assert.equal(result.body.error["code"], "PAYLOAD_TOO_LARGE");
  });
});

describe("toHttpErrorResponse — unexpected failures", () => {
  it("returns a generic 500 and flags it for logging", () => {
    const result = toHttpErrorResponse(new Error("connection string leaked here"));

    assert.equal(result.status, 500);
    assert.equal(result.unexpected, true);
    assert.deepEqual(result.body, {
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error." },
    });
    assert.equal(
      JSON.stringify(result.body).includes("connection string leaked here"),
      false,
    );
  });

  it("handles non-Error throwables", () => {
    const result = toHttpErrorResponse("a thrown string");

    assert.equal(result.status, 500);
    assert.equal(result.unexpected, true);
  });
});
