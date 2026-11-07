import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { io as openSocket, type Socket } from "socket.io-client";

/* Socket.IO tests for IOManager (phase 2A — realtime).

   These drive a REAL Socket.IO handshake against a real HTTP server on an
   ephemeral port, with an injected authenticator instead of Postgres/JWT:
   the transport is what is under test, not the credential store. What is
   pinned here:
     * staff and guest handshakes, and both refusal paths;
     * the room each principal receives, and that room requests are
       allowlisted server-side (a guest cannot enter the kitchen, another
       table, or any room its session did not earn);
     * join/leave acks and diagnostics;
     * inbound payload validation and refusal of unknown client events;
     * publish-to-room targeting and isolation, invalid names/rooms/payloads;
     * shutdown: clients disconnected, publishing skipped, idempotent. */

import {
  ERROR_CHANNEL,
  JOIN_CHANNEL,
  KITCHEN_ROOM,
  LEAVE_CHANNEL,
  MENU_ROOM,
  MAX_PAYLOAD_CHARS,
  READY_CHANNEL,
  SERVER_EVENT_CHANNEL,
  STAFF_ROOM,
  FLOOR_ROOM,
  ADMIN_ROOM,
  tableRoom,
} from "../src/infrastructure/realtime/RealtimePublisher.js";
import {
  IOManager,
  RealtimeError,
  type RealtimeAuthenticator,
} from "../src/infrastructure/realtime/IOManager.js";
import { initContext } from "./helpers/init-context.js";

const TABLE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TABLE_ID = "22222222-2222-4222-8222-222222222222";
const GUEST_TOKEN = `pc_${"A".repeat(43)}`;
const OTHER_GUEST_TOKEN = `pc_${"B".repeat(43)}`;

const GUEST_AUTH = { kind: "guest", participant_token: GUEST_TOKEN } as const;
const OTHER_GUEST_AUTH = { kind: "guest", participant_token: OTHER_GUEST_TOKEN } as const;
const KITCHEN_AUTH = { kind: "staff", token: "kitchen-token" } as const;
const FLOOR_AUTH = { kind: "staff", token: "floor-token" } as const;
const ADMIN_AUTH = { kind: "staff", token: "admin-token" } as const;

/* The transport's credential rules, stubbed. The real adapter is covered by
   the existing JWT/session tests; here the socket only needs valid/invalid. */
const authenticator: RealtimeAuthenticator = {
  authenticateStaff(token) {
    if (token === "kitchen-token") {
      return { kind: "staff", role: "kitchen", terminalId: "terminal-1" };
    }
    if (token === "floor-token") return { kind: "staff", role: "floor", terminalId: null };
    if (token === "admin-token") return { kind: "staff", role: "admin", terminalId: null };
    return null;
  },
  async authenticateGuest({ participantToken }) {
    if (participantToken === GUEST_TOKEN) {
      return {
        kind: "guest",
        tableId: TABLE_ID,
        tableToken: "table01",
        participantId: "guest-a",
        tokenHash: "hash-a",
      };
    }
    if (participantToken === OTHER_GUEST_TOKEN) {
      return {
        kind: "guest",
        tableId: OTHER_TABLE_ID,
        tableToken: "table02",
        participantId: "guest-b",
        tokenHash: "hash-b",
      };
    }
    return null;
  },
};

interface Harness {
  readonly manager: IOManager;
  readonly url: string;
}

async function withRealtime<T>(fn: (harness: Harness) => Promise<T>): Promise<T> {
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

  try {
    return await fn({ manager, url: `http://127.0.0.1:${address.port}` });
  } finally {
    await manager.shutdown();
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }
}

interface ReadyPayload {
  readonly socket_id: string;
  readonly kind: string;
  readonly rooms: readonly string[];
  readonly at: string;
}

interface Envelope {
  readonly id: string;
  readonly event: string;
  readonly room: string;
  readonly at: string;
  readonly sequence: number;
  readonly data: unknown;
}

interface ErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly fields?: Record<string, string>;
  readonly room?: string;
}

type RoomAck =
  | { readonly ok: true; readonly room: string; readonly joined: boolean }
  | { readonly ok: false; readonly error: ErrorPayload };

function waitFor<T>(socket: Socket, event: string, timeoutMs = 3_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function connectReady(
  url: string,
  auth: Record<string, unknown>,
): Promise<{ socket: Socket; ready: ReadyPayload }> {
  const socket = openSocket(url, {
    auth,
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    timeout: 3_000,
  });

  const ready = waitFor<ReadyPayload>(socket, READY_CHANNEL);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (err: Error) => reject(err));
  });

  return { socket, ready: await ready };
}

async function connectRejected(
  url: string,
  auth: Record<string, unknown>,
): Promise<{ message: string; code: string | undefined }> {
  const socket = openSocket(url, {
    auth,
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    timeout: 3_000,
  });

  try {
    return await new Promise((resolve, reject) => {
      socket.once("connect", () => reject(new Error("expected the handshake to be refused")));
      socket.once("connect_error", (err: Error) => {
        const data = (err as Error & { data?: { code?: string } }).data;
        resolve({ message: err.message, code: data?.code });
      });
    });
  } finally {
    socket.close();
  }
}

function requestRoom(socket: Socket, event: string, payload: unknown): Promise<RoomAck> {
  return new Promise<RoomAck>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 2_000);
    socket.emit(event, payload, (response: RoomAck) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/** Asserts that no published message arrives within a short window. */
function expectNoMessage(socket: Socket, timeoutMs = 100): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const onMessage = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      socket.off(SERVER_EVENT_CHANNEL, onMessage);
      reject(new Error("received a realtime message that should not have been delivered"));
    };

    socket.on(SERVER_EVENT_CHANNEL, onMessage);
    timer = setTimeout(() => {
      socket.off(SERVER_EVENT_CHANNEL, onMessage);
      resolve();
    }, timeoutMs);
  });
}

function expectRealtimeError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RealtimeError, `expected RealtimeError, got ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected a RealtimeError with code ${code}`);
}

describe("IOManager — handshake and connection", () => {
  it("authenticates a kitchen shift into the staff and kitchen rooms", async () => {
    await withRealtime(async ({ manager, url }) => {
      const { socket, ready } = await connectReady(url, KITCHEN_AUTH);
      try {
        assert.equal(ready.kind, "staff");
        assert.deepEqual(ready.rooms, [STAFF_ROOM, KITCHEN_ROOM]);
        assert.equal(typeof ready.socket_id, "string");
        assert.equal(manager.getState(), "listening");

        const diagnostics = manager.diagnostics();
        assert.equal(diagnostics.connections, 1);
        assert.equal(diagnostics.counters.accepted, 1);
        assert.equal(diagnostics.rooms[STAFF_ROOM], 1);
        assert.equal(diagnostics.rooms[KITCHEN_ROOM], 1);
        assert.equal(diagnostics.clients[0]?.role, "kitchen");
        assert.equal(diagnostics.clients[0]?.table_id, null);
      } finally {
        socket.close();
      }
    });
  });

  it("puts a verified guest in exactly its own table room", async () => {
    await withRealtime(async ({ manager, url }) => {
      const { socket, ready } = await connectReady(url, GUEST_AUTH);
      try {
        assert.equal(ready.kind, "guest");
        assert.deepEqual(ready.rooms, [tableRoom(TABLE_ID), MENU_ROOM]);
        assert.equal(manager.diagnostics().clients[0]?.kind, "guest");
        assert.equal(manager.diagnostics().clients[0]?.table_id, TABLE_ID);
        assert.equal(manager.diagnostics().rooms[tableRoom(TABLE_ID)], 1);
        assert.equal(manager.diagnostics().rooms[MENU_ROOM], 1);
        assert.equal(manager.diagnostics().rooms[KITCHEN_ROOM], undefined);
      } finally {
        socket.close();
      }
    });
  });

  it("maps floor and admin shifts to their own rooms", async () => {
    await withRealtime(async ({ url }) => {
      const floor = await connectReady(url, FLOOR_AUTH);
      const admin = await connectReady(url, ADMIN_AUTH);
      try {
        assert.deepEqual(floor.ready.rooms, [STAFF_ROOM, FLOOR_ROOM]);
        assert.deepEqual(admin.ready.rooms, [STAFF_ROOM, ADMIN_ROOM]);
      } finally {
        floor.socket.close();
        admin.socket.close();
      }
    });
  });

  it("refuses a guest whose participant token is unknown", async () => {
    await withRealtime(async ({ manager, url }) => {
      const failure = await connectRejected(url, {
        kind: "guest",
        participant_token: `pc_${"Z".repeat(43)}`,
      });

      assert.equal(failure.code, "UNAUTHORIZED");
      const diagnostics = manager.diagnostics();
      assert.equal(diagnostics.connections, 0);
      assert.equal(diagnostics.counters.rejected, 1);
      assert.equal(diagnostics.counters.accepted, 0);
    });
  });

  it("refuses expired and revoked guest credentials", async () => {
    await withRealtime(async ({ url }) => {
      for (const participantToken of [`pc_${"E".repeat(43)}`, `pc_${"R".repeat(43)}`]) {
        const failure = await connectRejected(url, {
          kind: "guest",
          participant_token: participantToken,
        });
        assert.equal(failure.code, "UNAUTHORIZED");
      }
    });
  });

  it("limits handshakes by server-observed IP, not client-supplied identity", async () => {
    await withRealtime(async ({ manager, url }) => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const failure = await connectRejected(url, {
          kind: "guest",
          participant_token: `pc_${"Z".repeat(43)}`,
          /* A client cannot move the bucket by claiming an address or device. */
          address: `203.0.113.${attempt + 1}`,
          device_id: `bypass-device-${attempt + 1}`,
          participant_id: `bypass-member-${attempt + 1}`,
        });
        assert.equal(failure.code, "UNAUTHORIZED", `attempt ${attempt + 1}`);
      }

      const limited = await connectRejected(url, GUEST_AUTH);
      assert.equal(limited.code, "RATE_LIMITED");
      assert.match(limited.message, /Too many connection attempts/);
      assert.equal(limited.message.includes(GUEST_TOKEN), false);
      assert.equal(limited.message.includes(TABLE_ID), false);
      assert.equal(manager.diagnostics().connections, 0);
      assert.equal(manager.diagnostics().counters.rejected, 31);
    });
  });

  it("refuses a staff token the authenticator does not recognize", async () => {
    await withRealtime(async ({ manager, url }) => {
      const failure = await connectRejected(url, { kind: "staff", token: "stale-token" });

      assert.equal(failure.code, "UNAUTHORIZED");
      assert.equal(manager.diagnostics().connections, 0);
    });
  });

  it("refuses a malformed handshake before any credential is checked", async () => {
    await withRealtime(async ({ manager, url }) => {
      const failure = await connectRejected(url, {
        kind: "guest",
        participant_token: "short",
      });

      assert.equal(failure.code, "INVALID_HANDSHAKE");
      assert.equal(manager.diagnostics().connections, 0);
    });
  });

  it("refuses an empty handshake", async () => {
    await withRealtime(async ({ manager, url }) => {
      const failure = await connectRejected(url, {});

      assert.equal(failure.code, "INVALID_HANDSHAKE");
      assert.equal(manager.diagnostics().counters.rejected, 1);
    });
  });
});

describe("IOManager — authorized room access", () => {
  it("forbids a guest from joining the kitchen", async () => {
    await withRealtime(async ({ manager, url }) => {
      const { socket } = await connectReady(url, GUEST_AUTH);
      try {
        const errorEvent = waitFor<ErrorPayload>(socket, ERROR_CHANNEL);
        const ack = await requestRoom(socket, JOIN_CHANNEL, { room: KITCHEN_ROOM });
        const error = await errorEvent;

        assert.equal(ack.ok, false);
        if (ack.ok) assert.fail("expected the join to be refused");
        assert.equal(ack.error.code, "ROOM_FORBIDDEN");
        assert.equal(error.code, "ROOM_FORBIDDEN");

        assert.equal(manager.toKitchen("order.created", { orderId: "o-1" }).recipients, 0);
        assert.equal(manager.diagnostics().counters.roomDenials, 1);
      } finally {
        socket.close();
      }
    });
  });

  it("forbids a guest from joining another table's room", async () => {
    await withRealtime(async ({ url }) => {
      const { socket } = await connectReady(url, GUEST_AUTH);
      try {
        const ack = await requestRoom(socket, JOIN_CHANNEL, { room: tableRoom(OTHER_TABLE_ID) });

        assert.equal(ack.ok, false);
        if (ack.ok) assert.fail("expected the join to be refused");
        assert.equal(ack.error.code, "ROOM_FORBIDDEN");
        assert.equal(ack.error.room, tableRoom(OTHER_TABLE_ID));
      } finally {
        socket.close();
      }
    });
  });

  it("keeps the kitchen and floor rooms apart for both shifts", async () => {
    await withRealtime(async ({ url }) => {
      const kitchen = await connectReady(url, KITCHEN_AUTH);
      const floor = await connectReady(url, FLOOR_AUTH);
      try {
        const kitchenFloor = await requestRoom(kitchen.socket, JOIN_CHANNEL, { room: FLOOR_ROOM });
        const floorKitchen = await requestRoom(floor.socket, JOIN_CHANNEL, {
          room: KITCHEN_ROOM,
        });

        assert.equal(kitchenFloor.ok, false);
        assert.equal(floorKitchen.ok, false);
        if (!kitchenFloor.ok) assert.equal(kitchenFloor.error.code, "ROOM_FORBIDDEN");
        if (!floorKitchen.ok) assert.equal(floorKitchen.error.code, "ROOM_FORBIDDEN");
      } finally {
        kitchen.socket.close();
        floor.socket.close();
      }
    });
  });

  it("does not promote an admin shift into the kitchen room", async () => {
    await withRealtime(async ({ url }) => {
      const admin = await connectReady(url, ADMIN_AUTH);
      try {
        const ack = await requestRoom(admin.socket, JOIN_CHANNEL, { room: KITCHEN_ROOM });

        assert.equal(ack.ok, false);
        if (!ack.ok) assert.equal(ack.error.code, "ROOM_FORBIDDEN");
      } finally {
        admin.socket.close();
      }
    });
  });

  it("lets a shift leave and rejoin a room it is entitled to", async () => {
    await withRealtime(async ({ manager, url }) => {
      const { socket } = await connectReady(url, KITCHEN_AUTH);
      try {
        assert.equal(manager.diagnostics().rooms[KITCHEN_ROOM], 1);

        const left = await requestRoom(socket, LEAVE_CHANNEL, { room: KITCHEN_ROOM });
        assert.deepEqual(left, { ok: true, room: KITCHEN_ROOM, joined: false });
        assert.equal(manager.diagnostics().rooms[KITCHEN_ROOM], undefined);
        assert.equal(manager.toKitchen("order.created", {}).recipients, 0);

        const rejoined = await requestRoom(socket, JOIN_CHANNEL, { room: KITCHEN_ROOM });
        assert.deepEqual(rejoined, { ok: true, room: KITCHEN_ROOM, joined: true });
        assert.equal(manager.diagnostics().rooms[KITCHEN_ROOM], 1);
      } finally {
        socket.close();
      }
    });
  });
});

describe("IOManager — incoming event validation", () => {
  it("rejects a room of the wrong type with field errors", async () => {
    await withRealtime(async ({ manager, url }) => {
      const { socket } = await connectReady(url, GUEST_AUTH);
      try {
        const errorEvent = waitFor<ErrorPayload>(socket, ERROR_CHANNEL);
        const ack = await requestRoom(socket, JOIN_CHANNEL, { room: 42 });
        const error = await errorEvent;

        assert.equal(ack.ok, false);
        if (ack.ok) assert.fail("expected validation to fail");
        assert.equal(ack.error.code, "INVALID_PAYLOAD");
        assert.equal(typeof ack.error.fields?.room, "string");
        assert.equal(error.code, "INVALID_PAYLOAD");
        assert.equal(manager.diagnostics().counters.invalidPayloads, 1);
      } finally {
        socket.close();
      }
    });
  });

  it("rejects a missing room", async () => {
    await withRealtime(async ({ manager, url }) => {
      const { socket } = await connectReady(url, GUEST_AUTH);
      try {
        const ack = await requestRoom(socket, JOIN_CHANNEL, {});

        assert.equal(ack.ok, false);
        if (!ack.ok) {
          assert.equal(ack.error.code, "INVALID_PAYLOAD");
          assert.equal(typeof ack.error.fields?.room, "string");
        }
        assert.equal(manager.diagnostics().counters.invalidPayloads, 1);
      } finally {
        socket.close();
      }
    });
  });

  it("rejects a non-object payload", async () => {
    await withRealtime(async ({ url }) => {
      const { socket } = await connectReady(url, GUEST_AUTH);
      try {
        const ack = await requestRoom(socket, LEAVE_CHANNEL, "kitchen");

        assert.equal(ack.ok, false);
        if (!ack.ok) {
          assert.equal(ack.error.code, "INVALID_PAYLOAD");
          assert.equal(typeof ack.error.fields?.body, "string");
        }
      } finally {
        socket.close();
      }
    });
  });

  it("refuses unknown client events instead of ignoring them", async () => {
    await withRealtime(async ({ manager, url }) => {
      const { socket } = await connectReady(url, KITCHEN_AUTH);
      try {
        const errorEvent = waitFor<ErrorPayload>(socket, ERROR_CHANNEL);
        socket.emit("order.created", { orderId: "forged" });
        const error = await errorEvent;

        assert.equal(error.code, "UNKNOWN_EVENT");
        assert.match(error.message, /order\.created/);
        assert.equal(manager.diagnostics().counters.unknownEvents, 1);
      } finally {
        socket.close();
      }
    });
  });
});

describe("IOManager — controlled publishing", () => {
  it("delivers a table event to that table only", async () => {
    await withRealtime(async ({ manager, url }) => {
      const diner = await connectReady(url, GUEST_AUTH);
      const otherDiner = await connectReady(url, OTHER_GUEST_AUTH);
      const kitchen = await connectReady(url, KITCHEN_AUTH);
      try {
        const envelope = waitFor<Envelope>(diner.socket, SERVER_EVENT_CHANNEL);
        const otherNothing = expectNoMessage(otherDiner.socket);
        const kitchenNothing = expectNoMessage(kitchen.socket);

        const result = manager.toTable(TABLE_ID, "order.created", {
          orderId: "o-1",
          itemCount: 2,
        });

        assert.equal(result.recipients, 1);
        assert.equal(result.skipped, false);

        const message = await envelope;
        assert.equal(message.event, "order.created");
        assert.equal(message.room, tableRoom(TABLE_ID));
        assert.deepEqual(message.data, { orderId: "o-1", itemCount: 2 });
        assert.equal(typeof message.id, "string");
        assert.equal(message.sequence, 1);
        assert.equal(Number.isNaN(Date.parse(message.at)), false);

        await otherNothing;
        await kitchenNothing;

        const diagnostics = manager.diagnostics();
        assert.equal(diagnostics.counters.published, 1);
        assert.equal(diagnostics.counters.delivered, 1);
      } finally {
        diner.socket.close();
        otherDiner.socket.close();
        kitchen.socket.close();
      }
    });
  });

  it("delivers a kitchen event to the kitchen and not the floor", async () => {
    await withRealtime(async ({ manager, url }) => {
      const kitchen = await connectReady(url, KITCHEN_AUTH);
      const floor = await connectReady(url, FLOOR_AUTH);
      try {
        const envelope = waitFor<Envelope>(kitchen.socket, SERVER_EVENT_CHANNEL);
        const floorNothing = expectNoMessage(floor.socket);

        const result = manager.toKitchen("ticket.created", { ticketId: "tk-1" });

        assert.equal(result.recipients, 1);
        assert.equal((await envelope).room, KITCHEN_ROOM);
        await floorNothing;
      } finally {
        kitchen.socket.close();
        floor.socket.close();
      }
    });
  });

  it("reaches every staff role on the staff room, and no diner", async () => {
    await withRealtime(async ({ manager, url }) => {
      const kitchen = await connectReady(url, KITCHEN_AUTH);
      const floor = await connectReady(url, FLOOR_AUTH);
      const admin = await connectReady(url, ADMIN_AUTH);
      const diner = await connectReady(url, GUEST_AUTH);
      try {
        const envelopes = [
          waitFor<Envelope>(kitchen.socket, SERVER_EVENT_CHANNEL),
          waitFor<Envelope>(floor.socket, SERVER_EVENT_CHANNEL),
          waitFor<Envelope>(admin.socket, SERVER_EVENT_CHANNEL),
        ];
        const dinerNothing = expectNoMessage(diner.socket);

        const result = manager.toStaff("floor.tables.updated", { tables: 3 });

        assert.equal(result.recipients, 3);
        assert.equal(result.room, STAFF_ROOM);
        for (const envelope of await Promise.all(envelopes)) {
          assert.equal(envelope.event, "floor.tables.updated");
          assert.equal(envelope.room, STAFF_ROOM);
        }
        await dinerNothing;
      } finally {
        kitchen.socket.close();
        floor.socket.close();
        admin.socket.close();
        diner.socket.close();
      }
    });
  });

  it("publishes only public catalogue metadata to the menu room", async () => {
    await withRealtime(async ({ manager, url }) => {
      const diner = await connectReady(url, GUEST_AUTH);
      const kitchen = await connectReady(url, KITCHEN_AUTH);
      try {
        const envelope = waitFor<Envelope>(diner.socket, SERVER_EVENT_CHANNEL);
        const kitchenNothing = expectNoMessage(kitchen.socket);

        const result = manager.toMenu("menu.updated", {
          items: [
            {
              id: "m-1",
              name: "Dal Tadka",
              price: 180,
              description: "Yellow lentils",
              is_available: true,
              image_url: "/menu/dal.jpg",
              cost: 60,
              stock_quantity: 4,
              supplier_name: "Hidden Supplier",
              supplier_contact: "+91-0000000000",
              internal_notes: "do not show",
              admin_notes: "admin only",
              participant_token: GUEST_TOKEN,
              session_secret: "abcdefghijklmnopqrst",
            },
          ],
          api_key: "provider-key",
        });

        assert.equal(result.room, MENU_ROOM);
        const message = await envelope;
        assert.deepEqual(message.data, {
          items: [
            {
              id: "m-1",
              name: "Dal Tadka",
              price: 180,
              description: "Yellow lentils",
              is_available: true,
              image_url: "/menu/dal.jpg",
            },
          ],
        });
        const serialized = JSON.stringify(message.data);
        for (const privateValue of [GUEST_TOKEN, "abcdefghijklmnopqrst", "Hidden Supplier", "provider-key"]) {
          assert.equal(serialized.includes(privateValue), false);
        }
        await kitchenNothing;
      } finally {
        diner.socket.close();
        kitchen.socket.close();
      }
    });
  });

  it("refuses a non-domain event name", async () => {
    await withRealtime(async ({ manager }) => {
      expectRealtimeError(
        () => manager.toKitchen("Order Created", { orderId: "o-1" }),
        "REALTIME_INVALID_EVENT",
      );
      expectRealtimeError(
        () => manager.toStaff("order", { orderId: "o-1" }),
        "REALTIME_INVALID_EVENT",
      );
    });
  });

  it("refuses a room this transport does not define", async () => {
    await withRealtime(async ({ manager }) => {
      expectRealtimeError(
        () => manager.toRoom("lobby", "order.created", {}),
        "REALTIME_INVALID_ROOM",
      );
    });
  });

  it("refuses an unserializable payload", async () => {
    await withRealtime(async ({ manager }) => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;

      expectRealtimeError(
        () => manager.toKitchen("order.created", circular),
        "REALTIME_INVALID_PAYLOAD",
      );
    });
  });

  it("refuses a payload above the size cap", async () => {
    await withRealtime(async ({ manager }) => {
      expectRealtimeError(
        () => manager.toKitchen("order.created", "x".repeat(MAX_PAYLOAD_CHARS + 1)),
        "REALTIME_PAYLOAD_TOO_LARGE",
      );
    });
  });

  it("skips publishing before the server starts", async () => {
    const manager = new IOManager({
      serverProvider: () => null,
      authenticator,
      isOriginAllowed: () => true,
    });

    const result = manager.toKitchen("order.created", { orderId: "o-1" });

    assert.deepEqual(result, {
      room: KITCHEN_ROOM,
      event: "order.created",
      recipients: 0,
      skipped: true,
    });
    assert.equal(manager.getState(), "new");
  });
});

describe("IOManager — shutdown", () => {
  it("disconnects clients, refuses new publishes and is idempotent", async () => {
    await withRealtime(async ({ manager, url }) => {
      const { socket } = await connectReady(url, GUEST_AUTH);
      const disconnected = new Promise<void>((resolve) => {
        socket.once("disconnect", () => resolve());
      });

      await manager.shutdown();
      await disconnected;

      assert.equal(manager.getState(), "closed");
      assert.equal(manager.diagnostics().connections, 0);
      assert.equal(manager.diagnostics().state, "closed");

      const result = manager.toKitchen("order.created", {});
      assert.equal(result.skipped, true);
      assert.equal(result.recipients, 0);

      await manager.shutdown();
      assert.equal(manager.getState(), "closed");
    });
  });

  it("counts accepted, rejected and rooms in diagnostics", async () => {
    await withRealtime(async ({ manager, url }) => {
      const diner = await connectReady(url, GUEST_AUTH);
      try {
        await connectRejected(url, { kind: "staff", token: "bad" });

        const diagnostics = manager.diagnostics();
        assert.equal(diagnostics.counters.accepted, 1);
        assert.equal(diagnostics.counters.rejected, 1);
        assert.equal(diagnostics.connections, 1);
        assert.equal(diagnostics.path, "/socket.io");
        assert.deepEqual(diagnostics.clients[0]?.rooms, [tableRoom(TABLE_ID), MENU_ROOM]);
        assert.equal(diagnostics.lastError, "staff token rejected");
      } finally {
        diner.socket.close();
      }
    });
  });
});
