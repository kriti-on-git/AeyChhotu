import type { ConversationMessage } from "@/lib/api-client";

/** Merge server messages by stable id, keeping one copy and chronological
    order. This is the whole local "state" of the shared transcript: REST
    history and Socket.IO events can arrive in either order without doubling a
    bubble. */
export function mergeConversationMessages(
  current: readonly ConversationMessage[],
  incoming: readonly ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map(current.map((message) => [message.message_id, message]));
  for (const message of incoming) byId.set(message.message_id, message);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Only the device named by the server may play a voice answer. Text replies
    and other guests' messages stay silent. */
export function shouldPlayVoice(
  message: Pick<ConversationMessage, "kind" | "voice_playback_device_id"> | null,
  deviceId: string,
): boolean {
  return Boolean(
    message &&
      message.kind === "voice" &&
      deviceId &&
      message.voice_playback_device_id === deviceId,
  );
}
