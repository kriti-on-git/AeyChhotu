/* Staff module — role/permission policy.

   One matrix, one decision function. Existing module routes keep their own
   `requireRole(...)` gates; this is the vocabulary the Staff module owns and
   the server-side check used by the staff-management surface. A permission is
   only ever granted by the role claim on the verified token — never by a
   request body. */

import type { RequestHandler } from "express";
import { AppError } from "../../errors/app-error.js";
import type { StaffPermission, StaffRole } from "./staff.types.js";

const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly StaffPermission[]>> = {
  kitchen: ["shift.identity", "kitchen.board", "menu.availability", "billing.settle"],
  floor: ["shift.identity", "floor.view", "billing.settle"],
  admin: [
    "shift.identity",
    "kitchen.board",
    "floor.view",
    "menu.availability",
    "billing.settle",
    "admin.console",
    "staff.manage",
  ],
};

const ROLE_SET: ReadonlySet<string> = new Set(Object.keys(ROLE_PERMISSIONS));

export function isStaffRole(value: string): value is StaffRole {
  return ROLE_SET.has(value);
}

/** Explicit permission table, useful for diagnostics/tests. */
export function permissionsFor(role: string): readonly StaffPermission[] {
  return isStaffRole(role) ? ROLE_PERMISSIONS[role] : [];
}

export function hasPermission(role: string, permission: StaffPermission): boolean {
  return permissionsFor(role).includes(permission);
}

/** Server-side gate: the token's role must grant the permission. */
export function requirePermission(permission: StaffPermission): RequestHandler {
  return (req, _res, next) => {
    if (!hasPermission(req.shift?.role ?? "", permission)) {
      next(
        new AppError(
          403,
          "FORBIDDEN",
          "This session role is not permitted to perform this action.",
        ),
      );
      return;
    }
    next();
  };
}
