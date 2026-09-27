import { Router } from "express";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { authenticateShift, sessionIdentity } from "../services/auth.service.js";
import { kdsLoginSchema, parseOrThrow } from "../validation/schemas.js";

/* Module 1 — Shift Authentication.
   E2  POST /api/v1/auth/kds-login  (issues role:'kitchen' JWT + httpOnly cookie)
   E2b GET  /api/v1/auth/me         (decodes header bearer or cookie) */
export const authRouter = Router();

// E2 — POST /api/v1/auth/kds-login
authRouter.post("/kds-login", async (req, res) => {
  const body = parseOrThrow(kdsLoginSchema, req.body);
  const shift = await authenticateShift(body.pin);

  // httpOnly cookie for same-origin browser terminals: JavaScript on the
  // page can never read the token (SameSite=Strict; Secure in production).
  res.setHeader(
    "Set-Cookie",
    [
      `kds_token=${encodeURIComponent(shift.token)}`,
      "HttpOnly",
      "Path=/",
      `Max-Age=${shift.expires_in}`,
      "SameSite=Strict",
      ...(env.nodeEnv === "production" ? ["Secure"] : []),
    ].join("; "),
  );

  res.status(200).json({
    success: true,
    data: {
      token: shift.token,
      token_type: shift.token_type,
      expires_in: shift.expires_in,
      role: shift.role,
      terminal_id: shift.terminal_id,
      message: shift.message,
    },
  });
});

// E2b — GET /api/v1/auth/me (401 via requireAuth when token missing/expired)
authRouter.get("/me", requireAuth, (req, res) => {
  const source =
    (req as typeof req & { shiftSource?: string }).shiftSource === "cookie" ? "cookie" : "header";
  const data = sessionIdentity(req.shift!, source);
  res.status(200).json({ success: true, data });
});
