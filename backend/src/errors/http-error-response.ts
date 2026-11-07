/* The one mapping from a thrown value to the contract error envelope
   (docs/7-api-contract.md §1.1):

     { "success": false, "error": { "code", "message", ...details } }

   Extracted from middleware/error-handler.ts so the mapping is unit-testable
   without an Express request/response, and so any future transport (a socket
   ack, a CLI) renders exactly the same body.

   `unexpected: true` means "log the real cause, return nothing about it":
   an internal failure never leaks a message or a stack to the client. */

import { AppError } from "./app-error.js";

export interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
}

export interface HttpErrorResponse {
  readonly status: number;
  readonly body: ErrorEnvelope;
  /** True for the 500 branch — the caller should log the original error. */
  readonly unexpected: boolean;
}

export function toHttpErrorResponse(err: unknown): HttpErrorResponse {
  // Malformed JSON body (express.json / body-parser parse failure).
  const bodyError = err as { type?: string } | undefined;

  if (err instanceof SyntaxError || bodyError?.type === "entity.parse.failed") {
    return {
      status: 400,
      unexpected: false,
      body: {
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Request body is not valid JSON." },
      },
    };
  }

  // Raw image bodies (or any route-level parser) exceed their limit.
  if (bodyError?.type === "entity.too.large") {
    return {
      status: 413,
      unexpected: false,
      body: {
        success: false,
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "That file is too large for this endpoint.",
        },
      },
    };
  }

  if (err instanceof AppError) {
    return {
      status: err.status,
      unexpected: false,
      body: {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ?? {}),
        },
      },
    };
  }

  return {
    status: 500,
    unexpected: true,
    body: {
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error." },
    },
  };
}
