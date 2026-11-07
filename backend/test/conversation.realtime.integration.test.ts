import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { io as openSocket, type Socket } from "socket.io-client";

/* REAL Socket.IO transport check for the Phase 5.2 guest handshake. Guests
   authenticate with a participant token; the server derives the table room.
   Conversation events themselves are written to the outbox and covered by the
   dispatcher tests; this file proves the transport and room isolation. */

import {
  READY_CHANNEL,
  SERVER_EVENT_CHANNEL,
  type RealtimeEnvelope,
} from "../src/infrastructure/realtime/RealtimePublisher.js";
import {
  IOManager,
  type RealtimeAuthenticator,
} from "../src/infrastructure/realtime/IOManager.js";
import { initContext } from "./helpers/init-context.js";
import { TABLE_CODE, TABLE_ID, TOKEN_A, TOKEN_B } from "./helpers/conversation-fakes.js";

const OTHER_TABLE_ID = "99999999-9999-4999-8999-999999999999";
const OTHER_TOKEN = `pc_${"C".repeat(43)}`;

const authenticator: RealtimeAuthenticator = {
  authenticateStaff() {
    return null;
  },
  async authenticateGuest({ participantToken }) {
    if (participantToken === TOKEN_A || participantToken === TOKEN_B) {
      return {
        kind: "guest",
        participantId: "guest-a",
        tokenHash: participantToken,
        tableId: TABLE_ID,
        tableToken: TABLE_CODE,
      };
    }
    if (participantToken === OTHER_TOKEN) {
      return {
        kind: "guest",
        participantId: "guest-c",
        tokenHash: participantToken,
        tableId: OTHER_TABLE_ID,
        tableToken: "other",
      };
    }
    return null;
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
  readonly sockets: Socket[];
  readonly received: RealtimeEnvelope[][];
  readonly manager: IOManager;
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

  const tokens = [TOKEN_A, TOKEN_B, OTHER_TOKEN];
  const sockets = tokens.map((token) =>
    openSocket(`http://127.0.0.1:${address.port}`, {
      auth: { kind: "guest", participant_token: token },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    }),
  );
  const received: RealtimeEnvelope[][] = [[], [], []];

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

    return await fn({ sockets, received, manager });
  } finally {
    for (const socket of sockets) socket.close();
    await manager.shutdown();
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }
}

describe("Guest realtime transport", () => {
  it("derives the table room from the participant token and isolates tables", async () => {
    await withRoom(async ({ received, manager }) => {
      const published = manager.toTable(TABLE_ID, "conversation.message.created", {
        message_id: "m-1",
      });
      assert.equal(published.recipients >= 2, true);

      await waitFor(() => received[0]!.length >= 1 && received[1]!.length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 80));

      assert.equal(received[0]![0]?.room, `table:${TABLE_ID}`);
      assert.equal(received[1]![0]?.room, `table:${TABLE_ID}`);
      assert.equal(received[2]!.length, 0, "another table's guest must not receive it");
    });
  });

  it("rejects a handshake with a token the server cannot resolve", async () => {
    const httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address() as import("node:net").AddressInfo;
    const manager = new IOManager({
      serverProvider: () => httpServer,
      authenticator,
      isOriginAllowed: () => true,
    });
    await manager.init(initContext());
    await manager.start();

    const socket = openSocket(`http://127.0.0.1:${address.port}`, {
      auth: { kind: "guest", participant_token: `pc_${"Z".repeat(43)}` },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });

    try {
      await assert.rejects(
        new Promise<void>((resolve, reject) => {
          socket.once(READY_CHANNEL, () => resolve());
          socket.once("connect_error", reject);
        }),
      );
    } finally {
      socket.close();
      await manager.shutdown();
      if (httpServer.listening) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    }
  });
});
