import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { io as openSocket, type Socket } from "socket.io-client";

/* REAL Socket.IO transport check. Two authenticated guests join the table room
   chosen by the server; conversation messages and voice coordination arrive
   through RealtimePublisher. The voice payload names the initiating device,
   while the answer text is visible to both. */

import {
  READY_CHANNEL,
  SERVER_EVENT_CHANNEL,
  type RealtimeEnvelope,
} from "../src/infrastructure/realtime/RealtimePublisher.js";
import {
  IOManager,
  type RealtimeAuthenticator,
} from "../src/infrastructure/realtime/IOManager.js";
import { ConversationService } from "../src/modules/conversation/conversation.service.js";
import { initContext } from "./helpers/init-context.js";
import {
  FakeAiProvider,
  FakeConversationRepository,
  FakeToolPort,
  TABLE_CODE,
  TABLE_ID,
  TABLE_SECRET,
  credentials,
} from "./helpers/conversation-fakes.js";

const authenticator: RealtimeAuthenticator = {
  authenticateStaff() {
    return null;
  },
  async authenticateGuest({ tableToken, secret }) {
    if (tableToken !== TABLE_CODE || secret !== TABLE_SECRET) return null;
    return { kind: "guest", tableId: TABLE_ID, tableToken: TABLE_CODE };
  },
};

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out waiting for realtime delivery"));
      }
    }, 10);
  });
}

interface Context {
  readonly sockets: [Socket, Socket];
  readonly received: [RealtimeEnvelope[], RealtimeEnvelope[]];
  readonly service: ConversationService;
  readonly conversationId: string;
}

async function withRoom<T>(fn: (context: Context) => Promise<T>): Promise<T> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server did not bind an ephemeral port");
  }

  const manager = new IOManager({
    serverProvider: () => httpServer,
    authenticator,
    isOriginAllowed: () => true,
  });
  await manager.init(initContext());
  await manager.start();

  const sockets = [0, 1].map(() =>
    openSocket(`http://127.0.0.1:${address.port}`, {
      auth: { kind: "guest", table_token: TABLE_CODE, secret: TABLE_SECRET },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    }),
  ) as [Socket, Socket];

  const received: [RealtimeEnvelope[], RealtimeEnvelope[]] = [[], []];

  try {
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve, reject) => {
            socket.once(READY_CHANNEL, () => resolve());
            socket.once("connect_error", reject);
          }),
      ),
    );
    sockets.forEach((socket, index) => {
      socket.on(SERVER_EVENT_CHANNEL, (envelope: RealtimeEnvelope) => {
        received[index]?.push(envelope);
      });
    });

    const service = new ConversationService({
      repository: new FakeConversationRepository(),
      realtime: manager,
      tools: new FakeToolPort(),
      aiProvider: new FakeAiProvider([{ text: "The dosa is excellent." }], "Sure."),
    });
    const view = await service.getOrCreate(credentials());

    return await fn({
      sockets,
      received,
      service,
      conversationId: view.conversation.conversation_id,
    });
  } finally {
    for (const socket of sockets) socket.close();
    await manager.shutdown();
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }
}

describe("Conversation realtime delivery", () => {
  it("broadcasts shared messages and initiator-only voice playback to the room", async () => {
    await withRoom(async ({ received, service, conversationId }) => {
      const started = await service.startVoice(
        conversationId,
        credentials(),
        "phone-a",
      );

      await waitFor(() => received[0].length >= 1 && received[1].length >= 1);

      for (const stream of received) {
        assert.equal(stream[0]?.event, "conversation.voice.started");
        assert.equal(stream[0]?.room, `table:${TABLE_ID}`);
        assert.equal(
          (stream[0]?.data as { playback_device_id: string }).playback_device_id,
          "phone-a",
        );
      }

      await service.postMessage(conversationId, credentials(), {
        text: "What is good?",
        kind: "voice",
        voice_interaction_id: started.interaction_id,
        device_id: "phone-a",
      });

      await waitFor(() => received[0].length >= 3 && received[1].length >= 3);

      for (const stream of received) {
        assert.deepEqual(
          stream.map((envelope) => envelope.event),
          [
            "conversation.voice.started",
            "conversation.message.created",
            "conversation.message.created",
          ],
        );
        const assistant = stream[2]?.data as {
          role: string;
          text: string;
          voice_playback_device_id: string | null;
          origin_participant_id: string;
        };
        assert.equal(assistant.role, "assistant");
        assert.equal(assistant.text, "The dosa is excellent.");
        assert.equal(assistant.voice_playback_device_id, "phone-a");
        assert.equal(assistant.origin_participant_id, "guest-a");
      }
    });
  });

  it("does not broadcast a second overlapping voice start", async () => {
    await withRoom(async ({ received, service, conversationId }) => {
      await service.startVoice(conversationId, credentials(), "phone-a");

      await assert.rejects(
        service.startVoice(conversationId, credentials("guest-b"), "phone-b"),
        (err: unknown) =>
          err instanceof Error &&
          "code" in err &&
          (err as { code: string }).code === "VOICE_IN_PROGRESS",
      );

      await waitFor(() => received[0].length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(received[0].filter((entry) => entry.event === "conversation.voice.started").length, 1);
      assert.equal(received[1].length, 1);
    });
  });
});
