import type { NextFunction, Request, Response } from "express";
import { toHttpErrorResponse } from "../errors/http-error-response.js";
import type { Logger } from "../infrastructure/logging/Logger.js";
import type { RequestLog } from "../observability/logger.js";

/* Central error handler — the only place that renders the error envelope
   (docs/7-api-contract.md §1.1):
     { "success": false, "error": { "code", "message", ...details } }
   Must be registered last and keep its 4-arg signature.

   The mapping itself lives in errors/http-error-response.ts so it can be
   unit-tested; this file only decides what to do with an unexpected failure
   (log the real cause server-side, leak nothing) and writes the response. */

export interface ErrorHandlerDeps {
  /** Structured logger for unexpected (500) failures. When omitted, the
      historical console.error fallback is used so existing wiring is
      unchanged. */
  readonly logger?: Logger;
}

function requestIdOf(req: Request): string | undefined {
  const log = (req as Request & { requestLog?: RequestLog }).requestLog;
  return log?.requestId;
}

export function createErrorHandler(deps: ErrorHandlerDeps = {}) {
  return function errorHandler(
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (res.headersSent) {
      next(err);
      return;
    }

    const { status, body, unexpected } = toHttpErrorResponse(err);

    if (unexpected) {
      if (deps.logger) {
        deps.logger.error("http_unhandled_error", {
          request_id: requestIdOf(req),
          method: req.method,
          path: req.originalUrl,
          error: err,
        });
      } else {
        console.error(`[error] ${req.method} ${req.originalUrl} ->`, err);
      }
    }

    res.status(status).json(body);
  };
}

/** Default instance — preserves the existing `errorHandler` import. */
export const errorHandler = createErrorHandler();
