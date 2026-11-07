import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for the lifecycle manager (phase 2A).

   The behaviour worth protecting:
     * ordered, all-or-nothing startup (no component starts on a half-built world),
     * rollback on failure — including shutting down the component that failed,
     * duplicate initialization is refused,
     * shutdown is reverse-ordered, idempotent, and does not stop at the first
       failure. */

import { Container } from "../src/bootstrap/Container.js";
import type { InitContext } from "../src/bootstrap/InitContext.js";
import {
  InitializationError,
  LifecycleError,
  LifecycleManager,
  type ManagedComponent,
} from "../src/bootstrap/lifecycle.js";
import { systemClock } from "../src/infrastructure/clock/Clock.js";
import { loadConfig } from "../src/infrastructure/config/ConfigManager.js";
import { createLogger, silentSink } from "../src/infrastructure/logging/Logger.js";
import { validEnv } from "./helpers/config-fixture.js";

function context(): InitContext {
  return {
    config: loadConfig(validEnv()),
    logger: createLogger({ sink: silentSink }),
    clock: systemClock,
    container: new Container(),
  };
}

function recordingComponent(name: string, calls: string[]): ManagedComponent {
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

describe("LifecycleManager — happy path", () => {
  it("initializes in order, then starts in order", async () => {
    const calls: string[] = [];
    const lifecycle = new LifecycleManager();
    lifecycle.register(recordingComponent("a", calls));
    lifecycle.register(recordingComponent("b", calls));

    await lifecycle.initAll(context());
    await lifecycle.startAll();

    assert.deepEqual(calls, ["init:a", "init:b", "start:a", "start:b"]);
    assert.equal(lifecycle.stateOf("a"), "started");
    assert.equal(lifecycle.stateOf("b"), "started");
  });

  it("accepts a component that only implements shutdown", async () => {
    const lifecycle = new LifecycleManager();
    lifecycle.register({ name: "bare", shutdown: () => undefined });

    await lifecycle.initAll(context());
    await lifecycle.startAll();

    assert.equal(lifecycle.stateOf("bare"), "started");
  });

  it("exposes component names in registration order", () => {
    const lifecycle = new LifecycleManager();
    lifecycle.register({ name: "first" });
    lifecycle.register({ name: "second" });

    assert.deepEqual(lifecycle.names, ["first", "second"]);
  });
});

describe("LifecycleManager — duplicate initialization is refused", () => {
  it("rejects two components with the same name", () => {
    const lifecycle = new LifecycleManager();
    lifecycle.register({ name: "dup" });

    assert.throws(() => lifecycle.register({ name: "dup" }), LifecycleError);
  });

  it("rejects an unnamed component", () => {
    const lifecycle = new LifecycleManager();

    assert.throws(() => lifecycle.register({ name: "   " }), LifecycleError);
  });

  it("rejects registration after initialization began", async () => {
    const lifecycle = new LifecycleManager();
    lifecycle.register({ name: "a" });
    await lifecycle.initAll(context());

    assert.throws(() => lifecycle.register({ name: "late" }), LifecycleError);
  });

  it("rejects a second initAll and a second startAll", async () => {
    const lifecycle = new LifecycleManager();
    lifecycle.register(recordingComponent("a", []));

    await lifecycle.initAll(context());
    assert.throws(() => lifecycle.initAll(context()), LifecycleError);

    await lifecycle.startAll();
    assert.throws(() => lifecycle.startAll(), LifecycleError);
  });

  it("requires initAll before startAll", () => {
    const lifecycle = new LifecycleManager();
    lifecycle.register({ name: "a" });

    assert.throws(() => lifecycle.startAll(), LifecycleError);
  });
});

describe("LifecycleManager — failure handling", () => {
  it("unwinds a failed init: the failing component and earlier ones are shut down", async () => {
    const calls: string[] = [];
    const lifecycle = new LifecycleManager();

    lifecycle.register(recordingComponent("a", calls));
    lifecycle.register({
      name: "b",
      init: () => {
        calls.push("init:b");
        throw new Error("cannot reach database");
      },
      shutdown: () => {
        calls.push("shutdown:b");
      },
    });
    lifecycle.register(recordingComponent("c", calls));

    await assert.rejects(
      () => lifecycle.initAll(context()),
      (err: unknown) => {
        assert.ok(err instanceof InitializationError);
        assert.equal(err.componentName, "b");
        assert.equal(err.phase, "init");
        assert.match(err.message, /cannot reach database/);
        return true;
      },
    );

    // b cleaned up, a unwound, c never touched.
    assert.deepEqual(calls, ["init:a", "init:b", "shutdown:b", "shutdown:a"]);
    assert.equal(lifecycle.stateOf("c"), "created");
    assert.equal(lifecycle.stateOf("b"), "failed");
  });

  it("rolls back started components when a later start fails", async () => {
    const calls: string[] = [];
    const lifecycle = new LifecycleManager();

    lifecycle.register(recordingComponent("a", calls));
    lifecycle.register({
      name: "b",
      start: () => {
        calls.push("start:b");
        throw new Error("port in use");
      },
      shutdown: () => {
        calls.push("shutdown:b");
      },
    });
    lifecycle.register(recordingComponent("c", calls));

    await lifecycle.initAll(context());
    await assert.rejects(
      () => lifecycle.startAll(),
      (err: unknown) => {
        assert.ok(err instanceof InitializationError);
        assert.equal(err.componentName, "b");
        assert.equal(err.phase, "start");
        return true;
      },
    );

    assert.equal(calls.includes("start:c"), false);
    assert.equal(calls.includes("shutdown:a"), true);
    assert.equal(calls.includes("shutdown:b"), true);
  });
});

describe("LifecycleManager — shutdown", () => {
  it("shuts down in reverse registration order", async () => {
    const calls: string[] = [];
    const lifecycle = new LifecycleManager();
    lifecycle.register(recordingComponent("a", calls));
    lifecycle.register(recordingComponent("b", calls));

    await lifecycle.initAll(context());
    await lifecycle.startAll();
    calls.length = 0;

    const report = await lifecycle.shutdownAll("test");

    assert.deepEqual(calls, ["shutdown:b", "shutdown:a"]);
    assert.deepEqual(report.failed, []);
    assert.equal(report.reason, "test");
  });

  it("is idempotent (no component is shut down twice)", async () => {
    const calls: string[] = [];
    const lifecycle = new LifecycleManager();
    lifecycle.register(recordingComponent("a", calls));

    await lifecycle.initAll(context());
    await lifecycle.startAll();
    calls.length = 0;

    const first = lifecycle.shutdownAll();
    const second = lifecycle.shutdownAll();

    assert.equal(first, second);
    await first;

    assert.deepEqual(calls, ["shutdown:a"]);
  });

  it("continues past a failing component and reports it", async () => {
    const calls: string[] = [];
    const lifecycle = new LifecycleManager();

    lifecycle.register(recordingComponent("a", calls));
    lifecycle.register({
      name: "b",
      shutdown: () => {
        throw new Error("cleanup exploded");
      },
    });

    await lifecycle.initAll(context());
    await lifecycle.startAll();

    const report = await lifecycle.shutdownAll();

    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.name, "b");
    assert.equal(calls.includes("shutdown:a"), true);
  });

  it("shuts nothing down when initialization never ran", async () => {
    const calls: string[] = [];
    const lifecycle = new LifecycleManager();
    lifecycle.register(recordingComponent("a", calls));

    const report = await lifecycle.shutdownAll();

    assert.deepEqual(calls, []);
    assert.deepEqual(report.failed, []);
  });
});
