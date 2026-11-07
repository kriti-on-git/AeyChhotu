/* Table module — request validators.

   Owned by the module so its HTTP contract moves with its controller. The
   base table-token primitive lives in validation/primitives.ts because the
   cart and order contracts share the same capability format. */

import { z } from "zod";
import { uuid } from "../../validation/primitives.js";
import { tableToken } from "../../validation/primitives.js";

/* When the CLIENT opened the page. Older than last_cleared_at ⇒ STALE_SESSION. */
const scanTime = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), "scan_time must be an ISO timestamp.")
  .optional();

/* The device identity registered in table_members. `name` is required on every
   entry point: an anonymous guest breaks the roster and the split bill. */
const sessionMember = {
  user_id: z
    .string()
    .trim()
    .min(1, "user_id cannot be empty.")
    .max(64, "user_id must be 64 characters or fewer.")
    .optional(),
  name: z
    .string()
    .trim()
    .min(1, "name is required — enter your name so the table knows who ordered.")
    .max(40, "name must be 40 characters or fewer."),
};

const tableSecret = z
  .string()
  .regex(/^[A-Za-z0-9]{20}$/, "The table pass must be 20 letters or digits.");

/** E1 POST /api/v1/sessions/initialize */
export const initializeSchema = z.object({
  table_token: tableToken,
  scan_time: scanTime,
  ...sessionMember,
});

/** E1b POST /api/v1/sessions/join-pin */
export const joinPinSchema = z.object({
  table_token: tableToken,
  pin: z.string().regex(/^\d{2}$/, "PIN must be exactly two digits (00-99)."),
  scan_time: scanTime,
  ...sessionMember,
});

/** E1c POST /api/v1/sessions/join-pass */
export const joinPassSchema = z.object({
  table_token: tableToken,
  secret: tableSecret,
  scan_time: scanTime,
  ...sessionMember,
});

/** E1d POST /api/v1/sessions/reconnect */
export const reconnectSchema = z.object({
  table_token: tableToken,
  secret: tableSecret,
  scan_time: scanTime,
  ...sessionMember,
});

/** E9 GET /api/v1/sessions/:table_token/active-check */
export const activeCheckParamsSchema = z.object({ table_token: tableToken });

/** POST /api/v1/sessions/:table_token/bill-request
    DELETE /api/v1/sessions/:table_token/heartbeat — same scope. */
export const sessionTableParamsSchema = z.object({ table_token: tableToken });

/** POST/DELETE /api/v1/sessions/:table_token/heartbeat body. */
export const heartbeatSchema = z.object({
  device_id: z
    .string()
    .trim()
    .min(1, "device_id is required.")
    .max(64, "device_id must be 64 characters or fewer."),
});

/** Server-issued participant bearer credential (Phase 5.2). */
export const participantTokenSchema = z
  .string()
  .trim()
  .regex(/^pc_[A-Za-z0-9_-]{43}$/, "Must be a participant credential issued by this server.");

/** POST /api/v1/sessions/:table_token/participants/:participant_id/revoke */
export const participantRevokeParamsSchema = z.object({
  table_token: tableToken,
  participant_id: uuid("participant_id"),
});

/** POST /api/v1/sessions/:table_token/feedback — a session-scoped review. */
export const feedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional().default(""),
});
