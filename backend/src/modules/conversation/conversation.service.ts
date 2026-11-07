/* Conversation module — service.

   The service owns the room rules and nothing else:
     * authorize the guest against the table roster before every read/write;
     * one conversation per seating;
     * one message per client retry key;
     * one active voice interaction, owned by participant + device;
     * AI context is the persisted transcript, and tool calls go through the
       injected tool port (which calls existing business services).

   It never touches SQL or Socket.IO. Broadcast failures are reported through
   onPublishError, because a saved message must not be rolled back by a phone
   that happened to be offline. */

import { AppError } from "../../errors/app-error.js";
import { iso } from "../../lib/util.js";
import type {
  AiContextMessage,
  AiToolResult,
  AiTurn,
  Conversation,
  ConversationAction,
  ConversationAiProvider,
  ConversationCredentials,
  ConversationMembership,
  ConversationMessage,
  ConversationMessageRow,
  ConversationRealtimePort,
  ConversationRepositoryPort,
  ConversationRow,
  ConversationServicePort,
  ConversationToolPort,
  PostMessageInput,
  PostMessageResult,
  VoiceInteraction,
  VoiceInteractionRow,
  VoiceStatus,
} from "./conversation.types.js";

const TRANSCRIPT_LIMIT = 200;
const AI_CONTEXT_LIMIT = 50;
const AI_TOOL_ROUNDS = 4;

export interface ConversationServiceDeps {
  readonly repository: ConversationRepositoryPort;
  readonly realtime: ConversationRealtimePort;
  readonly tools: ConversationToolPort;
  readonly aiProvider?: ConversationAiProvider | null;
  readonly onPublishError?: (err: unknown) => void;
}

function conversationDto(row: ConversationRow): Conversation {
  return {
    conversation_id: row.id,
    table_id: row.table_id,
    session_started_at: iso(row.session_started_at),
    created_at: iso(row.created_at),
  };
}

function actionsOf(value: unknown): ConversationAction[] {
  if (!Array.isArray(value)) return [];
  const actions: ConversationAction[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { kind?: unknown; label?: unknown; ok?: unknown };
    if (
      (candidate.kind === "cart" ||
        candidate.kind === "order" ||
        candidate.kind === "bill" ||
        candidate.kind === "info") &&
      typeof candidate.label === "string" &&
      typeof candidate.ok === "boolean"
    ) {
      actions.push({ kind: candidate.kind, label: candidate.label, ok: candidate.ok });
    }
  }
  return actions;
}

function metadataOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function messageDto(row: ConversationMessageRow): ConversationMessage {
  const metadata = metadataOf(row.metadata);
  const playback =
    typeof metadata.voice_playback_device_id === "string"
      ? metadata.voice_playback_device_id
      : null;
  const origin =
    typeof metadata.origin_participant_id === "string"
      ? metadata.origin_participant_id
      : row.participant_id;

  return {
    message_id: row.id,
    conversation_id: row.conversation_id,
    role: row.role,
    kind: row.kind,
    text: row.text,
    participant:
      row.participant_id === null
        ? null
        : { participant_id: row.participant_id, name: row.participant_name },
    origin_participant_id: origin,
    client_message_id: row.client_message_id,
    reply_to_message_id: row.reply_to_message_id,
    actions: actionsOf(row.actions),
    voice_playback_device_id: playback,
    created_at: iso(row.created_at),
  };
}

function voiceDto(row: VoiceInteractionRow): VoiceInteraction {
  return {
    interaction_id: row.id,
    conversation_id: row.conversation_id,
    status: row.status,
    initiator_participant_id: row.initiator_participant_id,
    initiator_device_id: row.initiator_device_id,
    playback_device_id: row.initiator_device_id,
    playback_participant_id: row.initiator_participant_id,
    started_at: iso(row.started_at),
    ended_at: row.ended_at ? iso(row.ended_at) : null,
  };
}

function sameSeating(left: ConversationRow, right: ConversationMembership): boolean {
  return (
    left.table_id === right.table_id &&
    left.session_started_at.getTime() === right.session_started_at.getTime()
  );
}

export class ConversationService implements ConversationServicePort {
  private readonly repository: ConversationRepositoryPort;
  private readonly realtime: ConversationRealtimePort;
  private readonly tools: ConversationToolPort;
  private readonly aiProvider: ConversationAiProvider | null;
  private readonly onPublishError: (err: unknown) => void;

  constructor(deps: ConversationServiceDeps) {
    this.repository = deps.repository;
    this.realtime = deps.realtime;
    this.tools = deps.tools;
    this.aiProvider = deps.aiProvider ?? null;
    this.onPublishError = deps.onPublishError ?? (() => undefined);
  }

  /* ------------------------------------------------------------- access */

  async getOrCreate(credentials: ConversationCredentials): Promise<{
    conversation: Conversation;
    messages: ConversationMessage[];
  }> {
    const membership = await this.requireMembership(credentials);
    const row = await this.repository.findOrCreateConversation(
      membership.table_id,
      membership.session_started_at,
    );
    return this.view(row);
  }

  async getConversation(
    conversationId: string,
    credentials: ConversationCredentials,
  ): Promise<{ conversation: Conversation; messages: ConversationMessage[] }> {
    const membership = await this.requireMembership(credentials);
    const conversation = await this.requireConversation(conversationId, membership);
    return this.view(conversation);
  }

  /* ------------------------------------------------------------ messages */

  async postMessage(
    conversationId: string,
    credentials: ConversationCredentials,
    input: PostMessageInput,
  ): Promise<PostMessageResult> {
    const membership = await this.requireMembership(credentials);
    const conversation = await this.requireConversation(conversationId, membership);

    const text = input.text.trim();
    if (!text) {
      throw new AppError(400, "VALIDATION_ERROR", "A message cannot be empty.", {
        fields: { text: "A message cannot be empty." },
      });
    }
    if (text.length > 4000) {
      throw new AppError(400, "VALIDATION_ERROR", "A message may be at most 4000 characters.", {
        fields: { text: "A message may be at most 4000 characters." },
      });
    }

    const kind = input.kind ?? "text";
    if (kind === "voice") {
      await this.assertVoiceOwnership(conversationId, membership, input);
    }

    const clientMessageId = input.client_message_id?.trim() || null;
    if (clientMessageId !== null) {
      const existing = await this.repository.findMessageByClientId(
        conversationId,
        clientMessageId,
      );
      if (existing) return this.duplicateResult(conversationId, existing);
    }

    const row = await this.repository.insertMessage({
      conversationId,
      tableId: conversation.table_id,
      role: "guest",
      kind,
      participantId: membership.participant_id,
      participantName: membership.participant_name,
      text,
      clientMessageId,
      replyToMessageId: null,
      actions: [],
      metadata: { origin_participant_id: membership.participant_id },
    });

    if (row === null) {
      // A concurrent retry with the same key won. Return its message and the
      // answer already produced for it; never run the AI a second time.
      if (clientMessageId === null) {
        throw new AppError(409, "DUPLICATE_MESSAGE", "The message was already stored.");
      }
      const existing = await this.repository.findMessageByClientId(
        conversationId,
        clientMessageId,
      );
      if (!existing) {
        throw new AppError(409, "DUPLICATE_MESSAGE", "The message was already stored.");
      }
      return this.duplicateResult(conversationId, existing);
    }

    const guestMessage = messageDto(row);
    this.publish(conversation.table_id, "conversation.message.created", guestMessage);

    if (this.aiProvider === null) {
      return {
        conversation_id: conversationId,
        message: guestMessage,
        assistant: null,
        duplicate: false,
      };
    }

    let turn: { text: string; actions: ConversationAction[]; toolRounds: number };
    try {
      turn = await this.answer(conversation, membership);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        502,
        "AI_UNAVAILABLE",
        "The assistant could not answer. Your message was saved.",
      );
    }

    if (!turn.text.trim() && turn.actions.length === 0) {
      return {
        conversation_id: conversationId,
        message: guestMessage,
        assistant: null,
        duplicate: false,
      };
    }

    const voice = kind === "voice" ? input : null;
    const assistantRow = await this.repository.insertMessage({
      conversationId,
      tableId: conversation.table_id,
      role: "assistant",
      kind,
      participantId: null,
      participantName: "Chhotu",
      text: turn.text.trim(),
      clientMessageId: null,
      replyToMessageId: row.id,
      actions: turn.actions,
      metadata: {
        tool_rounds: turn.toolRounds,
        origin_participant_id: membership.participant_id,
        ...(voice
          ? {
              voice_interaction_id: voice.voice_interaction_id,
              voice_playback_device_id: voice.device_id ?? null,
              voice_playback_participant_id: membership.participant_id,
            }
          : {}),
      },
    });

    if (assistantRow === null) {
      throw new AppError(500, "INTERNAL_ERROR", "The assistant reply could not be stored.");
    }

    const assistant = messageDto(assistantRow);
    this.publish(conversation.table_id, "conversation.message.created", assistant);

    return {
      conversation_id: conversationId,
      message: guestMessage,
      assistant,
      duplicate: false,
    };
  }

  /* --------------------------------------------------------------- voice */

  async startVoice(
    conversationId: string,
    credentials: ConversationCredentials,
    deviceId: string,
  ): Promise<VoiceInteraction> {
    const membership = await this.requireMembership(credentials);
    const conversation = await this.requireConversation(conversationId, membership);
    const device = deviceId.trim();
    if (!device) {
      throw new AppError(400, "VALIDATION_ERROR", "A device id is required.", {
        fields: { device_id: "A device id is required." },
      });
    }

    const row = await this.repository.insertVoice({
      conversationId,
      participantId: membership.participant_id,
      deviceId: device,
    });

    if (row === null) {
      const active = await this.repository.findActiveVoice(conversationId);
      throw new AppError(
        409,
        "VOICE_IN_PROGRESS",
        "Someone else is already using the table's voice line.",
        active
          ? {
              interaction_id: active.id,
              initiator_participant_id: active.initiator_participant_id,
              initiator_device_id: active.initiator_device_id,
            }
          : undefined,
      );
    }

    const dto = voiceDto(row);
    this.publish(conversation.table_id, "conversation.voice.started", {
      ...dto,
      playback_scope: "initiator",
    });
    return dto;
  }

  async endVoice(
    conversationId: string,
    interactionId: string,
    credentials: ConversationCredentials,
    deviceId: string,
  ): Promise<VoiceInteraction> {
    const membership = await this.requireMembership(credentials);
    const conversation = await this.requireConversation(conversationId, membership);
    const voice = await this.repository.findVoice(interactionId);

    if (!voice || voice.conversation_id !== conversationId) {
      throw new AppError(404, "VOICE_NOT_FOUND", "Unknown voice interaction.");
    }
    if (
      voice.initiator_participant_id !== membership.participant_id ||
      voice.initiator_device_id !== deviceId.trim()
    ) {
      throw new AppError(
        403,
        "VOICE_NOT_INITIATOR",
        "Only the guest who started this voice interaction can end it.",
      );
    }

    if (voice.status !== "active") return voiceDto(voice);

    const ended = await this.repository.endVoice({
      interactionId,
      conversationId,
      participantId: membership.participant_id,
      deviceId: deviceId.trim(),
    });

    if (ended === null) {
      const current = await this.repository.findVoice(interactionId);
      if (current && current.status === "completed") return voiceDto(current);
      throw new AppError(409, "VOICE_NOT_ACTIVE", "That voice interaction is no longer active.");
    }

    const dto = voiceDto(ended);
    this.publish(conversation.table_id, "conversation.voice.ended", {
      ...dto,
      playback_scope: "initiator",
    });
    return dto;
  }

  /* ------------------------------------------------------------- internal */

  private async requireMembership(
    credentials: ConversationCredentials,
  ): Promise<ConversationMembership> {
    const membership = await this.repository.findMembership(
      credentials.tableToken,
      credentials.sessionSecret,
      credentials.participantId,
    );
    if (membership === null) {
      throw new AppError(
        403,
        "NOT_TABLE_MEMBER",
        "This device is not a member of an active table session.",
      );
    }
    return membership;
  }

  private async requireConversation(
    conversationId: string,
    membership: ConversationMembership,
  ): Promise<ConversationRow> {
    const conversation = await this.repository.findConversation(conversationId);
    if (conversation === null || !sameSeating(conversation, membership)) {
      // NotFound also for an old seating: the next party must not learn that
      // a previous conversation exists.
      throw new AppError(
        404,
        "CONVERSATION_NOT_FOUND",
        "Unknown conversation for this table session.",
      );
    }
    return conversation;
  }

  private async view(row: ConversationRow): Promise<{
    conversation: Conversation;
    messages: ConversationMessage[];
  }> {
    const messages = await this.repository.listMessages(row.id, TRANSCRIPT_LIMIT);
    return {
      conversation: conversationDto(row),
      messages: messages.map(messageDto),
    };
  }

  private async duplicateResult(
    conversationId: string,
    existing: ConversationMessageRow,
  ): Promise<PostMessageResult> {
    const reply = await this.repository.findAssistantReply(existing.id);
    return {
      conversation_id: conversationId,
      message: messageDto(existing),
      assistant: reply ? messageDto(reply) : null,
      duplicate: true,
    };
  }

  private async assertVoiceOwnership(
    conversationId: string,
    membership: ConversationMembership,
    input: PostMessageInput,
  ): Promise<void> {
    if (!input.voice_interaction_id || !input.device_id) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Voice messages need a voice_interaction_id and device_id.",
        { fields: { voice_interaction_id: "Required for a voice message." } },
      );
    }

    const voice = await this.repository.findVoice(input.voice_interaction_id);
    if (!voice || voice.conversation_id !== conversationId) {
      throw new AppError(404, "VOICE_NOT_FOUND", "Unknown voice interaction.");
    }
    if (voice.status !== "active") {
      throw new AppError(409, "VOICE_NOT_ACTIVE", "That voice interaction has ended.");
    }
    if (
      voice.initiator_participant_id !== membership.participant_id ||
      voice.initiator_device_id !== input.device_id.trim()
    ) {
      throw new AppError(
        403,
        "VOICE_NOT_INITIATOR",
        "Only the device that started this voice interaction can speak on it.",
      );
    }
  }

  private async answer(
    conversation: ConversationRow,
    membership: ConversationMembership,
  ): Promise<{ text: string; actions: ConversationAction[]; toolRounds: number }> {
    const rows = await this.repository.listMessages(conversation.id, AI_CONTEXT_LIMIT);
    const messages: AiContextMessage[] = rows
      .filter((row) => row.role === "guest" || row.role === "assistant")
      .filter((row) => row.text.trim().length > 0)
      .map((row) => ({
        role: row.role === "guest" ? "guest" : "assistant",
        text: row.text,
      }));

    let toolResults: AiToolResult[] | undefined;
    const actions: ConversationAction[] = [];

    for (let round = 0; round <= AI_TOOL_ROUNDS; round += 1) {
      const turn: AiTurn = await this.aiProvider!.respond({
        conversation: conversationDto(conversation),
        membership,
        messages,
        tools: this.tools.declarations,
        ...(toolResults ? { tool_results: toolResults } : {}),
      });

      const calls = turn.tool_calls ?? [];
      if (calls.length === 0) {
        return {
          text: turn.text,
          actions: [...actions, ...(turn.actions ?? [])],
          toolRounds: round,
        };
      }
      if (round === AI_TOOL_ROUNDS) break;

      const results: AiToolResult[] = [];
      for (const call of calls) {
        const execution = await this.tools.execute(call.name, call.arguments, {
          tableToken: membership.table_code,
          participantName: membership.participant_name,
        });
        actions.push(...(execution.actions ?? []));
        results.push({
          tool_call_id: call.id,
          name: call.name,
          ok: execution.ok,
          data: execution.data,
        });
      }
      toolResults = results;
    }

    throw new AppError(
      502,
      "AI_TOOL_LIMIT",
      "The assistant could not finish its tool work. Your message was saved.",
    );
  }

  private publish(tableId: string, event: string, data: unknown): void {
    try {
      this.realtime.toTable(tableId, event, data);
    } catch (err) {
      this.onPublishError(err);
    }
  }
}

export type { VoiceStatus };
