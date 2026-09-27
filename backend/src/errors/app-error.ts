/* Error carrying an HTTP status and an error.code from the contract's
   error-code registry (docs/7-api-contract.md §1.8). Feature routes will
   throw this; the central error handler renders the envelope. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
