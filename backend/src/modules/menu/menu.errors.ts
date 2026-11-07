/* pg errors arrive wrapped by DatabaseManager as DatabaseError (code
   DB_QUERY_FAILED) with the driver error in `cause`. Repository code that
   needs a SQLSTATE must look through that chain, never at the top-level code. */

export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && code !== "DB_QUERY_FAILED") return code;
      current = (current as { cause?: unknown }).cause;
    } else {
      return undefined;
    }
  }
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505";
}
