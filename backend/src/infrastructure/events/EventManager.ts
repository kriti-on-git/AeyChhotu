/* EventManager — the internal, in-process domain event bus.

   WHAT IT IS FOR
   * The app tells itself that something happened: `cart.item.added`,
     `order.created`, `ticket.created`, `kitchen.ticket.completed`.
   * Producers publish, consumers subscribe. Neither learns about the other.

   WHAT IT IS NOT
   * NOT Socket.IO. Transport events (browser rooms, `table:{id}` channels,
     acknowledgement callbacks) are a different concern with a different
     failure mode: a dropped socket is normal, a dropped internal event is a
     bug. Nothing here imports a transport, and no event name below is a
     socket channel.
   * NOT a replacement for module interfaces. A service still takes its
     collaborators as constructor arguments; the bus only decouples
     side-effects that genuinely should not know their consumers (audit log,
     KDS refresh nudge, metrics). Never route a required return value through
     an event.

   GUARANTEES
   * Strongly typed: `EventManager<TMap>` ties every name to its payload, so
     `emit("order.created", …)` cannot be handed a cart payload.
   * Registration first: an event must be registered before it can be
     subscribed to or emitted. Typos fail loudly instead of being ignored.
     Duplicate registration throws.
   * Listener identity is unique per event: subscribing the same function
     twice throws instead of silently doubling every side-effect.
   * Dispatch snapshots the listener list, then runs listeners ONE AT A TIME
     in registration order. Deterministic ordering, and a listener added
     during dispatch waits for the next emission.
   * Listener errors are isolated: a throwing (or rejecting) listener is
     logged and counted, other listeners still run, and `emit()` resolves.
     An emitted event must never break the caller that emitted it.
   * `once` listeners are removed BEFORE they run, so a throwing once-listener
     cannot fire twice and a re-emit from inside it cannot loop.

   TESTABILITY: construction alone is a working bus (system clock, no logger).
   `init()` only supplies the logger and clock; nothing external is opened. */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { InitContext } from "../../bootstrap/InitContext.js";
import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import { systemClock, type Clock } from "../clock/Clock.js";
import type { Logger } from "../logging/Logger.js";

/* ------------------------------------------------------------------ types */

/** name → payload shape for one bus. `object` (not `Record<string, unknown>`)
    so a catalog can be written as a plain interface with literal keys;
    domain events belong in a catalog. */
export type EventMap = object;

export type EventName<TMap extends EventMap> = keyof TMap & string;

export interface EventDefinition<TName extends string = string> {
  readonly name: TName;
  readonly description: string;
}

/** Declares an event. Purely declarative: registration happens on the bus. */
export function defineEvent<TName extends string>(
  name: TName,
  description: string,
): EventDefinition<TName> {
  if (name.trim() === "") {
    throw new EventError("EVENT_INVALID_NAME", "An event name must not be empty.");
  }
  return Object.freeze({ name, description });
}

/** Facts about one emission, handed to every listener. */
export interface EventMeta<TName extends string = string> {
  readonly id: string;
  readonly name: TName;
  readonly at: Date;
  /** Monotonic per-bus counter, useful when log lines must be ordered. */
  readonly sequence: number;
  /** Size of the dispatch snapshot, i.e. how many listeners were offered it. */
  readonly listeners: number;
}

export type EventListener<TMap extends EventMap, TName extends EventName<TMap>> = (
  payload: TMap[TName],
  meta: EventMeta<TName>,
) => void | Promise<void>;

export interface ListenerOptions {
  readonly once?: boolean;
  /** Diagnostic name used in failure reports; defaults to the function name. */
  readonly label?: string;
}

export interface ListenerFailure {
  readonly event: string;
  readonly listener: string;
  readonly message: string;
  readonly at: string;
}

export interface EmitReport<TName extends string = string> {
  readonly id: string;
  readonly event: TName;
  readonly listeners: number;
  readonly delivered: number;
  readonly failures: readonly ListenerFailure[];
  readonly durationMs: number;
  /** Emitted after shutdown: nothing was dispatched. */
  readonly skipped?: true;
}

export type EventState = "open" | "closed";

export interface EventDiagnostics {
  readonly state: EventState;
  readonly registered: readonly string[];
  /** Listener count per event. Events with no listeners are omitted. */
  readonly listeners: Readonly<Record<string, number>>;
  readonly counters: Readonly<{
    emitted: number;
    delivered: number;
    failures: number;
    skipped: number;
  }>;
  readonly recentFailures: readonly ListenerFailure[];
}

/** What a publisher receives through dependency injection: no registration,
    no shutdown, no diagnostics. */
export interface EventPort<TMap extends EventMap> {
  emit<TName extends EventName<TMap>>(
    name: TName,
    payload: TMap[TName],
  ): Promise<EmitReport<TName>>;
  emitDetached<TName extends EventName<TMap>>(name: TName, payload: TMap[TName]): void;
}

export type EventErrorCode =
  | "EVENT_NOT_REGISTERED"
  | "EVENT_ALREADY_REGISTERED"
  | "EVENT_DUPLICATE_LISTENER"
  | "EVENT_INVALID_NAME"
  | "EVENT_MANAGER_CLOSED";

export class EventError extends Error {
  readonly code: EventErrorCode;

  constructor(code: EventErrorCode, message: string) {
    super(message);
    this.name = "EventError";
    this.code = code;
  }
}

/* -------------------------------------------------------------- internals */

/* One erasure point for listener storage. `on()` wraps the typed listener in
   `run`, so no `any` escapes into the bus. */
interface ListenerEntry {
  /** Identity for duplicate detection and off(); never invoked directly. */
  readonly source: unknown;
  readonly label: string;
  readonly once: boolean;
  readonly run: (payload: unknown, meta: EventMeta) => void | Promise<void>;
}

export interface EventManagerOptions {
  /** Component name in lifecycle logs. Defaults to "events". */
  readonly name?: string;
  /** How many listener failures diagnostics retain. Defaults to 20. */
  readonly maxRecentFailures?: number;
}

const DEFAULT_MAX_RECENT_FAILURES = 20;

/* ---------------------------------------------------------------- manager */

export class EventManager<TMap extends EventMap>
  implements ManagedComponent, EventPort<TMap>
{
  readonly name: string;
  readonly dependencies: readonly string[] = [];

  private readonly registry = new Map<string, EventDefinition>();
  private readonly listeners = new Map<string, ListenerEntry[]>();
  private readonly counters = {
    emitted: 0,
    delivered: 0,
    failures: 0,
    skipped: 0,
  };
  private readonly recentFailures: ListenerFailure[] = [];
  private readonly maxRecentFailures: number;

  private state: EventState = "open";
  private logger: Logger | null = null;
  private clock: Clock = systemClock;
  private sequence = 0;

  constructor(options: EventManagerOptions = {}) {
    this.name = options.name ?? "events";
    this.maxRecentFailures = options.maxRecentFailures ?? DEFAULT_MAX_RECENT_FAILURES;
  }

  /* --------------------------------------------------------- lifecycle */

  /** Supplies logger + clock. Opens nothing, so emit/on work without it. */
  async init(ctx: InitContext): Promise<void> {
    this.logger = ctx.logger.child({ component: this.name });
    this.clock = ctx.clock;
    this.logger.debug("events_ready", { registered: this.registry.size });
  }

  /** Drops every listener. The bus refuses new work afterwards. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.state === "closed") return;

    const removed = this.clear();
    this.state = "closed";

    this.logger?.info("events_closed", {
      listeners_removed: removed,
      emitted: this.counters.emitted,
      failures: this.counters.failures,
    });
  }

  /* ------------------------------------------------------ registration */

  register(definition: EventDefinition): this {
    if (this.state === "closed") {
      throw new EventError(
        "EVENT_MANAGER_CLOSED",
        "Cannot register events after the manager has shut down.",
      );
    }

    const name = definition.name;
    if (name.trim() === "") {
      throw new EventError("EVENT_INVALID_NAME", "An event name must not be empty.");
    }
    if (this.registry.has(name)) {
      throw new EventError(
        "EVENT_ALREADY_REGISTERED",
        `Event "${name}" is already registered. Each event is declared once, in the catalog.`,
      );
    }

    this.registry.set(name, Object.freeze({ name, description: definition.description }));
    return this;
  }

  registerAll(definitions: readonly EventDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  registeredEvents(): readonly string[] {
    return [...this.registry.keys()];
  }

  isRegistered(name: string): boolean {
    return this.registry.has(name);
  }

  /* --------------------------------------------------------- listeners */

  /**
   * Subscribes a listener. Returns a dispose function, so the subscriber owns
   * its own cleanup and `off()`/the disposer stay interchangeable.
   *
   * @throws EVENT_NOT_REGISTERED for an undeclared event
   * @throws EVENT_DUPLICATE_LISTENER when this exact function is already
   *         subscribed to this event
   */
  on<TName extends EventName<TMap>>(
    name: TName,
    listener: EventListener<TMap, TName>,
    options: ListenerOptions = {},
  ): () => void {
    this.requireRegistered(name);
    this.requireOpen();

    const entries = this.entriesFor(name, true);
    if (entries.some((entry) => entry.source === listener)) {
      throw new EventError(
        "EVENT_DUPLICATE_LISTENER",
        `This listener is already subscribed to "${name}". Subscribing it twice would double every side-effect.`,
      );
    }

    const entry: ListenerEntry = {
      source: listener,
      label: options.label ?? (listener.name === "" ? "anonymous" : listener.name),
      once: options.once === true,
      run: (payload, meta) => listener(payload as TMap[TName], meta as EventMeta<TName>),
    };
    entries.push(entry);

    return () => {
      this.removeEntry(name, entry);
    };
  }

  /** Convenience wrapper over `on(..., { once: true })`. */
  once<TName extends EventName<TMap>>(
    name: TName,
    listener: EventListener<TMap, TName>,
    options: Omit<ListenerOptions, "once"> = {},
  ): () => void {
    return this.on(name, listener, { ...options, once: true });
  }

  /** @returns whether that listener was subscribed. */
  off<TName extends EventName<TMap>>(
    name: TName,
    listener: EventListener<TMap, TName>,
  ): boolean {
    const entries = this.listeners.get(name);
    if (entries === undefined) return false;

    const entry = entries.find((candidate) => candidate.source === listener);
    return entry !== undefined && this.removeEntry(name, entry);
  }

  listenerCount(name: string): number {
    return this.listeners.get(name)?.length ?? 0;
  }

  hasListeners(name: string): boolean {
    return this.listenerCount(name) > 0;
  }

  /** Removes listeners for one event, or for every event.
      @returns how many listeners were removed. */
  clear(name?: string): number {
    if (name === undefined) {
      let removed = 0;
      for (const entries of this.listeners.values()) removed += entries.length;
      this.listeners.clear();
      return removed;
    }

    const removed = this.listeners.get(name)?.length ?? 0;
    this.listeners.delete(name);
    return removed;
  }

  /* ---------------------------------------------------------- dispatch */

  /**
   * Dispatches to the listeners registered at this moment, sequentially, and
   * resolves with a report. Never rejects because of a listener.
   *
   * Awaited on purpose: `order.created` must be finished (and its failures
   * known) before the HTTP handler responds. Fire-and-forget callers use
   * `emitDetached`.
   *
   * @throws EVENT_NOT_REGISTERED for an undeclared event
   */
  async emit<TName extends EventName<TMap>>(
    name: TName,
    payload: TMap[TName],
  ): Promise<EmitReport<TName>> {
    this.requireRegistered(name);

    const started = performance.now();
    const snapshot = this.entriesFor(name, false).slice();
    const meta: EventMeta<TName> = Object.freeze({
      id: randomUUID(),
      name,
      at: this.clock.now(),
      sequence: (this.sequence += 1),
      listeners: snapshot.length,
    });

    if (this.state === "closed") {
      // A shutdown must not turn a late emit into a crash.
      this.counters.skipped += 1;
      this.logger?.warn("event_emitted_after_close", { domain_event: name });
      return Object.freeze({
        id: meta.id,
        event: name,
        listeners: snapshot.length,
        delivered: 0,
        failures: Object.freeze([]),
        durationMs: roundMs(performance.now() - started),
        skipped: true,
      });
    }

    this.counters.emitted += 1;

    const failures: ListenerFailure[] = [];
    let delivered = 0;

    for (const entry of snapshot) {
      // Removed BEFORE it runs: a throwing once-listener still fires once.
      if (entry.once) this.removeEntry(name, entry);

      try {
        await entry.run(payload, meta);
        delivered += 1;
        this.counters.delivered += 1;
      } catch (err) {
        const failure: ListenerFailure = Object.freeze({
          event: name,
          listener: entry.label,
          message: err instanceof Error ? err.message : String(err),
          at: this.clock.now().toISOString(),
        });
        failures.push(failure);
        this.counters.failures += 1;
        this.rememberFailure(failure);
        // `event` is the logger's own line key, so the bus names its field
        // `domain_event` — otherwise the log event name is overwritten.
        this.logger?.error("event_listener_failed", {
          domain_event: name,
          listener: entry.label,
          error: err,
        });
      }
    }

    return Object.freeze({
      id: meta.id,
      event: name,
      listeners: snapshot.length,
      delivered,
      failures: Object.freeze(failures),
      durationMs: roundMs(performance.now() - started),
    });
  }

  /**
   * Fire-and-forget dispatch for callers that must not wait (a socket
   * broadcast, an analytics ping). Failures are already isolated per
   * listener; only a programming error (unregistered event) can surface, and
   * that is logged rather than thrown into the emitter.
   */
  emitDetached<TName extends EventName<TMap>>(
    name: TName,
    payload: TMap[TName],
  ): void {
    void this.emit(name, payload).then(
      () => undefined,
      (err: unknown) => {
        this.logger?.error("event_emit_detached_failed", {
          domain_event: name,
          error: err,
        });
      },
    );
  }

  /* ------------------------------------------------------------ health */

  health(): ComponentHealth {
    if (this.state === "closed") {
      return { state: "UNHEALTHY", message: "The event bus is closed." };
    }

    let listeners = 0;
    for (const entries of this.listeners.values()) listeners += entries.length;

    return {
      state: "HEALTHY",
      message: `${this.registry.size} event(s), ${listeners} listener(s).`,
      details: { registered: this.registry.size, listeners },
    };
  }

  /** Read-only invariant check: dispatches nothing, so it is safe under traffic. */
  selfTest(): SelfTestResult {
    const duplicated: string[] = [];

    for (const [event, entries] of this.listeners) {
      const sources = new Set<unknown>();
      for (const entry of entries) {
        if (sources.has(entry.source)) duplicated.push(event);
        sources.add(entry.source);
      }
    }

    return {
      ok: duplicated.length === 0,
      message:
        duplicated.length === 0
          ? "No duplicate listener registrations."
          : `Duplicate listeners on: ${duplicated.join(", ")}.`,
      details: { duplicate_events: duplicated },
    };
  }

  /* ------------------------------------------------------- diagnostics */

  diagnostics(): EventDiagnostics {
    const listeners: Record<string, number> = {};
    for (const [event, entries] of this.listeners) listeners[event] = entries.length;

    return {
      state: this.state,
      registered: [...this.registry.keys()],
      listeners: Object.freeze(listeners),
      counters: Object.freeze({ ...this.counters }),
      recentFailures: Object.freeze([...this.recentFailures]),
    };
  }

  getState(): EventState {
    return this.state;
  }

  /* ---------------------------------------------------------- internal */

  private requireOpen(): void {
    if (this.state === "closed") {
      throw new EventError(
        "EVENT_MANAGER_CLOSED",
        "Cannot subscribe after the manager has shut down.",
      );
    }
  }

  private requireRegistered(name: string): void {
    if (!this.registry.has(name)) {
      throw new EventError(
        "EVENT_NOT_REGISTERED",
        `Event "${name}" is not registered. Declare it with register() before subscribing or emitting.`,
      );
    }
  }

  private entriesFor(name: string, create: boolean): ListenerEntry[] {
    const existing = this.listeners.get(name);
    if (existing !== undefined) return existing;
    if (!create) return [];

    const created: ListenerEntry[] = [];
    this.listeners.set(name, created);
    return created;
  }

  private removeEntry(name: string, entry: ListenerEntry): boolean {
    const entries = this.listeners.get(name);
    if (entries === undefined) return false;

    const index = entries.indexOf(entry);
    if (index === -1) return false;

    entries.splice(index, 1);
    if (entries.length === 0) this.listeners.delete(name);
    return true;
  }

  private rememberFailure(failure: ListenerFailure): void {
    this.recentFailures.push(failure);
    if (this.recentFailures.length > this.maxRecentFailures) {
      this.recentFailures.splice(0, this.recentFailures.length - this.maxRecentFailures);
    }
  }
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}
