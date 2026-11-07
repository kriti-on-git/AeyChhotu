/* Compatibility facade for the legacy auth router.

   The controller moved to the Staff module. Production mounts the module's
   router with the composed service (app.ts); this export remains for callers
   that import `authRouter` directly and builds it over the same default
   service, so paths and cookie flags are identical. */

import { env } from "../config/env.js";
import { createAuthRouter } from "../modules/staff/staff.controller.js";
import { getDefaultStaffService } from "../services/staff.service.js";

/* Module 1 — Shift Authentication.
   E2  POST /api/v1/auth/kds-login    (role:'kitchen' JWT + httpOnly kds_token)
   E2c POST /api/v1/auth/admin-login  (role:'admin' JWT + httpOnly admin_token)
   E2b GET  /api/v1/auth/me           (decodes header bearer or cookie) */
export const authRouter = createAuthRouter({
  service: getDefaultStaffService(),
  cookie: { sameSite: env.cookieSameSite, secure: env.cookieSecure },
});
