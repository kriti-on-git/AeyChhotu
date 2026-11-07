import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

/* Staff service: identity, authentication, session shape, role policy and
   management. No database and no HTTP — a repository double keeps the rules
   honest and makes "invalid credentials never reach the repository" and
   "admin is not a terminal role" explicit assertions. */

import { AppError } from "../src/errors/app-error.js";
import { verifyToken } from "../src/lib/jwt.js";
import { hasPermission, permissionsFor } from "../src/modules/staff/staff.permissions.js";
import { StaffService, pinMatches } from "../src/modules/staff/staff.service.js";
import type {
  CreateStaffInput,
  StaffRepositoryPort,
  StaffSchemaPresence,
  StaffTerminalRow,
  StaffTerminalRole,
  UpdateStaffInput,
} from "../src/modules/staff/staff.types.js";

const KITCHEN_ID = "7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b";
const SECRET = "staff-service-test-secret";
const STAFF_PIN = "1234";
const ADMIN_PIN = "998877";

function terminal(overrides: Partial<StaffTerminalRow> = {}): StaffTerminalRow {
  return {
    id: KITCHEN_ID,
    device_label: "Kitchen KDS",
    role: "kitchen",
    is_active: true,
    pin_env_var: "STAFF_PIN",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

class FakeStaffRepository implements StaffRepositoryPort {
  rows: StaffTerminalRow[] = [terminal()];
  activeLookups = 0;
  createCalls: Required<CreateStaffInput>[] = [];

  async findTerminal(staffId: string): Promise<StaffTerminalRow | null> {
    return this.rows.find((row) => row.id === staffId) ?? null;
  }

  async findActiveByRole(role: StaffTerminalRole): Promise<StaffTerminalRow | null> {
    this.activeLookups += 1;
    return this.rows.find((row) => row.is_active && row.role === role) ?? null;
  }

  async listTerminals(): Promise<StaffTerminalRow[]> {
    return [...this.rows];
  }

  async createTerminal(input: Required<CreateStaffInput>): Promise<StaffTerminalRow | null> {
    this.createCalls.push(input);
    const row = terminal({
      id: randomUUID(),
      device_label: input.device_label,
      role: input.role,
      pin_env_var: input.pin_env_var,
      created_at: new Date("2026-02-01T00:00:00.000Z"),
    });
    this.rows.push(row);
    return row;
  }

  async updateTerminal(
    staffId: string,
    input: UpdateStaffInput,
  ): Promise<StaffTerminalRow | null> {
    const row = this.rows.find((candidate) => candidate.id === staffId);
    if (!row) return null;
    if (input.device_label !== undefined) row.device_label = input.device_label;
    if (input.role !== undefined) row.role = input.role;
    if (input.is_active !== undefined) row.is_active = input.is_active;
    if (input.pin_env_var !== undefined) row.pin_env_var = input.pin_env_var;
    return row;
  }

  async schemaObjects(): Promise<StaffSchemaPresence> {
    return { present: ["staff_terminals"], missing: [] };
  }
}

function service(
  repo = new FakeStaffRepository(),
  overrides: Partial<{ staffPin: string; adminPin: string; supabaseJwtSecret: string | null }> = {},
): StaffService {
  return new StaffService({
    repository: repo,
    staffPin: overrides.staffPin ?? STAFF_PIN,
    adminPin: overrides.adminPin ?? ADMIN_PIN,
    kdsTokenSecret: SECRET,
    supabaseJwtSecret:
      overrides.supabaseJwtSecret === undefined ? null : overrides.supabaseJwtSecret,
  });
}

async function expectAppError(promise: Promise<unknown>, code: string, status: number) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError ${code}, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    return err;
  }
  assert.fail(`expected AppError ${code}, but the call resolved`);
}

/* ------------------------------------------------------------ PIN compare */

describe("staff PIN comparison", () => {
  it("accepts only an exact match and never throws on different lengths", () => {
    assert.equal(pinMatches("1234", "1234"), true);
    assert.equal(pinMatches("1234", "12345"), false);
    assert.equal(pinMatches("12345", "1234"), false);
    assert.equal(pinMatches("", "1234"), false);
  });
});

/* --------------------------------------------------------- authentication */

describe("staff shift authentication", () => {
  it("issues the existing kitchen claim bound to the first active terminal", async () => {
    const repo = new FakeStaffRepository();
    repo.rows = [terminal({ is_active: false }), terminal({ id: "active-kitchen" })];
    const result = await service(repo).authenticateShift(STAFF_PIN);

    assert.equal(result.token_type, "Bearer");
    assert.equal(result.role, "kitchen");
    assert.equal(result.terminal_id, "active-kitchen");
    assert.equal(result.expires_in, 8 * 60 * 60);
    assert.equal(result.realtime_token, null);
    assert.equal(result.message, "Shift active · Audio armed.");

    const claims = verifyToken(result.token, SECRET);
    assert.ok(claims);
    assert.equal(claims.role, "kitchen");
    assert.equal(claims.terminal_id, "active-kitchen");
    assert.equal(claims.exp - claims.iat, 8 * 60 * 60);
  });

  it("keeps terminal_id nullable when no active kitchen exists", async () => {
    const repo = new FakeStaffRepository();
    repo.rows = [];
    const result = await service(repo).authenticateShift(STAFF_PIN);
    assert.equal(result.terminal_id, null);
    assert.equal(verifyToken(result.token, SECRET)?.terminal_id, null);
  });

  it("issues a Supabase read token only when a Supabase secret is configured", async () => {
    const repo = new FakeStaffRepository();
    const without = await service(repo).authenticateShift(STAFF_PIN);
    assert.equal(without.realtime_token, null);

    const withSecret = await service(repo, { supabaseJwtSecret: "supabase-secret" })
      .authenticateShift(STAFF_PIN);
    assert.ok(withSecret.realtime_token);
    assert.notEqual(withSecret.realtime_token, withSecret.token);
  });

  it("rejects a wrong PIN with the unchanged 401 and never touches the repository", async () => {
    const repo = new FakeStaffRepository();
    const err = await expectAppError(
      service(repo).authenticateShift("9999"),
      "INVALID_PIN",
      401,
    );
    assert.equal(err.message, "Invalid staff access configuration credentials.");
    assert.equal(repo.activeLookups, 0);
  });

  it("never echoes the configured PIN or signing secret", async () => {
    const result = await service().authenticateShift(STAFF_PIN);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(STAFF_PIN));
    assert.doesNotMatch(serialized, new RegExp(SECRET));
    assert.equal("pin" in result, false);
  });
});

describe("staff admin authentication", () => {
  it("issues the unchanged admin claim with no terminal", async () => {
    const result = await service().authenticateAdmin(ADMIN_PIN);
    assert.equal(result.role, "admin");
    assert.equal(result.token_type, "Bearer");
    assert.equal(result.expires_in, 8 * 60 * 60);
    assert.equal(result.message, "Manager console unlocked.");

    const claims = verifyToken(result.token, SECRET);
    assert.ok(claims);
    assert.equal(claims.role, "admin");
    assert.equal(claims.terminal_id, null);
    assert.equal(claims.exp - claims.iat, 8 * 60 * 60);
  });

  it("rejects a wrong manager PIN with the unchanged 401", async () => {
    const err = await expectAppError(
      service().authenticateAdmin(STAFF_PIN),
      "INVALID_ADMIN_PIN",
      401,
    );
    assert.equal(err.message, "That manager PIN is not correct.");
  });

  it("does not accept the staff PIN at the admin wall or vice versa", async () => {
    await expectAppError(service().authenticateAdmin(STAFF_PIN), "INVALID_ADMIN_PIN", 401);
    await expectAppError(service().authenticateShift(ADMIN_PIN), "INVALID_PIN", 401);
  });
});

/* --------------------------------------------------------------- identity */

describe("staff session identity", () => {
  it("describes the claims without extending or altering the session", () => {
    const claims = { role: "kitchen", terminal_id: KITCHEN_ID, iat: 1_767_225_600, exp: 1_767_254_400 };
    const identity = service().sessionIdentity(claims, "cookie");

    assert.deepEqual(identity, {
      authenticated: true,
      role: "kitchen",
      terminal_id: KITCHEN_ID,
      issued_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-01T08:00:00Z",
      source: "cookie",
    });
  });

  it("reports an unknown role verbatim; authorization stays a 403 elsewhere", () => {
    const identity = service().sessionIdentity(
      { role: "auditor", terminal_id: null, iat: 1_767_225_600, exp: 1_767_254_400 },
      "header",
    );
    assert.equal(identity.role, "auditor");
    assert.equal(identity.source, "header");
  });
});

/* ----------------------------------------------------------- authorization */

describe("staff permission matrix", () => {
  it("grants kitchen the board and availability but not staff management", () => {
    assert.equal(hasPermission("kitchen", "kitchen.board"), true);
    assert.equal(hasPermission("kitchen", "menu.availability"), true);
    assert.equal(hasPermission("kitchen", "billing.settle"), true);
    assert.equal(hasPermission("kitchen", "floor.view"), false);
    assert.equal(hasPermission("kitchen", "admin.console"), false);
    assert.equal(hasPermission("kitchen", "staff.manage"), false);
  });

  it("grants floor settlement but not kitchen actions", () => {
    assert.equal(hasPermission("floor", "floor.view"), true);
    assert.equal(hasPermission("floor", "billing.settle"), true);
    assert.equal(hasPermission("floor", "kitchen.board"), false);
    assert.equal(hasPermission("floor", "menu.availability"), false);
    assert.equal(hasPermission("floor", "staff.manage"), false);
  });

  it("gives admin every permission and unknown roles none", () => {
    assert.deepEqual(permissionsFor("admin"), [
      "shift.identity",
      "kitchen.board",
      "floor.view",
      "menu.availability",
      "billing.settle",
      "admin.console",
      "staff.manage",
    ]);
    assert.deepEqual(permissionsFor("auditor"), []);
    assert.equal(hasPermission("auditor", "floor.view"), false);
    assert.equal(hasPermission("", "shift.identity"), false);
  });

  it("exposes the same decision through the service port", () => {
    const staff = service();
    assert.equal(staff.hasPermission("admin", "staff.manage"), true);
    assert.equal(staff.hasPermission("kitchen", "staff.manage"), false);
  });
});

/* ------------------------------------------------------------- management */

describe("staff identity management", () => {
  it("lists terminals without any credential material", async () => {
    const staff = await service().listStaff();
    assert.equal(staff.length, 1);
    assert.deepEqual(staff[0], {
      staff_id: KITCHEN_ID,
      device_label: "Kitchen KDS",
      role: "kitchen",
      is_active: true,
      pin_env_var: "STAFF_PIN",
      created_at: "2026-01-01T00:00:00Z",
    });
    assert.doesNotMatch(JSON.stringify(staff), /998877|1234/);
  });

  it("creates a floor terminal with a variable name, never a value", async () => {
    const repo = new FakeStaffRepository();
    const created = await service(repo).createStaff({
      role: "floor",
      device_label: "  Waiter phone  ",
      pin_env_var: "FLOOR_PIN",
    });

    assert.equal(created.role, "floor");
    assert.equal(created.device_label, "Waiter phone");
    assert.equal(created.pin_env_var, "FLOOR_PIN");
    assert.equal(repo.createCalls[0]?.pin_env_var, "FLOOR_PIN");
  });

  it("rejects an admin role at the service boundary", async () => {
    const repo = new FakeStaffRepository();
    const err = await expectAppError(
      service(repo).createStaff({ role: "admin" as never }),
      "VALIDATION_ERROR",
      400,
    );
    assert.match(JSON.stringify(err.details), /role/);
    assert.equal(repo.createCalls.length, 0);
  });

  it("rejects a pin_env_var that is not an uppercase variable name", async () => {
    for (const pinEnvVar of ["staff_pin", "1234", "STAFF-PIN"]) {
      await expectAppError(
        service().createStaff({ role: "kitchen", pin_env_var: pinEnvVar }),
        "VALIDATION_ERROR",
        400,
      );
    }
  });

  it("updates label, role and active state and trims the label", async () => {
    const repo = new FakeStaffRepository();
    const updated = await service(repo).updateStaff(KITCHEN_ID, {
      device_label: "  Pass KDS ",
      role: "floor",
      is_active: false,
    });

    assert.equal(updated.device_label, "Pass KDS");
    assert.equal(updated.role, "floor");
    assert.equal(updated.is_active, false);
    assert.equal(repo.rows[0]?.is_active, false);
  });

  it("refuses an admin role on update", async () => {
    await expectAppError(
      service().updateStaff(KITCHEN_ID, { role: "admin" as never }),
      "VALIDATION_ERROR",
      400,
    );
  });

  it("returns 404 for an unknown terminal", async () => {
    const err = await expectAppError(
      service().updateStaff(randomUUID(), { is_active: true }),
      "STAFF_NOT_FOUND",
      404,
    );
    assert.equal(err.message, "Unknown staff terminal.");
  });
});
