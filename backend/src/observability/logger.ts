import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/* Structured logging + request correlation.

   Every request gets an X-Request-Id (honouring an upstream one from a load
   balancer) that is echoed back to the client and attached to both the
   access log and every log line emitted while the request is in flight.
   When a 500 reaches the client, the response body carries the same id, so
   "something broke" support reports can be matched to an exact log line.

   One JSON object per line — no logger dependency, greppable by any
   log-ingester (Render, Fly, Loki, Datadog all parse ndjson natively). */

export interface RequestLog {
  /** Correlation id, shared by every log line for this request. */
  requestId: string;
}

/** Expand an Error into the fields an ingester wants, without dumping a
    stack trace into the response path. */
function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { error_name: err.name, error_message: err.message };
  }
  return { error_message: String(err) };
}

/** Emit one ndjson log line. Extra fields are merged after the standard
    ones; keep values scalar or they will be stringified by the ingester. */
export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Attach a request id (upstream or generated) and write the access log
    after the response finishes. Registers `req.log` for downstream use. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const upstream = req.header("x-request-id");
  // Header values are attacker-controlled; clamp to a sane charset/length.
  const requestId =
    upstream && /^[A-Za-z0-9_-]{8,64}$/.test(upstream) ? upstream : randomUUID();

  res.setHeader("X-Request-Id", requestId);
  (req as Request & { requestLog: RequestLog }).requestLog = { requestId };

  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logEvent("info", "http_request", {
      request_id: requestId,
      method: req.method,
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 10) / 10,
    });
  });

  next();
}
