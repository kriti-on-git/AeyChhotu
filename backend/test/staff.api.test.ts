import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

/* Staff HTTP contract.

   A real Express app boots with a real StaffService over a repository double,
   so the login envelopes, cookie flags, identity, permission gate and
   management payloads are exercised end to end without SQL. Environment
   defaults are installed BEFORE the app/config module is imported. */

process.env.NODE_ENV = "test";
process.env.PORT = "4000";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.STAFF_PIN = "1234";
process.env.ADMIN_PIN = "998877";
process.env.KDS_TOKEN_SECRET = "staff-api-test-secret";

const { createApp } = await import("../src/app.js");
const { env } = await import("../src/config/env.js");
const { AppError } = await import("../src/errors/app-error.js");
const { signToken } = await import("../src/lib/jwt.js");
const { StaffService } = await import("../src/modules/staff/staff.service.js");
const typeOnly = await import("../src/modules/staff/staff.types.js");

const KITCHEN_ID = "7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b";

type TerminalRow = import("../src/modules/staff/staff.types.js").StaffTerminalRow;
type CreateStaffInput = import("../src/modules/staff/staff.types.js").CreateStaffInput;
type UpdateStaffInput = import("../src/modules/staff/staff.types.js").UpdateStaffInput;

class FakeStaffRepository {
  rows: TerminalRow[] = [
    {
      id: KITCHEN_ID,
      device_label: "Kitchen KDS",
      role: "kitchen",
      is_active: true,
      pin_env_var: "STAFF_PIN",
      created_at: new Date("2026-01-01T00:00:00.000Z"),
    },
  ];

  async findTerminal(staffId: string): Promise<TerminalRow | null> {
    return this.rows.find((row) => row.id === staffId) ?? null;
  }

  async findActiveByRole(role: "kitchen" | "floor"): Promise<TerminalRow | null> {
    return this.rows.find((row) => row.is_active && row.role === role) ?? null;
  }

  async listTerminals(): Promise<TerminalRow[]> {
    return [...this.rows];
  }

  async createTerminal(input: Required<CreateStaffInput>): Promise<TerminalRow | null> {
    const row: TerminalRow = {
      id: randomUUID(),
      device_label: input.device_label,
      role: input.role,
      is_active: true,
      pin_env_var: input.pin_env_var,
      created_at: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async updateTerminal(
    staffId: string,
    input: UpdateStaffInput,
  ): Promise<TerminalRow | null> {
    const row = this.rows.find((candidate) => candidate.id === staffId);
    if (!row) return null;
    if (input.device_label !== undefined) row.device_label = input.device_label;
    if (input.role !== undefined) row.role = input.role;
    if (input.is_active !== undefined) row.is_active = input.is_active;
    if (input.pin_env_var !== undefined) row.pin_env_var = input.pin_env_var;
    return row;
  }

  async schemaObjects() {
    return { present: ["staff_terminals"], missing: [] };
  }
}

let server: import("node:http").Server;
let baseUrl = "";
let repository: FakeStaffRepository;
let staff: InstanceType<typeof StaffService>;

before(async () => {
  repository = new FakeStaffRepository();
  staff = new StaffService({
    repository,
    staffPin: env.staffPin,
    adminPin: env.adminPin,
    kdsTokenSecret: env.kdsTokenSecret,
    supabaseJwtSecret: env.supabaseJwtSecret,
  });

  const app = createApp({ staffService: staff });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type CallOptions = {
  body?: unknown;
  token?: string;
  cookie?: string;
};

async function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.cookie = options.cookie;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
    setCookie: response.headers.getSetCookie(),
  };
}

function tokenFor(role: "kitchen" | "admin", overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signToken(
    {
      role,
      terminal_id: role === "admin" ? null : KITCHEN_ID,
      iat: now,
      exp: now + 3600,
      ...overrides,
    } as import("../src/lib/jwt.js").ShiftClaims,
    env.kdsTokenSecret,
  );
}

const expiredToken = signToken(
  {
    role: "kitchen",
    terminal_id: KITCHEN_ID,
    iat: Math.floor(Date.now() / 1000) - 7200,
    exp: Math.floor(Date.now() / 1000) - 3600,
  },
  env.kdsTokenSecret,
);

describe("Staff API — authentication", () => {
  it("POST /api/v1/auth/kds-login preserves the response and cookie contract", async () => {
    const response = await call("POST", "/api/v1/auth/kds-login", {
      body: { pin: env.staffPin },
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.success, true);
    assert.equal(response.json.data.token_type, "Bearer");
    assert.equal(response.json.data.role, "kitchen");
    assert.equal(response.json.data.terminal_id, KITCHEN_ID);
    assert.equal(response.json.data.expires_in, 28800);
    assert.ok(response.json.data.token);

    const cookie = response.setCookie.join(";");
    assert.match(cookie, /kds_token=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Max-Age=28800/);
    assert.match(cookie, /SameSite=Strict/);

    const serialized = JSON.stringify(response.json);
    assert.doesNotMatch(serialized, new RegExp(env.staffPin));
    assert.doesNotMatch(serialized, new RegExp(env.kdsTokenSecret));
  });

  it("rejects an invalid PIN with the unchanged 401", async () => {
    const response = await call("POST", "/api/v1/auth/kds-login", {
      body: { pin: "0000" },
    });
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, "INVALID_PIN");
    assert.equal(response.json.error.message, "Invalid staff access configuration credentials.");
    assert.equal(response.setCookie.length, 0);
  });

  it("rejects a malformed PIN with 400 before authentication", async () => {
    const response = await call("POST", "/api/v1/auth/kds-login", {
      body: { pin: "12" },
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "VALIDATION_ERROR");
    assert.ok(response.json.error.fields.pin);
  });

  it("POST /api/v1/auth/admin-login preserves the manager contract", async () => {
    const response = await call("POST", "/api/v1/auth/admin-login", {
      body: { pin: env.adminPin },
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.data.role, "admin");
    assert.equal(response.json.data.expires_in, 28800);
    assert.match(response.setCookie.join(";"), /admin_token=/);
  });

  it("rejects an invalid manager PIN with INVALID_ADMIN_PIN", async () => {
    const response = await call("POST", "/api/v1/auth/admin-login", {
      body: { pin: "0000" },
    });
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, "INVALID_ADMIN_PIN");
  });
});

describe("Staff API — session lifecycle", () => {
  it("GET /api/v1/auth/me requires a token", async () => {
    const response = await call("GET", "/api/v1/auth/me");
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, "UNAUTHORIZED");
  });

  it("rejects an expired session with 401, not 403", async () => {
    const response = await call("GET", "/api/v1/auth/me", { token: expiredToken });
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, "UNAUTHORIZED");
  });

  it("returns the identity for a header token", async () => {
    const response = await call("GET", "/api/v1/auth/me", {
      token: tokenFor("kitchen"),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.data.authenticated, true);
    assert.equal(response.json.data.role, "kitchen");
    assert.equal(response.json.data.terminal_id, KITCHEN_ID);
    assert.equal(response.json.data.source, "header");
    assert.match(response.json.data.issued_at, /Z$/);
    assert.match(response.json.data.expires_at, /Z$/);
  });

  it("accepts the httpOnly cookie and reports its source", async () => {
    const token = tokenFor("kitchen");
    const response = await call("GET", "/api/v1/auth/me", {
      cookie: `kds_token=${encodeURIComponent(token)}`,
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.data.source, "cookie");
  });

  it("POST /api/v1/auth/logout clears both session cookies", async () => {
    const response = await call("POST", "/api/v1/auth/logout", { body: {} });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { success: true, data: { logged_out: true } });

    const cookies = response.setCookie.join("\n");
    assert.match(cookies, /kds_token=;.*Max-Age=0/);
    assert.match(cookies, /admin_token=;.*Max-Age=0/);
  });
});

describe("Staff API — authorization", () => {
  it("GET /api/v1/staff requires a token", async () => {
    const response = await call("GET", "/api/v1/staff");
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, "UNAUTHORIZED");
  });

  it("refuses a kitchen session with 403 FORBIDDEN", async () => {
    const response = await call("GET", "/api/v1/staff", {
      token: tokenFor("kitchen"),
    });
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, "FORBIDDEN");
  });

  it("allows an admin session and exposes no credentials", async () => {
    const response = await call("GET", "/api/v1/staff", {
      token: tokenFor("admin"),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.data.count, 1);
    assert.equal(response.json.data.staff[0].staff_id, KITCHEN_ID);
    assert.equal(response.json.data.staff[0].pin_env_var, "STAFF_PIN");

    const serialized = JSON.stringify(response.json);
    assert.doesNotMatch(serialized, new RegExp(env.adminPin));
    assert.doesNotMatch(serialized, new RegExp(env.staffPin));
    assert.equal("pin" in response.json.data.staff[0], false);
  });

  it("returns 403 for a valid token with an unknown role", async () => {
    const response = await call("GET", "/api/v1/staff", {
      token: tokenFor("auditor" as never),
    });
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, "FORBIDDEN");
  });
});

describe("Staff API — management", () => {
  const admin = () => tokenFor("admin");

  it("creates a floor terminal and validates the role server-side", async () => {
    const created = await call("POST", "/api/v1/staff", {
      token: admin(),
      body: { device_label: "Waiter phone", role: "floor", pin_env_var: "FLOOR_PIN" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.data.role, "floor");
    assert.equal(created.json.data.is_active, true);
    assert.equal(created.json.data.pin_env_var, "FLOOR_PIN");

    const refused = await call("POST", "/api/v1/staff", {
      token: admin(),
      body: { role: "admin" },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error.code, "VALIDATION_ERROR");
  });

  it("updates the active state and trims the label", async () => {
    const response = await call("PATCH", `/api/v1/staff/${KITCHEN_ID}`, {
      token: admin(),
      body: { device_label: "  Pass KDS  ", is_active: false },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.data.device_label, "Pass KDS");
    assert.equal(response.json.data.is_active, false);
    assert.equal(repository.rows[0]?.is_active, false);
  });

  it("returns 404 for an unknown terminal and 400 for an invalid id", async () => {
    const missing = await call("PATCH", `/api/v1/staff/${randomUUID()}`, {
      token: admin(),
      body: { is_active: true },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "STAFF_NOT_FOUND");

    const invalid = await call("PATCH", "/api/v1/staff/not-a-uuid", {
      token: admin(),
      body: { is_active: true },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, "VALIDATION_ERROR");
  });

  it("requires at least one update field", async () => {
    const response = await call("PATCH", `/api/v1/staff/${KITCHEN_ID}`, {
      token: admin(),
      body: {},
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "VALIDATION_ERROR");
  });
});

// The dynamic type import exists only to keep the module's runtime contracts
// in this file's type graph; referencing it prevents an unused-import error.
void typeOnly;
void AppError;
