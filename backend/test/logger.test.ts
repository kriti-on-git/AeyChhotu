import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for the structured logger (phase 2A). The sink is injected, so
   nothing here writes to stdout and timestamps are exact. */

import {
  createLogger,
  silentSink,
  type LogLevel,
  type LogSink,
} from "../src/infrastructure/logging/Logger.js";

function capture(): { sink: LogSink; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    sink: (line) => {
      lines.push({ ...line });
    },
  };
}

const fixedClock = { now: () => new Date("2026-01-02T03:04:05.000Z") };

describe("StructuredLogger — line shape", () => {
  it("emits ts/level/event plus the supplied fields", () => {
    const { sink, lines } = capture();
    const logger = createLogger({ sink, clock: fixedClock, level: "debug" });

    logger.info("order_fired", { order_id: "o-1", quantity: 2 });

    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], {
      ts: "2026-01-02T03:04:05.000Z",
      level: "info",
      event: "order_fired",
      order_id: "o-1",
      quantity: 2,
    });
  });

  it("routes each level with its own level value", () => {
    const { sink, lines } = capture();
    const logger = createLogger({ sink, clock: fixedClock, level: "debug" });

    for (const level of ["debug", "info", "warn", "error"] as const) {
      logger[level]("event_name");
    }

    assert.deepEqual(
      lines.map((line) => line["level"]),
      ["debug", "info", "warn", "error"],
    );
  });

  it("suppresses levels below the configured threshold", () => {
    const { sink, lines } = capture();
    const logger = createLogger({ sink, clock: fixedClock, level: "warn" });

    logger.debug("hidden");
    logger.info("hidden");
    logger.warn("shown");

    assert.deepEqual(
      lines.map((line) => line["event"]),
      ["shown"],
    );
  });

  it("defaults to info (debug is suppressed)", () => {
    const { sink, lines } = capture();
    const logger = createLogger({ sink, clock: fixedClock });

    logger.debug("hidden");
    logger.info("shown");

    assert.equal(lines.length, 1);
  });
});

describe("StructuredLogger — child loggers", () => {
  it("stamps child lines without mutating the parent", () => {
    const { sink, lines } = capture();
    const root = createLogger({ sink, clock: fixedClock });
    const child = root.child({ table_id: "t-1" });

    child.info("heartbeat");
    root.info("heartbeat");

    assert.equal(lines[0]?.["table_id"], "t-1");
    assert.equal(lines[1]?.["table_id"], undefined);
  });

  it("lets a call-level field override an inherited one", () => {
    const { sink, lines } = capture();
    const child = createLogger({ sink, clock: fixedClock }).child({ table_id: "t-1" });

    child.info("cleared", { table_id: "t-2" });

    assert.equal(lines[0]?.["table_id"], "t-2");
  });
});

describe("StructuredLogger — safety", () => {
  it("expands an Error field into error_name/error_message", () => {
    const { sink, lines } = capture();
    const logger = createLogger({ sink, clock: fixedClock, level: "error" });

    logger.error("boom", { error: new TypeError("bad input") });

    assert.equal(lines[0]?.["error_name"], "TypeError");
    assert.equal(lines[0]?.["error_message"], "bad input");
  });

  it("never throws when a sink fails", () => {
    const throwingSink: LogSink = () => {
      throw new Error("stdout closed");
    };
    const logger = createLogger({ sink: throwingSink, clock: fixedClock });

    assert.doesNotThrow(() => logger.info("still alive"));
  });

  it("never throws on a circular payload", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    // This sink serializes like consoleSink does, so a circular field would
    // throw inside the sink — the logger must contain it.
    const serializingSink: LogSink = (line) => {
      JSON.stringify(line);
    };
    const logger = createLogger({ sink: serializingSink, clock: fixedClock, level: "debug" });

    assert.doesNotThrow(() => logger.info("circular", { circular }));
  });

  it("silentSink writes nothing", () => {
    const logger = createLogger({ sink: silentSink });
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];

    assert.doesNotThrow(() => {
      for (const level of levels) logger[level]("quiet");
    });
  });
});
