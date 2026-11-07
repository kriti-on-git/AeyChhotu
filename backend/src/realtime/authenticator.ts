/* Realtime authorizer — the application-side adapter for IOManager.

   Lives outside infrastructure on purpose: it is the ONE place that knows
   both the transport's principal shapes and the app's real credential rules.

     * staff → lib/jwt verifyToken() with the same KDS_TOKEN_SECRET the REST
       middleware uses, and the same role vocabulary (kitchen/floor/admin);
     * guest → sessions.service reconnectSession(), i.e. the exact
       table-token + 20-character pass check a returning phone already goes
       through. It returns the database table id, which becomes the room
       name, so a guest can never address someone else's table.

   Both failures are mapped to null. The transport turns null into a generic
   refusal, so a socket client cannot distinguish "wrong pass" from "no such
   table" (the same non-oracle stance the REST session endpoints take). */

import type {
  GuestPrincipal,
  RealtimeAuthenticator,
  StaffPrincipal,
} from "../infrastructure/realtime/IOManager.js";
import type { AppConfig } from "../infrastructure/config/ConfigManager.js";
import { verifyToken } from "../lib/jwt.js";
import { reconnectSession } from "../services/sessions.service.js";

const STAFF_ROLES: ReadonlySet<string> = new Set(["kitchen", "floor", "admin"]);

function isStaffRole(role: string): role is StaffPrincipal["role"] {
  return STAFF_ROLES.has(role);
}

export function createRealtimeAuthenticator(config: AppConfig): RealtimeAuthenticator {
  return {
    authenticateStaff(token: string): StaffPrincipal | null {
      const claims = verifyToken(token, config.kdsTokenSecret);
      if (claims === null || !isStaffRole(claims.role)) return null;
      return { kind: "staff", role: claims.role, terminalId: claims.terminal_id };
    },

    async authenticateGuest({ tableToken, secret }): Promise<GuestPrincipal | null> {
      try {
        const granted = await reconnectSession({ table_token: tableToken, secret });
        return { kind: "guest", tableId: granted.table_id, tableToken: granted.code };
      } catch {
        // Invalid pass, settled table, unknown token — all one refusal.
        return null;
      }
    },
  };
}
