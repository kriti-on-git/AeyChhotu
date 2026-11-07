/* Staff module — business rules.

   AUTHENTICATION IS NOT REINVENTED. The module keeps the deployed rules:
     * 4–6 digit PIN compared in constant time against STAFF_PIN/ADMIN_PIN;
     * HS256 JWT signed with KDS_TOKEN_SECRET, 8-hour TTL;
     * shift login binds the first ACTIVE kitchen terminal (terminal_id may be
       null if none exists — the existing response shape);
     * admin login is configuration-backed and carries terminal_id: null.
   Moving this code out of `services/` changes who owns it, not what it does.

   SESSION LIFECYCLE: issuing, describing and expiring a session all use the
   same claims. Expiry is enforced by the existing JWT verifier in
   middleware/auth; identity never re-interprets an expired token.

   AUTHORIZATION: role validation happens here even though the HTTP layer also
   validates it. A role is a server-side fact: `admin` cannot be assigned to a
   terminal row, and an unknown role grants no permissions. */

import { timingSafeEqual } from "node:crypto";
import { AppError } from "../../errors/app-error.js";
import { signReadToken, signToken, type ShiftClaims } from "../../lib/jwt.js";
import { iso } from "../../lib/util.js";
import { hasPermission, isStaffRole } from "./staff.permissions.js";
import type {
  AdminLoginResult,
  CreateStaffInput,
  ShiftLoginResult,
  StaffMember,
  StaffPermission,
  StaffRepositoryPort,
  StaffServicePort,
  StaffSessionIdentity,
  StaffTerminalRow,
  StaffTerminalRole,
  UpdateStaffInput,
} from "./staff.types.js";

const TOKEN_TTL_SECONDS = 8 * 60 * 60; // one 8-hour shift
const PIN_ENV_VAR_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STAFF_TERMINAL_ROLES: readonly string[] = ["kitchen", "floor"];

export interface StaffServiceDeps {
  readonly repository: StaffRepositoryPort;
  readonly staffPin: string;
  readonly adminPin: string;
  readonly kdsTokenSecret: string;
  readonly supabaseJwtSecret: string | null;
}

/** Constant-time PIN comparison (both sides fixed length). */
export function pinMatches(attempt: string, expected: string): boolean {
  const a = Buffer.from(attempt);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isTerminalRole(value: string): value is StaffTerminalRole {
  return STAFF_TERMINAL_ROLES.includes(value);
}

function toMember(row: StaffTerminalRow): StaffMember {
  return {
    staff_id: row.id,
    device_label: row.device_label,
    role: row.role,
    is_active: row.is_active,
    pin_env_var: row.pin_env_var,
    created_at: iso(row.created_at),
  };
}

function invalidField(field: string, message: string): AppError {
  return new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
    fields: { [field]: message },
  });
}

function assertPinEnvVar(value: string): string {
  const name = value.trim();
  if (!PIN_ENV_VAR_RE.test(name)) {
    throw invalidField(
      "pin_env_var",
      "Use an uppercase environment variable name (letters, digits, underscore).",
    );
  }
  return name;
}

export class StaffService implements StaffServicePort {
  private readonly repository: StaffRepositoryPort;
  private readonly staffPin: string;
  private readonly adminPin: string;
  private readonly kdsTokenSecret: string;
  private readonly supabaseJwtSecret: string | null;

  constructor(deps: StaffServiceDeps) {
    this.repository = deps.repository;
    this.staffPin = deps.staffPin;
    this.adminPin = deps.adminPin;
    this.kdsTokenSecret = deps.kdsTokenSecret;
    this.supabaseJwtSecret = deps.supabaseJwtSecret;
  }

  /* -------------------------------------------------------------- shift */

  async authenticateShift(pin: string): Promise<ShiftLoginResult> {
    if (!pinMatches(pin, this.staffPin)) {
      throw new AppError(
        401,
        "INVALID_PIN",
        "Invalid staff access configuration credentials.",
      );
    }

    const terminal = await this.repository.findActiveByRole("kitchen");
    const now = Math.floor(Date.now() / 1000);
    const claims: ShiftClaims = {
      role: "kitchen",
      terminal_id: terminal?.id ?? null,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    };

    const realtimeToken = this.supabaseJwtSecret
      ? signReadToken(
          {
            sub: claims.terminal_id ?? "kds",
            role: "authenticated",
            staff: claims.role,
            iat: now,
            exp: now + TOKEN_TTL_SECONDS,
          },
          this.supabaseJwtSecret,
        )
      : null;

    return {
      token: signToken(claims, this.kdsTokenSecret),
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      role: "kitchen",
      terminal_id: claims.terminal_id,
      realtime_token: realtimeToken,
      message: "Shift active · Audio armed.",
    };
  }

  /* -------------------------------------------------------------- admin */

  async authenticateAdmin(pin: string): Promise<AdminLoginResult> {
    if (!pinMatches(pin, this.adminPin)) {
      throw new AppError(401, "INVALID_ADMIN_PIN", "That manager PIN is not correct.");
    }

    const now = Math.floor(Date.now() / 1000);
    const claims: ShiftClaims = {
      role: "admin",
      terminal_id: null,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    };

    return {
      token: signToken(claims, this.kdsTokenSecret),
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      role: "admin",
      message: "Manager console unlocked.",
    };
  }

  /* ----------------------------------------------------------- identity */

  sessionIdentity(
    claims: ShiftClaims,
    source: "header" | "cookie",
  ): StaffSessionIdentity {
    return {
      authenticated: true,
      role: claims.role,
      terminal_id: claims.terminal_id,
      issued_at: iso(new Date(claims.iat * 1000)),
      expires_at: iso(new Date(claims.exp * 1000)),
      source,
    };
  }

  /* ------------------------------------------------------- authorization */

  hasPermission(role: string, permission: StaffPermission): boolean {
    return hasPermission(role, permission);
  }

  /* ----------------------------------------------------- staff management */

  async listStaff(): Promise<StaffMember[]> {
    const rows = await this.repository.listTerminals();
    return rows.map(toMember);
  }

  async createStaff(input: CreateStaffInput): Promise<StaffMember> {
    if (!isTerminalRole(input.role)) {
      throw invalidField("role", "A terminal can only be kitchen or floor.");
    }

    const deviceLabel = (input.device_label ?? "").trim();
    if (deviceLabel.length > 80) {
      throw invalidField("device_label", "Device labels must be 80 characters or fewer.");
    }

    const row = await this.repository.createTerminal({
      device_label: deviceLabel,
      role: input.role,
      pin_env_var: assertPinEnvVar(input.pin_env_var ?? "STAFF_PIN"),
    });

    if (!row) {
      throw new AppError(500, "INTERNAL_ERROR", "The staff terminal could not be created.");
    }
    return toMember(row);
  }

  async updateStaff(staffId: string, input: UpdateStaffInput): Promise<StaffMember> {
    if (input.role !== undefined && !isTerminalRole(input.role)) {
      throw invalidField("role", "A terminal can only be kitchen or floor.");
    }

    const deviceLabel =
      input.device_label === undefined ? undefined : input.device_label.trim();
    if (deviceLabel !== undefined && deviceLabel.length > 80) {
      throw invalidField("device_label", "Device labels must be 80 characters or fewer.");
    }

    const row = await this.repository.updateTerminal(staffId, {
      ...input,
      ...(deviceLabel !== undefined ? { device_label: deviceLabel } : {}),
      ...(input.pin_env_var !== undefined
        ? { pin_env_var: assertPinEnvVar(input.pin_env_var) }
        : {}),
    });

    if (!row) {
      throw new AppError(404, "STAFF_NOT_FOUND", "Unknown staff terminal.");
    }
    return toMember(row);
  }

  /** Kept for callers that only need a boolean role decision. */
  can(role: string, permission: StaffPermission): boolean {
    return isStaffRole(role) && hasPermission(role, permission);
  }
}
