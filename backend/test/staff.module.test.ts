import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Staff lifecycle component: read-only schema probes, an honest dependency
   list and no authentication or write during a health check. */

import type { DbPort } from "../src/infrastructure/database/DatabaseManager.js";
import { createStaffModule } from "../src/modules/staff/staff.module.js";

function fakeDb(present: boolean, roleConstraint = present) {
  const statements: string[] = [];
  const db = {
    async query(text: string) {
      statements.push(text);
      return {
        rows: [{ terminals: present, role_constraint: roleConstraint }],
        rowCount: 1,
      };
    },
  } as unknown as DbPort;
  return { db, statements };
}

const options = {
  staffPin: "1234",
  adminPin: "998877",
  kdsTokenSecret: "lifecycle-test-secret",
  supabaseJwtSecret: null,
};

describe("Staff module lifecycle", () => {
  it("reports healthy when the terminal table and role constraint exist", async () => {
    const { db } = fakeDb(true);
    const module = createStaffModule({ db, ...options });

    const health = await module.health();
    assert.equal(health.state, "HEALTHY");
    assert.deepEqual(health.details, {
      present: ["staff_terminals", "staff_terminals.role_check"],
      missing: [],
    });

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, true);
    assert.equal(module.name, "staff");
    assert.deepEqual(module.dependencies, ["database"]);
    assert.ok(module.service);
  });

  it("names every missing object and stays unhealthy", async () => {
    const { db } = fakeDb(false);
    const module = createStaffModule({ db, ...options });

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /staff_terminals/);
    assert.match(health.message ?? "", /role_check/);
    assert.equal((await module.selfTest()).ok, false);
  });

  it("reports a missing role constraint specifically", async () => {
    const { db } = fakeDb(true, false);
    const module = createStaffModule({ db, ...options });

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /role_check/);
    assert.doesNotMatch(health.message ?? "", /^Missing staff objects: staff_terminals\.$/);
  });

  it("runs only read-only catalog checks and never logs in", async () => {
    const { db, statements } = fakeDb(true);
    const module = createStaffModule({ db, ...options });

    await module.health();
    await module.selfTest();

    assert.ok(statements.length >= 2);
    for (const sql of statements) {
      assert.match(sql, /to_regclass|pg_constraint/);
      assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/i);
    }
    assert.deepEqual(module.diagnostics(), {
      module: "staff",
      repository: "StaffRepository",
      schema: {
        present: ["staff_terminals", "staff_terminals.role_check"],
        missing: [],
      },
    });
  });

  it("reports unhealthy instead of throwing when the probe fails", async () => {
    const db = {
      async query() {
        throw new Error("connection refused");
      },
    } as unknown as DbPort;

    const module = createStaffModule({ db, ...options });
    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /connection refused/);
    assert.equal((await module.selfTest()).ok, false);
  });
});
