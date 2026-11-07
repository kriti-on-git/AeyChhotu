/* Realtime authorizer — the application-side adapter for IOManager.

   Lives outside infrastructure on purpose: it is the ONE place that knows
   both the transport's principal shapes and the app's real credential rules.

     * staff → lib/jwt verifyToken() with the same KDS_TOKEN_SECRET the REST
       middleware uses, and the same role vocabulary (kitchen/floor/admin);
     * guest → the server-issued participant credential (`pc_...`) validated
       by the Table module. The table id and room come from the database, so
       a guest can never address someone else's table.

   Both failures are mapped to null. The transport turns null into a generic
   refusal, so a socket client cannot distinguish "unknown token" from
   "expired" or "revoked" (the same non-oracle stance as REST).

   The Table service is resolved lazily because Socket.IO is constructed in
   the composition root before the module graph is fully assigned; the
   authenticator only runs when a handshake arrives, long after start(). */

import type {
  GuestPrincipal,
  RealtimeAuthenticator,
  StaffPrincipal,
} from "../infrastructure/realtime/IOManager.js";
import { hashParticipantToken } from "../modules/table/index.js";
import type { TableServicePort } from "../modules/table/index.js";
import type { AppConfig } from "../infrastructure/config/ConfigManager.js";
import { verifyToken } from "../lib/jwt.js";

const STAFF_ROLES: ReadonlySet<string> = new Set(["kitchen", "floor", "admin"]);

function isStaffRole(role: string): role is StaffPrincipal["role"] {
  return STAFF_ROLES.has(role);
}

export function createRealtimeAuthenticator(
  config: AppConfig,
  getTableService: () => TableServicePort | null,
): RealtimeAuthenticator {
  return {
    authenticateStaff(token: string): StaffPrincipal | null {
      const claims = verifyToken(token, config.kdsTokenSecret);
      if (claims === null || !isStaffRole(claims.role)) return null;
      return { kind: "staff", role: claims.role, terminalId: claims.terminal_id };
    },

    async authenticateGuest({ participantToken }): Promise<GuestPrincipal | null> {
      const service = getTableService();
      if (service === null) return null;

      try {
        const principal = await service.authorizeParticipantToken(participantToken);
        if (principal === null) return null;
        return {
          kind: "guest",
          tableId: principal.table_id,
          tableToken: principal.table_code,
          participantId: principal.participant_id,
          tokenHash: hashParticipantToken(participantToken),
        };
      } catch {
        // Infrastructure failure during validation is still a refusal.
        return null;
      }
    },

    async revalidateGuest({ tokenHash }): Promise<boolean> {
      const service = getTableService();
      if (service === null) return false;
      try {
        return (await service.authorizeParticipantTokenHash(tokenHash)) !== null;
      } catch {
        // Fail closed: a socket whose credential cannot be revalidated is
        // disconnected rather than trusted indefinitely.
        return false;
      }
    },
  };
}
