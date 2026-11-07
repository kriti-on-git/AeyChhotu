/* Public surface of the Staff module. */

export { StaffService, pinMatches } from "./staff.service.js";
export { StaffRepository } from "./staff.repository.js";
export {
  createStaffModule,
  type StaffModule,
  type StaffModuleOptions,
} from "./staff.module.js";
export {
  createAuthRouter,
  createStaffRouter,
  type StaffControllerDeps,
  type StaffCookieOptions,
} from "./staff.controller.js";
export {
  hasPermission,
  isStaffRole,
  permissionsFor,
  requirePermission,
} from "./staff.permissions.js";
export { STAFF_TOKENS } from "./staff.tokens.js";
export {
  adminLoginSchema,
  createStaffSchema,
  kdsLoginSchema,
  staffParamsSchema,
  updateStaffSchema,
} from "./staff.validation.js";
export {
  STAFF_PERMISSIONS,
  STAFF_ROLES,
  STAFF_TERMINAL_ROLES,
} from "./staff.types.js";
export type {
  AdminLoginResult,
  CreateStaffInput,
  ShiftLoginResult,
  StaffMember,
  StaffPermission,
  StaffRepositoryPort,
  StaffRole,
  StaffSchemaPresence,
  StaffServicePort,
  StaffSessionIdentity,
  StaffTerminalRole,
  StaffTerminalRow,
  UpdateStaffInput,
} from "./staff.types.js";
