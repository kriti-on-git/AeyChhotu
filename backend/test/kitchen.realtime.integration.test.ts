import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { io as openSocket, type Socket } from "socket.io-client";

/* REAL-TRANSPORT check: KitchenService talks only to RealtimePublisher, and a
   real kitchen socket receives every notification over Socket.IO. The module
   never receives the Socket.IO server — only the manager behind the port. */

import {
  READY_CHANNEL,
  SERVER_EVENT_CHANNEL,
  type RealtimeEnvelope,
} from "../src/infrastructure/realtime/RealtimePublisher.js";
import {
  IOManager,
  type RealtimeAuthenticator,
} from "../src/infrastructure/realtime/IOManager.js";
import { KitchenService } from "../src/modules/kitchen/kitchen.service.js";
import { NOOP_KITCHEN_EVENTS } from "../src/modules/kitchen/kitchen.events.js";
import type {
  KitchenOrderPort,
  KitchenOrderRef,
  KitchenQueueSummary,
  KitchenRepositoryPort,
  KitchenTicketPort,
} from "../src/modules/kitchen/kitchen.types.js";
import { buildMeta } from "../src/lib/util.js";
import { initContext } from "./helpers/init-context.js";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const TABLE_ID = "22222222-2222-4222-8222-222222222222";

const authenticator: RealtimeAuthenticator = {
  authenticateStaff(token) {
    return token === "kitchen-token"
      ? { kind: "staff", role: "kitchen", terminalId: "terminal-1" }
      : null;
  },
  async authenticateGuest() {
    return null;
  },
};

class FakeTickets implements KitchenTicketPort {
  async listTickets() {
    return { data: [], meta: buildMeta(1, 20, 0) };
  }
  async advanceTicket(id: string, target: "preparing" | "ready") {
    return { ticket_id: id, order_id: TICKET_ID, status: target };
  }
  async pruneTicket(id: string) {
    return {
      ticket_id: id,
      order_id: TICKET_ID,
      status: "served" as const,
      table_cleared: false,
    };
  }
  async denyTicket(id: string, reason: string) {
    return {
      ticket_id: id,
      order_id: TICKET_ID,
      status: "denied" as const,
      denial_reason: reason,
      table_cleared: false,
    };
  }
}

class FakeRepository implements KitchenRepositoryPort, KitchenOrderPort {
  async summary(): Promise<KitchenQueueSummary> {
    return { pending: 0, preparing: 0, ready: 0, active: 0, oldest_created_at: null };
  }
  async findOrder(): Promise<KitchenOrderRef | null> {
    return {
      order_id: TICKET_ID,
      table_id: TABLE_ID,
      status: "pending",
      created_at: new Date("2026-01-01T10:00:00Z"),
    };
  }
  async schemaObjects() {
    return { present: [], missing: [] };
  }
}

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

interface SocketContext {
  readonly socket: Socket;
  readonly received: RealtimeEnvelope[];
  readonly manager: IOManager;
}

async function withKitchenSocket<T>(fn: (context: SocketContext) => Promise<T>): Promise<T> {
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

  const socket = openSocket(`http://127.0.0.1:${address.port}`, {
    auth: { kind: "staff", token: "kitchen-token" },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once(READY_CHANNEL, () => resolve());
      socket.once("connect_error", (err) => reject(err));
    });

    const received: RealtimeEnvelope[] = [];
    socket.on(SERVER_EVENT_CHANNEL, (envelope: RealtimeEnvelope) => received.push(envelope));
    return await fn({ socket, received, manager });
  } finally {
    socket.close();
    await manager.shutdown();
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }
}

describe("Kitchen realtime delivery", () => {
  it("delivers intake and every board move to the kitchen room", async () => {
    await withKitchenSocket(async ({ received, manager }) => {
      const repository = new FakeRepository();
      const kitchen = new KitchenService({
        tickets: new FakeTickets(),
        repository,
        orders: repository,
        realtime: manager,
        events: NOOP_KITCHEN_EVENTS,
      });

      await kitchen.handleIncomingTicket({
        ticketId: TICKET_ID,
        orderId: TICKET_ID,
        tableId: TABLE_ID,
      });
      await kitchen.acceptTicket(TICKET_ID);
      await kitchen.markTicketReady(TICKET_ID);
      await kitchen.completeTicket(TICKET_ID);

      await waitFor(() => received.length >= 4);

      assert.deepEqual(
        received.map((envelope) => envelope.event),
        [
          "kitchen.ticket.incoming",
          "kitchen.ticket.accepted",
          "kitchen.ticket.ready",
          "kitchen.ticket.served",
        ],
      );
      assert.ok(received.every((envelope) => envelope.room === "kitchen"));
      assert.deepEqual(
        received.map((envelope) => envelope.data),
        [
          {
            ticket_id: TICKET_ID,
            order_id: TICKET_ID,
            table_id: TABLE_ID,
            status: "pending",
          },
          {
            ticket_id: TICKET_ID,
            order_id: TICKET_ID,
            table_id: TABLE_ID,
            status: "preparing",
          },
          {
            ticket_id: TICKET_ID,
            order_id: TICKET_ID,
            table_id: TABLE_ID,
            status: "ready",
          },
          {
            ticket_id: TICKET_ID,
            order_id: TICKET_ID,
            table_id: TABLE_ID,
            status: "served",
          },
        ],
      );
    });
  });

  it("delivers a denial to the kitchen room", async () => {
    await withKitchenSocket(async ({ received, manager }) => {
      const repository = new FakeRepository();
      const kitchen = new KitchenService({
        tickets: new FakeTickets(),
        repository,
        orders: repository,
        realtime: manager,
      });

      await kitchen.denyTicket(TICKET_ID, "Paneer ran out");
      await waitFor(() => received.length >= 1);

      assert.equal(received[0]?.event, "kitchen.ticket.denied");
      assert.deepEqual(received[0]?.data, {
        ticket_id: TICKET_ID,
        order_id: TICKET_ID,
        table_id: TABLE_ID,
        status: "denied",
      });
    });
  });
});
