/* Conversation module — request validation.

   Credentials live in headers, never in a URL, so a table pass cannot end up
   in access logs or browser history. The table and participant identity are
   still re-checked against the roster by the service; these schemas only make
   malformed input cheap to refuse. */

import { z } from "zod";
import { tableToken, uuid } from "../../validation/primitives.js";

const participantId = z
  .string()
  .trim()
  .min(1, "participant id is required")
  .max(120, "participant id must be 120 characters or fewer");

const sessionSecret = z
  .string()
  .regex(/^[A-Za-z0-9]{20}$/, "session secret must be the 20-character table pass");

export const conversationCredentialHeadersSchema = z.object({
  "x-table-token": tableToken,
  "x-table-secret": sessionSecret,
  "x-participant-id": participantId,
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
