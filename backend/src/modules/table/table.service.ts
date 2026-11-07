/* Table module — session, roster, presence and seating lifecycle.

   The service owns every decision; the repository owns every statement. It
   receives its collaborators through the constructor, so a unit test can run
   the whole session protocol against an in-memory repository with no
   Postgres, no Express and no clock patching.

   SECURITY MODEL (unchanged from the pre-module implementation)
     Layer 1 — a 2-digit PIN minted when an empty table is claimed; three
               wrong attempts lock the TABLE.
     Layer 2 — a 20-character pass that only joined devices hold; it unlocks a
               PIN-locked table but is NOT accepted while the keypad works.

   RELEASE MODEL (unchanged): a table is released only when the bill is paid,
   no ticket is pending/preparing/ready, and no device beat in the last 45 s —
   all read under one row lock. */

import { randomInt } from "node:crypto";
import { AppError } from "../../errors/app-error.js";
import { iso } from "../../lib/util.js";
import { NOOP_TABLE_EVENTS, type TableEventPublisher } from "./table.events.js";
import {
  MAX_PIN_ATTEMPTS,
  RELEASE_PRESENCE_WINDOW_SECONDS,
  SCAN_TIME_SKEW_TOLERANCE_MS,
  type ActiveCheckResult,
  type AutoReleaseResult,
  type BillRequestResult,
  type ClearTableConfig,
  type ClearTableResult,
  type GrantedSession,
  type HeartbeatResult,
  type InitializeResult,
  type LockedSession,
  type ReadTokenIssuer,
  type SessionEntryOptions,
  type SessionRow,
  type TableMember,
  type TableMemberInput,
  type TableRecord,
  type TableRepositoryPort,
  type TableServicePort,
  type TableStateResult,
} from "./table.types.js";

const SECRET_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A random '00'–'99'. Leading zeros matter, so this stays a string. */
export function generateSessionPin(): string {
  return String(randomInt(0, 100)).padStart(2, "0");
}

export function generateSessionSecret(length = 20): string {
  let secret = "";
  for (let i = 0; i < length; i += 1) {
    secret += SECRET_ALPHABET.charAt(randomInt(0, SECRET_ALPHABET.length));
  }
  return secret;
}

const SESSION_ENDED_MESSAGE =
  "This table session has ended. Scan the table's QR code to start a new one.";
const PIN_LOCKED_MESSAGE =
  "Table PIN locked after 3 failed attempts. Scan a tablemate's QR pass to unlock and join.";
const STALE_SESSION_MESSAGE =
  "This table was cleared after your page was opened. Scan the table's QR code again.";

/* One expected join outcome. Returning a value (rather than throwing inside
   the transaction) is what lets a WRONG PIN still commit its counter — the
   caller raises the AppError after the increment is durable. */
type PinOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "ended" }
  | { readonly kind: "already_locked"; readonly attempts: number }
  | { readonly kind: "wrong_pin"; readonly attempts: number }
  | { readonly kind: "granted"; readonly row: SessionRow };

type PassOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "ended" }
  | { readonly kind: "pass_requires_pin"; readonly attempts: number }
  | { readonly kind: "invalid_secret" }
  | { readonly kind: "granted"; readonly row: SessionRow };

type InitializeOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "locked"; readonly row: SessionRow }
  | { readonly kind: "granted"; readonly row: SessionRow };

export interface TableServiceDeps {
  readonly repository: TableRepositoryPort;
  /** Supabase read-token issuer; defaults to "no token". */
  readonly issueReadToken?: ReadTokenIssuer;
  /** Gemini key released with a granted session; null hides the assistant. */
  readonly assistantKey?: string | null;
  readonly events?: TableEventPublisher;
}

export class TableService implements TableServicePort {
  private readonly repository: TableRepositoryPort;
  private readonly issueReadToken: ReadTokenIssuer;
  private readonly assistantKey: string | null;
  private readonly events: TableEventPublisher;

  constructor(deps: TableServiceDeps) {
    this.repository = deps.repository;
    this.issueReadToken = deps.issueReadToken ?? (() => null);
    this.assistantKey = deps.assistantKey ?? null;
    this.events = deps.events ?? NOOP_TABLE_EVENTS;
  }

  /* ------------------------------------------------------------- access */

  async requireTable(tableToken: string): Promise<TableRecord> {
    const table = await this.repository.findTableByCode(tableToken);
    if (table === null) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
    }
    return table;
  }

  /* ----------------------------------------------------------- sessions */

  async initializeSession(
    tableToken: string,
    options: SessionEntryOptions = {},
  ): Promise<InitializeResult> {
    const outcome = await this.repository.transaction<InitializeOutcome>(async (tx) => {
      const table = await this.repository.lockSessionByCode(tx, tableToken);
      if (table === null) return { kind: "not_found" };

      this.assertFreshSession(table, options.scan_time);

      if (table.status === "active") {
        // A live table stays the property of the party already seated: no
        // credentials, no roster entry, no read token.
        return { kind: "locked", row: table };
      }

      const pin = generateSessionPin();
      const secret = generateSessionSecret();
      const row = await this.repository.startSession(tx, table.id, pin, secret);
      if (row === null) {
        throw new AppError(500, "INTERNAL_ERROR", "The table session could not be started.");
      }

      await this.repository.upsertMember(tx, row.id, options.member);
      return { kind: "granted", row };
    });

    if (outcome.kind === "not_found") {
      throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
    }
    if (outcome.kind === "locked") return this.lockedSession(outcome.row);

    const granted = this.grantedSession(outcome.row);
    this.events.sessionStarted({ tableId: outcome.row.id, code: outcome.row.code });
    return granted;
  }

  async joinWithPin(
    input: { table_token: string; pin: string } & SessionEntryOptions,
  ): Promise<GrantedSession> {
    const outcome = await this.repository.transaction<PinOutcome>(async (tx) => {
      const table = await this.repository.lockSessionByCode(tx, input.table_token);
      if (table === null) return { kind: "not_found" };

      this.assertFreshSession(table, input.scan_time);

      if (table.status !== "active" || !table.session_pin) return { kind: "ended" };

      if (table.failed_pin_attempts >= MAX_PIN_ATTEMPTS) {
        return { kind: "already_locked", attempts: table.failed_pin_attempts };
      }

      if (table.session_pin !== input.pin) {
        const attempts = await this.repository.incrementPinAttempts(tx, table.id);
        // Committed by returning; the 401/423 is raised below.
        return { kind: "wrong_pin", attempts };
      }

      const row = await this.repository.clearPinAttempts(tx, table.id);
      if (row === null) {
        throw new AppError(500, "INTERNAL_ERROR", "The table session could not be joined.");
      }

      await this.repository.upsertMember(tx, row.id, input.member);
      return { kind: "granted", row };
    });

    switch (outcome.kind) {
      case "not_found":
        throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
      case "ended":
        throw new AppError(403, "SESSION_ENDED", SESSION_ENDED_MESSAGE);
      case "already_locked":
        throw new AppError(423, "TABLE_PIN_LOCKED", PIN_LOCKED_MESSAGE, {
          attempts_remaining: 0,
          failed_attempts: outcome.attempts,
          locked: true,
        });
      case "wrong_pin": {
        if (outcome.attempts >= MAX_PIN_ATTEMPTS) {
          throw new AppError(423, "TABLE_PIN_LOCKED", PIN_LOCKED_MESSAGE, {
            attempts_remaining: 0,
            failed_attempts: outcome.attempts,
            locked: true,
          });
        }

        const remaining = MAX_PIN_ATTEMPTS - outcome.attempts;
        throw new AppError(
          401,
          "INVALID_SESSION_PIN",
          `That PIN is not right. ${remaining} ${remaining === 1 ? "try" : "tries"} left before the table locks.`,
          { attempts_remaining: remaining, failed_attempts: outcome.attempts, locked: false },
        );
      }
      case "granted":
        return this.grantedSession(outcome.row);
    }
  }

  async joinWithPass(
    input: { table_token: string; secret: string } & SessionEntryOptions,
  ): Promise<GrantedSession> {
    const outcome = await this.repository.transaction<PassOutcome>(async (tx) => {
      const table = await this.repository.lockSessionByCode(tx, input.table_token);
      if (table === null) return { kind: "not_found" };

      this.assertFreshSession(table, input.scan_time);

      if (table.status !== "active" || !table.session_secret) return { kind: "ended" };

      /* The pass is the UNLOCK, not a shortcut past the PIN. Checked before
         the secret comparison, so a refused pass cannot probe a guess. */
      if (table.failed_pin_attempts < MAX_PIN_ATTEMPTS) {
        return { kind: "pass_requires_pin", attempts: table.failed_pin_attempts };
      }

      if (table.session_secret !== input.secret) return { kind: "invalid_secret" };

      const row = await this.repository.clearPinAttempts(tx, table.id);
      if (row === null) {
        throw new AppError(500, "INTERNAL_ERROR", "The table session could not be joined.");
      }

      await this.repository.upsertMember(tx, row.id, input.member);
      return { kind: "granted", row };
    });

    switch (outcome.kind) {
      case "not_found":
        throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
      case "ended":
        throw new AppError(403, "SESSION_ENDED", SESSION_ENDED_MESSAGE);
      case "pass_requires_pin": {
        const remaining = MAX_PIN_ATTEMPTS - outcome.attempts;
        throw new AppError(
          403,
          "PASS_REQUIRES_PIN",
          `Enter the two-digit PIN on the table card to join. A tablemate's pass only unlocks a table after ${MAX_PIN_ATTEMPTS} wrong PINs.`,
          { attempts_remaining: remaining, failed_attempts: outcome.attempts },
        );
      }
      case "invalid_secret":
        throw new AppError(
          401,
          "INVALID_SESSION_SECRET",
          "That table pass is not valid for this table. Ask a tablemate to show their pass again.",
        );
      case "granted":
        return this.grantedSession(outcome.row);
    }
  }

  async reconnectSession(
    input: { table_token: string; secret: string } & SessionEntryOptions,
  ): Promise<GrantedSession> {
    const table = await this.requireSessionRow(input.table_token);

    this.assertFreshSession(table, input.scan_time);

    if (table.status !== "active" || !table.session_secret) {
      throw new AppError(403, "SESSION_ENDED", SESSION_ENDED_MESSAGE);
    }
    if (table.session_secret !== input.secret) {
      // Deliberately the same code as a settled table: a stale secret must not
      // reveal that the session is still live.
      throw new AppError(403, "SESSION_ENDED", SESSION_ENDED_MESSAGE);
    }

    // Best-effort: a roster write must never turn a valid refresh into a failure.
    await this.repository
      .upsertMemberBestEffort(table.id, input.member)
      .catch(() => undefined);

    return this.grantedSession(table);
  }

  /* -------------------------------------------------------------- state */

  async getTableState(tableToken: string): Promise<TableStateResult> {
    const row = await this.repository.findTableState(
      tableToken,
      RELEASE_PRESENCE_WINDOW_SECONDS,
    );
    if (row === null) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
    }

    return {
      table_id: row.id,
      code: row.code,
      name: row.name,
      status: row.status === "active" ? "active" : "empty",
      bill_status: row.bill_status,
      bill_requested_at: row.bill_requested_at ? iso(row.bill_requested_at) : null,
      bill_paid_at: row.bill_paid_at ? iso(row.bill_paid_at) : null,
      session_started_at: row.session_started_at ? iso(row.session_started_at) : null,
      active_devices: row.active_devices,
      active_orders: row.active_orders,
    };
  }

  async listTableMembers(tableToken: string): Promise<TableMember[]> {
    const table = await this.requireTable(tableToken);
    const rows = await this.repository.listMembers(table.id);

    return rows.map((row) => ({
      user_id: row.user_id,
      name: row.name,
      joined_at: iso(row.joined_at),
    }));
  }

  async activeCheck(tableToken: string): Promise<ActiveCheckResult> {
    const table = await this.requireTable(tableToken);
    const order = await this.repository.findActiveOrder(table.id);

    if (order === null) {
      return { has_active_order: false, message: "Ready for new order round initialization." };
    }

    return {
      has_active_order: true,
      order_id: order.id,
      status: order.status,
      message: "Order already sent",
    };
  }

  /* --------------------------------------------------------------- bill */

  async requestTableBill(tableToken: string): Promise<BillRequestResult> {
    const table = await this.requireTable(tableToken);
    const updated = await this.repository.requestBill(table.id);

    if (updated !== null) {
      this.events.billRequested({ tableId: updated.id, code: table.code });
      return {
        table_id: updated.id,
        bill_status: updated.bill_status,
        bill_requested_at: updated.bill_requested_at ? iso(updated.bill_requested_at) : null,
      };
    }

    // Idempotent: keep the first request timestamp; never downgrade 'paid'.
    const current = await this.repository.findBill(table.id);
    if (current === null) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
    }

    return {
      table_id: current.id,
      bill_status: current.bill_status,
      bill_requested_at: current.bill_requested_at ? iso(current.bill_requested_at) : null,
    };
  }

  /* ---------------------------------------------------------- presence */

  async recordHeartbeat(tableToken: string, deviceId: string): Promise<HeartbeatResult> {
    const table = await this.requireTable(tableToken);
    const row = await this.repository.recordHeartbeat(table.id, deviceId);

    if (row === null) {
      throw new AppError(500, "INTERNAL_ERROR", "The device heartbeat could not be recorded.");
    }

    return { table_id: table.id, device_id: row.device_id, last_seen: iso(row.last_seen) };
  }

  async removeHeartbeat(
    tableToken: string,
    deviceId: string,
  ): Promise<{ table_id: string; device_id: string; released: boolean }> {
    const table = await this.requireTable(tableToken);
    await this.repository.removePresence(table.id, deviceId);

    const { released } = await this.checkAndAutoReleaseTable(table.id);
    return { table_id: table.id, device_id: deviceId, released };
  }

  /* ----------------------------------------------------------- release */

  async checkAndAutoReleaseTable(tableId: string): Promise<AutoReleaseResult> {
    const released = await this.repository.transaction(async (tx) => {
      const locked = await this.repository.lockTable(tx, tableId);
      if (locked === null) return false;

      const candidate = await this.repository.releaseCandidate(
        tx,
        tableId,
        RELEASE_PRESENCE_WINDOW_SECONDS,
      );
      if (
        candidate === null ||
        candidate.bill_status !== "paid" ||
        candidate.active_orders > 0 ||
        candidate.active_devices > 0
      ) {
        return false;
      }

      await this.repository.clearTableRows(tx, tableId);
      return true;
    });

    if (released) {
      this.events.sessionCleared({ tableId, reason: "auto_release", billStatus: "paid" });
    }

    return { released };
  }

  async clearTableSession(
    tableId: string,
    options: ClearTableConfig,
  ): Promise<ClearTableResult> {
    const result = await this.repository.transaction<ClearTableResult>(async (tx) => {
      const table = await this.repository.lockTable(tx, tableId);
      if (table === null) {
        return { outcome: "not_found", bill_status: null, active_orders: 0, order_count: 0 };
      }

      /* Money owed is scoped to the CURRENT session; a DENIED ticket is not a
         debt. Both counts are taken before any cancellation, so a staff
         override can never erase a debt only a manager may forgive. */
      const counts = await this.repository.countOrders(tx, tableId, table.session_started_at);

      if (counts.active_orders > 0 && options.cancelActiveOrders) {
        await this.repository.cancelActiveOrders(tx, tableId);
      }

      if (counts.active_orders > 0 && !options.cancelActiveOrders) {
        return {
          outcome: "active_orders",
          bill_status: table.bill_status,
          active_orders: counts.active_orders,
          order_count: counts.order_count,
        };
      }

      const unpaid = table.bill_status !== "paid" && counts.session_order_count > 0;
      if (unpaid && !options.allowUnpaid) {
        return {
          outcome: "unpaid",
          bill_status: table.bill_status,
          active_orders: 0,
          order_count: counts.order_count,
        };
      }

      await this.repository.clearTableRows(tx, tableId);
      return {
        outcome: "cleared",
        bill_status: table.bill_status,
        active_orders: 0,
        order_count: counts.order_count,
      };
    });

    if (result.outcome === "cleared") {
      this.events.sessionCleared({
        tableId,
        reason: options.allowUnpaid ? "admin_clear" : "staff_clear",
        billStatus: result.bill_status ?? "paid",
      });
    }

    return result;
  }

  /* ----------------------------------------------------------- internal */

  private async requireSessionRow(tableToken: string): Promise<SessionRow> {
    const row = await this.repository.findSessionByCode(tableToken);
    if (row === null) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
    }
    return row;
  }

  /** Rejects a page opened before the table was last cleared, tolerating a
      small clock skew so a phone running behind is not locked out forever. */
  private assertFreshSession(table: SessionRow, scanTime: string | undefined): void {
    if (!scanTime || !table.last_cleared_at) return;

    const scannedAt = Date.parse(scanTime);
    if (Number.isNaN(scannedAt)) return; // validated by Zod; never trust blindly

    if (scannedAt < table.last_cleared_at.getTime() - SCAN_TIME_SKEW_TOLERANCE_MS) {
      throw new AppError(409, "STALE_SESSION", STALE_SESSION_MESSAGE, {
        table_id: table.id,
        cleared_at: iso(table.last_cleared_at),
      });
    }
  }

  private grantedSession(row: SessionRow): GrantedSession {
    if (!row.session_pin || !row.session_secret) {
      // A live row without credentials is a broken invariant, not an invite.
      throw new AppError(403, "SESSION_ENDED", SESSION_ENDED_MESSAGE);
    }

    return {
      table_id: row.id,
      code: row.code,
      name: row.name,
      status: "active",
      session_pin: row.session_pin,
      session_secret: row.session_secret,
      session_started_at: row.session_started_at ? iso(row.session_started_at) : null,
      bill_status: row.bill_status,
      realtime_token: this.issueReadToken({ id: row.id, code: row.code }),
      gemini_api_key: this.assistantKey,
    };
  }

  private lockedSession(row: SessionRow): LockedSession {
    return {
      table_id: row.id,
      code: row.code,
      name: row.name,
      status: "locked",
      pin_locked: row.failed_pin_attempts >= MAX_PIN_ATTEMPTS,
      attempts_remaining: Math.max(0, MAX_PIN_ATTEMPTS - row.failed_pin_attempts),
      realtime_token: null,
    };
  }
}

export type { TableMemberInput };
