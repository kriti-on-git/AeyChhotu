/* Lifecycle — the parent-child initialization contract.

   COMPOSITION, NOT INHERITANCE: a component is a plain object implementing
   optional hooks; the manager owns the order and the state. There is no base
   class to extend and nothing to call `super` on.

   GUARANTEES
   * `initAll` runs components sequentially in registration order. A component
     only becomes "initialized" after its promise settles.
   * Nothing is started until EVERY component has initialized, so a component
     never observes a half-built world.
   * A failure unwinds instead of aborting: the component that failed is asked
     to clean up, then every already-completed component is shut down in
     reverse. The caller gets an InitializationError naming the component.
   * Initialization happens at most once. Calling `initAll`/`startAll` twice —
     or registering after initialization began — throws a LifecycleError
     rather than silently double-wiring resources.
   * `shutdownAll` is idempotent: repeated calls return the same report and no
     component is shut down twice. One failing component does not prevent the
     rest from shutting down; failures are collected in the report. */

import type { Logger } from "../infrastructure/logging/Logger.js";
import type { InitContext } from "./InitContext.js";

export type LifecycleState = "created" | "initialized" | "started" | "stopped" | "failed";

/** What a component reports about itself. Health is not lifecycle state: a
    component can be initialized and still be UNHEALTHY (database down), or
    still be INITIALIZING while the manager has not checked it yet. */
export type ComponentHealthState = "HEALTHY" | "DEGRADED" | "UNHEALTHY";

export interface ComponentHealth {
  readonly state: ComponentHealthState;
  readonly message?: string;
  readonly details?: unknown;
}

export interface SelfTestResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly details?: unknown;
}

export interface ManagedComponent {
  readonly name: string;
  /** Names of components this one needs. Declared, never resolved implicitly:
      a dependent whose dependency is missing or UNHEALTHY is reported as
      UNHEALTHY by HealthManager without running its own check. */
  readonly dependencies?: readonly string[];
  /** Whether system readiness depends on this component. Default true.
      Optional components can fail without making /ready fail. */
  readonly required?: boolean;
  /** Resolve dependencies and assert preconditions. No work should be visible
      to the outside world yet (no listeners, no timers). */
  init?(ctx: InitContext): void | Promise<void>;
  /** Begin accepting work: bind a port, start timers, subscribe. */
  start?(): void | Promise<void>;
  /** Release everything init/start acquired. Must be safe to call when the
      component only partially initialized. */
  shutdown?(): void | Promise<void>;
  /** Self-reported health. MUST be read-only and cheap; it may be called while
      the app is serving traffic. Throwing or hanging marks UNHEALTHY. */
  health?(): ComponentHealth | Promise<ComponentHealth>;
  /** Functional self-test. MUST NOT mutate orders, tickets, payments or
      inventory: use SELECTs, rollback transactions or test doubles. */
  selfTest?(): SelfTestResult | Promise<SelfTestResult>;
  /** Structured, JSON-serializable runtime diagnostics (counters, pool stats,
      connection state). Must never require a restart to read. */
  diagnostics?(): unknown;
}

export interface ShutdownReport {
  readonly reason: string;
  readonly failed: ReadonlyArray<{ readonly name: string; readonly error: unknown }>;
  /** Set by AppBootstrap when the overall drain exceeded its budget. */
  readonly timedOut?: boolean;
}

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

export class InitializationError extends Error {
  readonly componentName: string;
  readonly phase: "init" | "start";

  constructor(componentName: string, phase: "init" | "start", cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Component "${componentName}" failed to ${phase === "init" ? "initialize" : "start"}: ${detail}`,
    );
    this.name = "InitializationError";
    this.componentName = componentName;
    this.phase = phase;
    this.cause = cause;
  }
}

export class LifecycleManager {
  private readonly components: ManagedComponent[] = [];
  private readonly states = new Map<string, LifecycleState>();
  private initPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<ShutdownReport> | null = null;
  private readonly logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  register(component: ManagedComponent): this {
    if (this.initPromise !== null) {
      throw new LifecycleError("Cannot register a component after initAll() has been called.");
    }

    const name = component.name?.trim();
    if (!name) {
      throw new LifecycleError("Every component needs a non-empty name.");
    }
    if (this.states.has(name)) {
      throw new LifecycleError(`Duplicate component name "${name}".`);
    }

    this.components.push(component);
    this.states.set(name, "created");
    return this;
  }

  get names(): readonly string[] {
    return this.components.map((component) => component.name);
  }

  stateOf(name: string): LifecycleState | undefined {
    return this.states.get(name);
  }

  initAll(ctx: InitContext): Promise<void> {
    if (this.initPromise !== null) {
      throw new LifecycleError("initAll() may only be called once.");
    }
    this.initPromise = this.runInit(ctx);
    return this.initPromise;
  }

  startAll(): Promise<void> {
    if (this.initPromise === null) {
      throw new LifecycleError("startAll() requires a successful initAll() first.");
    }
    if (this.startPromise !== null) {
      throw new LifecycleError("startAll() may only be called once.");
    }
    this.startPromise = this.runStart();
    return this.startPromise;
  }

  shutdownAll(reason = "shutdown"): Promise<ShutdownReport> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.shutdownPromise = this.runShutdown(reason);
    return this.shutdownPromise;
  }

  private async runInit(ctx: InitContext): Promise<void> {
    const completed: ManagedComponent[] = [];

    for (const component of this.components) {
      try {
        await component.init?.(ctx);
        this.states.set(component.name, "initialized");
        completed.push(component);
      } catch (err) {
        await this.rollback(component, completed, "init");
        this.states.set(component.name, "failed");
        this.logger?.error("component_init_failed", {
          component: component.name,
          error: err,
        });
        throw new InitializationError(component.name, "init", err);
      }
    }
  }

  private async runStart(): Promise<void> {
    const started: ManagedComponent[] = [];

    for (const component of this.components) {
      try {
        await component.start?.();
        this.states.set(component.name, "started");
        started.push(component);
      } catch (err) {
        await this.rollback(component, started, "start");
        this.states.set(component.name, "failed");
        this.logger?.error("component_start_failed", {
          component: component.name,
          error: err,
        });
        throw new InitializationError(component.name, "start", err);
      }
    }
  }

  private async runShutdown(reason: string): Promise<ShutdownReport> {
    const failed: Array<{ name: string; error: unknown }> = [];

    for (const component of [...this.components].reverse()) {
      const state = this.states.get(component.name);
      // "created"/"stopped"/"failed" components hold nothing to release: a
      // failure was already unwound by rollback().
      if (state !== "initialized" && state !== "started") continue;

      try {
        await component.shutdown?.();
        this.states.set(component.name, "stopped");
      } catch (err) {
        failed.push({ name: component.name, error: err });
        this.states.set(component.name, "failed");
        this.logger?.error("component_shutdown_failed", {
          component: component.name,
          error: err,
        });
      }
    }

    return { reason, failed };
  }

  /* The component that failed may already hold partially-acquired resources,
     so it is unwound first; then everything that completed, newest first. */
  private async rollback(
    failing: ManagedComponent,
    completed: readonly ManagedComponent[],
    phase: "init" | "start",
  ): Promise<void> {
    await this.safeShutdown(failing, phase);
    for (const component of [...completed].reverse()) {
      await this.safeShutdown(component, phase);
    }
  }

  private async safeShutdown(
    component: ManagedComponent,
    phase: "init" | "start",
  ): Promise<void> {
    try {
      await component.shutdown?.();
      // Marked stopped so shutdownAll() never unwinds it a second time.
      this.states.set(component.name, "stopped");
    } catch (err) {
      this.states.set(component.name, "failed");
      this.logger?.error("component_rollback_failed", {
        component: component.name,
        phase,
        error: err,
      });
    }
  }
}
