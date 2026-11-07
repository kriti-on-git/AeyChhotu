/* Conversation module — contracts.

   ONE CONVERSATION PER SEATING. The transcript is shared: every authorized
   guest reads every message, and every assistant answer is broadcast to the
   table room. A cleared table starts a new session and a new conversation, so
   the next party can never read the previous one.

   VOICE is deliberately simple: one active voice interaction per conversation
   (partial unique index), owned by the participant AND device that started it.
   Every client receives the answer text, but the payload names the initiating
   device and only that device may play the audio.

   AI: providers implement one port. The service sends context, executes the
   provider's tool calls through ConversationToolPort (which itself calls the
   existing Menu/Cart/Orders/Table public services), and persists the final
   answer. A model can therefore never write application data directly.

   SECRETS: a table session secret is accepted only for authorization. It is
   never stored in a message, returned in a DTO or given to the AI provider. */

import type { RealtimePublisher } from "../../infrastructure/realtime/RealtimePublisher.js";
import type { CartServicePort } from "../cart/cart.types.js";
import type { MenuServicePort } from "../menu/menu.types.js";
import type { OrdersServicePort } from "../orders/orders.types.js";
import type { TableServicePort } from "../table/table.types.js";

export type ConversationRole = "guest" | "assistant" | "system";
export type ConversationKind = "text" | "voice";
export type VoiceStatus = "active" | "completed" | "cancelled";

export type ConversationCredentials = {
  readonly tableToken: string;
  readonly sessionSecret: string;
  readonly participantId: string;
};

/** Resolved from the roster, never trusted from the request body. */
export type ConversationMembership = {
  table_id: string;
  table_code: string;
  session_started_at: Date;
  participant_id: string;
  participant_name: string;
};

export type ConversationRow = {
  id: string;
  table_id: string;
  session_started_at: Date;
  created_at: Date;
};

export type ConversationMessageRow = {
  id: string;
  conversation_id: string;
  table_id: string;
  sequence: string | number;
  role: ConversationRole;
  kind: ConversationKind;
  participant_id: string | null;
  participant_name: string;
  text: string;
  client_message_id: string | null;
  reply_to_message_id: string | null;
  actions: unknown;
  metadata: unknown;
  created_at: Date;
};

export type VoiceInteractionRow = {
  id: string;
  conversation_id: string;
  initiator_participant_id: string;
  initiator_device_id: string;
  status: VoiceStatus;
  started_at: Date;
  ended_at: Date | null;
};

export type ConversationAction = {
  kind: "cart" | "order" | "bill" | "info";
  label: string;
  ok: boolean;
};

export type Conversation = {
  conversation_id: string;
  table_id: string;
  session_started_at: string;
  created_at: string;
};

export type ConversationMessage = {
  message_id: string;
  conversation_id: string;
  role: ConversationRole;
  kind: ConversationKind;
  text: string;
  participant: { participant_id: string; name: string } | null;
  /** Who caused this message: the guest for a guest turn, the requesting
      guest for an assistant reply. Retained even for voice interactions. */
  origin_participant_id: string | null;
  client_message_id: string | null;
  reply_to_message_id: string | null;
  actions: ConversationAction[];
  voice_playback_device_id: string | null;
  created_at: string;
};

export type ConversationView = {
  conversation: Conversation;
  messages: ConversationMessage[];
};

export type PostMessageInput = {
  text: string;
  client_message_id?: string;
  kind?: ConversationKind;
  voice_interaction_id?: string;
  device_id?: string;
};

export type PostMessageResult = {
  conversation_id: string;
  message: ConversationMessage;
  assistant: ConversationMessage | null;
  duplicate: boolean;
};

export type VoiceInteraction = {
  interaction_id: string;
  conversation_id: string;
  status: VoiceStatus;
  initiator_participant_id: string;
  initiator_device_id: string;
  /** The only device that may play this interaction's answer. */
  playback_device_id: string;
  playback_participant_id: string;
  started_at: string;
  ended_at: string | null;
};

export type ConversationSchemaPresence = {
  readonly present: readonly string[];
  readonly missing: readonly string[];
};

/* ------------------------------------------------------------------ AI */

export type AiContextMessage = {
  readonly role: "guest" | "assistant";
  readonly text: string;
};

export type AiToolDeclaration = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
};

export type AiToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
};

export type AiToolResult = {
  readonly tool_call_id: string;
  readonly name: string;
  readonly ok: boolean;
  readonly data: unknown;
};

export type AiTurn = {
  readonly text: string;
  readonly actions?: readonly ConversationAction[];
  readonly tool_calls?: readonly AiToolCall[];
};

export type AiRespondInput = {
  readonly conversation: Conversation;
  readonly membership: ConversationMembership;
  readonly messages: readonly AiContextMessage[];
  readonly tools: readonly AiToolDeclaration[];
  /** Present only on a continuation after tool execution. */
  readonly tool_results?: readonly AiToolResult[];
};

/** The only AI dependency the service knows. A fake is used in tests; the
    browser's existing Gemini Live session remains a separate presentation
    concern. */
export interface ConversationAiProvider {
  respond(input: AiRespondInput): Promise<AiTurn>;
}

/* --------------------------------------------------------------- tools */

export type ConversationToolContext = {
  readonly tableToken: string;
  readonly participantName: string;
};

export type ConversationToolExecution = {
  readonly ok: boolean;
  readonly data: unknown;
  readonly actions?: readonly ConversationAction[];
  readonly mutated?: boolean;
};

export interface ConversationToolPort {
  readonly declarations: readonly AiToolDeclaration[];
  execute(
    name: string,
    args: Readonly<Record<string, unknown>>,
    context: ConversationToolContext,
  ): Promise<ConversationToolExecution>;
}

/** Narrow cross-module ports. The tool layer may only call these services. */
export type ConversationMenuPort = Pick<MenuServicePort, "listMenu">;
export type ConversationCartPort = Pick<
  CartServicePort,
  "listCart" | "addItem" | "updateItem" | "removeItem"
>;
export type ConversationOrdersPort = Pick<
  OrdersServicePort,
  "fireOrder" | "listOrders"
>;
export type ConversationTablePort = Pick<TableServicePort, "requestTableBill">;

export interface ConversationBusinessPorts {
  readonly menu: ConversationMenuPort;
  readonly cart: ConversationCartPort;
  readonly orders: ConversationOrdersPort;
  readonly tables: ConversationTablePort;
}

export type ConversationRealtimePort = Pick<RealtimePublisher, "toTable">;

/* ---------------------------------------------------------- repository */

export interface ConversationRepositoryPort {
  /** Validates token + pass AND proves the participant is on the roster. */
  findMembership(
    tableToken: string,
    sessionSecret: string,
    participantId: string,
  ): Promise<ConversationMembership | null>;

  findConversation(conversationId: string): Promise<ConversationRow | null>;
  findOrCreateConversation(
    tableId: string,
    sessionStartedAt: Date,
  ): Promise<ConversationRow>;

  listMessages(conversationId: string, limit: number): Promise<ConversationMessageRow[]>;
  findMessageByClientId(
    conversationId: string,
    clientMessageId: string,
  ): Promise<ConversationMessageRow | null>;
  findAssistantReply(messageId: string): Promise<ConversationMessageRow | null>;
  /** Returns null when the dedupe constraint won the race. */
  insertMessage(input: {
    conversationId: string;
    tableId: string;
    role: ConversationRole;
    kind: ConversationKind;
    participantId: string | null;
    participantName: string;
    text: string;
    clientMessageId: string | null;
    replyToMessageId: string | null;
    actions: readonly ConversationAction[];
    metadata: Readonly<Record<string, unknown>>;
  }): Promise<ConversationMessageRow | null>;

  findVoice(interactionId: string): Promise<VoiceInteractionRow | null>;
  findActiveVoice(conversationId: string): Promise<VoiceInteractionRow | null>;
  /** Null means another active interaction owns the room (unique index). */
  insertVoice(input: {
    conversationId: string;
    participantId: string;
    deviceId: string;
  }): Promise<VoiceInteractionRow | null>;
  endVoice(input: {
    interactionId: string;
    conversationId: string;
    participantId: string;
    deviceId: string;
  }): Promise<VoiceInteractionRow | null>;

  schemaObjects(): Promise<ConversationSchemaPresence>;
}

/* ------------------------------------------------------------- service */

export interface ConversationServicePort {
  getOrCreate(credentials: ConversationCredentials): Promise<ConversationView>;
  getConversation(
    conversationId: string,
    credentials: ConversationCredentials,
  ): Promise<ConversationView>;
  postMessage(
    conversationId: string,
    credentials: ConversationCredentials,
    input: PostMessageInput,
  ): Promise<PostMessageResult>;
  startVoice(
    conversationId: string,
    credentials: ConversationCredentials,
    deviceId: string,
  ): Promise<VoiceInteraction>;
  endVoice(
    conversationId: string,
    interactionId: string,
    credentials: ConversationCredentials,
    deviceId: string,
  ): Promise<VoiceInteraction>;
}
