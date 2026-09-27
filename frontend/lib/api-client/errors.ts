/* ApiError — the single error type every wrapper throws.
   Mirrors the contract envelope (docs/7 §1.1):
     { success: false, error: { code, message, ...case-specific details } }
   so UI code can branch on `err.error === "INVENTORY_FAILURE"` etc. */

export class ApiError extends Error {
  /** HTTP status (0 = never reached the server: timeout / offline / config). */
  readonly status: number;
  /** Contract error.code, e.g. INVENTORY_FAILURE, DUPLICATE_ORDER, UNAUTHORIZED. */
  readonly error: string;
  /** Case-specific keys from the envelope's error object (sold_out, fields, …). */
  readonly details?: Record<string, unknown>;

  constructor(status: number, error: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.error = error;
    this.details = details;
  }

  /** Menu names carried by a 409 INVENTORY_FAILURE (empty otherwise). */
  get soldOut(): string[] {
    const sold = this.details?.["sold_out"];
    return Array.isArray(sold) ? sold.filter((item): item is string => typeof item === "string") : [];
  }

  /** Per-field messages carried by a 400 VALIDATION_ERROR. */
  get fields(): Record<string, string> {
    const fields = this.details?.["fields"];
    return fields && typeof fields === "object" ? (fields as Record<string, string>) : {};
  }

  get isTimeout(): boolean {
    return this.error === "TIMEOUT";
  }

  get isNetworkFailure(): boolean {
    return this.error === "NETWORK_ERROR";
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
