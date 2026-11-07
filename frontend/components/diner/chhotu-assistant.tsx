"use client";

import { Check, Loader2, Mic, Send, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChhotuAvatar } from "@/components/brand/chhotu-avatar";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import type { LiveTableValue } from "@/hooks/use-live-table";
import { useConversation } from "@/hooks/use-conversation";
import {
  ApiError,
  endConversationVoice,
  startConversationVoice,
  type ConversationMessage,
} from "@/lib/api-client";
import { createId, getDeviceId, getStoredDisplayName } from "@/lib/api/session";
import { shouldPlayVoice } from "@/lib/conversation/messages";
import { cn } from "@/lib/utils";

/* Chhotu — the floating waiter.

   The transcript, AI provider and every tool now live on the backend. This
   component reads and writes that one shared conversation with the participant
   token, so two phones at a table see the same messages and only the server
   can mutate the cart, fire an order or request the bill.

   VOICE: the typed contract is `kind: "voice"` with a server-issued interaction
   id. Browser speech recognition supplies the transcript and speech synthesis
   plays the answer, but only on the device named in `voice_playback_device_id`.
   The backend still enforces one active interaction per conversation, so two
   guests cannot both hold the microphone.

   No Gemini key is read here and no model call runs in this browser. */

const QUICK_PROMPTS = [
  "What's good tonight?",
  "Something spicy under ₹250",
  "Add 2 masala dosa",
  "Where's my order?",
  "Get the bill",
] as const;

const INTRO: ConversationMessage = {
  message_id: "intro",
  conversation_id: "intro",
  role: "assistant",
  kind: "text",
  text: "Namaste! I'm Chhotu, your table's waiter. Talk to me or type — ask what's good, add dishes to the shared cart, or check on your order.",
  participant: null,
  origin_participant_id: null,
  client_message_id: null,
  reply_to_message_id: null,
  actions: [],
  voice_playback_device_id: null,
  created_at: "1970-01-01T00:00:00.000Z",
};

export interface ChhotuAssistantProps {
  tableToken: string;
  live: LiveTableValue;
  /** Hydrated guest name on the menu screen; the tracker reads storage. */
  displayName?: string;
  /** Positioning for the floating trigger (bottom offsets differ per screen). */
  className?: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

function speak(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text.trim()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-IN";
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

export function ChhotuAssistant({ tableToken, live, displayName, className }: ChhotuAssistantProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [heard, setHeard] = useState("");

  const conversation = useConversation(live.table?.id ?? null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const interactionRef = useRef<{ id: string; deviceId: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const deviceId = typeof window === "undefined" ? "" : getDeviceId();
  const guestName = (displayName || (typeof window === "undefined" ? "" : getStoredDisplayName())).trim();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [open, conversation.messages, conversation.sending, heard]);

  const stopVoice = useCallback((notifyServer: boolean) => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        /* Already stopped. */
      }
    }

    const interaction = interactionRef.current;
    interactionRef.current = null;
    setMicOn(false);
    setVoiceBusy(false);
    setHeard("");

    if (notifyServer && interaction) {
      void endConversationVoice(
        conversation.conversationId ?? "",
        interaction.id,
        interaction.deviceId,
      ).catch(() => undefined);
    }
  }, [conversation.conversationId]);

  useEffect(() => () => stopVoice(true), [stopVoice]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || conversation.phase !== "ready" || conversation.sending) return;

    setInput("");
    setLocalError(null);
    await conversation.send({
      text: trimmed,
      client_message_id: createId("chat"),
    });
    if (mountedRef.current) void live.refresh();
  };

  async function toggleMic() {
    setLocalError(null);

    if (micOn) {
      stopVoice(true);
      return;
    }

    if (!conversation.conversationId || conversation.phase !== "ready") {
      setLocalError("Chhotu is not connected to this table yet.");
      return;
    }

    const Recognition = recognitionConstructor();
    if (!Recognition) {
      setLocalError("Voice input is not supported in this browser. Type your message instead.");
      return;
    }

    let interaction: { id: string; deviceId: string };
    try {
      const started = await startConversationVoice(conversation.conversationId, deviceId);
      interaction = { id: started.interaction_id, deviceId };
      interactionRef.current = interaction;
    } catch (err) {
      setLocalError(
        err instanceof ApiError
          ? err.message
          : "The voice line could not be opened. Type your message instead.",
      );
      return;
    }

    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = "en-IN";
    recognition.continuous = false;
    recognition.interimResults = true;

    let finalText = "";
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      setHeard(finalText || interim);
    };

    recognition.onerror = (event) => {
      if (!mountedRef.current) return;
      setLocalError(
        event.error === "not-allowed"
          ? "Microphone permission was denied. Allow it, then tap the mic again."
          : "I could not hear that. Tap the mic and try again.",
      );
      stopVoice(true);
    };

    recognition.onend = () => {
      if (!mountedRef.current) return;
      setMicOn(false);
      const text = finalText.trim();
      if (!text) {
        stopVoice(true);
        return;
      }

      setVoiceBusy(true);
      void conversation
        .send({
          text,
          kind: "voice",
          voice_interaction_id: interaction.id,
          device_id: interaction.deviceId,
          client_message_id: createId("voice"),
        })
        .then((reply) => {
          if (!mountedRef.current) return;
          if (reply && shouldPlayVoice(reply, deviceId)) speak(reply.text);
          void live.refresh();
        })
        .finally(() => {
          if (!mountedRef.current) return;
          setVoiceBusy(false);
          stopVoice(true);
        });
    };

    try {
      recognition.start();
      setMicOn(true);
    } catch {
      setLocalError("The microphone could not start. Type your message instead.");
      stopVoice(true);
    }
  }

  const visibleMessages =
    conversation.messages.length > 0
      ? conversation.messages.filter((message) => message.role !== "system")
      : [INTRO];
  const statusLine =
    localError ??
    conversation.error ??
    (conversation.phase === "ended"
      ? "This table session has ended."
      : voiceBusy
        ? "Chhotu is thinking…"
        : micOn
          ? heard
            ? `Hearing: ${heard}`
            : "Listening — speak, then pause."
          : null);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Ask Chhotu, your AI waiter"
        className={cn(
          "fixed right-4 z-40 inline-flex cursor-pointer items-center gap-2 rounded-pill border border-ember/30 bg-ember px-4 py-3 font-sans text-sm font-semibold text-on-ember shadow-lg transition-transform duration-[var(--duration-fast)] ease-gentle hover:-translate-y-0.5 hover:bg-ember-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ember/25",
          className ?? "bottom-24 lg:bottom-6",
        )}
      >
        <ChhotuAvatar size="sm" />
        <span>Ask Chhotu</span>
      </button>

      <Drawer
        open={open}
        onClose={() => {
          stopVoice(true);
          setOpen(false);
        }}
        title="Chhotu"
        description="Your table's waiter — talk or type, ask, add, fire, track."
        size="md"
        footer={
          <div className="flex w-full flex-col gap-2">
            {statusLine ? (
              <p
                role={localError || conversation.error ? "alert" : "status"}
                className={cn(
                  "text-xs font-medium",
                  localError || conversation.error ? "text-alert" : "text-ink-muted",
                )}
              >
                {statusLine}
              </p>
            ) : null}

            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void send(input);
              }}
            >
              <Input
                aria-label="Message Chhotu"
                placeholder={micOn ? "Listening…" : "Ask for a dish, or say what to add…"}
                value={input}
                maxLength={500}
                onChange={(event) => setInput(event.target.value)}
                containerClassName="min-w-0 flex-1"
              />

              <Button
                type="button"
                variant={micOn ? "ember" : "soft"}
                size="md"
                aria-label={micOn ? "Stop listening" : "Talk to Chhotu"}
                aria-pressed={micOn}
                onClick={() => void toggleMic()}
                disabled={conversation.sending || voiceBusy || conversation.phase !== "ready"}
                className={cn("h-12 shrink-0 px-3", micOn && "ring-2 ring-ember/40")}
                leftIcon={micOn ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Mic className="size-4" aria-hidden />}
              >
                <span className="sr-only">{micOn ? "Stop listening" : "Voice"}</span>
              </Button>

              <Button
                type="submit"
                variant="ember"
                size="md"
                disabled={
                  !input.trim() ||
                  conversation.sending ||
                  conversation.phase !== "ready"
                }
                aria-label="Send message"
                className="h-12 shrink-0 px-3"
                leftIcon={<Send className="size-4" aria-hidden />}
              >
                <span className="sr-only">Send</span>
              </Button>
            </form>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {conversation.phase === "loading" ? (
            <p className="flex items-center gap-2 text-sm text-ink-muted" role="status">
              <Loader2 className="size-4 animate-spin text-ember" aria-hidden />
              Opening this table's conversation…
            </p>
          ) : null}

          <ul className="flex flex-col gap-3" aria-live="polite">
            {visibleMessages.map((message) => (
              <MessageBubble key={message.message_id} message={message} />
            ))}

            {conversation.sending || voiceBusy ? (
              <li className="flex items-center gap-2 text-sm text-ink-muted" role="status">
                <Loader2 className="size-4 shrink-0 animate-spin text-ember" aria-hidden />
                <span>Chhotu is checking the table…</span>
              </li>
            ) : null}
          </ul>

          {conversation.phase === "error" ? (
            <Button variant="outline" size="sm" onClick={() => void conversation.refresh()}>
              Try the conversation again
            </Button>
          ) : null}

          {conversation.messages.length === 0 && !conversation.sending ? (
            <div role="group" aria-label="Quick requests" className="flex flex-wrap gap-2 pt-1">
              {QUICK_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={conversation.phase !== "ready" || conversation.sending}
                  onClick={() => void send(prompt)}
                  className="cursor-pointer rounded-pill border border-line-strong bg-paper px-3 py-1.5 text-xs font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-gentle hover:border-ember/40 hover:bg-ember-soft/50 focus-visible:border-ember focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                  {prompt}
                </button>
              ))}
            </div>
          ) : null}

          <div ref={endRef} />
        </div>
      </Drawer>
    </>
  );
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  const fromChhotu = message.role === "assistant";
  const isIntro = message.message_id === "intro";

  return (
    <li className={cn("flex flex-col gap-1.5", fromChhotu ? "items-start" : "items-end")}>
      <div className={cn("flex w-full items-start gap-2", fromChhotu ? "justify-start" : "justify-end")}>
        {fromChhotu ? <ChhotuAvatar size="sm" className="mt-0.5" /> : null}

        {message.text ? (
          <div
            className={cn(
              "max-w-[92%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
              fromChhotu
                ? "border border-line bg-paper text-ink"
                : "border border-ember/20 bg-ember-soft text-ink",
            )}
          >
            {message.text}
          </div>
        ) : null}
      </div>

      {!isIntro && fromChhotu && message.participant === null ? null : null}

      {message.actions.length > 0 ? (
        <ul className="flex w-full flex-wrap gap-1.5">
          {message.actions.map((action, index) => (
            <li
              key={`${message.message_id}-action-${index}`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium",
                action.ok
                  ? "border-ready/35 bg-ready-surface text-ready"
                  : "border-alert/35 bg-alert-surface text-alert",
              )}
            >
              {action.ok ? (
                <Check className="size-3" aria-hidden />
              ) : (
                <TriangleAlert className="size-3" aria-hidden />
              )}
              {action.label}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
