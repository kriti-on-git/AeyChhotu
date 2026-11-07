/* Conversation module — HTTP controller.

   All routes are additive. Phase 5.2 authorization is the server-issued
   participant token in `X-Participant-Token`; the table pass and any
   client-supplied participant id are ignored. No response ever contains the
   token or a provider credential. */

import { Router, type Request } from "express";
import { parseOrThrow } from "../../validation/parse.js";
import {
  conversationCredentialHeadersSchema,
  conversationParamsSchema,
  endVoiceParamsSchema,
  postConversationMessageSchema,
  startVoiceSchema,
} from "./conversation.validation.js";
import type {
  ConversationCredentials,
  ConversationServicePort,
} from "./conversation.types.js";

export interface ConversationControllerDeps {
  readonly service: ConversationServicePort;
}

function credentials(req: Request): ConversationCredentials {
  const parsed = parseOrThrow(conversationCredentialHeadersSchema, {
    "x-participant-token": req.headers["x-participant-token"],
  });
  return { participantToken: parsed["x-participant-token"] };
}

export function createConversationRouter(deps: ConversationControllerDeps): Router {
  const router = Router();

  // POST /api/v1/conversations — the table's one conversation for this seating.
  router.post("/", async (req, res) => {
    const data = await deps.service.getOrCreate(credentials(req));
    res.status(200).json({ success: true, data });
  });

  // GET /api/v1/conversations/:conversation_id — shared history for the room.
  router.get("/:conversation_id", async (req, res) => {
    const params = parseOrThrow(conversationParamsSchema, req.params);
    const data = await deps.service.getConversation(
      params.conversation_id,
      credentials(req),
    );
    res.status(200).json({ success: true, data });
  });

  // POST /api/v1/conversations/:conversation_id/messages
  router.post("/:conversation_id/messages", async (req, res) => {
    const params = parseOrThrow(conversationParamsSchema, req.params);
    const body = parseOrThrow(postConversationMessageSchema, req.body);
    const data = await deps.service.postMessage(
      params.conversation_id,
      credentials(req),
      body,
    );
    res.status(200).json({ success: true, data });
  });

  // POST /api/v1/conversations/:conversation_id/voice/start
  router.post("/:conversation_id/voice/start", async (req, res) => {
    const params = parseOrThrow(conversationParamsSchema, req.params);
    const body = parseOrThrow(startVoiceSchema, req.body);
    const data = await deps.service.startVoice(
      params.conversation_id,
      credentials(req),
      body.device_id,
    );
    res.status(201).json({ success: true, data });
  });

  // POST /api/v1/conversations/:conversation_id/voice/:interaction_id/end
  router.post("/:conversation_id/voice/:interaction_id/end", async (req, res) => {
    const params = parseOrThrow(endVoiceParamsSchema, req.params);
    const body = parseOrThrow(startVoiceSchema, req.body);
    const data = await deps.service.endVoice(
      params.conversation_id,
      params.interaction_id,
      credentials(req),
      body.device_id,
    );
    res.status(200).json({ success: true, data });
  });

  return router;
}
