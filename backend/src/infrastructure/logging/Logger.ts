/* Structured logging — one ndjson object per line, no dependency.

   The format is identical to observability/logger.ts (ts · level · event ·
   fields) so existing log greps and ingesters keep working. What changes is
   that the sink is INJECTED: tests capture lines without touching stdout, and
   a component receives a Logger through InitContext instead of reaching for a
   module-level singleton.

   A logging call must never break a request: serialization and sink failures
   are swallowed (one best-effort fallback line is emitted instead). */

import { systemClock, type Clock } from "../clock/Clock.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export type LogSink = (line: Readonly<Record<string, unknown>>) => void;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that stamps every line with additional fields. */
  child(fields: LogFields): Logger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Default sink: stdout/stderr in the historical ndjson shape. */
export const consoleSink: LogSink = (line) => {
  const serialized = JSON.stringify(line);
  if (line["level"] === "error") {
    console.error(serialized);
  } else if (line["level"] === "warn") {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
};

/** A sink that writes nothing (tests, silenced components). */
export const silentSink: LogSink = () => undefined;

/* Errors do not survive JSON.stringify usefully, so expand them into the
   field names this codebase already greps for: `error` → error_message +
   error_name. */
function expandFields(fields: LogFields): LogFields {
  const expanded: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      expanded[`${key}_name`] = value.name;
      expanded[`${key}_message`] = value.message;
      continue;
    }
    expanded[key] = value;
  }

  return expanded;
}

export class StructuredLogger implements Logger {
  private readonly sink: LogSink;
  private readonly level: LogLevel;
  private readonly clock: Clock;
  private readonly fields: LogFields;

  constructor(sink: LogSink, level: LogLevel, clock: Clock, fields: LogFields = {}) {
    this.sink = sink;
    this.level = level;
    this.clock = clock;
    this.fields = fields;
  }

  debug(event: string, fields?: LogFields): void {
    this.write("debug", event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.write("error", event, fields);
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger(this.sink, this.level, this.clock, {
      ...this.fields,
      ...fields,
    });
  }

  private write(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;

    const line: Record<string, unknown> = {
      ts: this.clock.now().toISOString(),
      level,
      event,
      ...this.fields,
      ...(fields ? expandFields(fields) : {}),
    };

    try {
      this.sink(line);
    } catch {
      // A sink failure (circular payload, closed stdout) must not propagate
      // into request handling. Fall back to a minimal, always-serializable line.
      try {
        console.error(`[log] dropped "${event}" — sink failed`);
      } catch {
        /* nothing left to do */
      }
    }
  }
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly clock?: Clock;
  readonly fields?: LogFields;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(
    options.sink ?? consoleSink,
    options.level ?? "info",
    options.clock ?? systemClock,
    options.fields ?? {},
  );
}
