/* Shared doubles for Conversation tests. Not a *.test.ts file, so the runner
   never executes it. */

import type {
  AiRespondInput,
  AiToolDeclaration,
  AiToolResult,
  AiTurn,
  ConversationAiProvider,
  ConversationCredentials,
  ConversationMembership,
  ConversationMessageRow,
  ConversationRepositoryPort,
  ConversationRow,
  ConversationToolContext,
  ConversationToolExecution,
  ConversationToolPort,
  VoiceInteractionRow,
} from "../../src/modules/conversation/conversation.types.js";
import type { RealtimeEnvelope, PublishResult } from "../../src/infrastructure/realtime/RealtimePublisher.js";

export const TABLE_ID = "11111111-1111-4111-8111-111111111111";
export const TABLE_CODE = "t4b2";
export const TABLE_SECRET = "abcdefghijklmnopqrst";
export const PARTICIPANT_A = "guest-a";
export const PARTICIPANT_B = "guest-b";
export const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
export const MENU_ITEM_ID = "33333333-3333-4333-8333-333333333333";
export const CART_ITEM_ID = "44444444-4444-4444-8444-444444444444";

const SESSION_STARTED_AT = new Date("2026-01-01T10:00:00.000Z");

export function credentials(participantId = PARTICIPANT_A): ConversationCredentials {
  return {
    tableToken: TABLE_CODE,
    sessionSecret: TABLE_SECRET,
    participantId,
  };
}

export function membership(participantId = PARTICIPANT_A): ConversationMembership {
  return {
    table_id: TABLE_ID,
    table_code: TABLE_CODE,
    session_started_at: SESSION_STARTED_AT,
    participant_id: participantId,
    participant_name: participantId === PARTICIPANT_A ? "Asha" : "Ravi",
  };
}

export class FakeConversationRepository implements ConversationRepositoryPort {
  sessionStartedAt = SESSION_STARTED_AT;
  conversation: ConversationRow | null = null;
  messages: ConversationMessageRow[] = [];
  voices: VoiceInteractionRow[] = [];

  private sequence = 0;
  private clock = 0;

  async findMembership(
    tableToken: string,
    sessionSecret: string,
    participantId: string,
  ): Promise<ConversationMembership | null> {
    if (
      tableToken !== TABLE_CODE ||
      sessionSecret !== TABLE_SECRET ||
      (participantId !== PARTICIPANT_A && participantId !== PARTICIPANT_B)
    ) {
      return null;
    }
    return {
      ...membership(participantId),
      session_started_at: this.sessionStartedAt,
    };
  }

  async findConversation(conversationId: string): Promise<ConversationRow | null> {
    return this.conversation?.id === conversationId ? this.conversation : null;
  }

  async findOrCreateConversation(
    tableId: string,
    sessionStartedAt: Date,
  ): Promise<ConversationRow> {
    if (this.conversation === null) {
      this.conversation = {
        id: CONVERSATION_ID,
        table_id: tableId,
        session_started_at: sessionStartedAt,
        created_at: this.timestamp(),
      };
    }
    return this.conversation;
  }

  async listMessages(
    conversationId: string,
    limit: number,
  ): Promise<ConversationMessageRow[]> {
    return this.messages
      .filter((message) => message.conversation_id === conversationId)
      .slice(-limit);
  }

  async findMessageByClientId(
    conversationId: string,
    clientMessageId: string,
  ): Promise<ConversationMessageRow | null> {
    return (
      this.messages.find(
        (message) =>
          message.conversation_id === conversationId &&
          message.client_message_id === clientMessageId,
      ) ?? null
    );
  }

  async findAssistantReply(messageId: string): Promise<ConversationMessageRow | null> {
    return (
      this.messages.find(
        (message) =>
          message.role === "assistant" && message.reply_to_message_id === messageId,
      ) ?? null
    );
  }

  async insertMessage(input: {
    conversationId: string;
    tableId: string;
    role: ConversationMessageRow["role"];
    kind: ConversationMessageRow["kind"];
    participantId: string | null;
    participantName: string;
    text: string;
    clientMessageId: string | null;
    replyToMessageId: string | null;
    actions: readonly unknown[];
    metadata: Readonly<Record<string, unknown>>;
  }): Promise<ConversationMessageRow | null> {
    if (
      input.clientMessageId !== null &&
      this.messages.some(
        (message) =>
          message.conversation_id === input.conversationId &&
          message.client_message_id === input.clientMessageId,
      )
    ) {
      return null;
    }

    this.sequence += 1;
    const row: ConversationMessageRow = {
      id: `00000000-0000-4000-8000-${String(this.sequence).padStart(12, "0")}`,
      conversation_id: input.conversationId,
      table_id: input.tableId,
      sequence: this.sequence,
      role: input.role,
      kind: input.kind,
      participant_id: input.participantId,
      participant_name: input.participantName,
      text: input.text,
      client_message_id: input.clientMessageId,
      reply_to_message_id: input.replyToMessageId,
      actions: [...input.actions],
      metadata: { ...input.metadata },
      created_at: this.timestamp(),
    };
    this.messages.push(row);
    return row;
  }

  async findVoice(interactionId: string): Promise<VoiceInteractionRow | null> {
    return this.voices.find((voice) => voice.id === interactionId) ?? null;
  }

  async findActiveVoice(conversationId: string): Promise<VoiceInteractionRow | null> {
    return (
      this.voices.find(
        (voice) =>
          voice.conversation_id === conversationId && voice.status === "active",
      ) ?? null
    );
  }

  async insertVoice(input: {
    conversationId: string;
    participantId: string;
    deviceId: string;
  }): Promise<VoiceInteractionRow | null> {
    if (await this.findActiveVoice(input.conversationId)) return null;

    const row: VoiceInteractionRow = {
      id: `55555555-5555-4555-8555-${String(this.voices.length + 1).padStart(12, "0")}`,
      conversation_id: input.conversationId,
      initiator_participant_id: input.participantId,
      initiator_device_id: input.deviceId,
      status: "active",
      started_at: this.timestamp(),
      ended_at: null,
    };
    this.voices.push(row);
    return row;
  }

  async endVoice(input: {
    interactionId: string;
    conversationId: string;
    participantId: string;
    deviceId: string;
  }): Promise<VoiceInteractionRow | null> {
    const row = this.voices.find(
      (voice) =>
        voice.id === input.interactionId &&
        voice.conversation_id === input.conversationId &&
        voice.status === "active" &&
        voice.initiator_participant_id === input.participantId &&
        voice.initiator_device_id === input.deviceId,
    );
    if (!row) return null;
    row.status = "completed";
    row.ended_at = this.timestamp();
    return row;
  }

  async schemaObjects() {
    return { present: ["conversations"], missing: [] };
  }

  private timestamp(): Date {
    this.clock += 1;
    return new Date(SESSION_STARTED_AT.getTime() + this.clock * 1_000);
  }
}

export class FakeAiProvider implements ConversationAiProvider {
  readonly inputs: AiRespondInput[] = [];
  private readonly turns: AiTurn[];

  constructor(turns: AiTurn[], fallback = "How can I help?") {
    this.turns = [...turns];
    this.fallback = fallback;
  }

  private readonly fallback: string;

  async respond(input: AiRespondInput): Promise<AiTurn> {
    this.inputs.push(input);
    return this.turns.shift() ?? { text: this.fallback };
  }
}

export class ThrowingAiProvider implements ConversationAiProvider {
  async respond(): Promise<AiTurn> {
    throw new Error("provider down");
  }
}

export class FakeToolPort implements ConversationToolPort {
  readonly declarations: readonly AiToolDeclaration[] = [
    { name: "add_to_cart", description: "add", parameters: { type: "object" } },
  ];
  readonly calls: Array<{
    name: string;
    args: Readonly<Record<string, unknown>>;
    context: ConversationToolContext;
  }> = [];
  execution: ConversationToolExecution = {
    ok: true,
    mutated: true,
    data: { added: true },
    actions: [{ kind: "cart", label: "Added 1 dish", ok: true }],
  };

  async execute(
    name: string,
    args: Readonly<Record<string, unknown>>,
    context: ConversationToolContext,
  ): Promise<ConversationToolExecution> {
    this.calls.push({ name, args, context });
    return this.execution;
  }
}

export class FakeRealtime {
  readonly events: Array<{ tableId: string; event: string; data: unknown }> = [];

  toTable(tableId: string, event: string, data: unknown): PublishResult {
    this.events.push({ tableId, event, data });
    return { room: `table:${tableId}`, event, recipients: 1, skipped: false };
  }
}

export type CapturedEnvelope = RealtimeEnvelope;
