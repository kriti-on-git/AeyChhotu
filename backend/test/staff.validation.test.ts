import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

/* Staff request contracts: the login bodies the terminals already send, the
   role vocabulary, and the management payloads. The login schemas are also
   re-exported by validation/schemas.ts; that path is asserted explicitly so
   moving ownership cannot silently change the accepted shape. */

import {
  adminLoginSchema,
  createStaffSchema,
  kdsLoginSchema,
  staffParamsSchema,
  updateStaffSchema,
} from "../src/modules/staff/staff.validation.js";
import {
  adminLoginSchema as reExportedAdminLogin,
  kdsLoginSchema as reExportedKdsLogin,
} from "../src/validation/schemas.js";

describe("staff login validation", () => {
  it("keeps the deployed kds-login shape and re-export", () => {
    assert.equal(reExportedKdsLogin, kdsLoginSchema);

    const parsed = kdsLoginSchema.parse({ pin: "1234", surface: "floor" });
    assert.deepEqual(parsed, { pin: "1234", surface: "floor" });
    assert.equal(kdsLoginSchema.parse({ pin: "123456" }).surface, undefined);
    assert.equal("extra" in kdsLoginSchema.parse({ pin: "1234", extra: true }), false);
  });

  it("rejects short, long and non-numeric PINs", () => {
    for (const pin of ["123", "1234567", "12a4", "", " 1234"]) {
      assert.equal(kdsLoginSchema.safeParse({ pin }).success, false, pin);
    }
    assert.equal(kdsLoginSchema.safeParse({}).success, false);
  });

  it("keeps admin-login identical apart from the surface field", () => {
    assert.equal(reExportedAdminLogin, adminLoginSchema);
    assert.deepEqual(adminLoginSchema.parse({ pin: "998877" }), { pin: "998877" });
    assert.equal(adminLoginSchema.safeParse({ pin: "998877", surface: "kitchen" }).success, true);
    assert.equal(adminLoginSchema.safeParse({ pin: "998" }).success, false);
  });
});

describe("staff management validation", () => {
  it("accepts kitchen and floor terminals with defaults", () => {
    const parsed = createStaffSchema.parse({ role: "floor" });
    assert.equal(parsed.device_label, "");
    assert.equal(parsed.pin_env_var, "STAFF_PIN");

    const kitchen = createStaffSchema.parse({
      role: "kitchen",
      device_label: "  Grill KDS  ",
      pin_env_var: "KITCHEN_PIN",
    });
    assert.equal(kitchen.device_label, "Grill KDS");
    assert.equal(kitchen.pin_env_var, "KITCHEN_PIN");
  });

  it("refuses to mint an admin terminal", () => {
    for (const role of ["admin", "manager", "owner", ""]) {
      assert.equal(createStaffSchema.safeParse({ role }).success, false, role);
    }
  });

  it("refuses a pin_env_var that is a value instead of a variable name", () => {
    for (const name of ["staff_pin", "1234", "STAFF-PIN", "1STAFF", "A".repeat(65)]) {
      assert.equal(
        createStaffSchema.safeParse({ role: "kitchen", pin_env_var: name }).success,
        false,
        name,
      );
    }
  });

  it("caps device labels at 80 characters", () => {
    const label = "x".repeat(81);
    assert.equal(createStaffSchema.safeParse({ role: "kitchen", device_label: label }).success, false);
    assert.equal(updateStaffSchema.safeParse({ device_label: label }).success, false);
  });

  it("requires at least one update field and keeps false meaningful", () => {
    assert.equal(updateStaffSchema.safeParse({}).success, false);
    assert.equal(updateStaffSchema.safeParse({ is_active: false }).success, true);
    assert.equal(updateStaffSchema.safeParse({ role: "floor" }).success, true);
    assert.equal(updateStaffSchema.safeParse({ role: "admin" }).success, false);
  });

  it("validates the staff id as a UUID", () => {
    assert.equal(staffParamsSchema.safeParse({ staff_id: randomUUID() }).success, true);
    assert.equal(staffParamsSchema.safeParse({ staff_id: "not-a-uuid" }).success, false);
  });
});
