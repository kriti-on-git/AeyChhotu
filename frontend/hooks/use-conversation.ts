"use client";

/* Server-owned conversation state for one seating.

   The browser no longer owns the transcript or executes AI tools. REST creates
   and reads the conversation with the participant token; Socket.IO streams new
   messages to every authorized device in the table room. The backend service
   is the only writer.

   Reconnect behaviour:
   - the initial load retries once with `createConversation` after a stale id;
   - Socket.IO reconnects on its own, and any missed messages are recovered by
     the next `refresh()` (history is always server truth);
   - `table.session.ended` closes the room locally so stale events cannot be
     appended. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  createConversation,
  getConversation,
  postConversationMessage,
  subscribeConversation,
  type ConversationMessage,
  type ConversationRealtimeEvent,
  type ConversationView,
  type PostConversationMessageInput,
} from "@/lib/api-client";
import { getParticipantToken } from "@/lib/api/session";
import { mergeConversationMessages } from "@/lib/conversation/messages";

export type ConversationPhase = "loading" | "ready" | "error" | "ended";

export interface ConversationValue {
  phase: ConversationPhase;
  conversationId: string | null;
  messages: ConversationMessage[];
  error: string | null;
  sending: boolean;
  ended: boolean;
  send: (input: PostConversationMessageInput) => Promise<ConversationMessage | null>;
  refresh: () => Promise<void>;
  mergeMessage: (message: ConversationMessage) => void;
}

export function useConversation(tableId: string | null): ConversationValue {
  const [phase, setPhase] = useState<ConversationPhase>("loading");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const conversationRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const participantToken = typeof window === "undefined" ? null : getParticipantToken();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mergeMessage = useCallback((message: ConversationMessage) => {
    if (!mountedRef.current) return;
    setMessages((current) => mergeConversationMessages(current, [message]));
  }, []);

  const load = useCallback(async (existingId: string | null): Promise<void> => {
    setError(null);
    if (existingId) setPhase("loading");

    try {
      const view: ConversationView = existingId
        ? await getConversation(existingId)
        : await createConversation();
      if (!mountedRef.current) return;
      conversationRef.current = view.conversation.conversation_id;
      setConversationId(view.conversation.conversation_id);
      setMessages(view.messages);
      setPhase("ready");
    } catch (err) {
      if (!mountedRef.current) return;
      /* A cleared seating invalidates the old id. Create this seating's room
         once; if that also fails, the screen reports the real error. */
      if (existingId && err instanceof ApiError && err.status === 404) {
        await load(null);
        return;
      }
      if (err instanceof ApiError && err.error === "NOT_TABLE_MEMBER") {
        setPhase("ended");
        setError(err.message);
        return;
      }
      setPhase("error");
      setError(
        err instanceof ApiError ? err.message : "The conversation could not be opened.",
      );
    }
  }, []);

  useEffect(() => {
    if (!tableId) {
      setPhase("error");
      setError("This table session is not ready.");
      return;
    }
    if (!participantToken) {
      setPhase("error");
      setError("Join the table again to chat with Chhotu.");
      return;
    }
    void load(conversationRef.current);
  }, [load, participantToken, tableId]);

  /* Always reconcile with the server after a reconnect. The socket itself
     reconnects; a missed event is recovered by history, never patched locally. */
  useEffect(() => {
    if (!tableId || !conversationId || !participantToken) return;

    return subscribeConversation(
      tableId,
      participantToken,
      (event: ConversationRealtimeEvent) => {
        if (event.event === "table.session.ended") {
          setPhase("ended");
          setMessages([]);
          setError("This table session ended.");
          return;
        }

        if (event.event === "conversation.message.created") {
          const message = event.payload.message;
          if (message && typeof message === "object") {
            mergeMessage(message as ConversationMessage);
          }
          return;
        }

        if (event.event === "conversation.voice.started" || event.event === "conversation.voice.ended") {
          // The REST response and message stream carry the user-visible state;
          // voice lifecycle only needs to prevent a second local mic.
          return;
        }
      },
      (status) => {
        if (status.state === "connected" && conversationRef.current) {
          void load(conversationRef.current);
        }
      },
    );
  }, [conversationId, load, mergeMessage, participantToken, tableId]);

  const send = useCallback(
    async (input: PostConversationMessageInput): Promise<ConversationMessage | null> => {
      const id = conversationRef.current;
      if (!id) {
        setError("The conversation is not ready yet.");
        return null;
      }

      setSending(true);
      setError(null);
      try {
        const result = await postConversationMessage(id, input);
        if (!mountedRef.current) return null;
        mergeMessage(result.message);
        if (result.assistant) mergeMessage(result.assistant);
        return result.assistant;
      } catch (err) {
        if (!mountedRef.current) return null;
        if (err instanceof ApiError && (err.error === "NOT_TABLE_MEMBER" || err.error === "SESSION_ENDED")) {
          setPhase("ended");
          setError(err.message);
          return null;
        }
        setError(err instanceof ApiError ? err.message : "Chhotu could not answer.");
        return null;
      } finally {
        if (mountedRef.current) setSending(false);
      }
    },
    [mergeMessage],
  );

  const refresh = useCallback(async () => {
    await load(conversationRef.current);
  }, [load]);

  return {
    phase,
    conversationId,
    messages,
    error,
    sending,
    ended: phase === "ended",
    send,
    refresh,
    mergeMessage,
  };
}
