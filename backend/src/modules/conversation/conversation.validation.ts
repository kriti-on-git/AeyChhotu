/* Conversation module — request validation.

   Phase 5.2: the only credential is the server-issued participant token in
   `X-Participant-Token`. It lives in a header, never a URL, and the service
   validates it transactionally against the roster. */

import { z } from "zod";
import { uuid } from "../../validation/primitives.js";

export const conversationCredentialHeadersSchema = z.object({
  "x-participant-token": z
    .string()
    .trim()
    .regex(/^pc_[A-Za-z0-9_-]{43}$/, "A participant credential is required."),
});

export const conversationParamsSchema = z.object({
  conversation_id: uuid("conversation_id"),
});

export const endVoiceParamsSchema = conversationParamsSchema.extend({
  interaction_id: uuid("interaction_id"),
});

export const startVoiceSchema = z.object({
  device_id: z
    .string()
    .trim()
    .min(1, "device_id is required")
    .max(100, "device_id must be 100 characters or fewer"),
});

export const postConversationMessageSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "A message cannot be empty.")
      .max(4000, "A message may be at most 4000 characters."),
    client_message_id: z.string().trim().min(1).max(120).optional(),
    kind: z.enum(["text", "voice"]).default("text"),
    voice_interaction_id: uuid("voice_interaction_id").optional(),
    device_id: z.string().trim().min(1).max(100).optional(),
  })
  .refine(
    (body) =>
      body.kind !== "voice" ||
      (body.voice_interaction_id !== undefined && body.device_id !== undefined),
    {
      message: "A voice message needs voice_interaction_id and device_id.",
      path: ["voice_interaction_id"],
    },
  );
