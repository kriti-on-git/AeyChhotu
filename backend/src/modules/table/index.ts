/* Public surface of the Table module. Other modules import from here, never
   from a file inside it. */

export { TableService, generateSessionPin, generateSessionSecret } from "./table.service.js";
export { TableRepository } from "./table.repository.js";
export { createTableRouter, type TableControllerDeps } from "./table.controller.js";
export {
  createTableModule,
  configureTableService,
  getDefaultTableService,
  type TableModule,
  type TableModuleOptions,
} from "./table.module.js";
export { createReadTokenIssuer } from "./table.read-token.js";
export { NOOP_TABLE_EVENTS, type TableEventPublisher, type TableClearReason } from "./table.events.js";
export { TABLE_TOKENS } from "./table.tokens.js";
export {
  activeCheckParamsSchema,
  feedbackSchema,
  heartbeatSchema,
  initializeSchema,
  joinPassSchema,
  joinPinSchema,
  reconnectSchema,
  sessionTableParamsSchema,
} from "./table.validation.js";
export {
  MAX_PIN_ATTEMPTS,
  RELEASE_PRESENCE_WINDOW_SECONDS,
  SCAN_TIME_SKEW_TOLERANCE_MS,
  SESSION_SECRET_LENGTH,
  type ActiveCheckResult,
  type AutoReleaseResult,
  type BillRequestResult,
  type BillStatus,
  type ClearTableConfig,
  type ClearTableOutcome,
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
