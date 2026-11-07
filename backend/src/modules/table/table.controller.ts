/* Table module — HTTP controller.

   Thin by design: parse with the module's validators, call one service
   method, render the existing envelope. No SQL, no business rule and no
   knowledge of the legacy service layer. `recordFeedback` is injected because
   feedback belongs to the insights module but lives under the session
   capability; the controller does not import that module. */

import { Router, type Request } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { parseOrThrow } from "../../validation/parse.js";
import {
  activeCheckParamsSchema,
  feedbackSchema,
  heartbeatSchema,
  initializeSchema,
  joinPassSchema,
  joinPinSchema,
  participantRevokeParamsSchema,
  participantTokenSchema,
  reconnectSchema,
  sessionTableParamsSchema,
} from "./table.validation.js";
import type { TableServicePort } from "./table.types.js";

export interface TableControllerDeps {
  readonly service: TableServicePort;
  readonly recordFeedback: (
    tableToken: string,
    input: { rating: number; comment: string },
  ) => Promise<unknown>;
}

/* Every session entry point forwards the client's `scan_time` and, where the
   guest can identify themselves, their roster entry. */
function memberOf(body: { user_id?: string; name: string }) {
  if (!body.user_id) return undefined;
  return { user_id: body.user_id, name: body.name };
}

/* Phase 5.2: the credential is a header, never a URL or body value. The
   service validates it server-side; no handler reads a participant id from
   the request to establish identity. */
function participantToken(req: Request): string {
  return parseOrThrow(participantTokenSchema, req.header("x-participant-token") ?? "");
}

export function createTableRouter(deps: TableControllerDeps): Router {
  const router = Router();
  const service = deps.service;

  // E1 — POST /api/v1/sessions/initialize
  router.post("/initialize", async (req, res) => {
    const body = parseOrThrow(initializeSchema, req.body);
    const data = await service.initializeSession(body.table_token, {
      scan_time: body.scan_time,
      member: memberOf(body),
    });
    res.status(200).json({ success: true, data });
  });

  // E1b — POST /api/v1/sessions/join-pin
  router.post("/join-pin", async (req, res) => {
    const body = parseOrThrow(joinPinSchema, req.body);
    const data = await service.joinWithPin({ ...body, member: memberOf(body) });
    res.status(200).json({ success: true, data });
  });

  // E1c — POST /api/v1/sessions/join-pass
  router.post("/join-pass", async (req, res) => {
    const body = parseOrThrow(joinPassSchema, req.body);
    const data = await service.joinWithPass({ ...body, member: memberOf(body) });
    res.status(200).json({ success: true, data });
  });

  // E1d — POST /api/v1/sessions/reconnect
  router.post("/reconnect", async (req, res) => {
    const body = parseOrThrow(reconnectSchema, req.body);
    const data = await service.reconnectSession({ ...body, member: memberOf(body) });
    res.status(200).json({ success: true, data });
  });

  // GET /api/v1/sessions/:table_token — the diner's own table state.
  router.get("/:table_token", async (req, res) => {
    const params = parseOrThrow(sessionTableParamsSchema, req.params);
    const data = await service.getTableState(params.table_token);
    res.status(200).json({ success: true, data });
  });

  // GET /api/v1/sessions/:table_token/members — the live roster.
  router.get("/:table_token/members", async (req, res) => {
    const params = parseOrThrow(sessionTableParamsSchema, req.params);
    const data = await service.listTableMembers(params.table_token, participantToken(req));
    res.status(200).json({ success: true, data });
  });

  // E9 — GET /api/v1/sessions/:table_token/active-check
  router.get("/:table_token/active-check", async (req, res) => {
    const params = parseOrThrow(activeCheckParamsSchema, req.params);
    const data = await service.activeCheck(params.table_token);
    res.status(200).json({ success: true, data });
  });

  // POST /api/v1/sessions/:table_token/bill-request
  router.post("/:table_token/bill-request", async (req, res) => {
    const params = parseOrThrow(sessionTableParamsSchema, req.params);
    const data = await service.requestTableBill(params.table_token);
    res.status(200).json({ success: true, data });
  });

  // POST /api/v1/sessions/:table_token/heartbeat
  router.post("/:table_token/heartbeat", async (req, res) => {
    const params = parseOrThrow(sessionTableParamsSchema, req.params);
    const body = parseOrThrow(heartbeatSchema, req.body);
    const data = await service.recordHeartbeat(
      params.table_token,
      participantToken(req),
      body.device_id,
    );
    res.status(200).json({ success: true, data });
  });

  // DELETE /api/v1/sessions/:table_token/heartbeat
  router.delete("/:table_token/heartbeat", async (req, res) => {
    const params = parseOrThrow(sessionTableParamsSchema, req.params);
    const body = parseOrThrow(heartbeatSchema, req.body);
    const data = await service.removeHeartbeat(
      params.table_token,
      participantToken(req),
      body.device_id,
    );
    res.status(200).json({ success: true, data });
  });

  // POST /api/v1/sessions/:table_token/participant/revoke — self-service.
  router.post("/:table_token/participant/revoke", async (req, res) => {
    const params = parseOrThrow(sessionTableParamsSchema, req.params);
    const data = await service.revokeOwnParticipantTokens(participantToken(req));
    res.status(200).json({ success: true, data: { ...data, table_token: params.table_token } });
  });

  // POST /api/v1/sessions/:table_token/participants/:participant_id/revoke
  // Staff only: a guest can never revoke a tablemate's credentials.
  router.post(
    "/:table_token/participants/:participant_id/revoke",
    requireAuth,
    requireRole("kitchen", "floor", "admin"),
    async (req, res) => {
      const params = parseOrThrow(participantRevokeParamsSchema, req.params);
      const data = await service.revokeParticipantTokensAsStaff(
        params.table_token,
        params.participant_id,
      );
      res.status(200).json({ success: true, data });
    },
  );

  // POST /api/v1/sessions/:table_token/feedback — written from the TABLE
  // capability, read only by the admin console.
  router.post("/:table_token/feedback", async (req, res) => {
    const params = parseOrThrow(sessionTableParamsSchema, req.params);
    const body = parseOrThrow(feedbackSchema, req.body);
    const data = await deps.recordFeedback(params.table_token, body);
    res.status(201).json({ success: true, data });
  });

  return router;
}
