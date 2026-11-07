/* Compatibility seam for the Staff module.

   Production supplies the service from the composition root. The legacy
   `authenticateShift`/`authenticateAdmin`/`sessionIdentity` exports use this
   default, built over the legacy pool and the validated environment config,
   so existing tests and scripts keep working without composing the app. */

import { env } from "../config/env.js";
import { createLegacyDbPort } from "../db/legacy-db-port.js";
import { StaffRepository } from "../modules/staff/staff.repository.js";
import { StaffService } from "../modules/staff/staff.service.js";
import type { StaffServicePort } from "../modules/staff/staff.types.js";

let defaultService: StaffServicePort | null = null;

export function getDefaultStaffService(): StaffServicePort {
  if (defaultService === null) {
    defaultService = new StaffService({
      repository: new StaffRepository(createLegacyDbPort()),
      staffPin: env.staffPin,
      adminPin: env.adminPin,
      kdsTokenSecret: env.kdsTokenSecret,
      supabaseJwtSecret: env.supabaseJwtSecret,
    });
  }
  return defaultService;
}

/** Called once by the composition root before any request is served. */
export function configureStaffService(service: StaffServicePort): void {
  defaultService = service;
}
