/* Module 1 — Shift Authentication Engine (compatibility facade).
   The rules now live in the Staff module; these names stay so routes/tests
   that import the legacy service keep the exact same behaviour. */

import type { ShiftClaims } from "../lib/jwt.js";
import { getDefaultStaffService } from "./staff.service.js";

export type {
  ShiftLoginResult,
  StaffSessionIdentity as SessionIdentity,
} from "../modules/staff/staff.types.js";

export function authenticateShift(pin: string) {
  return getDefaultStaffService().authenticateShift(pin);
}

export function sessionIdentity(claims: ShiftClaims, source: "header" | "cookie") {
  return getDefaultStaffService().sessionIdentity(claims, source);
}
