import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import { verifyToken, type ShiftClaims } from "../lib/jwt.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Attached by requireAuth(); consumed by requireRole() and /auth/me. */
    shift?: ShiftClaims;
  }
}

const UNAUTHORIZED_MESSAGE = "Missing or invalid kitchen shift token.";

/* Accepts `Authorization: Bearer <jwt>` first, then the httpOnly
   `kds_token` cookie set by kds-login (same-origin browser terminals). */
function extractToken(req: Request): { token: string; source: "header" | "cookie" } | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return { token, source: "header" };
  }

  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === "kds_token") {
        const token = decodeURIComponent(rest.join("="));
        if (token) return { token, source: "cookie" };
      }
    }
  }

  return null;
}

/* requireAuth — protects /api/v1/kds/* and /api/v1/auth/me.
   Missing / malformed / invalid / expired token → immediate 401 with the
   contract error frame; the handler never runs. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const found = extractToken(req);
  if (!found) {
    next(new AppError(401, "UNAUTHORIZED", UNAUTHORIZED_MESSAGE));
    return;
  }

  const claims = verifyToken(found.token, env.kdsTokenSecret);
  if (!claims) {
    next(new AppError(401, "UNAUTHORIZED", UNAUTHORIZED_MESSAGE));
    return;
  }

  req.shift = claims;
  (req as Request & { shiftSource?: string }).shiftSource = found.source;
  next();
}

/* requireRole — access policy for administrative / kitchen layout
   changes (status tags, 86ing, …). A valid token whose role claim is not
   the required role is blocked with 403 FORBIDDEN. */
export function requireRole(role: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.shift?.role !== role) {
      next(
        new AppError(403, "FORBIDDEN", "This session role is not permitted to perform this action."),
      );
      return;
    }
    next();
  };
}
