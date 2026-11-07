/* Staff module — HTTP controllers.

   Two surfaces:
     * /api/v1/auth   — E2, E2c, E2b and an additive logout. Paths, payloads,
       cookies and status codes are unchanged from the legacy router.
     * /api/v1/staff  — additive, admin-only identity/role management.
   No route accepts or returns a PIN, a token secret or a stored credential. */

import { Router } from "express";
import type { Request } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { parseOrThrow } from "../../validation/parse.js";
import { requirePermission } from "./staff.permissions.js";
import {
  adminLoginSchema,
  createStaffSchema,
  kdsLoginSchema,
  staffParamsSchema,
  updateStaffSchema,
} from "./staff.validation.js";
import type { StaffServicePort } from "./staff.types.js";

export interface StaffCookieOptions {
  readonly sameSite: "Strict" | "Lax" | "None";
  readonly secure: boolean;
}

export interface StaffControllerDeps {
  readonly service: StaffServicePort;
  readonly cookie: StaffCookieOptions;
}

function cookieHeader(
  name: string,
  value: string,
  maxAge: number,
  options: StaffCookieOptions,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAge}`,
    `SameSite=${options.sameSite}`,
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

export function createAuthRouter(deps: StaffControllerDeps): Router {
  const router = Router();

  // E2 — POST /api/v1/auth/kds-login
  router.post("/kds-login", async (req, res) => {
    const body = parseOrThrow(kdsLoginSchema, req.body);
    const shift = await deps.service.authenticateShift(body.pin);

    res.setHeader(
      "Set-Cookie",
      cookieHeader("kds_token", shift.token, shift.expires_in, deps.cookie),
    );

    res.status(200).json({
      success: true,
      data: {
        token: shift.token,
        token_type: shift.token_type,
        expires_in: shift.expires_in,
        role: shift.role,
        terminal_id: shift.terminal_id,
        realtime_token: shift.realtime_token,
        message: shift.message,
      },
    });
  });

  // E2c — POST /api/v1/auth/admin-login
  router.post("/admin-login", async (req, res) => {
    const body = parseOrThrow(adminLoginSchema, req.body);
    const session = await deps.service.authenticateAdmin(body.pin);

    res.setHeader(
      "Set-Cookie",
      cookieHeader("admin_token", session.token, session.expires_in, deps.cookie),
    );

    res.status(200).json({
      success: true,
      data: {
        token: session.token,
        token_type: session.token_type,
        expires_in: session.expires_in,
        role: session.role,
        message: session.message,
      },
    });
  });

  // E2b — GET /api/v1/auth/me
  router.get("/me", requireAuth, (req, res) => {
    const source: "header" | "cookie" =
      (req as typeof req & { shiftSource?: string }).shiftSource === "cookie"
        ? "cookie"
        : "header";
    const data = deps.service.sessionIdentity(req.shift!, source);
    res.status(200).json({ success: true, data });
  });

  /* Additive: clearing the httpOnly cookies is the server half of sign-out.
     It is safe without a valid token — an expired session must still be able
     to clear the stale browser cookie. */
  router.post("/logout", (_req: Request, res) => {
    res.append("Set-Cookie", cookieHeader("kds_token", "", 0, deps.cookie));
    res.append("Set-Cookie", cookieHeader("admin_token", "", 0, deps.cookie));
    res.status(200).json({ success: true, data: { logged_out: true } });
  });

  return router;
}

export function createStaffRouter(deps: { service: StaffServicePort }): Router {
  const router = Router();

  router.use(requireAuth, requirePermission("staff.manage"));

  // GET /api/v1/staff — every terminal, oldest first. No credentials.
  router.get("/", async (_req, res) => {
    const staff = await deps.service.listStaff();
    res.status(200).json({
      success: true,
      data: { count: staff.length, staff },
    });
  });

  // POST /api/v1/staff — add a kitchen/floor terminal.
  router.post("/", async (req, res) => {
    const body = parseOrThrow(createStaffSchema, req.body);
    const data = await deps.service.createStaff(body);
    res.status(201).json({ success: true, data });
  });

  // PATCH /api/v1/staff/:staff_id — label, role or active state.
  router.patch("/:staff_id", async (req, res) => {
    const params = parseOrThrow(staffParamsSchema, req.params);
    const body = parseOrThrow(updateStaffSchema, req.body);
    const data = await deps.service.updateStaff(params.staff_id, body);
    res.status(200).json({ success: true, data });
  });

  return router;
}
