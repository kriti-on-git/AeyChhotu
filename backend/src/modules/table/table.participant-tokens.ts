/* Participant credentials — generation, hashing, issuance and validation.

   DESIGN
     * 32 random bytes, base64url, prefixed `pc_`. The raw value is returned
       once (the grant response) and never stored or logged.
     * Only the SHA-256 hex digest is persisted.
     * A credential is bound to `table_members.id` AND the seating's
       `session_started_at`, so a new party can never reuse the old one.
     * 12-hour expiry, non-sliding. `last_used_at` is diagnostic only.
     * At most 5 live tokens per member. Issuing a sixth revokes the oldest
       in the same transaction. The member row lock serializes concurrent
       issuance, so the cap cannot be exceeded.

   LOCK ORDER (shared by every caller):
     1. restaurant_tables row
     2. table_participant_tokens / table_members rows
   Normal writes take SHARE; clear and revocation take UPDATE. Expiry is
   evaluated with `clock_timestamp()` AFTER those locks are held, so a
   revocation that commits while a request waits is observed. */

import { createHash, randomBytes } from "node:crypto";
import type { DbPort, DbTransaction } from "../../infrastructure/database/DatabaseManager.js";
import type {
  ParticipantPrincipal,
  ParticipantTokenIssuance,
  SessionCleanupPort,
} from "./table.types.js";

export const PARTICIPANT_TOKEN_PREFIX = "pc_";
export const PARTICIPANT_TOKEN_TTL_HOURS = 12;
export const MAX_ACTIVE_PARTICIPANT_TOKENS = 5;

/** `pc_` + 43 base64url characters (32 bytes, unpadded). */
export const PARTICIPANT_TOKEN_RE = /^pc_[A-Za-z0-9_-]{43}$/;

export function generateParticipantToken(): string {
  return `${PARTICIPANT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashParticipantToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Fixed, message-free refusal: never distinguishes unknown from expired. */
export const PARTICIPANT_UNAUTHORIZED_MESSAGE =
  "This participant credential is missing, expired or revoked.";

export type ParticipantLockMode = "share" | "update";

export interface ParticipantTokenStorePort {
  transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T>;

  /** Issue one credential for a member already proven to be on the table. */
  issue(
    tx: DbTransaction,
    input: {
      memberId: string;
      tableId: string;
      sessionStartedAt: Date;
    },
  ): Promise<ParticipantTokenIssuance>;

  /**
   * Validate inside an existing transaction, after locking the table row.
   * Returns null for every failure. `now` is read from Postgres with
   * clock_timestamp(), never from the transaction snapshot.
   */
  authorizeInTransaction(
    tx: DbTransaction,
    rawToken: string,
    mode?: ParticipantLockMode,
  ): Promise<ParticipantPrincipal | null>;

  /** Non-locking validation for read-only paths (socket handshake). */
  authorizeByHash(tokenHash: string): Promise<ParticipantPrincipal | null>;

  /** Best-effort diagnostics; never fails a request. */
  touch(rawToken: string): Promise<void>;

  /** Revoke every token of the member that owns `rawToken`. */
  revokeSelf(rawToken: string): Promise<number>;

  /** Staff-authorized revocation of another member's tokens. */
  revokeForMember(tableToken: string, memberId: string): Promise<number>;

  /** Clear: delete every token belonging to the table. */
  deleteForTable(tx: DbTransaction, tableId: string): Promise<void>;
}

type TokenLookupRow = {
  table_id: string;
};

type LockedTableRow = {
  id: string;
  code: string;
  status: string;
  session_started_at: Date | null;
};

type ParticipantTokenRow = {
  id: string;
  member_id: string;
  table_id: string;
  session_started_at: Date;
  member_table_id: string;
  user_id: string;
  name: string;
  token_live: boolean;
  revoked_at: Date | null;
};

const JOINED_TOKEN_COLUMNS = `tok.id,
  tok.member_id,
  tok.table_id,
  tok.session_started_at,
  (tok.expires_at > clock_timestamp()) AS token_live,
  tok.revoked_at,
  m.table_id AS member_table_id,
  m.user_id,
  m.name`;

export class ParticipantTokenStore implements ParticipantTokenStorePort {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  async issue(
    tx: DbTransaction,
    input: { memberId: string; tableId: string; sessionStartedAt: Date },
  ): Promise<ParticipantTokenIssuance> {
    /* Lock the member first: concurrent issuance for one guest serializes
       here, which is what makes the five-token cap impossible to exceed. */
    const member = await tx.query<{ id: string }>(
      `SELECT id
         FROM table_members
        WHERE id = $1 AND table_id = $2
          FOR UPDATE`,
      [input.memberId, input.tableId],
    );
    if (member.rows[0] === undefined) {
      throw new Error("The participant is not a member of this table session.");
    }

    const active = await tx.query<{ active: number }>(
      `SELECT count(*)::int AS active
         FROM table_participant_tokens
        WHERE member_id = $1
          AND revoked_at IS NULL
          AND expires_at > clock_timestamp()`,
      [input.memberId],
    );
    const live = active.rows[0]?.active ?? 0;
    const excess = Math.max(0, live - (MAX_ACTIVE_PARTICIPANT_TOKENS - 1));

    if (excess > 0) {
      await tx.query(
        `UPDATE table_participant_tokens
            SET revoked_at = clock_timestamp(),
                revoked_reason = 'token_cap'
          WHERE id IN (
            SELECT id
              FROM table_participant_tokens
             WHERE member_id = $1
               AND revoked_at IS NULL
               AND expires_at > clock_timestamp()
             ORDER BY issued_at ASC, id ASC
             LIMIT $2
          )`,
        [input.memberId, excess],
      );
    }

    const rawToken = generateParticipantToken();
    const inserted = await tx.query<{ expires_at: Date }>(
      `INSERT INTO table_participant_tokens
         (member_id, table_id, session_started_at, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + ($5 || ' hours')::interval)
       RETURNING expires_at`,
      [
        input.memberId,
        input.tableId,
        input.sessionStartedAt,
        hashParticipantToken(rawToken),
        String(PARTICIPANT_TOKEN_TTL_HOURS),
      ],
    );
    const expiresAt = inserted.rows[0]?.expires_at;
    if (expiresAt === undefined) {
      throw new Error("The participant credential could not be issued.");
    }

    return { participant_token: rawToken, participant_expires_at: expiresAt };
  }

  async authorizeInTransaction(
    tx: DbTransaction,
    rawToken: string,
    mode: ParticipantLockMode = "share",
  ): Promise<ParticipantPrincipal | null> {
    const hash = hashParticipantToken(rawToken);

    const lookup = await tx.query<TokenLookupRow>(
      "SELECT table_id FROM table_participant_tokens WHERE token_hash = $1",
      [hash],
    );
    const tableId = lookup.rows[0]?.table_id;
    if (tableId === undefined) return null;

    const lock = mode === "update" ? "FOR UPDATE" : "FOR SHARE";
    const table = await tx.query<LockedTableRow>(
      `SELECT id, code, status, session_started_at
         FROM restaurant_tables
        WHERE id = $1 AND deleted_at IS NULL
          ${lock}`,
      [tableId],
    );
    const tableRow = table.rows[0];
    if (tableRow === undefined) return null;

    const joined = await tx.query<ParticipantTokenRow>(
      `SELECT ${JOINED_TOKEN_COLUMNS}
         FROM table_participant_tokens tok
         JOIN table_members m
           ON m.id = tok.member_id
          AND m.table_id = tok.table_id
        WHERE tok.token_hash = $1
        ${mode === "update" ? "FOR UPDATE OF tok, m" : "FOR SHARE OF tok, m"}`,
      [hash],
    );
    return this.principal(joined.rows[0], tableRow, tableId);
  }

  async authorizeByHash(tokenHash: string): Promise<ParticipantPrincipal | null> {
    /* Read-only: used for the socket handshake and periodic revalidation.
       clock_timestamp() is evaluated by Postgres in this statement. */
    const res = await this.db.query<
      ParticipantTokenRow & {
        table_code: string;
        table_status: string;
        table_session_started_at: Date | null;
      }
    >(
      `SELECT ${JOINED_TOKEN_COLUMNS},
              t.code AS table_code,
              t.status AS table_status,
              t.session_started_at AS table_session_started_at
         FROM table_participant_tokens tok
         JOIN table_members m
           ON m.id = tok.member_id
          AND m.table_id = tok.table_id
         JOIN restaurant_tables t
           ON t.id = tok.table_id
          AND t.deleted_at IS NULL
        WHERE tok.token_hash = $1
        LIMIT 1`,
      [tokenHash],
    );

    const row = res.rows[0];
    if (row === undefined) return null;
    return this.principal(
      row,
      {
        id: row.table_id,
        code: row.table_code,
        status: row.table_status,
        session_started_at: row.table_session_started_at,
      },
      row.table_id,
    );
  }

  async touch(rawToken: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE table_participant_tokens
            SET last_used_at = clock_timestamp()
          WHERE token_hash = $1
            AND revoked_at IS NULL`,
        [hashParticipantToken(rawToken)],
      );
    } catch {
      /* Diagnostic only: never turn a valid request into a failure. */
    }
  }

  async revokeSelf(rawToken: string): Promise<number> {
    const hash = hashParticipantToken(rawToken);

    return this.db.transaction(async (tx) => {
      const lookup = await tx.query<TokenLookupRow>(
        "SELECT table_id FROM table_participant_tokens WHERE token_hash = $1",
        [hash],
      );
      const tableId = lookup.rows[0]?.table_id;
      if (tableId === undefined) return 0;

      const table = await tx.query<LockedTableRow>(
        `SELECT id, code, status, session_started_at
           FROM restaurant_tables
          WHERE id = $1 AND deleted_at IS NULL
            FOR UPDATE`,
        [tableId],
      );
      if (table.rows[0] === undefined) return 0;

      const joined = await tx.query<ParticipantTokenRow>(
        `SELECT ${JOINED_TOKEN_COLUMNS}
           FROM table_participant_tokens tok
           JOIN table_members m
             ON m.id = tok.member_id
            AND m.table_id = tok.table_id
          WHERE tok.token_hash = $1
            FOR UPDATE OF tok, m`,
        [hash],
      );
      const member = this.principal(joined.rows[0], table.rows[0], tableId);
      if (member === null) return 0;

      const updated = await tx.query<{ id: string }>(
        `UPDATE table_participant_tokens
            SET revoked_at = clock_timestamp(),
                revoked_reason = COALESCE(revoked_reason, 'self')
          WHERE member_id = $1
            AND table_id = $2
          RETURNING id`,
        [member.participant_id, member.table_id],
      );
      return updated.rowCount ?? updated.rows.length;
    });
  }

  async revokeForMember(tableToken: string, memberId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const table = await tx.query<LockedTableRow>(
        `SELECT id, code, status, session_started_at
           FROM restaurant_tables
          WHERE code = $1 AND deleted_at IS NULL
            FOR UPDATE`,
        [tableToken],
      );
      const tableRow = table.rows[0];
      if (tableRow === undefined) return 0;

      const member = await tx.query<{ id: string }>(
        `SELECT id
           FROM table_members
          WHERE id = $1 AND table_id = $2
            FOR UPDATE`,
        [memberId, tableRow.id],
      );
      if (member.rows[0] === undefined) return 0;

      const updated = await tx.query<{ id: string }>(
        `UPDATE table_participant_tokens
            SET revoked_at = clock_timestamp(),
                revoked_reason = COALESCE(revoked_reason, 'staff')
          WHERE member_id = $1
            AND table_id = $2
          RETURNING id`,
        [memberId, tableRow.id],
      );
      return updated.rowCount ?? updated.rows.length;
    });
  }

  async deleteForTable(tx: DbTransaction, tableId: string): Promise<void> {
    await tx.query("DELETE FROM table_participant_tokens WHERE table_id = $1", [tableId]);
  }

  private principal(
    token: ParticipantTokenRow | undefined,
    table: LockedTableRow,
    tableId: string,
  ): ParticipantPrincipal | null {
    if (token === undefined) return null;

    /* Every check runs against state read under the lock. `token_live` was
       computed by Postgres with clock_timestamp(). */
    if (token.revoked_at !== null) return null;
    if (token.token_live !== true) return null;
    if (token.table_id !== tableId) return null;
    if (token.member_table_id !== tableId) return null;
    if (table.status !== "active") return null;
    if (table.session_started_at === null) return null;
    if (token.session_started_at.getTime() !== table.session_started_at.getTime()) return null;

    return {
      participant_id: token.member_id,
      user_id: token.user_id,
      name: token.name,
      table_id: tableId,
      table_code: table.code,
      session_started_at: table.session_started_at,
    };
  }
}

/** Table clear does not own conversation SQL; it receives this narrow port. */
export const NOOP_SESSION_CLEANUP: SessionCleanupPort = Object.freeze({
  purgeSeating: async () => undefined,
});
