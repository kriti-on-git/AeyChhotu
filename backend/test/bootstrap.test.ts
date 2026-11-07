import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for AppBootstrap (phase 2A).

   These boot the real composition root with a fixture environment and fake
   components — proving the same sequence production uses, without opening a
   port, reading the developer's .env, or installing signal handlers. */

import { AppBootstrap, BootstrapError } from "../src/bootstrap/AppBootstrap.js";
import { TOKENS } from "../src/bootstrap/tokens.js";
import type { ManagedComponent } from "../src/bootstrap/lifecycle.js";
import { ConfigError } from "../src/infrastructure/config/ConfigManager.js";
import { createLogger, silentSink } from "../src/infrastructure/logging/Logger.js";
import { validEnv } from "./helpers/config-fixture.js";

const silentLogger = () => createLogger({ sink: silentSink, level: "error" });

function recorder(name: string, calls: string[]): ManagedComponent {
  return {
    name,
    init: () => {
      calls.push(`init:${name}`);
    },
    start: () => {
      calls.push(`start:${name}`);
    },
    shutdown: () => {
      calls.push(`shutdown:${name}`);
    },
  };
}

describe("AppBootstrap — successful boot", () => {
  it("validates config, initializes and starts the components in order", async () => {
    const calls: string[] = [];
    const bootstrap = new AppBootstrap({
      configSource: validEnv({ NODE_ENV: "test" }),
      logger: silentLogger(),
      componentFactory: () => [recorder("a", calls), recorder("b", calls)],
    });

    const ctx = await bootstrap.run();

    assert.deepEqual(calls, ["init:a", "init:b", "start:a", "start:b"]);
    assert.equal(ctx.config.nodeEnv, "test");
    assert.deepEqual(ctx.lifecycle.names, ["a", "b"]);
    assert.equal(bootstrap.getState(), "running");
  });

  it("exposes infrastructure through the context and DI container", async () => {
    const logger = silentLogger();
    const bootstrap = new AppBootstrap({
      configSource: validEnv(),
      logger,
      componentFactory: () => [],
    });

    const ctx = await bootstrap.run();

    assert.equal(ctx.logger, logger);
    assert.equal(ctx.container.resolve(TOKENS.logger), logger);
    assert.equal(ctx.container.resolve(TOKENS.config), ctx.config);
    assert.equal(ctx.container.resolve(TOKENS.clock), ctx.clock);
    assert.ok(Object.isFrozen(ctx.config));
  });

  it("does not install signal handlers unless asked", async () => {
    const before = process.listenerCount("SIGTERM");
    const bootstrap = new AppBootstrap({
      configSource: validEnv(),
      logger: silentLogger(),
      componentFactory: () => [],
    });

    await bootstrap.run();

    assert.equal(process.listenerCount("SIGTERM"), before);
  });
});

describe("AppBootstrap — failure handling", () => {
  it("refuses a second run", async () => {
    const bootstrap = new AppBootstrap({
      configSource: validEnv(),
      logger: silentLogger(),
      componentFactory: () => [],
    });

    await bootstrap.run();

    await assert.rejects(() => bootstrap.run(), BootstrapError);
  });

  it("propagates a configuration error before any component is built", async () => {
    let factoryCalls = 0;
    const bootstrap = new AppBootstrap({
      configSource: validEnv({ DATABASE_URL: undefined }),
      logger: silentLogger(),
      componentFactory: () => {
        factoryCalls += 1;
        return [];
      },
    });

    await assert.rejects(() => bootstrap.run(), ConfigError);
    assert.equal(factoryCalls, 0);
    assert.equal(bootstrap.getState(), "failed");
  });

  it("aborts startup and unwinds when a component fails to initialize", async () => {
    const calls: string[] = [];
    const bootstrap = new AppBootstrap({
      configSource: validEnv(),
      logger: silentLogger(),
      componentFactory: () => [
        recorder("a", calls),
        {
          name: "b",
          init: () => {
            throw new Error("dependency missing");
          },
          shutdown: () => {
            calls.push("shutdown:b");
          },
        },
        recorder("c", calls),
      ],
    });

    await assert.rejects(() => bootstrap.run());
    assert.equal(calls.includes("shutdown:a"), true);
    assert.equal(calls.includes("start:c"), false);
    assert.equal(bootstrap.getState(), "failed");
  });
});

describe("AppBootstrap — shutdown", () => {
  it("shuts components down in reverse order and is idempotent", async () => {
    const calls: string[] = [];
    const bootstrap = new AppBootstrap({
      configSource: validEnv(),
      logger: silentLogger(),
      componentFactory: () => [recorder("a", calls), recorder("b", calls), recorder("c", calls)],
    });

    const ctx = await bootstrap.run();
    calls.length = 0;

    const first = await ctx.shutdown("test-drain");
    const second = await ctx.shutdown("test-drain");

    assert.deepEqual(calls, ["shutdown:c", "shutdown:b", "shutdown:a"]);
    assert.equal(first.reason, "test-drain");
    assert.equal(second, first);
    assert.equal(bootstrap.getState(), "stopped");
  });

  it("rejects shutdown before run", async () => {
    const bootstrap = new AppBootstrap({ logger: silentLogger() });

    await assert.rejects(() => bootstrap.shutdown(), BootstrapError);
  });

  it("reports a component that fails during shutdown", async () => {
    const bootstrap = new AppBootstrap({
      configSource: validEnv(),
      logger: silentLogger(),
      componentFactory: () => [
        { name: "stubborn", shutdown: () => Promise.reject(new Error("still connected")) },
      ],
    });

    const ctx = await bootstrap.run();
    const report = await ctx.shutdown();

    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.name, "stubborn");
  });
});
