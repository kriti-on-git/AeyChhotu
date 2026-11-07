import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for the configuration manager (phase 2A).

   What is pinned here is the contract other components will rely on:
     * every validation rule that used to live inline in config/env.ts,
     * all problems reported at once (one restart, not several),
     * secrets never echoed into an error message,
     * the derived `cookieSecure` rule (production OR SameSite=None),
     * the returned configuration is immutable. */

import { ConfigError, loadConfig } from "../src/infrastructure/config/ConfigManager.js";
import { validEnv } from "./helpers/config-fixture.js";

describe("loadConfig — valid configuration", () => {
  it("parses required values and applies the documented defaults", () => {
    const config = loadConfig(validEnv({ PORT: undefined, NODE_ENV: undefined }));

    assert.equal(config.port, 4000);
    assert.equal(config.nodeEnv, "development");
    assert.equal(config.isProduction, false);
    assert.equal(config.cookieSameSite, "Strict");
    assert.equal(config.cookieSecure, false);
    assert.deepEqual(config.clientUrls, ["http://localhost:3000"]);
    assert.equal(config.supabaseJwtSecret, null);
    assert.equal(config.geminiApiKey, null);
  });

  it("keeps an explicit PORT and NODE_ENV", () => {
    const config = loadConfig(validEnv({ PORT: "8080", NODE_ENV: "production" }));

    assert.equal(config.port, 8080);
    assert.equal(config.nodeEnv, "production");
    assert.equal(config.isProduction, true);
    assert.equal(config.cookieSecure, true);
  });

  it("splits CLIENT_URL on commas and strips trailing slashes", () => {
    const config = loadConfig(
      validEnv({ CLIENT_URL: "https://app.example.com/, http://localhost:3000/" }),
    );

    assert.deepEqual(config.clientUrls, [
      "https://app.example.com",
      "http://localhost:3000",
    ]);
  });

  it("returns a deeply frozen configuration", () => {
    const config = loadConfig(validEnv());

    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.clientUrls), true);
    assert.equal(Object.isFrozen(config.imageStorage), true);
  });
});

describe("loadConfig — validation failures", () => {
  it("reports every missing required variable in a single error", () => {
    const env = validEnv({
      DATABASE_URL: undefined,
      STAFF_PIN: undefined,
      ADMIN_PIN: undefined,
      KDS_TOKEN_SECRET: undefined,
    });

    assert.throws(
      () => loadConfig(env),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.issues.length, 4);
        for (const name of ["DATABASE_URL", "STAFF_PIN", "ADMIN_PIN", "KDS_TOKEN_SECRET"]) {
          assert.ok(
            err.issues.some((issue) => issue.includes(name)),
            `expected an issue naming ${name}, got: ${err.issues.join(" | ")}`,
          );
        }
        return true;
      },
    );
  });

  it("rejects an out-of-range PORT", () => {
    assert.throws(() => loadConfig(validEnv({ PORT: "99999" })), ConfigError);
  });

  it("rejects a non-numeric PORT", () => {
    assert.throws(() => loadConfig(validEnv({ PORT: "not-a-port" })), ConfigError);
  });

  it("rejects PINs that are not 4-6 digits", () => {
    for (const pin of ["12", "1234567", "abcd", "12 34"]) {
      assert.throws(() => loadConfig(validEnv({ STAFF_PIN: pin })), ConfigError);
      assert.throws(() => loadConfig(validEnv({ ADMIN_PIN: pin })), ConfigError);
    }
  });

  it("rejects an empty or origin-less CLIENT_URL", () => {
    assert.throws(() => loadConfig(validEnv({ CLIENT_URL: "" })), ConfigError);
    assert.throws(() => loadConfig(validEnv({ CLIENT_URL: " , " })), ConfigError);
  });

  it("rejects an unknown COOKIE_SAME_SITE", () => {
    assert.throws(() => loadConfig(validEnv({ COOKIE_SAME_SITE: "sometimes" })), ConfigError);
  });

  it("never echoes a secret value in the error message", () => {
    const secret = "super-secret-token-value";
    try {
      loadConfig(validEnv({ PORT: "not-a-port", KDS_TOKEN_SECRET: secret }));
      assert.fail("expected loadConfig to throw");
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.equal(
        err.message.includes(secret),
        false,
        "the KDS_TOKEN_SECRET value must not appear in a configuration error",
      );
    }
  });
});

describe("loadConfig — derived security flags", () => {
  it("forces Secure cookies for SameSite=None even in development", () => {
    const config = loadConfig(
      validEnv({ NODE_ENV: "development", COOKIE_SAME_SITE: "none" }),
    );

    assert.equal(config.cookieSameSite, "None");
    assert.equal(config.cookieSecure, true);
  });

  it("accepts lax without forcing Secure outside production", () => {
    const config = loadConfig(validEnv({ NODE_ENV: "development", COOKIE_SAME_SITE: "lax" }));

    assert.equal(config.cookieSameSite, "Lax");
    assert.equal(config.cookieSecure, false);
  });
});

describe("loadConfig — optional integrations", () => {
  it("treats absent or blank optional values as null", () => {
    const config = loadConfig(
      validEnv({ SUPABASE_JWT_SECRET: "  ", GEMINI_API_KEY: undefined }),
    );

    assert.equal(config.supabaseJwtSecret, null);
    assert.equal(config.geminiApiKey, null);
  });

  it("keeps supplied optional values", () => {
    const config = loadConfig(
      validEnv({ SUPABASE_JWT_SECRET: "jwt-secret", GEMINI_API_KEY: "gemini-key" }),
    );

    assert.equal(config.supabaseJwtSecret, "jwt-secret");
    assert.equal(config.geminiApiKey, "gemini-key");
  });

  it("defaults dish-photo storage to Postgres", () => {
    const config = loadConfig(validEnv());

    assert.equal(config.imageStorage.driver, "postgres");
    assert.equal(config.imageStorage.bucket, "menu-images");
  });

  it("selects Supabase storage only when requested AND configured", () => {
    const requestedOnly = loadConfig(validEnv({ IMAGE_STORAGE: "supabase" }));
    assert.equal(requestedOnly.imageStorage.driver, "postgres");

    const configured = loadConfig(
      validEnv({
        IMAGE_STORAGE: "supabase",
        SUPABASE_URL: "https://example.supabase.co/",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      }),
    );
    assert.equal(configured.imageStorage.driver, "supabase");
    assert.equal(configured.imageStorage.supabaseUrl, "https://example.supabase.co");
  });
});
