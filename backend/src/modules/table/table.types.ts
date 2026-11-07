/* Table module — contracts.

   This file is the boundary of the module: DTOs returned over HTTP, the
   records the repository maps from SQL, and the two ports the outside world
   sees (repository for storage, service for behaviour). Nothing here imports
   Express, pg or a business service, so the module can be tested with fakes
   and consumed by the legacy service layer without a cycle. */

import type { DbTransaction } from "../../infrastructure/database/DatabaseManager.js";

/** Wrong PINs tolerated before the table is flagged. Table-wide. */
export const MAX_PIN_ATTEMPTS = 3;

/** The pass length the DB check, the QR payload and join-pass all assume. */
export const SESSION_SECRET_LENGTH = 20;

/** Clock-skew allowance for a client's `scan_time` (see the service). */
export const SCAN_TIME_SKEW_TOLERANCE_MS = 2 * 60_000;

/** How recently a device must have beaten to count as still sitting here. */
export const RELEASE_PRESENCE_WINDOW_SECONDS = 45;

export type BillStatus = "unrequested" | "requested" | "paid";

/* Row shapes are type aliases, not interfaces: the shared DbPort query generic
   accepts structural aliases (implicit index signature) without a cast. */
export type TableRecord = {
  id: string;
  code: string;
  name: string;
  status: string;
};

/** The full session row, including credentials. Never leaves the server
    except through GrantedSession, and never to a staff surface. */
export type SessionRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  session_pin: string | null;
  session_secret: string | null;
  failed_pin_attempts: number;
  session_started_at: Date | null;
  bill_status: BillStatus;
  /** Last time the table was handed to its next party (sql/011). */
  last_cleared_at: Date | null;
};

/** The identity a device registers at the table (sql/011 table_members). */
export interface TableMemberInput {
  user_id?: string;
  name: string;
}

/** Extra context every session entry point accepts. */
export interface SessionEntryOptions {
  /** When the CLIENT opened the page. Older than last_cleared_at ⇒ stale. */
  scan_time?: string;
  member?: TableMemberInput;
}

/** The credentials a device holds once it belongs to the table. */
export interface GrantedSession {
  table_id: string;
  code: string;
  name: string;
  status: "active";
  session_pin: string;
  session_secret: string;
  session_started_at: string | null;
  bill_status: BillStatus;
  realtime_token: string | null;
  gemini_api_key: string | null;
}

/** The reply to a scan of a table that already has a live session. */
export interface LockedSession {
  table_id: string;
  code: string;
  name: string;
  status: "locked";
  pin_locked: boolean;
  attempts_remaining: number;
  realtime_token: null;
}

export type InitializeResult = GrantedSession | LockedSession;

export type ActiveCheckResult =
  | { has_active_order: true; order_id: string; status: string; message: string }
  | { has_active_order: false; message: string };

export interface AutoReleaseResult {
  readonly released: boolean;
}

export type ClearTableOutcome = "cleared" | "not_found" | "active_orders" | "unpaid";

export interface ClearTableConfig {
  readonly allowUnpaid: boolean;
  readonly cancelActiveOrders?: boolean;
}

export interface ClearTableResult {
  outcome: ClearTableOutcome;
  bill_status: BillStatus | null;
  active_orders: number;
  order_count: number;
}

export interface BillRequestResult {
  table_id: string;
  bill_status: BillStatus;
  bill_requested_at: string | null;
}

export interface TableStateResult {
  table_id: string;
  code: string;
  name: string;
  status: "active" | "empty";
  bill_status: BillStatus;
  bill_requested_at: string | null;
  bill_paid_at: string | null;
  session_started_at: string | null;
  /** Devices that beat inside the release window. */
  active_devices: number;
  /** pending / preparing / ready tickets on this seating. */
  active_orders: number;
}

export interface TableMember {
  user_id: string;
  name: string;
  joined_at: string;
}

export interface HeartbeatResult {
  table_id: string;
  device_id: string;
  last_seen: string;
}

/* -------------------------------------------------------------- storage */

export type LockedTableRow = {
  id: string;
  bill_status: BillStatus;
  session_started_at: Date | null;
};

export type ReleaseCandidateRow = {
  bill_status: BillStatus;
  active_orders: number;
  active_devices: number;
};

export type OrderCounts = {
  order_count: number;
  session_order_count: number;
  active_orders: number;
};

export type BillRow = {
  id: string;
  bill_status: BillStatus;
  bill_requested_at: Date | null;
};

export type TableStateRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  bill_status: BillStatus;
  bill_requested_at: Date | null;
  bill_paid_at: Date | null;
  session_started_at: Date | null;
  active_devices: number;
  active_orders: number;
};

export type MemberRow = {
  user_id: string;
  name: string;
  joined_at: Date;
};

export type PresenceRow = {
  device_id: string;
  last_seen: Date;
};

export type ActiveOrderRow = {
  id: string;
  status: string;
};

export type SchemaPresence = {
  readonly present: readonly string[];
  readonly missing: readonly string[];
};

/** The module's storage contract. Every method is one explicit query (or one
    transaction the service composes); no business decision lives here. */
export interface TableRepositoryPort {
  transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T>;

  findTableByCode(code: string): Promise<TableRecord | null>;
  findSessionByCode(code: string): Promise<SessionRow | null>;
  lockSessionByCode(tx: DbTransaction, code: string): Promise<SessionRow | null>;

  startSession(
    tx: DbTransaction,
    tableId: string,
    pin: string,
    secret: string,
  ): Promise<SessionRow | null>;
  incrementPinAttempts(tx: DbTransaction, tableId: string): Promise<number>;
  clearPinAttempts(tx: DbTransaction, tableId: string): Promise<SessionRow | null>;

  upsertMember(
    tx: DbTransaction,
    tableId: string,
    member: TableMemberInput | undefined,
  ): Promise<void>;
  /** Reconnect is best-effort: a roster write must not fail a valid refresh. */
  upsertMemberBestEffort(tableId: string, member: TableMemberInput | undefined): Promise<void>;
  listMembers(tableId: string): Promise<MemberRow[]>;

  recordHeartbeat(tableId: string, deviceId: string): Promise<PresenceRow | null>;
  removePresence(tableId: string, deviceId: string): Promise<void>;

  lockTable(tx: DbTransaction, tableId: string): Promise<LockedTableRow | null>;
  releaseCandidate(
    tx: DbTransaction,
    tableId: string,
    presenceWindowSeconds: number,
  ): Promise<ReleaseCandidateRow | null>;
  countOrders(
    tx: DbTransaction,
    tableId: string,
    sessionStartedAt: Date | null,
  ): Promise<OrderCounts>;
  cancelActiveOrders(tx: DbTransaction, tableId: string): Promise<void>;
  clearTableRows(tx: DbTransaction, tableId: string): Promise<void>;

  findTableState(tableToken: string, presenceWindowSeconds: number): Promise<TableStateRow | null>;
  requestBill(tableId: string): Promise<BillRow | null>;
  findBill(tableId: string): Promise<BillRow | null>;
  findActiveOrder(tableId: string): Promise<ActiveOrderRow | null>;

  /** Read-only existence check used by the health hook and self-test. */
  schemaObjects(): Promise<SchemaPresence>;
}

/* -------------------------------------------------------------- service */

/** What controllers, the lifecycle and legacy call sites consume. */
export interface TableServicePort {
  requireTable(tableToken: string): Promise<TableRecord>;
  initializeSession(
    tableToken: string,
    options?: SessionEntryOptions,
  ): Promise<InitializeResult>;
  joinWithPin(
    input: { table_token: string; pin: string } & SessionEntryOptions,
  ): Promise<GrantedSession>;
  joinWithPass(
    input: { table_token: string; secret: string } & SessionEntryOptions,
  ): Promise<GrantedSession>;
  reconnectSession(
    input: { table_token: string; secret: string } & SessionEntryOptions,
  ): Promise<GrantedSession>;
  getTableState(tableToken: string): Promise<TableStateResult>;
  listTableMembers(tableToken: string): Promise<TableMember[]>;
  activeCheck(tableToken: string): Promise<ActiveCheckResult>;
  requestTableBill(tableToken: string): Promise<BillRequestResult>;
  recordHeartbeat(tableToken: string, deviceId: string): Promise<HeartbeatResult>;
  removeHeartbeat(
    tableToken: string,
    deviceId: string,
  ): Promise<{ table_id: string; device_id: string; released: boolean }>;
  checkAndAutoReleaseTable(tableId: string): Promise<AutoReleaseResult>;
  clearTableSession(tableId: string, options: ClearTableConfig): Promise<ClearTableResult>;
}

/** Issues the read-scoped Supabase token for a granted session; null when the
    deployment has no Supabase JWT secret. */
export type ReadTokenIssuer = (table: { id: string; code: string }) => string | null;
