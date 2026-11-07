/* Transitional facade over the Table module.

   The Table module is the owner of session/access, roster, presence, bill
   request and seating release. Several not-yet-migrated services (floor,
   admin, orders, cart, menu, kds, ownership, realtime auth) still import the
   historical function names and types from this file. Instead of a flag day,
   this facade keeps those names and delegates to the single TableService
   instance composed at boot.

   It holds no logic and no SQL. When the last caller migrates to
   modules/table, this file is deleted. */

import { getDefaultTableService } from "../modules/table/table.module.js";
import type {
  ActiveCheckResult,
  AutoReleaseResult,
  BillRequestResult,
  ClearTableConfig,
  ClearTableResult,
  GrantedSession,
  HeartbeatResult,
  InitializeResult,
  SessionEntryOptions,
  SessionRow,
  TableMember,
  TableMemberInput,
  TableRecord,
  TableStateResult,
} from "../modules/table/table.types.js";

export {
  MAX_PIN_ATTEMPTS,
  RELEASE_PRESENCE_WINDOW_SECONDS,
  SCAN_TIME_SKEW_TOLERANCE_MS,
  SESSION_SECRET_LENGTH,
} from "../modules/table/table.types.js";

export { generateSessionPin, generateSessionSecret } from "../modules/table/table.service.js";

export type {
  ActiveCheckResult,
  AutoReleaseResult,
  BillRequestResult,
  BillStatus,
  ClearTableConfig,
  ClearTableOutcome,
  ClearTableResult,
  GrantedSession,
  HeartbeatResult,
  InitializeResult,
  LockedSession,
  SessionEntryOptions,
  SessionRow,
  TableMember,
  TableMemberInput,
  TableRecord,
  TableStateResult,
} from "../modules/table/table.types.js";

export function requireTable(tableToken: string): Promise<TableRecord> {
  return getDefaultTableService().requireTable(tableToken);
}

export function initializeSession(
  tableToken: string,
  options: SessionEntryOptions = {},
): Promise<InitializeResult> {
  return getDefaultTableService().initializeSession(tableToken, options);
}

export function joinWithPin(
  input: { table_token: string; pin: string } & SessionEntryOptions,
): Promise<GrantedSession> {
  return getDefaultTableService().joinWithPin(input);
}

export function joinWithPass(
  input: { table_token: string; secret: string } & SessionEntryOptions,
): Promise<GrantedSession> {
  return getDefaultTableService().joinWithPass(input);
}

export function reconnectSession(
  input: { table_token: string; secret: string } & SessionEntryOptions,
): Promise<GrantedSession> {
  return getDefaultTableService().reconnectSession(input);
}

export function getTableState(tableToken: string): Promise<TableStateResult> {
  return getDefaultTableService().getTableState(tableToken);
}

export function listTableMembers(tableToken: string): Promise<TableMember[]> {
  return getDefaultTableService().listTableMembers(tableToken);
}

export function activeCheck(tableToken: string): Promise<ActiveCheckResult> {
  return getDefaultTableService().activeCheck(tableToken);
}

export function requestTableBill(tableToken: string): Promise<BillRequestResult> {
  return getDefaultTableService().requestTableBill(tableToken);
}

export function recordHeartbeat(
  tableToken: string,
  deviceId: string,
): Promise<HeartbeatResult> {
  return getDefaultTableService().recordHeartbeat(tableToken, deviceId);
}

export function removeHeartbeat(
  tableToken: string,
  deviceId: string,
): Promise<{ table_id: string; device_id: string; released: boolean }> {
  return getDefaultTableService().removeHeartbeat(tableToken, deviceId);
}

export function checkAndAutoReleaseTable(tableId: string): Promise<AutoReleaseResult> {
  return getDefaultTableService().checkAndAutoReleaseTable(tableId);
}

export function clearTableSession(
  tableId: string,
  options: ClearTableConfig,
): Promise<ClearTableResult> {
  return getDefaultTableService().clearTableSession(tableId, options);
}

/* Re-exported for callers that only need the row shape (ownership.ts uses
   TableRecord; no caller constructs a SessionRow). */
export type { SessionRow as TableSessionRow };
