/* Shared validation primitives. The table token is a capability, so its shape
   is defined once and used by the table, cart and order contracts. */

import { z } from "zod";

export const TABLE_TOKEN_RE = /^[a-z0-9]{4,16}$/;

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path/body UUID with the field-specific message existing schemas use. */
export function uuid(label: string) {
  return z.string().regex(UUID_RE, `Must be a valid ${label} UUID.`);
}

export const tableToken = z
  .string()
  .regex(TABLE_TOKEN_RE, "Must be a 4-16 character lowercase table token.");

/** §1.5 pagination — shared by every list endpoint. */
export const pagination = {
  page: z.coerce.number().int().min(1, "page must be an integer >= 1.").default(1),
  limit: z.coerce.number().int().min(1, "limit must be between 1 and 100.").max(100, "limit must be between 1 and 100.").default(20),
};

/** Free-text kitchen instructions; the DB check uses the same 500 cap. */
export const note = z.string().max(500, "Notes must be 500 characters or fewer.");
