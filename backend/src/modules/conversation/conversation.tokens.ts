/* Conversation module's DI token. */

import { createToken } from "../../bootstrap/Container.js";
import type { ConversationServicePort } from "./conversation.types.js";

export const CONVERSATION_TOKENS = {
  service: createToken<ConversationServicePort>("conversation.service"),
} as const;
