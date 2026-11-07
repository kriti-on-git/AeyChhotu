import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

/* REAL-POSTGRES checks for the Table module's repository and service.

   Run only when TEST_DATABASE_URL points at a database with the project
   schema applied (npm run db:setup):

       TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/aeychhotu_test npm test

   Skipped otherwise, so the default unit run stays hermetic. Each test owns
   one uniquely-coded table and removes it (and its rows) afterwards. */

import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { createReadTokenIssuer } from "../src/modules/table/table.read-token.js";
import { ParticipantTokenStore } from "../src/modules/table/table.participant-tokens.js";
import { TableRepository } from "../src/modules/table/table.repository.js";
import { TableService } from "../src/modules/table/table.service.js";
import type { SchemaPresence } from "../src/modules/table/table.types.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres table checks skipped";

function uniqueCode(): string {
  return `t${randomUUID().replace(/[^a-z0-9]/g, "").slice(0, 10)}`;
}

async function withHarness<T>(
  fn: (harness: {
    manager: DatabaseManager;
    repository: TableRepository;
    service: TableService;
    tableId: string;
    code: string;
  }) => Promise<T>,
): Promise<T> {
  const manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));

  const code = uniqueCode();
  const inserted = await manager.query<{ id: string }>(
    "INSERT INTO restaurant_tables (code, name, status) VALUES ($1, $2, 'empty') RETURNING id",
    [code, `Integration ${code}`],
  );
  const tableId = inserted.rows[0]?.id;
  assert.ok(tableId);

  const repository = new TableRepository(manager);
  const service = new TableService({
    repository,
    participants: new ParticipantTokenStore(manager),
    assistantKey: null,
    issueReadToken: createReadTokenIssuer(null),
  });

  try {
    return await fn({ manager, repository, service, tableId, code });
  } finally {
    await manager.query("DELETE FROM cart_items WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE table_id = $1)", [tableId]);
    await manager.query("DELETE FROM orders WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM table_members WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM table_device_presence WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM restaurant_tables WHERE id = $1", [tableId]);
    await manager.shutdown();
  }
}

describe("TableRepository — real Postgres", { skip: skipReason }, () => {
  it("reports the table schema objects as present", async () => {
    await withHarness(async ({ repository }) => {
      const schema: SchemaPresence = await repository.schemaObjects();
      assert.deepEqual(schema.missing, []);
      assert.deepEqual(schema.present, [
        "restaurant_tables",
        "table_members",
        "table_device_presence",
      ]);
    });
  });

  it("persists a session, a roster entry and a heartbeat", async () => {
    await withHarness(async ({ service, repository, code }) => {
      const granted = await service.initializeSession(code, {
        member: { user_id: "integration-u1", name: "Asha" },
      });
      assert.equal(granted.status, "active");
      if (granted.status !== "active") return;

      const stored = await repository.findSessionByCode(code);
      assert.equal(stored?.status, "active");
      assert.equal(stored?.session_pin, granted.session_pin);
      assert.equal(stored?.session_secret, granted.session_secret);
      assert.equal(stored?.failed_pin_attempts, 0);

      const token = granted.participant_token;
      assert.ok(token);
      assert.deepEqual(
        (await service.listTableMembers(code, token)).map((member) => member.name),
        ["Asha"],
      );

      await service.recordHeartbeat(code, token, "integration-device");
      const state = await service.getTableState(code);
      assert.equal(state.active_devices, 1);
      assert.equal(state.active_devices, 1);
    });
  });

  it("serializes PIN attempts inside the transaction and unlocks with the pass", async () => {
    await withHarness(async ({ service, code }) => {
      const granted = await service.initializeSession(code, {
        member: { user_id: "integration-u1", name: "Asha" },
      });
      assert.equal(granted.status, "active");
      if (granted.status !== "active") return;

      const wrongPin = granted.session_pin === "00" ? "01" : "00";
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await assert.rejects(() =>
          service.joinWithPin({ table_token: code, pin: wrongPin }),
        );
      }

      const member = await service.joinWithPass({
        table_token: code,
        secret: granted.session_secret,
        member: { user_id: "integration-u2", name: "Ravi" },
      });
      assert.equal(member.status, "active");
      assert.deepEqual(
        (await service.listTableMembers(code, member.participant_token!))
          .map((entry) => entry.name)
          .sort(),
        ["Asha", "Ravi"],
      );
    });
  });

  it("releases only when paid, with no open ticket and no live device", async () => {
    await withHarness(async ({ service, manager, tableId, code }) => {
      const granted = await service.initializeSession(code, {
        member: { user_id: "integration-u1", name: "Asha" },
      });
      assert.equal(granted.status, "active");

      await manager.query(
        "UPDATE restaurant_tables SET bill_status = 'paid', bill_paid_at = now() WHERE id = $1",
        [tableId],
      );
      const token = granted.participant_token;
      assert.ok(token);
      await service.recordHeartbeat(code, token, "integration-device");

      const held = await service.checkAndAutoReleaseTable(tableId);
      assert.equal(held.released, false);

      // Removing the last device is itself a release attempt; the table is
      // empty afterwards, so a second explicit check must report nothing to do.
      const released = await service.removeHeartbeat(code, token, "integration-device");
      assert.equal(released.released, true);
      assert.equal((await service.checkAndAutoReleaseTable(tableId)).released, false);

      const state = await service.getTableState(code);
      assert.equal(state.status, "empty");
      await assert.rejects(() => service.listTableMembers(code, token));
    });
  });

  it("clears a seating, and the next initialize mints fresh credentials", async () => {
    await withHarness(async ({ service, code, tableId, manager }) => {
      const first = await service.initializeSession(code, {
        member: { user_id: "integration-u1", name: "Asha" },
      });
      assert.equal(first.status, "active");
      if (first.status !== "active") return;

      await manager.query(
        "UPDATE restaurant_tables SET bill_status = 'paid', bill_paid_at = now() WHERE id = $1",
        [tableId],
      );
      const cleared = await service.clearTableSession(tableId, { allowUnpaid: false });
      assert.equal(cleared.outcome, "cleared");

      assert.equal((await service.getTableState(code)).status, "empty");
      await assert.rejects(() =>
        service.listTableMembers(code, first.participant_token!),
      );

      const second = await service.initializeSession(code, {
        member: { user_id: "integration-u2", name: "Ravi" },
      });
      assert.equal(second.status, "active");
      if (second.status !== "active") return;
      assert.notEqual(second.session_secret, first.session_secret);
      assert.deepEqual(
        (await service.listTableMembers(code, second.participant_token!)).map(
          (member) => member.name,
        ),
        ["Ravi"],
      );
    });
  });

  it("never lets a participant claim, refresh or remove another's presence", async () => {
    await withHarness(async ({ service, manager, tableId, code }) => {
      const first = await service.initializeSession(code, {
        member: { user_id: "presence-a", name: "Asha" },
      });
      assert.equal(first.status, "active");
      if (first.status !== "active") return;
      const firstToken = first.participant_token;
      assert.ok(firstToken);

      const second = await service.joinWithPin({
        table_token: code,
        pin: first.session_pin,
        member: { user_id: "presence-b", name: "Ravi" },
      });
      assert.equal(second.status, "active");
      const secondToken = second.participant_token;
      assert.ok(secondToken);

      await service.recordHeartbeat(code, secondToken, "device-b");
      const owned = await manager.query<{ participant_id: string }>(
        "SELECT participant_id FROM table_device_presence WHERE table_id = $1 AND device_id = $2",
        [tableId, "device-b"],
      );
      assert.equal(owned.rows[0]?.participant_id, second.participant_id);

      /* A knows B's device id but must not refresh it. */
      await assert.rejects(
        () => service.recordHeartbeat(code, firstToken, "device-b"),
        (err: unknown) => (err as { code?: string }).code === "PRESENCE_NOT_OWNED",
      );
      await service.removeHeartbeat(code, firstToken, "device-b");
      assert.equal(
        (await manager.query("SELECT id FROM table_device_presence WHERE table_id = $1", [tableId]))
          .rowCount,
        1,
        "A's removal must not delete B's row",
      );

      /* An unowned legacy row is not claimable or removable by either guest. */
      await manager.query(
        "INSERT INTO table_device_presence (table_id, device_id) VALUES ($1, 'legacy-device')",
        [tableId],
      );
      for (const token of [firstToken, secondToken]) {
        await assert.rejects(
          () => service.recordHeartbeat(code, token, "legacy-device"),
          (err: unknown) => (err as { code?: string }).code === "PRESENCE_NOT_OWNED",
        );
        await service.removeHeartbeat(code, token, "legacy-device");
      }
      const legacy = await manager.query<{ participant_id: string | null }>(
        "SELECT participant_id FROM table_device_presence WHERE table_id = $1 AND device_id = 'legacy-device'",
        [tableId],
      );
      assert.equal(legacy.rowCount, 1);
      assert.equal(legacy.rows[0]?.participant_id, null);
    });
  });
});
