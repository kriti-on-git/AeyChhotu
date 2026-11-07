import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

/* REAL-POSTGRES checks for the Staff repository. Gated on TEST_DATABASE_URL,
   which must point at a database with `npm run db:setup` applied. Each test
   creates uniquely labelled terminals and deletes them afterwards. */

import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { StaffRepository } from "../src/modules/staff/staff.repository.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres staff checks skipped";

let manager: DatabaseManager;
let repository: StaffRepository;
const createdIds: string[] = [];

before(async () => {
  if (!TEST_DATABASE_URL) return;
  manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));
  repository = new StaffRepository(manager);
});

after(async () => {
  if (!TEST_DATABASE_URL) return;
  if (createdIds.length > 0) {
    await manager.query("DELETE FROM staff_terminals WHERE id = ANY($1::uuid[])", [createdIds]);
  }
  await manager.shutdown();
});

function label(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

describe("StaffRepository — real Postgres", { skip: skipReason }, () => {
  it("reports the terminal table and role constraint as present", async () => {
    const schema = await repository.schemaObjects();
    assert.deepEqual(schema.missing, []);
    assert.deepEqual(schema.present, [
      "staff_terminals",
      "staff_terminals.role_check",
    ]);
  });

  it("lists the seeded terminal and binds the active kitchen by role", async () => {
    const seeded = await repository.findActiveByRole("kitchen");
    assert.ok(seeded);
    assert.equal(seeded.role, "kitchen");
    assert.equal(seeded.is_active, true);

    const all = await repository.listTerminals();
    assert.ok(all.some((row) => row.id === seeded.id));
    for (const row of all) {
      assert.equal("pin" in row, false);
      assert.equal("pin_hash" in row, false);
    }
  });

  it("inserts, reads and deactivates a floor terminal", async () => {
    const deviceLabel = label("Floor phone");
    const created = await repository.createTerminal({
      device_label: deviceLabel,
      role: "floor",
      pin_env_var: "STAFF_PIN",
    });
    assert.ok(created);
    createdIds.push(created.id);

    assert.equal(created.device_label, deviceLabel);
    assert.equal(created.role, "floor");
    assert.equal(created.is_active, true);
    assert.equal(created.pin_env_var, "STAFF_PIN");
    assert.ok(created.created_at instanceof Date);

    const found = await repository.findTerminal(created.id);
    assert.deepEqual(found, created);

    const activeFloor = await repository.findActiveByRole("floor");
    assert.ok(activeFloor);
    // It may not be ours if the fixture already has an older active floor,
    // but ours must be selectable until it is deactivated.
    const updated = await repository.updateTerminal(created.id, {
      device_label: `  ${deviceLabel} pass  `.trim(),
      is_active: false,
      pin_env_var: "FLOOR_PIN",
    });
    assert.ok(updated);
    assert.equal(updated.device_label, `${deviceLabel} pass`);
    assert.equal(updated.is_active, false);
    assert.equal(updated.pin_env_var, "FLOOR_PIN");
    assert.equal(updated.role, "floor");

    const after = await repository.findActiveByRole("floor");
    assert.notEqual(after?.id, created.id);
  });

  it("returns null for an unknown terminal", async () => {
    assert.equal(await repository.findTerminal(randomUUID()), null);
    assert.equal(
      await repository.updateTerminal(randomUUID(), { is_active: true }),
      null,
    );
  });
});
