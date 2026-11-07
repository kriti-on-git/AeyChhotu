/* IOManager — the single owner of the Socket.IO server.

   WHAT IT OWNS
   * the Socket.IO Server attached to the app's existing HTTP server;
   * the handshake: staff shift token OR table token + session pass;
   * room membership, decided server-side from the authenticated principal;
   * the client→server protocol (join/leave) and its payload validation;
   * publish-to-room for business code, behind RealtimePublisher;
   * connection diagnostics and a bounded, idempotent shutdown.

   WHAT IT DOES NOT DO
   * no SQL, no business rules: guest authorization is delegated to the
       injected RealtimeAuthenticator, which reuses the existing
       reconnectSession() table-session validation;
   * no domain event bus: the internal EventManager stays the internal
       channel. Nothing here imports it, and a socket event name never equals
       a domain event name.
   * no raw `io` escape hatch: the only outbound API is publish-to-room, which
       validates the room and the event name.

   AUTH MODEL
     staff: handshake { kind: "staff", token } → verifyToken (existing JWT),
            role becomes a room (`kitchen` / `floor` / `admin`) plus `staff`.
     guest: handshake { kind: "guest", table_token, secret } → the same
            table-token + 20-char pass a returning device already uses. The
            room is `table:<table_id>` from the database, so a client cannot
            address a table it did not authenticate for.

   Room requests are ALLOWLISTED: a guest may only (re)join its own table
   room; a shift may only use the rooms its role grants. There is no
   "join any room" path and no client-initiated broadcast. */

import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server as SocketServer, type Socket } from "socket.io";
import { z } from "zod";
import type { InitContext } from "../../bootstrap/InitContext.js";
import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import { systemClock, type Clock } from "../clock/Clock.js";
import type { Logger } from "../logging/Logger.js";
import {
  ADMIN_ROOM,
  ERROR_CHANNEL,
  EVENT_NAME_PATTERN,
  FLOOR_ROOM,
  JOIN_CHANNEL,
  KITCHEN_ROOM,
  LEAVE_CHANNEL,
  MAX_PAYLOAD_CHARS,
  MENU_ROOM,
  publicMenuPayload,
  READY_CHANNEL,
  ROOM_PATTERN,
  SERVER_EVENT_CHANNEL,
  STAFF_ROOM,
  tableRoom,
  type PublishResult,
  type RealtimeEnvelope,
  type RealtimePublisher,
} from "./RealtimePublisher.js";

/* ---------------------------------------------------------------- types */

export type StaffRole = "kitchen" | "floor" | "admin";

export interface StaffPrincipal {
  readonly kind: "staff";
  readonly role: StaffRole;
  readonly terminalId: string | null;
}

export interface GuestPrincipal {
  readonly kind: "guest";
  /** Database id from the validated table session — never client-supplied. */
  readonly tableId: string;
  readonly tableToken: string;
  /** Server-side roster identity derived from the participant credential. */
  readonly participantId: string;
  /** SHA-256 digest only: revalidation never needs the raw token again. */
  readonly tokenHash: string;
}

export type RealtimePrincipal = StaffPrincipal | GuestPrincipal;

/** Injected at the composition root. `authenticateStaff` is synchronous (JWT
    verification); `authenticateGuest` may hit the database through the
    existing session validation. Both return null for an invalid credential —
    they never throw on bad input. */
export interface RealtimeAuthenticator {
  authenticateStaff(token: string): StaffPrincipal | null;
  authenticateGuest(input: {
    readonly participantToken: string;
  }): Promise<GuestPrincipal | null>;
  /** Periodic check that the credential is still live for this seating. */
  revalidateGuest?(input: { readonly tokenHash: string }): Promise<boolean>;
}

export type RealtimeState = "new" | "listening" | "closed";

export interface RealtimeClientInfo {
  readonly socket_id: string;
  readonly kind: RealtimePrincipal["kind"];
  readonly role: StaffRole | null;
  readonly table_id: string | null;
  readonly connected_at: string;
  readonly rooms: readonly string[];
}

/** Internal bookkeeping: same fields as the diagnostics view, but with a
    mutable room set. */
interface TrackedClient {
  readonly socket_id: string;
  readonly kind: RealtimePrincipal["kind"];
  readonly role: StaffRole | null;
  readonly table_id: string | null;
  /** Guest credential digest, used only for periodic revalidation. */
  readonly token_hash: string | null;
  readonly connected_at: string;
  readonly rooms: Set<string>;
}

export interface RealtimeDiagnostics {
  readonly state: RealtimeState;
  readonly path: string;
  readonly connections: number;
  readonly counters: Readonly<{
    accepted: number;
    rejected: number;
    disconnected: number;
    published: number;
    delivered: number;
    skipped: number;
    invalidPayloads: number;
    roomDenials: number;
    unknownEvents: number;
  }>;
  readonly rooms: Readonly<Record<string, number>>;
  readonly clients: readonly RealtimeClientInfo[];
  readonly lastError: string | null;
}

export type RealtimeErrorCode =
  | "REALTIME_ALREADY_STARTED"
  | "REALTIME_NO_SERVER"
  | "REALTIME_INVALID_ROOM"
  | "REALTIME_INVALID_EVENT"
  | "REALTIME_INVALID_PAYLOAD"
  | "REALTIME_PAYLOAD_TOO_LARGE";

export class RealtimeError extends Error {
  readonly code: RealtimeErrorCode;

  constructor(code: RealtimeErrorCode, message: string) {
    super(message);
    this.name = "RealtimeError";
    this.code = code;
  }
}

interface RealtimeErrorPayload {
  readonly code:
    | "UNAUTHORIZED"
    | "INVALID_HANDSHAKE"
    | "INVALID_PAYLOAD"
    | "ROOM_FORBIDDEN"
    | "UNKNOWN_EVENT"
    | "RATE_LIMITED";
  readonly message: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly room?: string;
}

type RoomAck =
  | { readonly ok: true; readonly room: string; readonly joined: boolean }
  | { readonly ok: false; readonly error: RealtimeErrorPayload };

interface ClientToServerEvents {
  "realtime:join": (payload: unknown, ack?: (response: RoomAck) => void) => void;
  "realtime:leave": (payload: unknown, ack?: (response: RoomAck) => void) => void;
}

interface ServerToClientEvents {
  "realtime:ready": (payload: {
    readonly socket_id: string;
    readonly kind: RealtimePrincipal["kind"];
    readonly rooms: readonly string[];
    readonly at: string;
  }) => void;
  "realtime:event": (envelope: RealtimeEnvelope) => void;
  "realtime:error": (error: RealtimeErrorPayload) => void;
}

type InterServerEvents = Record<string, never>;

interface SocketData {
  principal?: RealtimePrincipal;
}

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type TypedServer = SocketServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface IOManagerOptions {
  /** The app's listening HTTP server. Socket.IO never opens its own port. */
  readonly serverProvider: () => HttpServer | null;
  readonly authenticator: RealtimeAuthenticator;
  /** Path for the Socket.IO endpoint. Defaults to /socket.io. */
  readonly path?: string;
  /** Reuses the API's CORS policy at the composition root. */
  readonly isOriginAllowed?: (origin: string) => boolean;
  readonly name?: string;
}

/* -------------------------------------------------------------- protocol */

const handshakeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("staff"),
    token: z.string().min(1, "A staff token is required."),
  }),
  z.object({
    kind: z.literal("guest"),
    participant_token: z
      .string()
      .trim()
      .regex(/^pc_[A-Za-z0-9_-]{43}$/, "A participant credential is required."),
  }),
]);

const roomRequestSchema = z.object({
  room: z.string().trim().min(1, "room is required.").max(80, "room must be 80 characters or fewer."),
});

const AUTH_MESSAGE = "Missing or invalid realtime credentials.";

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    fields[issue.path.length > 0 ? issue.path.join(".") : "body"] = issue.message;
  }
  return fields;
}

function authFailure(code: RealtimeErrorPayload["code"], message: string): Error & { data: unknown } {
  const error = new Error(message) as Error & { data: unknown };
  error.name = "RealtimeAuthError";
  error.data = { code, message };
  return error;
}

function staffRoomFor(role: StaffRole): string {
  if (role === "kitchen") return KITCHEN_ROOM;
  if (role === "floor") return FLOOR_ROOM;
  return ADMIN_ROOM;
}

/** The complete set of rooms a principal may ever occupy. A guest may only
    see its own table room and the public catalogue; room names from the
    client are never used unless they appear in this list. */
export function allowedRooms(principal: RealtimePrincipal): readonly string[] {
  if (principal.kind === "guest") return [tableRoom(principal.tableId), MENU_ROOM];
  return [STAFF_ROOM, staffRoomFor(principal.role)];
}

/* ---------------------------------------------------------------- manager */

export class IOManager implements ManagedComponent, RealtimePublisher {
  readonly name: string;
  /** Socket.IO rides the API's listener; without it there is nothing to attach to. */
  readonly dependencies: readonly string[] = ["http.server"];

  private readonly options: IOManagerOptions;
  private readonly path: string;
  private readonly originAllowed: (origin: string) => boolean;

  private io: TypedServer | null = null;
  private state: RealtimeState = "new";
  private logger: Logger | null = null;
  private clock: Clock = systemClock;
  private lastError: string | null = null;
  private revalidationTimer: NodeJS.Timeout | null = null;
  /** Process-local handshake budget, per /64-corrected client address. */
  private readonly handshakeBuckets = new Map<string, { count: number; resetAt: number }>();

  private readonly clients = new Map<string, TrackedClient>();
  private readonly counters = {
    accepted: 0,
    rejected: 0,
    disconnected: 0,
    published: 0,
    delivered: 0,
    skipped: 0,
    invalidPayloads: 0,
    roomDenials: 0,
    unknownEvents: 0,
  };

  constructor(options: IOManagerOptions) {
    this.options = options;
    this.name = options.name ?? "realtime";
    this.path = options.path ?? "/socket.io";
    this.originAllowed = options.isOriginAllowed ?? (() => false);
  }

  /* --------------------------------------------------------- lifecycle */

  async init(ctx: InitContext): Promise<void> {
    this.logger = ctx.logger.child({ component: this.name });
    this.clock = ctx.clock;
  }

  /**
   * Attaches Socket.IO to the already-listening HTTP server. Called after the
   * http.server component starts, so the API and the websocket share a port.
   */
  async start(): Promise<void> {
    if (this.state !== "new") {
      throw new RealtimeError(
        "REALTIME_ALREADY_STARTED",
        "IOManager.start() may only be called once.",
      );
    }

    const httpServer = this.options.serverProvider();
    if (httpServer === null) {
      throw new RealtimeError(
        "REALTIME_NO_SERVER",
        "IOManager needs a listening HTTP server before it can start.",
      );
    }

    const io: TypedServer = new SocketServer(httpServer, {
      path: this.path,
      serveClient: false,
      cors: {
        origin: (origin, callback) => {
          // Same rule as the REST API: no Origin (native client, server,
          // same-origin navigation) is fine; a browser origin must be allowed.
          callback(null, origin === undefined || this.originAllowed(origin));
        },
        credentials: true,
      },
    });

    this.io = io;
    io.use((socket, next) => {
      void this.authenticate(socket).then((result) => {
        if ("error" in result) {
          next(result.error);
          return;
        }
        socket.data.principal = result.principal;
        next();
      });
    });
    io.on("connection", (socket) => this.onConnection(socket));

    /* Expired/revoked guest credentials are disconnected without waiting for
       the client to reconnect. The interval is process-local, like the
       adapter; the documented deployment is one API instance. */
    this.revalidationTimer = setInterval(() => void this.revalidateGuests(), 60_000);
    this.revalidationTimer.unref();

    this.state = "listening";
    this.logger?.info("realtime_listening", { path: this.path });
  }

  /** Disconnects every client, closes the Socket.IO server, is idempotent. */
  async shutdown(): Promise<void> {
    if (this.state === "closed") return;

    if (this.revalidationTimer !== null) {
      clearInterval(this.revalidationTimer);
      this.revalidationTimer = null;
    }

    const io = this.io;
    this.io = null;
    this.state = "closed";

    const connections = this.clients.size;
    this.clients.clear();

    if (io !== null) {
      io.disconnectSockets(true);
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    }

    this.logger?.info("realtime_closed", {
      clients: connections,
      published: this.counters.published,
    });
  }

  /* ------------------------------------------------------------- auth */

  private async authenticate(
    socket: TypedSocket,
  ): Promise<{ principal: RealtimePrincipal } | { error: Error & { data: unknown } }> {
    /* Handshake limiting is separate from the REST limiters: a socket never
       passes through Express. The response is generic and never reveals
       whether a token or table exists. */
    if (!this.allowHandshake(socket.handshake.address)) {
      this.counters.rejected += 1;
      this.lastError = "handshake rate limited";
      return {
        error: authFailure("RATE_LIMITED", "Too many connection attempts. Please wait."),
      };
    }

    const parsed = handshakeSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) {
      this.counters.rejected += 1;
      this.lastError = "invalid handshake payload";
      this.logger?.warn("realtime_handshake_rejected", { reason: "invalid_payload" });
      return {
        error: authFailure(
          "INVALID_HANDSHAKE",
          'Provide { kind: "staff", token } or { kind: "guest", participant_token }.',
        ),
      };
    }

    const credential = parsed.data;

    if (credential.kind === "staff") {
      const principal = this.options.authenticator.authenticateStaff(credential.token);
      if (principal === null) {
        this.counters.rejected += 1;
        this.lastError = "staff token rejected";
        this.logger?.warn("realtime_handshake_rejected", { reason: "staff_token" });
        return { error: authFailure("UNAUTHORIZED", AUTH_MESSAGE) };
      }
      this.counters.accepted += 1;
      return { principal };
    }

    let principal: GuestPrincipal | null = null;
    try {
      principal = await this.options.authenticator.authenticateGuest({
        participantToken: credential.participant_token,
      });
    } catch (err) {
      // An infrastructure failure during validation is not a credential
      // decision: log it, but still refuse the socket.
      this.logger?.error("realtime_guest_auth_failed", { error: err });
      principal = null;
    }

    if (principal === null) {
      this.counters.rejected += 1;
      this.lastError = "table session rejected";
      this.logger?.warn("realtime_handshake_rejected", { reason: "table_session" });
      return { error: authFailure("UNAUTHORIZED", AUTH_MESSAGE) };
    }

    this.counters.accepted += 1;
    return { principal };
  }

  /* -------------------------------------------------------- connection */

  private onConnection(socket: TypedSocket): void {
    const principal = socket.data.principal;
    if (principal === undefined) {
      // Unreachable through the middleware above; refuse rather than guess.
      socket.disconnect(true);
      return;
    }

    const rooms = allowedRooms(principal);
    for (const room of rooms) void socket.join(room);

    this.clients.set(socket.id, {
      socket_id: socket.id,
      kind: principal.kind,
      role: principal.kind === "staff" ? principal.role : null,
      table_id: principal.kind === "guest" ? principal.tableId : null,
      token_hash: principal.kind === "guest" ? principal.tokenHash : null,
      connected_at: this.clock.now().toISOString(),
      rooms: new Set(rooms),
    });

    socket.emit(READY_CHANNEL, {
      socket_id: socket.id,
      kind: principal.kind,
      rooms,
      at: this.clock.now().toISOString(),
    });

    socket.on(JOIN_CHANNEL, (payload, ack) => {
      this.handleRoomRequest(socket, "join", payload, ack);
    });
    socket.on(LEAVE_CHANNEL, (payload, ack) => {
      this.handleRoomRequest(socket, "leave", payload, ack);
    });

    // Nothing else is accepted from a client. Without this, a typo'd or
    // hostile event name would be silently ignored; instead it is refused
    // and counted, so a client bug is visible in diagnostics.
    socket.onAny((event: string) => {
      if (event === JOIN_CHANNEL || event === LEAVE_CHANNEL) return;
      this.counters.unknownEvents += 1;
      this.sendError(socket, {
        code: "UNKNOWN_EVENT",
        message: `Event "${event}" is not accepted from clients.`,
      });
    });

    socket.on("disconnect", () => {
      this.clients.delete(socket.id);
      this.counters.disconnected += 1;
    });

    this.logger?.debug("realtime_client_connected", {
      socket_id: socket.id,
      kind: principal.kind,
      rooms,
    });
  }

  /* -------------------------------------------------------- room policy */

  private handleRoomRequest(
    socket: TypedSocket,
    action: "join" | "leave",
    payload: unknown,
    ack?: (response: RoomAck) => void,
  ): void {
    const principal = socket.data.principal;
    if (principal === undefined) {
      this.reject(socket, ack, { code: "UNAUTHORIZED", message: AUTH_MESSAGE });
      return;
    }

    const parsed = roomRequestSchema.safeParse(payload);
    if (!parsed.success) {
      this.counters.invalidPayloads += 1;
      this.reject(socket, ack, {
        code: "INVALID_PAYLOAD",
        message: "Room requests need { room: string }.",
        fields: fieldErrors(parsed.error),
      });
      return;
    }

    const room = parsed.data.room;
    if (!allowedRooms(principal).includes(room)) {
      this.counters.roomDenials += 1;
      this.logger?.warn("realtime_room_denied", {
        socket_id: socket.id,
        kind: principal.kind,
        room,
      });
      this.reject(socket, ack, {
        code: "ROOM_FORBIDDEN",
        message: "This connection is not authorized for that room.",
        room,
      });
      return;
    }

    if (action === "join") {
      void socket.join(room);
      this.clients.get(socket.id)?.rooms.add(room);
    } else {
      void socket.leave(room);
      this.clients.get(socket.id)?.rooms.delete(room);
    }

    ack?.({ ok: true, room, joined: action === "join" });
  }

  private reject(
    socket: TypedSocket,
    ack: ((response: RoomAck) => void) | undefined,
    error: RealtimeErrorPayload,
  ): void {
    this.sendError(socket, error);
    ack?.({ ok: false, error });
  }

  private sendError(socket: TypedSocket, error: RealtimeErrorPayload): void {
    this.lastError = error.message;
    socket.emit(ERROR_CHANNEL, error);
  }

  /* ----------------------------------------------------------- publish */

  toTable(tableId: string, event: string, data: unknown): PublishResult {
    return this.publish(tableRoom(tableId), event, data);
  }

  toKitchen(event: string, data: unknown): PublishResult {
    return this.publish(KITCHEN_ROOM, event, data);
  }

  toFloor(event: string, data: unknown): PublishResult {
    return this.publish(FLOOR_ROOM, event, data);
  }

  toAdmin(event: string, data: unknown): PublishResult {
    return this.publish(ADMIN_ROOM, event, data);
  }

  toStaff(event: string, data: unknown): PublishResult {
    return this.publish(STAFF_ROOM, event, data);
  }

  /** Public catalogue room. Internal catalogue fields are stripped first. */
  toMenu(event: string, data: unknown): PublishResult {
    return this.publish(MENU_ROOM, event, publicMenuPayload(data));
  }

  toRoom(room: string, event: string, data: unknown): PublishResult {
    return this.publish(room, event, data);
  }

  /** True while the transport can actually deliver. The outbox uses this so a
      boot-time poll does not mark events published with no listener. */
  isAvailable(): boolean {
    return this.state === "listening" && this.io !== null;
  }

  /**
   * Clear: the terminal `table.session.ended` event is emitted through the
   * outbox FIRST; this runs after that publish commits and only then drops
   * the room's sockets.
   */
  disconnectTable(tableId: string): void {
    const io = this.io;
    if (io === null || this.state !== "listening") return;
    io.in(tableRoom(tableId)).disconnectSockets(true);
  }

  /**
   * Controlled broadcast: the room must be one this transport defines, the
   * event name must be a domain-style name, and the payload must serialize
   * under the size cap. Nothing here is reachable from a socket.
   */
  private publish(room: string, event: string, data: unknown): PublishResult {
    if (!ROOM_PATTERN.test(room)) {
      throw new RealtimeError(
        "REALTIME_INVALID_ROOM",
        `"${room}" is not a realtime room. Use staff/kitchen/floor/admin or table:<id>.`,
      );
    }
    if (!EVENT_NAME_PATTERN.test(event)) {
      throw new RealtimeError(
        "REALTIME_INVALID_EVENT",
        `"${event}" is not a domain event name (lowercase, dot-separated, e.g. order.created).`,
      );
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(data ?? null);
    } catch {
      throw new RealtimeError(
        "REALTIME_INVALID_PAYLOAD",
        "The realtime payload is not JSON-serializable.",
      );
    }
    if (serialized.length > MAX_PAYLOAD_CHARS) {
      throw new RealtimeError(
        "REALTIME_PAYLOAD_TOO_LARGE",
        `The realtime payload exceeds ${MAX_PAYLOAD_CHARS} characters. Publish an id and let the client fetch the rest.`,
      );
    }

    if (this.state !== "listening" || this.io === null) {
      this.counters.skipped += 1;
      this.logger?.debug("realtime_publish_skipped", { room, event });
      return { room, event, recipients: 0, skipped: true };
    }

    const envelope: RealtimeEnvelope = Object.freeze({
      id: randomUUID(),
      event,
      room,
      at: this.clock.now().toISOString(),
      sequence: this.counters.published + 1,
      data,
    });

    this.io.to(room).emit(SERVER_EVENT_CHANNEL, envelope);

    const recipients = this.io.sockets.adapter.rooms.get(room)?.size ?? 0;
    this.counters.published += 1;
    this.counters.delivered += recipients;

    return { room, event, recipients, skipped: false };
  }

  /* ------------------------------------------------------------ health */

  health(): ComponentHealth {
    if (this.state === "listening") {
      return {
        state: "HEALTHY",
        message: `Socket.IO is listening on ${this.path}.`,
        details: { connections: this.clients.size },
      };
    }

    return {
      state: "UNHEALTHY",
      message:
        this.state === "new"
          ? "Socket.IO has not been attached to the HTTP server."
          : "Socket.IO has shut down.",
    };
  }

  /** Read-only: asks the adapter for its room map. No client is disturbed. */
  selfTest(): SelfTestResult {
    if (this.state !== "listening" || this.io === null) {
      return { ok: false, message: "Socket.IO is not listening." };
    }

    const rooms = this.io.sockets.adapter.rooms;
    return {
      ok: rooms instanceof Map,
      message:
        rooms instanceof Map
          ? `Adapter reachable with ${rooms.size} room record(s).`
          : "The adapter did not expose its room map.",
      details: {
        connections: this.clients.size,
        rooms: rooms instanceof Map ? rooms.size : null,
      },
    };
  }

  /* ------------------------------------------------------- diagnostics */

  diagnostics(): RealtimeDiagnostics {
    const rooms: Record<string, number> = {};
    const io = this.io;
    if (io !== null) {
      for (const [room, members] of io.sockets.adapter.rooms) {
        if (ROOM_PATTERN.test(room)) rooms[room] = members.size;
      }
    }

    return {
      state: this.state,
      path: this.path,
      connections: this.clients.size,
      counters: Object.freeze({ ...this.counters }),
      rooms: Object.freeze(rooms),
      clients: Object.freeze(
        [...this.clients.values()].map((client) =>
          Object.freeze({
            socket_id: client.socket_id,
            kind: client.kind,
            role: client.role,
            table_id: client.table_id,
            connected_at: client.connected_at,
            rooms: Object.freeze([...client.rooms]),
          }),
        ),
      ),
      lastError: this.lastError,
    };
  }

  getState(): RealtimeState {
    return this.state;
  }

  /* ------------------------------------------------------ revalidation */

  private allowHandshake(address: string | undefined): boolean {
    const key = address && address.length > 0 ? address : "unknown";
    const now = Date.now();
    const windowMs = 60_000;
    const limit = 30;

    const bucket = this.handshakeBuckets.get(key);
    if (bucket === undefined || now >= bucket.resetAt) {
      if (this.handshakeBuckets.size > 2_000) this.handshakeBuckets.clear();
      this.handshakeBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    bucket.count += 1;
    return bucket.count <= limit;
  }

  private async revalidateGuests(): Promise<void> {
    const check = this.options.authenticator.revalidateGuest;
    const io = this.io;
    if (check === undefined || io === null) return;

    for (const client of [...this.clients.values()]) {
      if (client.kind !== "guest" || client.token_hash === null) continue;

      let valid = false;
      try {
        valid = await check({ tokenHash: client.token_hash });
      } catch {
        valid = false;
      }
      if (valid) continue;

      const socket = io.sockets.sockets.get(client.socket_id);
      if (socket === undefined) continue;
      socket.emit(ERROR_CHANNEL, {
        code: "UNAUTHORIZED",
        message: "This participant credential is no longer valid.",
      });
      socket.disconnect(true);
    }
  }
}
