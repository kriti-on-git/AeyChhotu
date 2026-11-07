/* Staff module — request validators.

   The login schemas moved here from validation/schemas.ts, which re-exports
   them so every existing importer keeps working. A role in a body is never
   trusted: the enum below and the service guard both reject `admin`. */

import { z } from "zod";
import { uuid } from "../../validation/primitives.js";

const pin = z.string().regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits.");

/** E2 POST /api/v1/auth/kds-login */
export const kdsLoginSchema = z.object({
  pin,
  surface: z.enum(["kitchen", "floor"]).optional(),
});

/** E2c POST /api/v1/auth/admin-login */
export const adminLoginSchema = z.object({ pin });

export const staffParamsSchema = z.object({ staff_id: uuid("staff_id") });

const staffRole = z.enum(["kitchen", "floor"]);

const pinEnvVar = z
  .string()
  .trim()
  .regex(
    /^[A-Z][A-Z0-9_]{0,63}$/,
    "Use an uppercase environment variable name (letters, digits, underscore).",
  );

export const createStaffSchema = z.object({
  device_label: z.string().trim().max(80, "Device labels must be 80 characters or fewer.").default(""),
  role: staffRole,
  pin_env_var: pinEnvVar.default("STAFF_PIN"),
});

export const updateStaffSchema = z
  .object({
    device_label: z
      .string()
      .trim()
      .max(80, "Device labels must be 80 characters or fewer.")
      .optional(),
    role: staffRole.optional(),
    is_active: z.boolean().optional(),
    pin_env_var: pinEnvVar.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Provide at least one field to update.",
  });
