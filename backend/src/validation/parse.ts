/* Shared request parser: zod failure → the contract's 400 VALIDATION_ERROR
   envelope with per-field messages (docs/7 §1.1). Extracted so module-owned
   validators can use it without importing the whole legacy schema catalog. */

import type { z } from "zod";
import { AppError } from "../errors/app-error.js";

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    fields[issue.path.length > 0 ? issue.path.join(".") : "body"] = issue.message;
  }
  throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", { fields });
}
