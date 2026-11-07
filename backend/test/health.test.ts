import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for HealthManager (phase 3).

   Behaviour protected here:
     * explicit component states and transitions;
     * dependency-aware system checks (ordering, missing dependencies, cycles);
     * timeouts, crash containment and repeated checks;
     * self-tests: isolation, timeouts, concurrent-run protection, recording;
     * liveness / readiness / health / deep diagnostics being different things;
     * initialization failure, recovery and shutdown.

   No database or socket is involved: every component is a fake whose hooks
   count their calls, which is also how the "the manager observes, it does not
   own business logic" rule is asserted. */

import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../src/bootstrap/lifecycle.js";
import {
  HealthError,
  HealthManager,
  type HealthTransition,
} from "../src/infrastructure/health/HealthManager.js";
import { initContext } from "./helpers/init-context.js";

interface FakeCalls {
  health: number;
  selfTest: number;
}

interface FakeOptions {
  dependencies?: readonly string[];
  required?: boolean;
  health?: () => ComponentHealth | Promise<ComponentHealth>;
  selfTest?: () => SelfTestResult | Promise<SelfTestResult>;
  diagnostics?: () => unknown;
}

type FakeComponent = ManagedComponent & { readonly calls: FakeCalls };

function fake(name: string, options: FakeOptions = {}): FakeComponent {
  const calls: FakeCalls = { health: 0, selfTest: 0 };

  return {
    name,
    dependencies: options.dependencies,
    required: options.required,
    calls,
    health: async () => {
      calls.health += 1;
      return options.health === undefined
        ? { state: "HEALTHY" as const }
        : await options.health();
    },
    selfTest: async () => {
      calls.selfTest += 1;
      return options.selfTest === undefined ? { ok: true } : await options.selfTest();
    },
    diagnostics: options.diagnostics ?? (() => ({ name })),
  };
}

async function running(
  components: readonly ManagedComponent[],
  options: {
    checkTimeoutMs?: number;
    selfTestTimeoutMs?: number;
    historyLimit?: number;
  } = {},
): Promise<HealthManager> {
  const manager = new HealthManager({
    checkTimeoutMs: 200,
    selfTestTimeoutMs: 200,
    historyLimit: 20,
    ...options,
  });
  manager.registerAll(components);
  await manager.init(initContext());
  return manager;
}

describe("HealthManager — registration and states", () => {
  it("registers components and holds them INITIALIZING until checked", async () => {
    const manager = await running([fake("db"), fake("api", { dependencies: ["db"] })]);

    assert.deepEqual(manager.names(), ["db", "api"]);
    assert.equal(manager.stateOf("db"), "INITIALIZING");

    const readiness = manager.readiness();
    assert.equal(readiness.ready, false);
    assert.match(readiness.reasons.join(" "), /db is INITIALIZING/);
  });

  it("refuses duplicate names, empty names, self-dependencies and late registration", async () => {
    const manager = new HealthManager();
    manager.register(fake("db"));

    assert.throws(
      () => manager.register(fake("db")),
      (err: unknown) =>
        err instanceof HealthError && err.code === "HEALTH_DUPLICATE_COMPONENT",
    );
    assert.throws(
      () => manager.register({ name: "   " }),
      (err: unknown) => err instanceof HealthError && err.code === "HEALTH_INVALID_COMPONENT",
    );
    assert.throws(
      () => manager.register(fake("loop", { dependencies: ["loop"] })),
      (err: unknown) => err instanceof HealthError && err.code === "HEALTH_SELF_DEPENDENCY",
    );

    await manager.init(initContext());
    await manager.shutdown();

    assert.throws(
      () => manager.register(fake("late")),
      (err: unknown) => err instanceof HealthError && err.code === "HEALTH_MANAGER_CLOSED",
    );
  });

  it("rejects checking an unknown component", async () => {
    const manager = await running([]);

    await assert.rejects(
      () => manager.checkComponent("ghost"),
      (err: unknown) => err instanceof HealthError && err.code === "HEALTH_UNKNOWN_COMPONENT",
    );
  });
});

describe("HealthManager — component checks", () => {
  it("records a check and emits one transition", async () => {
    const manager = await running([fake("db")]);
    const events: HealthTransition[] = [];
    manager.subscribe((event) => events.push(event));

    const record = await manager.checkComponent("db");

    assert.equal(record.state, "HEALTHY");
    assert.equal(record.previous, "INITIALIZING");
    assert.equal(manager.stateOf("db"), "HEALTHY");
    assert.deepEqual(
      events.map((event) => `${event.from}->${event.to}`),
      ["INITIALIZING->HEALTHY"],
    );
  });

  it("keeps a stable state on repeated checks (no duplicate transitions)", async () => {
    const manager = await running([fake("db")]);
    const events: HealthTransition[] = [];
    manager.subscribe((event) => events.push(event));

    await manager.checkComponent("db");
    await manager.checkComponent("db");

    assert.equal(events.length, 1);
    assert.equal(manager.diagnostics().history.length, 2);
  });

  it("carries DEGRADED and UNHEALTHY reports from the component", async () => {
    const manager = await running([
      fake("warm", { health: () => ({ state: "DEGRADED", message: "cache cold" }) }),
      fake("down", { health: () => ({ state: "UNHEALTHY", message: "refused" }) }),
    ]);

    assert.equal((await manager.checkComponent("warm")).state, "DEGRADED");
    const down = await manager.checkComponent("down");
    assert.equal(down.state, "UNHEALTHY");
    assert.equal(down.message, "refused");
  });

  it("contains a throwing hook as UNHEALTHY", async () => {
    const manager = await running([
      fake("db", {
        health: () => {
          throw new Error("connection refused");
        },
      }),
    ]);

    const record = await manager.checkComponent("db");

    assert.equal(record.state, "UNHEALTHY");
    assert.equal(record.reason, "error");
    assert.match(record.message ?? "", /connection refused/);
    assert.equal(manager.diagnostics().counters.failures, 1);
    assert.match(manager.diagnostics().lastError ?? "", /db: connection refused/);
  });

  it("times out a hanging hook instead of hanging the caller", async () => {
    const manager = await running([
      fake("slow", { health: () => new Promise<ComponentHealth>(() => undefined) }),
    ]);

    const record = await manager.checkComponent("slow", { timeoutMs: 10 });

    assert.equal(record.state, "UNHEALTHY");
    assert.equal(record.reason, "timeout");
    assert.equal(manager.diagnostics().counters.timeouts, 1);
  });

  it("assumes a component without a health hook is healthy", async () => {
    const manager = await running([{ name: "bare" }]);

    const record = await manager.checkComponent("bare");

    assert.equal(record.state, "HEALTHY");
    assert.equal(record.reason, "no_health_hook");
  });
});

describe("HealthManager — system checks", () => {
  it("checks dependencies before dependents", async () => {
    const order: string[] = [];
    const manager = await running([
      fake("api", {
        dependencies: ["db"],
        health: () => {
          order.push("api");
          return { state: "HEALTHY" };
        },
      }),
      fake("db", {
        health: () => {
          order.push("db");
          return { state: "HEALTHY" };
        },
      }),
    ]);

    const report = await manager.checkAll();

    assert.deepEqual(order, ["db", "api"]);
    assert.equal(report.state, "HEALTHY");
    assert.deepEqual(report.dependencyFailures, []);
  });

  it("reports a dependency failure without calling the dependent's hook", async () => {
    const api = fake("api", { dependencies: ["db"] });
    const manager = await running([
      fake("db", { health: () => ({ state: "UNHEALTHY", message: "down" }) }),
      api,
    ]);

    const report = await manager.checkAll();
    const apiRecord = report.components.find((record) => record.component === "api");

    assert.equal(report.state, "UNHEALTHY");
    assert.deepEqual(report.dependencyFailures, [{ component: "api", dependency: "db" }]);
    assert.equal(api.calls.health, 0);
    assert.equal(apiRecord?.state, "UNHEALTHY");
    assert.equal(apiRecord?.reason, "dependency_failed");
  });

  it("reports missing dependencies and keeps readiness false", async () => {
    const manager = await running([fake("api", { dependencies: ["ghost"] })]);

    const report = await manager.checkAll();

    assert.deepEqual(report.missingDependencies, [{ component: "api", missing: ["ghost"] }]);
    assert.equal(report.state, "UNHEALTHY");
    assert.equal(manager.readiness().ready, false);
  });

  it("reports dependency cycles instead of looping", async () => {
    const manager = await running([
      fake("a", { dependencies: ["b"] }),
      fake("b", { dependencies: ["a"] }),
    ]);

    const report = await manager.checkAll();

    assert.equal(report.cycles.length, 1);
    assert.equal(
      report.components.every((record) => record.state === "UNHEALTHY"),
      true,
    );
    assert.equal(
      report.components.every((record) => record.reason === "cycle"),
      true,
    );
  });

  it("degrades the system for an optional component failure but stays ready", async () => {
    const manager = await running([
      fake("core"),
      fake("metrics", {
        required: false,
        health: () => ({ state: "UNHEALTHY", message: "scrape failed" }),
      }),
    ]);

    const report = await manager.checkAll();

    assert.equal(report.state, "DEGRADED");
    assert.equal(manager.readiness().ready, true);
  });
});

describe("HealthManager — diagnostic history", () => {
  it("keeps only the most recent records", async () => {
    const manager = await running([fake("db")], { historyLimit: 3 });

    for (let index = 0; index < 5; index += 1) {
      await manager.checkComponent("db");
    }

    assert.equal(manager.diagnostics().history.length, 3);
  });
});

describe("HealthManager — initialization failure and recovery", () => {
  it("reports an initialization failure, then recovers", async () => {
    let failing = true;
    const manager = await running([
      fake("db", {
        health: () => {
          if (failing) throw new Error("not initialized");
          return { state: "HEALTHY" };
        },
      }),
    ]);
    const events: HealthTransition[] = [];
    manager.subscribe((event) => events.push(event));

    const failed = await manager.checkComponent("db");
    assert.equal(failed.state, "UNHEALTHY");
    assert.equal(manager.readiness().ready, false);

    failing = false;
    const recovered = await manager.checkComponent("db");
    assert.equal(recovered.state, "HEALTHY");
    assert.equal(manager.readiness().ready, true);
    assert.deepEqual(
      events.map((event) => `${event.from}->${event.to}`),
      ["INITIALIZING->UNHEALTHY", "UNHEALTHY->HEALTHY"],
    );
  });
});

describe("HealthManager — self-tests", () => {
  it("runs functional self-tests, records the run and skips components without a hook", async () => {
    const manager = await running([
      fake("db", { selfTest: () => ({ ok: true, message: "schema intact" }) }),
      fake("cache", { selfTest: () => ({ ok: false, message: "cache unreachable" }) }),
      // Plain object: no health hook, no self-test hook.
      { name: "bare" },
    ]);

    const result = await manager.runSelfTests();
    const run = result.run;

    assert.equal(result.ran, true);
    assert.ok(run !== undefined);
    assert.equal(run.entries.length, 2);
    assert.deepEqual(run.skippedComponents, ["bare"]);
    assert.equal(run.entries.find((entry) => entry.component === "cache")?.ok, false);
    assert.equal(manager.stateOf("cache"), "UNHEALTHY");
    assert.equal(manager.diagnostics().selfTests.length, 1);
  });

  it("contains a throwing self-test", async () => {
    const manager = await running([
      fake("db", {
        selfTest: () => {
          throw new Error("probe exploded");
        },
      }),
    ]);

    const result = await manager.runSelfTests();

    assert.equal(result.run?.entries[0]?.ok, false);
    assert.match(result.run?.entries[0]?.message ?? "", /probe exploded/);
    assert.equal(manager.stateOf("db"), "UNHEALTHY");
  });

  it("times out a hanging self-test", async () => {
    const manager = await running(
      [fake("slow", { selfTest: () => new Promise<SelfTestResult>(() => undefined) })],
      { selfTestTimeoutMs: 10 },
    );

    const result = await manager.runSelfTests();

    assert.equal(result.ran, true);
    assert.equal(result.run?.entries[0]?.timedOut, true);
    assert.equal(manager.stateOf("slow"), "UNHEALTHY");
  });

  it("refuses a concurrent run and allows the next one", async () => {
    // A deferred gate: the manager must see the first run in flight.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const manager = await running([
      fake("db", {
        selfTest: async () => {
          await gate;
          return { ok: true };
        },
      }),
    ]);

    const first = manager.runSelfTests();
    const second = await manager.runSelfTests();
    assert.equal(second.ran, false);
    assert.equal(second.reason, "already_running");
    assert.ok(second.activeRunId !== undefined);

    openGate();
    assert.equal((await first).ran, true);

    const third = await manager.runSelfTests();
    assert.equal(third.ran, true);
  });

  it("uses a passing self-test to recover an unhealthy component", async () => {
    let healthy = false;
    const manager = await running([
      fake("db", {
        health: () => ({ state: healthy ? "HEALTHY" : "UNHEALTHY" }),
        selfTest: () => ({ ok: true }),
      }),
    ]);

    await manager.checkComponent("db");
    assert.equal(manager.stateOf("db"), "UNHEALTHY");

    healthy = true;
    await manager.runSelfTests();
    assert.equal(manager.stateOf("db"), "HEALTHY");
  });
});

describe("HealthManager — liveness, readiness and health are distinct", () => {
  it("stays live while a required component is unhealthy", async () => {
    const manager = await running([
      fake("db", { health: () => ({ state: "UNHEALTHY", message: "down" }) }),
    ]);

    await manager.checkAll();

    assert.equal(manager.liveness().alive, true);
    assert.equal(manager.readiness().ready, false);
    assert.match(manager.readiness().reasons.join(" "), /db is UNHEALTHY/);
    // The observer itself is fine: its registry is complete.
    assert.equal(manager.health().state, "HEALTHY");
  });

  it("is ready when required components are only DEGRADED", async () => {
    const manager = await running([fake("db", { health: () => ({ state: "DEGRADED" }) })]);

    await manager.checkAll();

    assert.equal(manager.readiness().ready, true);
    assert.equal(manager.liveness().alive, true);
  });
});

describe("HealthManager — diagnostics and events", () => {
  it("returns structured per-component diagnostics without a restart", async () => {
    const manager = await running([
      fake("db", { diagnostics: () => ({ pool: { total: 2 } }) }),
      fake("broken", {
        diagnostics: () => {
          throw new Error("diagnostics exploded");
        },
      }),
    ]);

    await manager.checkAll();
    const diagnostics = manager.diagnostics();

    assert.deepEqual(
      diagnostics.components.find((component) => component.name === "db")?.diagnostics,
      { pool: { total: 2 } },
    );
    assert.deepEqual(
      diagnostics.components.find((component) => component.name === "broken")?.diagnostics,
      { error: "diagnostics exploded" },
    );
    assert.equal(diagnostics.counters.checks, 2);
    assert.ok(diagnostics.transitions.length >= 2);
  });

  it("isolates a throwing listener from a health verdict", async () => {
    const manager = await running([fake("db")]);
    manager.subscribe(() => {
      throw new Error("subscriber bug");
    });

    const record = await manager.checkComponent("db");

    assert.equal(record.state, "HEALTHY");
  });

  it("emits a system transition when the overall state changes", async () => {
    const manager = await running([fake("db")]);
    const seen: string[] = [];
    manager.subscribe((event) => {
      if (event.component === "system") seen.push(`${event.from}->${event.to}`);
    });

    await manager.checkAll();

    assert.deepEqual(seen, ["INITIALIZING->HEALTHY"]);
  });
});

describe("HealthManager — shutdown", () => {
  it("marks every component STOPPING then STOPPED, and is idempotent", async () => {
    const manager = await running([fake("db"), fake("api", { dependencies: ["db"] })]);
    await manager.checkAll();

    const events: HealthTransition[] = [];
    manager.subscribe((event) => events.push(event));

    await manager.shutdown();

    assert.equal(manager.stateOf("db"), "STOPPED");
    assert.equal(manager.stateOf("api"), "STOPPED");
    assert.equal(manager.getState(), "closed");
    assert.deepEqual(
      events.map((event) => `${event.component}:${event.to}`),
      ["db:STOPPING", "api:STOPPING", "db:STOPPED", "api:STOPPED"],
    );

    const recorded = events.length;
    await manager.shutdown();
    assert.equal(events.length, recorded);
  });

  it("refuses checks and self-tests after shutdown without calling hooks", async () => {
    const db = fake("db");
    const manager = await running([db]);
    await manager.shutdown();

    const record = await manager.checkComponent("db");
    assert.equal(record.state, "STOPPED");
    assert.equal(db.calls.health, 0);

    const selfTests = await manager.runSelfTests();
    assert.equal(selfTests.ran, false);
    assert.equal(selfTests.reason, "manager_stopped");
    assert.equal(manager.liveness().alive, false);
  });
});
