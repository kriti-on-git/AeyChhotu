/* Staff module — contracts.

   IDENTITY: a staff member working a surface is a `staff_terminals` row. The
   table never stores a PIN; `pin_env_var` stores the NAME of the environment
   variable that holds the PIN. That rule is preserved exactly.

   AUTH: this module integrates the existing mechanism — STAFF_PIN/ADMIN_PIN
   compared in constant time in Node, and an HS256 JWT signed with
   KDS_TOKEN_SECRET. It deliberately does NOT invent a replacement system:
   the same claims, TTL, secret, cookies and error codes stay in force. The
   `admin` role is configuration-backed (ADMIN_PIN), not a staff_terminals row.

   AUTHORIZATION: the role vocabulary and permission matrix live here. The
   existing per-route `requireRole()` gates are untouched; new staff-management
   routes use `requirePermission()` so the decision is server-side.

   ZERO EXPOSURE: no method returns a PIN, a hash, a token secret or a raw
   config value. Responses carry ids, labels, roles and the environment
   variable NAME only. */

import type { ShiftClaims } from "../../lib/jwt.js";

export const STAFF_ROLES = ["kitchen", "floor", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Roles that can own a terminal row. `admin` is the env-backed console. */
export const STAFF_TERMINAL_ROLES = ["kitchen", "floor"] as const;
export type StaffTerminalRole = (typeof STAFF_TERMINAL_ROLES)[number];

export const STAFF_PERMISSIONS = [
  "shift.identity",
  "kitchen.board",
  "floor.view",
  "menu.availability",
  "billing.settle",
  "admin.console",
  "staff.manage",
] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export type StaffTerminalRow = {
  id: string;
  device_label: string;
  role: StaffTerminalRole;
  is_active: boolean;
  /** The environment variable NAME, never its value. */
  pin_env_var: string;
  created_at: Date;
};

export type StaffMember = {
  staff_id: string;
  device_label: string;
  role: StaffTerminalRole;
  is_active: boolean;
  pin_env_var: string;
  created_at: string;
};

/** E2 response body — unchanged fields. */
export type ShiftLoginResult = {
  token: string;
  token_type: "Bearer";
  expires_in: number;
  role: "kitchen";
  terminal_id: string | null;
  realtime_token: string | null;
  message: string;
};

/** E2c response body — unchanged fields. */
export type AdminLoginResult = {
  token: string;
  token_type: "Bearer";
  expires_in: number;
  role: "admin";
  message: string;
};

/** E2b response body — unchanged fields. */
export type StaffSessionIdentity = {
  authenticated: true;
  role: string;
  terminal_id: string | null;
  issued_at: string;
  expires_at: string;
  source: "header" | "cookie";
};

export type CreateStaffInput = {
  device_label?: string;
  role: StaffTerminalRole;
  pin_env_var?: string;
};

export type UpdateStaffInput = {
  device_label?: string;
  role?: StaffTerminalRole;
  is_active?: boolean;
  pin_env_var?: string;
};

export type StaffSchemaPresence = {
  readonly present: readonly string[];
  readonly missing: readonly string[];
};

export interface StaffRepositoryPort {
  findTerminal(staffId: string): Promise<StaffTerminalRow | null>;
  /** First active terminal of that role, oldest first (E2 binding). */
  findActiveByRole(role: StaffTerminalRole): Promise<StaffTerminalRow | null>;
  listTerminals(): Promise<StaffTerminalRow[]>;
  createTerminal(input: Required<CreateStaffInput>): Promise<StaffTerminalRow | null>;
  updateTerminal(
    staffId: string,
    input: UpdateStaffInput,
  ): Promise<StaffTerminalRow | null>;
  schemaObjects(): Promise<StaffSchemaPresence>;
}

export interface StaffServicePort {
  authenticateShift(pin: string): Promise<ShiftLoginResult>;
  authenticateAdmin(pin: string): Promise<AdminLoginResult>;
  sessionIdentity(claims: ShiftClaims, source: "header" | "cookie"): StaffSessionIdentity;
  hasPermission(role: string, permission: StaffPermission): boolean;
  listStaff(): Promise<StaffMember[]>;
  createStaff(input: CreateStaffInput): Promise<StaffMember>;
  updateStaff(staffId: string, input: UpdateStaffInput): Promise<StaffMember>;
}
