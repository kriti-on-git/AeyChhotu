/* Conversation module — service.

   The service owns the room rules and nothing else:
     * authorize the participant credential BEFORE any read/write, inside the
       same transaction that writes, after Table has locked the table row;
     * one conversation per seating;
     * one message per client retry key;
     * one active voice interaction, owned by participant + device;
     * AI context is the persisted transcript, and tool calls go through the
       injected tool port (which calls existing business services).

   PHASE 5.2 CHANGES
     * authorization is `X-Participant-Token` only. The table pass and a
       client-supplied participant id no longer authorize anything.
     * every write is transactional and writes its realtime event to the
       outbox in the same transaction. The service never publishes directly.
     * the guest message commits BEFORE the AI provider is called, and the
       assistant reply is inserted in a NEW transaction that revalidates the
       same seating and conversation. A clear that wins the race makes the
       late reply a no-op: no row, no outbox event, no recreated conversation. */

import { AppError } from "../../errors/app-error.js";
import { iso } from "../../lib/util.js";
import type { DbTransaction } from "../../infrastructure/database/DatabaseManager.js";
import type { ConversationOutboxPort } from "../realtime-outbox/realtime-outbox.types.js";
import type { ParticipantPrincipal } from "../table/table.types.js";
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
  ConversationParticipantPort,
  ConversationRepositoryPort,
  ConversationRow,
  ConversationServicePort,
  ConversationToolPort,
  PostMessageInput,
  PostMessageResult,
  VoiceInteraction,
  VoiceInteractionRow,
} from "./conversation.types.js";

const TRANSCRIPT_LIMIT = 200;
const AI_CONTEXT_LIMIT = 50;
const AI_TOOL_ROUNDS = 4;

export interface ConversationServiceDeps {
  readonly repository: ConversationRepositoryPort;
  /** Table's transactional participant guard. */
  readonly participants: ConversationParticipantPort;
  readonly tools: ConversationToolPort;
  /** Written in the same transaction as each business row. */
  readonly outbox: ConversationOutboxPort;
  readonly aiProvider?: ConversationAiProvider | null;
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

function membershipOf(principal: ParticipantPrincipal): ConversationMembership {
  return {
    table_id: principal.table_id,
    table_code: principal.table_code,
    session_started_at: principal.session_started_at,
    participant_id: principal.participant_id,
    participant_name: principal.name,
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
  private readonly participants: ConversationParticipantPort;
  private readonly tools: ConversationToolPort;
  private readonly outbox: ConversationOutboxPort;
  private readonly aiProvider: ConversationAiProvider | null;

  constructor(deps: ConversationServiceDeps) {
    this.repository = deps.repository;
    this.participants = deps.participants;
    this.tools = deps.tools;
    this.outbox = deps.outbox;
    this.aiProvider = deps.aiProvider ?? null;
  }

  /* ------------------------------------------------------------- access */

  async getOrCreate(credentials: ConversationCredentials): Promise<{
    conversation: Conversation;
    messages: ConversationMessage[];
  }> {
    const row = await this.repository.transaction(async (tx) => {
      const membership = await this.requireMembership(tx, credentials);
      return this.repository.findOrCreateConversation(
        tx,
        membership.table_id,
        membership.session_started_at,
      );
    });
    return this.view(row);
  }

  async getConversation(
    conversationId: string,
    credentials: ConversationCredentials,
  ): Promise<{ conversation: Conversation; messages: ConversationMessage[] }> {
    const conversation = await this.repository.transaction(async (tx) => {
      const membership = await this.requireMembership(tx, credentials);
      return this.requireConversation(tx, conversationId, membership);
    });
    return this.view(conversation);
  }

  /* ------------------------------------------------------------ messages */

  async postMessage(
    conversationId: string,
    credentials: ConversationCredentials,
    input: PostMessageInput,
  ): Promise<PostMessageResult> {
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

    /* Transaction 1: authorize under the table lock, then persist the guest
       turn AND its outbox row atomically. Nothing external happens here. */
    const prepared = await this.repository.transaction(async (tx) => {
      const membership = await this.requireMembership(tx, credentials);
      const conversation = await this.requireConversation(tx, conversationId, membership);

      if (kind === "voice") {
        await this.assertVoiceOwnership(tx, conversationId, membership, input);
      }

      const clientMessageId = input.client_message_id?.trim() || null;
      if (clientMessageId !== null) {
        const existing = await this.repository.findMessageByClientId(
          tx,
          conversationId,
          clientMessageId,
        );
        if (existing) {
          return { duplicate: existing, row: null, membership, conversation };
        }
      }

      const row = await this.repository.insertMessage(tx, {
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
        if (clientMessageId === null) {
          throw new AppError(409, "DUPLICATE_MESSAGE", "The message was already stored.");
        }
        const existing = await this.repository.findMessageByClientId(
          tx,
          conversationId,
          clientMessageId,
        );
        if (!existing) {
          throw new AppError(409, "DUPLICATE_MESSAGE", "The message was already stored.");
        }
        return { duplicate: existing, row: null, membership, conversation };
      }

      await this.outbox.enqueueConversationEvent(tx, {
        tableId: conversation.table_id,
        sessionStartedAt: conversation.session_started_at,
        conversationId,
        event: "conversation.message.created",
        payload: {
          table_id: conversation.table_id,
          conversation_id: conversationId,
          message: messageDto(row),
        },
      });

      return { duplicate: null, row, membership, conversation };
    });

    if (prepared.duplicate !== null) {
      return this.duplicateResult(conversationId, prepared.duplicate);
    }

    const guestRow = prepared.row;
    if (guestRow === null) {
      throw new AppError(409, "DUPLICATE_MESSAGE", "The message was already stored.");
    }
    const guestMessage = messageDto(guestRow);

    if (this.aiProvider === null) {
      return {
        conversation_id: conversationId,
        message: guestMessage,
        assistant: null,
        duplicate: false,
      };
    }

    /* Provider work happens OUTSIDE every transaction. */
    let turn: { text: string; actions: ConversationAction[]; toolRounds: number };
    try {
      turn = await this.answer(prepared.conversation, prepared.membership, credentials);
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

    /* Transaction 2: revalidate the SAME seating/conversation. A clear or a
       new seating that committed during the provider call makes this a
       no-op; it can never recreate a deleted conversation. */
    const assistantRow = await this.repository.transaction(async (tx) => {
      const membership = await this.resolveMembership(tx, credentials);
      if (membership === null) return null;
      if (membership.table_id !== prepared.membership.table_id) return null;
      if (
        membership.session_started_at.getTime() !==
        prepared.membership.session_started_at.getTime()
      ) {
        return null;
      }

      const conversation = await this.repository.findConversation(tx, conversationId);
      if (conversation === null || !sameSeating(conversation, membership)) return null;

      const row = await this.repository.insertMessage(tx, {
        conversationId,
        tableId: conversation.table_id,
        role: "assistant",
        kind,
        participantId: null,
        participantName: "Chhotu",
        text: turn.text.trim(),
        clientMessageId: null,
        replyToMessageId: guestRow.id,
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

      if (row === null) return null;

      await this.outbox.enqueueConversationEvent(tx, {
        tableId: conversation.table_id,
        sessionStartedAt: conversation.session_started_at,
        conversationId,
        event: "conversation.message.created",
        payload: {
          table_id: conversation.table_id,
          conversation_id: conversationId,
          message: messageDto(row),
        },
      });

      return row;
    });

    if (assistantRow === null) {
      /* Late response after clear/new seating: discard it silently. The guest
         message that committed before the clear is handled by the clear
         transaction itself. */
      return {
        conversation_id: conversationId,
        message: guestMessage,
        assistant: null,
        duplicate: false,
      };
    }

    return {
      conversation_id: conversationId,
      message: guestMessage,
      assistant: messageDto(assistantRow),
      duplicate: false,
    };
  }

  /* --------------------------------------------------------------- voice */

  async startVoice(
    conversationId: string,
    credentials: ConversationCredentials,
    deviceId: string,
  ): Promise<VoiceInteraction> {
    const device = deviceId.trim();
    if (!device) {
      throw new AppError(400, "VALIDATION_ERROR", "A device id is required.", {
        fields: { device_id: "A device id is required." },
      });
    }

    const row = await this.repository.transaction(async (tx) => {
      const membership = await this.requireMembership(tx, credentials);
      const conversation = await this.requireConversation(tx, conversationId, membership);

      const inserted = await this.repository.insertVoice(tx, {
        conversationId,
        participantId: membership.participant_id,
        deviceId: device,
      });

      if (inserted === null) {
        const active = await this.repository.findActiveVoice(tx, conversationId);
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

      await this.outbox.enqueueConversationEvent(tx, {
        tableId: conversation.table_id,
        sessionStartedAt: conversation.session_started_at,
        conversationId,
        event: "conversation.voice.started",
        payload: {
          table_id: conversation.table_id,
          conversation_id: conversationId,
          interaction: voiceDto(inserted),
          playback_scope: "initiator",
        },
      });

      return inserted;
    });

    return voiceDto(row);
  }

  async endVoice(
    conversationId: string,
    interactionId: string,
    credentials: ConversationCredentials,
    deviceId: string,
  ): Promise<VoiceInteraction> {
    const device = deviceId.trim();

    const row = await this.repository.transaction(async (tx) => {
      const membership = await this.requireMembership(tx, credentials);
      const conversation = await this.requireConversation(tx, conversationId, membership);
      const voice = await this.repository.findVoice(tx, interactionId);

      if (!voice || voice.conversation_id !== conversationId) {
        throw new AppError(404, "VOICE_NOT_FOUND", "Unknown voice interaction.");
      }
      if (
        voice.initiator_participant_id !== membership.participant_id ||
        voice.initiator_device_id !== device
      ) {
        throw new AppError(
          403,
          "VOICE_NOT_INITIATOR",
          "Only the guest who started this voice interaction can end it.",
        );
      }

      if (voice.status !== "active") return voice;

      const ended = await this.repository.endVoice(tx, {
        interactionId,
        conversationId,
        participantId: membership.participant_id,
        deviceId: device,
      });

      if (ended === null) {
        const current = await this.repository.findVoice(tx, interactionId);
        if (current && current.status === "completed") return current;
        throw new AppError(409, "VOICE_NOT_ACTIVE", "That voice interaction is no longer active.");
      }

      await this.outbox.enqueueConversationEvent(tx, {
        tableId: conversation.table_id,
        sessionStartedAt: conversation.session_started_at,
        conversationId,
        event: "conversation.voice.ended",
        payload: {
          table_id: conversation.table_id,
          conversation_id: conversationId,
          interaction: voiceDto(ended),
          playback_scope: "initiator",
        },
      });

      return ended;
    });

    return voiceDto(row);
  }

  /* ------------------------------------------------------------- internal */

  private async resolveMembership(
    tx: DbTransaction,
    credentials: ConversationCredentials,
  ): Promise<ConversationMembership | null> {
    const principal = await this.participants.authorizeParticipantInTransaction(
      tx,
      credentials.participantToken,
    );
    return principal === null ? null : membershipOf(principal);
  }

  private async requireMembership(
    tx: DbTransaction,
    credentials: ConversationCredentials,
  ): Promise<ConversationMembership> {
    const membership = await this.resolveMembership(tx, credentials);
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
    tx: DbTransaction,
    conversationId: string,
    membership: ConversationMembership,
  ): Promise<ConversationRow> {
    const conversation = await this.repository.findConversation(tx, conversationId);
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

  private async assertSeatingActive(
    conversation: ConversationRow,
    credentials: ConversationCredentials,
  ): Promise<void> {
    const active = await this.repository.transaction(async (tx) => {
      const membership = await this.resolveMembership(tx, credentials);
      if (membership === null) return false;
      if (membership.table_id !== conversation.table_id) return false;
      if (
        membership.session_started_at.getTime() !==
        conversation.session_started_at.getTime()
      ) {
        return false;
      }
      const current = await this.repository.findConversation(tx, conversation.id);
      return current !== null && sameSeating(current, membership);
    });

    if (!active) {
      throw new AppError(
        409,
        "SESSION_ENDED",
        "This table session ended before the assistant finished.",
      );
    }
  }

  private async assertVoiceOwnership(
    tx: DbTransaction,
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

    const voice = await this.repository.findVoice(tx, input.voice_interaction_id);
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
    credentials: ConversationCredentials,
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
        participant_name: membership.participant_name,
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
        /* Re-authorize against the live seating immediately before each tool.
           A clear/revocation during the provider call therefore cannot let a
           queued tool mutate the next party's table. */
        await this.assertSeatingActive(conversation, credentials);
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
}
