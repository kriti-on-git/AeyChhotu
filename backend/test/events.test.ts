import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Tests for the internal EventManager (phase 2A — events).

   No transport, no database, no timers beyond a couple of milliseconds of
   deliberate async: the bus is pure in-memory state, so these pin exactly
   what a consumer depends on — registration, ordering, isolation, cleanup. */

import {
  DOMAIN_EVENTS,
  DOMAIN_EVENT_NAMES,
  registerDomainEvents,
  type DomainEventMap,
} from "../src/events/domain-events.js";
import {
  EventError,
  EventManager,
  defineEvent,
  type EventErrorCode,
  type EventMeta,
} from "../src/infrastructure/events/EventManager.js";
import { createLogger } from "../src/infrastructure/logging/Logger.js";
import { initContext } from "./helpers/init-context.js";

interface TestEvents {
  "order.created": { readonly orderId: string; readonly tableId: string };
  "ticket.created": { readonly ticketId: string };
  "kitchen.ticket.completed": { readonly ticketId: string };
}

const ORDER = { orderId: "o-1", tableId: "t-1" } as const;

function newBus(options: { maxRecentFailures?: number } = {}): EventManager<TestEvents> {
  const manager = new EventManager<TestEvents>(options);
  manager.register(defineEvent("order.created", "test event"));
  manager.register(defineEvent("ticket.created", "test event"));
  manager.register(defineEvent("kitchen.ticket.completed", "test event"));
  return manager;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function expectEventError(fn: () => unknown, code: EventErrorCode): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof EventError, `expected EventError, got ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected an EventError with code ${code}`);
}

function rejectsWithEventError(code: EventErrorCode) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof EventError, `expected EventError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  };
}

describe("EventManager — event registration", () => {
  it("registers events and lists them in declaration order", () => {
    const manager = newBus();

    assert.deepEqual(manager.registeredEvents(), [
      "order.created",
      "ticket.created",
      "kitchen.ticket.completed",
    ]);
    assert.equal(manager.isRegistered("order.created"), true);
    assert.equal(manager.isRegistered("nope"), false);
  });

  it("refuses a duplicate event registration", () => {
    const manager = newBus();

    expectEventError(
      () => manager.register(defineEvent("order.created", "declared twice")),
      "EVENT_ALREADY_REGISTERED",
    );
    assert.equal(manager.registeredEvents().length, 3);
  });

  it("refuses an empty event name", () => {
    expectEventError(() => defineEvent("   ", "no name"), "EVENT_INVALID_NAME");

    const manager = new EventManager<TestEvents>();
    expectEventError(
      () => manager.register({ name: "", description: "blank" }),
      "EVENT_INVALID_NAME",
    );
  });

  it("refuses to subscribe to or emit an undeclared event", async () => {
    const manager = new EventManager<TestEvents>();

    expectEventError(() => manager.on("order.created", () => undefined), "EVENT_NOT_REGISTERED");
    await assert.rejects(
      () => manager.emit("order.created", ORDER),
      rejectsWithEventError("EVENT_NOT_REGISTERED"),
    );
  });
});

describe("EventManager — dispatch", () => {
  it("delivers the payload and its metadata to every listener", async () => {
    const manager = newBus();
    const payloads: unknown[] = [];
    const metas: EventMeta[] = [];

    manager.on("order.created", (payload) => {
      payloads.push(payload);
    });
    manager.on("order.created", (payload, meta) => {
      payloads.push(payload);
      metas.push(meta);
    });

    const report = await manager.emit("order.created", ORDER);

    assert.equal(payloads.length, 2);
    assert.equal(payloads[0], ORDER); // same object the emitter passed
    assert.equal(report.listeners, 2);
    assert.equal(report.delivered, 2);
    assert.deepEqual(report.failures, []);
    assert.equal(report.event, "order.created");
    assert.equal(typeof report.id, "string");
    assert.equal(typeof report.durationMs, "number");

    const meta = metas[0];
    assert.ok(meta);
    assert.equal(meta.name, "order.created");
    assert.equal(meta.listeners, 2);
    assert.equal(meta.sequence, 1);
    assert.ok(meta.at instanceof Date);
  });

  it("accepts an emission with no listeners", async () => {
    const manager = newBus();

    const report = await manager.emit("order.created", ORDER);

    assert.equal(report.listeners, 0);
    assert.equal(report.delivered, 0);
    assert.equal(report.skipped, undefined);
  });

  it("resolves only after an async listener has finished", async () => {
    const manager = newBus();
    let finished = false;

    manager.on("order.created", async () => {
      await delay(5);
      finished = true;
    });

    const report = await manager.emit("order.created", ORDER);

    assert.equal(finished, true);
    assert.equal(report.delivered, 1);
  });

  it("runs listeners sequentially in registration order", async () => {
    const manager = newBus();
    const order: string[] = [];

    manager.on("order.created", async () => {
      await delay(10);
      order.push("slow-first");
    });
    manager.on("order.created", () => {
      order.push("fast-second");
    });

    await manager.emit("order.created", ORDER);

    assert.deepEqual(order, ["slow-first", "fast-second"]);
  });

  it("snapshots listeners, so one added mid-dispatch waits for the next emission", async () => {
    const manager = newBus();
    const calls: string[] = [];

    manager.on("order.created", () => {
      calls.push("first");
      manager.on("order.created", () => {
        calls.push("late");
      });
    });

    await manager.emit("order.created", ORDER);
    assert.deepEqual(calls, ["first"]);
    assert.equal(manager.listenerCount("order.created"), 2);

    await manager.emit("order.created", ORDER);
    assert.deepEqual(calls, ["first", "first", "late"]);
  });

  it("keeps emissions of one event away from listeners of another", async () => {
    const manager = newBus();
    const calls: string[] = [];

    manager.on("order.created", () => {
      calls.push("order.created");
    });
    manager.on("ticket.created", () => {
      calls.push("ticket.created");
    });
    manager.on("kitchen.ticket.completed", () => {
      calls.push("kitchen.ticket.completed");
    });

    await manager.emit("ticket.created", { ticketId: "t-1" });

    assert.deepEqual(calls, ["ticket.created"]);
  });

  it("stamps metadata with the injected clock", async () => {
    const manager = newBus();
    const fixed = new Date("2026-01-02T03:04:05.000Z");
    await manager.init({ ...initContext(), clock: { now: () => fixed } });

    const metas: EventMeta[] = [];
    manager.on("order.created", (_payload, meta) => {
      metas.push(meta);
    });

    await manager.emit("order.created", ORDER);
    await manager.emit("order.created", ORDER);

    assert.equal(metas[0]?.at.toISOString(), fixed.toISOString());
    assert.equal(metas[0]?.sequence, 1);
    assert.equal(metas[1]?.sequence, 2);
    assert.notEqual(metas[0]?.id, metas[1]?.id);
  });
});

describe("EventManager — listener errors are isolated", () => {
  it("runs the remaining listeners and reports the failures", async () => {
    const manager = newBus();
    const ran: string[] = [];

    manager.on(
      "order.created",
      () => {
        ran.push("throws");
        throw new Error("boom");
      },
      { label: "thrower" },
    );
    manager.on(
      "order.created",
      async () => {
        ran.push("rejects");
        throw new Error("async boom");
      },
      { label: "rejecter" },
    );
    manager.on("order.created", () => {
      ran.push("survivor");
    });

    const report = await manager.emit("order.created", ORDER);

    assert.deepEqual(ran, ["throws", "rejects", "survivor"]);
    assert.equal(report.listeners, 3);
    assert.equal(report.delivered, 1);
    assert.deepEqual(
      report.failures.map((failure) => failure.listener),
      ["thrower", "rejecter"],
    );
    assert.equal(report.failures[0]?.message, "boom");
    assert.equal(manager.diagnostics().counters.failures, 2);
    assert.equal(manager.diagnostics().counters.delivered, 1);
  });

  it("reports a non-Error throw as text", async () => {
    const manager = newBus();
    manager.on("order.created", () => {
      throw "a thrown string";
    });

    const report = await manager.emit("order.created", ORDER);

    assert.equal(report.failures[0]?.message, "a thrown string");
  });

  it("logs a listener failure instead of losing it", async () => {
    const lines: Array<Readonly<Record<string, unknown>>> = [];
    const manager = newBus();
    await manager.init({
      ...initContext(),
      logger: createLogger({ sink: (line) => lines.push(line) }),
    });

    manager.on(
      "order.created",
      () => {
        throw new Error("boom");
      },
      { label: "audit-writer" },
    );

    await manager.emit("order.created", ORDER);

    const failureLine = lines.find((line) => line["event"] === "event_listener_failed");
    assert.ok(failureLine);
    assert.equal(failureLine["listener"], "audit-writer");
    assert.equal(failureLine["error_message"], "boom");
  });
});

describe("EventManager — listener removal and duplicates", () => {
  it("refuses the same listener twice for one event", () => {
    const manager = newBus();
    const handler = (): void => undefined;

    manager.on("order.created", handler);

    expectEventError(
      () => manager.on("order.created", handler),
      "EVENT_DUPLICATE_LISTENER",
    );
    assert.equal(manager.listenerCount("order.created"), 1);
  });

  it("allows the same listener on different events", () => {
    const manager = newBus();
    const handler = (): void => undefined;

    manager.on("order.created", handler);
    manager.on("ticket.created", handler);

    assert.equal(manager.listenerCount("order.created"), 1);
    assert.equal(manager.listenerCount("ticket.created"), 1);
  });

  it("removes with off() and reports whether anything was removed", async () => {
    const manager = newBus();
    const calls: string[] = [];
    const handler = (): void => {
      calls.push("called");
    };

    manager.on("order.created", handler);
    assert.equal(manager.off("order.created", handler), true);
    assert.equal(manager.off("order.created", handler), false);
    assert.equal(manager.off("ticket.created", handler), false);

    await manager.emit("order.created", ORDER);
    assert.deepEqual(calls, []);
  });

  it("disposes with the returned function, twice safely", () => {
    const manager = newBus();
    const handler = (): void => undefined;

    const dispose = manager.on("order.created", handler);
    dispose();
    dispose();

    assert.equal(manager.listenerCount("order.created"), 0);
    assert.equal(manager.off("order.created", handler), false);
  });

  it("allows re-subscribing after removal", async () => {
    const manager = newBus();
    const calls: string[] = [];
    const handler = (): void => {
      calls.push("called");
    };

    const dispose = manager.on("order.created", handler);
    dispose();
    manager.on("order.created", handler);

    await manager.emit("order.created", ORDER);

    assert.deepEqual(calls, ["called"]);
  });

  it("fires a once listener exactly once, even when it throws", async () => {
    const manager = newBus();
    let calls = 0;

    manager.once("ticket.created", () => {
      calls += 1;
      throw new Error("once failed");
    });

    const first = await manager.emit("ticket.created", { ticketId: "t-1" });
    const second = await manager.emit("ticket.created", { ticketId: "t-1" });

    assert.equal(calls, 1);
    assert.equal(first.failures.length, 1);
    assert.equal(second.listeners, 0);
    assert.equal(manager.listenerCount("ticket.created"), 0);
  });
});

describe("EventManager — diagnostics", () => {
  it("reports state, per-event listener counts and counters", async () => {
    const manager = newBus();
    manager.on("order.created", () => undefined);
    manager.on("order.created", () => undefined);
    manager.on("ticket.created", () => undefined);

    await manager.emit("order.created", ORDER);

    const diagnostics = manager.diagnostics();

    assert.equal(diagnostics.state, "open");
    assert.deepEqual(diagnostics.listeners, { "order.created": 2, "ticket.created": 1 });
    assert.equal(diagnostics.counters.emitted, 1);
    assert.equal(diagnostics.counters.delivered, 2);
    assert.equal(diagnostics.counters.failures, 0);
    assert.equal(diagnostics.counters.skipped, 0);
    assert.deepEqual(diagnostics.recentFailures, []);
    assert.deepEqual(diagnostics.registered, manager.registeredEvents());
  });

  it("caps the retained failure history", async () => {
    const manager = newBus({ maxRecentFailures: 2 });
    for (const label of ["a", "b", "c"]) {
      manager.on(
        "order.created",
        () => {
          throw new Error(`${label} failed`);
        },
        { label },
      );
    }

    await manager.emit("order.created", ORDER);

    const diagnostics = manager.diagnostics();
    assert.equal(diagnostics.counters.failures, 3);
    assert.deepEqual(
      diagnostics.recentFailures.map((failure) => failure.listener),
      ["b", "c"],
    );
    assert.equal(diagnostics.recentFailures[1]?.event, "order.created");
  });
});

describe("EventManager — detached dispatch", () => {
  it("does not make the emitter wait for an async listener", async () => {
    const manager = newBus();
    let finished = false;

    manager.on("order.created", async () => {
      await delay(5);
      finished = true;
    });

    manager.emitDetached("order.created", ORDER);
    assert.equal(finished, false);

    await delay(20);
    assert.equal(finished, true);
    assert.equal(manager.diagnostics().counters.emitted, 1);
  });

  it("logs, rather than throws, a detached emission of an unregistered event", async () => {
    const lines: Array<Readonly<Record<string, unknown>>> = [];
    const manager = new EventManager<TestEvents>();
    await manager.init({
      ...initContext(),
      logger: createLogger({ sink: (line) => lines.push(line) }),
    });

    manager.emitDetached("order.created", ORDER);
    await delay(0);

    assert.equal(
      lines.some((line) => line["event"] === "event_emit_detached_failed"),
      true,
    );
    assert.equal(manager.diagnostics().counters.emitted, 0);
  });
});

describe("EventManager — cleanup and shutdown", () => {
  it("clears one event or every event", () => {
    const manager = newBus();
    manager.on("order.created", () => undefined);
    manager.on("order.created", () => undefined);
    manager.on("ticket.created", () => undefined);

    assert.equal(manager.clear("order.created"), 2);
    assert.equal(manager.listenerCount("order.created"), 0);
    assert.equal(manager.listenerCount("ticket.created"), 1);
    assert.equal(manager.clear(), 1);
    assert.deepEqual(manager.diagnostics().listeners, {});
  });

  it("drops every listener on shutdown and refuses new subscriptions", async () => {
    const manager = newBus();
    manager.on("order.created", () => undefined);

    await manager.shutdown();

    assert.equal(manager.getState(), "closed");
    assert.equal(manager.listenerCount("order.created"), 0);

    expectEventError(
      () => manager.on("order.created", () => undefined),
      "EVENT_MANAGER_CLOSED",
    );
    expectEventError(
      () => manager.register(defineEvent("cart.item.added", "late")),
      "EVENT_MANAGER_CLOSED",
    );
  });

  it("skips a late emission instead of crashing the emitter", async () => {
    const manager = newBus();
    let called = false;
    manager.on("order.created", () => {
      called = true;
    });

    await manager.shutdown();
    const report = await manager.emit("order.created", ORDER);

    assert.equal(called, false);
    assert.equal(report.skipped, true);
    assert.equal(report.delivered, 0);
    assert.equal(manager.diagnostics().counters.skipped, 1);
  });

  it("is idempotent", async () => {
    const manager = newBus();
    manager.on("order.created", () => undefined);

    await manager.shutdown();
    await manager.shutdown();

    assert.equal(manager.getState(), "closed");
  });
});

describe("domain event catalog", () => {
  it("registers every declared domain event", () => {
    const manager = new EventManager<DomainEventMap>();

    registerDomainEvents(manager);

    assert.deepEqual(manager.registeredEvents(), [
      "cart.item.added",
      "order.created",
      "order.denied",
      "ticket.created",
      "kitchen.ticket.incoming",
      "kitchen.ticket.completed",
      "ticket.status.changed",
      "ticket.served",
      "ticket.denied",
      "table.session.started",
      "table.session.cleared",
      "table.bill.requested",
      "bill.settled",
    ]);
    assert.deepEqual([...DOMAIN_EVENT_NAMES], manager.registeredEvents());
  });

  it("refuses to register the catalog twice", () => {
    const manager = new EventManager<DomainEventMap>();
    registerDomainEvents(manager);

    expectEventError(() => registerDomainEvents(manager), "EVENT_ALREADY_REGISTERED");
  });

  it("uses lowercase, dot-separated domain names with no transport vocabulary", () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      assert.match(name, /^[a-z]+(\.[a-z]+)+$/);
      assert.equal(/socket|room|channel|broadcast|emit/i.test(name), false);
    }
  });

  it("carries a typed payload through to the listener", async () => {
    const manager = new EventManager<DomainEventMap>();
    registerDomainEvents(manager);
    const received: string[] = [];

    manager.on("kitchen.ticket.completed", (payload) => {
      received.push(payload.ticketId);
    });

    await manager.emit("kitchen.ticket.completed", { ticketId: "tk-1", orderId: "o-1" });

    assert.deepEqual(received, ["tk-1"]);
  });

  it("declares every catalog entry with a description", () => {
    for (const definition of Object.values(DOMAIN_EVENTS)) {
      assert.equal(definition.name.trim().length > 0, true);
      assert.equal(definition.description.length > 0, true);
    }
  });
});
