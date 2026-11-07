/* Conversation module — repository.

   Every SQL statement for conversations, their transcript and voice
   interactions lives here. Authorization is NOT done here any more: the
   service asks Table's participant guard to validate the credential inside
   the same transaction, then this repository reads/writes.

   Reads that feed a response (transcript history, dedupe replies) may use the
   pool. Every write takes the caller's `DbTransaction`, so the message and
   its outbox row commit together. */

import type { DbPort, DbTransaction } from "../../infrastructure/database/DatabaseManager.js";
import type {
  ConversationAction,
  ConversationKind,
  ConversationMessageRow,
  ConversationRepositoryPort,
  ConversationRole,
  ConversationRow,
  ConversationSchemaPresence,
  VoiceInteractionRow,
} from "./conversation.types.js";

const MESSAGE_COLUMNS = `id, conversation_id, table_id, sequence, role, kind,
  participant_id, participant_name, text, client_message_id,
  reply_to_message_id, actions, metadata, created_at`;

const CONVERSATION_COLUMNS = `id, table_id, session_started_at, created_at`;

const VOICE_COLUMNS = `id, conversation_id, initiator_participant_id,
  initiator_device_id, status, started_at, ended_at`;

const SCHEMA_OBJECTS = [
  "conversations",
  "conversation_messages",
  "conversation_voice_interactions",
  "conversation_one_active_voice",
] as const;

export class ConversationRepository implements ConversationRepositoryPort {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  async findConversation(
    tx: DbTransaction,
    conversationId: string,
  ): Promise<ConversationRow | null> {
    const res = await tx.query<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = $1`,
      [conversationId],
    );
    return res.rows[0] ?? null;
  }

  async findOrCreateConversation(
    tx: DbTransaction,
    tableId: string,
    sessionStartedAt: Date,
  ): Promise<ConversationRow> {
    const res = await tx.query<ConversationRow>(
      `INSERT INTO conversations (table_id, session_started_at)
       VALUES ($1, $2)
       ON CONFLICT (table_id, session_started_at)
       DO UPDATE SET table_id = EXCLUDED.table_id
       RETURNING ${CONVERSATION_COLUMNS}`,
      [tableId, sessionStartedAt],
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error("The conversation could not be created.");
    }
    return row;
  }

  async listMessages(
    conversationId: string,
    limit: number,
  ): Promise<ConversationMessageRow[]> {
    /* Newest N, then restored to chronological order. Taking the OLDEST N
       would make a long conversation answer from its opening instead of its
       latest turns. */
    const res = await this.db.query<ConversationMessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM (
           SELECT ${MESSAGE_COLUMNS}
             FROM conversation_messages
            WHERE conversation_id = $1
            ORDER BY sequence DESC
            LIMIT $2
         ) AS recent
        ORDER BY sequence`,
      [conversationId, limit],
    );
    return res.rows;
  }

  async findMessageByClientId(
    tx: DbTransaction,
    conversationId: string,
    clientMessageId: string,
  ): Promise<ConversationMessageRow | null> {
    const res = await tx.query<ConversationMessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM conversation_messages
        WHERE conversation_id = $1 AND client_message_id = $2
        LIMIT 1`,
      [conversationId, clientMessageId],
    );
    return res.rows[0] ?? null;
  }

  async findAssistantReply(messageId: string): Promise<ConversationMessageRow | null> {
    const res = await this.db.query<ConversationMessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM conversation_messages
        WHERE reply_to_message_id = $1 AND role = 'assistant'
        ORDER BY sequence
        LIMIT 1`,
      [messageId],
    );
    return res.rows[0] ?? null;
  }

  async insertMessage(
    tx: DbTransaction,
    input: {
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
    },
  ): Promise<ConversationMessageRow | null> {
    const res = await tx.query<ConversationMessageRow>(
      `INSERT INTO conversation_messages
         (conversation_id, table_id, role, kind, participant_id,
          participant_name, text, client_message_id, reply_to_message_id,
          actions, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
       ON CONFLICT ON CONSTRAINT conversation_messages_client_dedupe
       DO NOTHING
       RETURNING ${MESSAGE_COLUMNS}`,
      [
        input.conversationId,
        input.tableId,
        input.role,
        input.kind,
        input.participantId,
        input.participantName,
        input.text,
        input.clientMessageId,
        input.replyToMessageId,
        JSON.stringify(input.actions),
        JSON.stringify(input.metadata),
      ],
    );
    return res.rows[0] ?? null;
  }

  async findVoice(
    tx: DbTransaction,
    interactionId: string,
  ): Promise<VoiceInteractionRow | null> {
    const res = await tx.query<VoiceInteractionRow>(
      `SELECT ${VOICE_COLUMNS}
         FROM conversation_voice_interactions
        WHERE id = $1`,
      [interactionId],
    );
    return res.rows[0] ?? null;
  }

  async findActiveVoice(
    tx: DbTransaction,
    conversationId: string,
  ): Promise<VoiceInteractionRow | null> {
    const res = await tx.query<VoiceInteractionRow>(
      `SELECT ${VOICE_COLUMNS}
         FROM conversation_voice_interactions
        WHERE conversation_id = $1 AND status = 'active'
        LIMIT 1`,
      [conversationId],
    );
    return res.rows[0] ?? null;
  }

  async insertVoice(
    tx: DbTransaction,
    input: {
      conversationId: string;
      participantId: string;
      deviceId: string;
    },
  ): Promise<VoiceInteractionRow | null> {
    const res = await tx.query<VoiceInteractionRow>(
      `INSERT INTO conversation_voice_interactions
         (conversation_id, initiator_participant_id, initiator_device_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id) WHERE status = 'active'
       DO NOTHING
       RETURNING ${VOICE_COLUMNS}`,
      [input.conversationId, input.participantId, input.deviceId],
    );
    return res.rows[0] ?? null;
  }

  async endVoice(
    tx: DbTransaction,
    input: {
      interactionId: string;
      conversationId: string;
      participantId: string;
      deviceId: string;
    },
  ): Promise<VoiceInteractionRow | null> {
    const res = await tx.query<VoiceInteractionRow>(
      `UPDATE conversation_voice_interactions
          SET status = 'completed', ended_at = now()
        WHERE id = $1
          AND conversation_id = $2
          AND status = 'active'
          AND initiator_participant_id = $3
          AND initiator_device_id = $4
        RETURNING ${VOICE_COLUMNS}`,
      [input.interactionId, input.conversationId, input.participantId, input.deviceId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Clear-time purge. The caller already holds the table row lock and the
   * session identity; `IS NOT DISTINCT FROM` also covers an empty table
   * (NULL) so no historical conversation is left behind.
   */
  async purgeSeating(
    tx: DbTransaction,
    tableId: string,
    sessionStartedAt: Date | null,
  ): Promise<void> {
    await tx.query(
      `DELETE FROM conversation_voice_interactions
        WHERE conversation_id IN (
          SELECT id
            FROM conversations
           WHERE table_id = $1
             AND session_started_at IS NOT DISTINCT FROM $2
        )`,
      [tableId, sessionStartedAt],
    );

    await tx.query(
      `DELETE FROM conversation_messages
        WHERE table_id = $1
          AND conversation_id IN (
            SELECT id
              FROM conversations
             WHERE table_id = $1
               AND session_started_at IS NOT DISTINCT FROM $2
          )`,
      [tableId, sessionStartedAt],
    );

    await tx.query(
      `DELETE FROM conversations
        WHERE table_id = $1
          AND session_started_at IS NOT DISTINCT FROM $2`,
      [tableId, sessionStartedAt],
    );
  }

  async schemaObjects(): Promise<ConversationSchemaPresence> {
    const res = await this.db.query<{
      conversations: boolean;
      messages: boolean;
      voice: boolean;
      active_voice_index: boolean;
    }>(
      `SELECT to_regclass('public.conversations') IS NOT NULL AS conversations,
              to_regclass('public.conversation_messages') IS NOT NULL AS messages,
              to_regclass('public.conversation_voice_interactions') IS NOT NULL AS voice,
              EXISTS (
                SELECT 1 FROM pg_indexes
                 WHERE indexname = 'conversation_one_active_voice'
              ) AS active_voice_index`,
    );

    const row = res.rows[0];
    const present: string[] = [];
    const missing: string[] = [];
    const values = [
      SCHEMA_OBJECTS[0],
      row?.conversations === true,
      SCHEMA_OBJECTS[1],
      row?.messages === true,
      SCHEMA_OBJECTS[2],
      row?.voice === true,
      SCHEMA_OBJECTS[3],
      row?.active_voice_index === true,
    ] as const;

    for (let index = 0; index < values.length; index += 2) {
      const name = values[index] as string;
      if (values[index + 1] === true) present.push(name);
      else missing.push(name);
    }
    return { present, missing };
  }
}
