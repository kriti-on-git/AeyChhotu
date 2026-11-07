/* HealthManager — the registry and interpreter for component health.

   WHAT IT OWNS
   * a registry of managed components and the dependency edges they declare;
   * per-component checks with timeouts, state transitions and history;
   * full-system checks that respect dependency order and refuse to run a
     dependent whose dependency is broken;
   * readiness / liveness answers that are cheap and side-effect free;
   * deep diagnostics and functional self-tests, both callable while the app
     is serving traffic;
   * health-status change events.

   WHAT IT DOES NOT OWN
   * business logic, or any component's internals. It calls the hooks the
     component exposes (`health`, `selfTest`, `diagnostics`) and interprets
     the answer. It never queries Postgres, reads a socket or mutates state
     on a component's behalf.
   * initialization order. AppBootstrap/LifecycleManager still initializes;
     the manager observes the results.

   SELF-TEST SAFETY CONTRACT (enforced by convention + review):
   a `selfTest` must be read-only. Database checks use SELECTs and schema
   lookups; a test that needs to write must use a transaction it rolls back or
   an isolated test resource — never a live order, ticket, payment or stock
   row. The manager runs self-tests concurrently with request traffic, so a
   side effect would be a production bug, not a test failure.

   CONCURRENT PROTECTION: at most one self-test run is in flight. A second
   request is refused with `already_running` rather than queued, so a flapping
   probe cannot pile up work on a sick component.

   DEPENDENCY POLICY: a component whose dependency is missing, UNHEALTHY,
   STOPPED or part of a cycle is marked UNHEALTHY without its own health hook
   being called — the failure is reported as a dependency failure, which is
   what an operator needs to know. */

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

export type ComponentState =
  | "INITIALIZING"
  | "HEALTHY"
  | "DEGRADED"
  | "UNHEALTHY"
  | "STOPPING"
  | "STOPPED";

export type CheckReason =
  | "check"
  | "error"
  | "timeout"
  | "no_health_hook"
  | "missing_dependency"
  | "dependency_failed"
  | "cycle"
  | "self_test"
  | "self_test_error"
  | "self_test_timeout"
  | "manager_closed"
  | "shutdown";

export interface ComponentCheckRecord {
  readonly component: string;
  readonly state: ComponentState;
  readonly previous: ComponentState;
  readonly at: string;
  readonly durationMs: number;
  readonly reason?: CheckReason;
  readonly message?: string;
  readonly details?: unknown;
}

export interface HealthTransition {
  readonly component: string;
  readonly from: ComponentState;
  readonly to: ComponentState;
  readonly at: string;
  readonly reason?: string;
}

export interface DependencyFailure {
  readonly component: string;
  readonly dependency: string;
}

export interface MissingDependency {
  readonly component: string;
  readonly missing: readonly string[];
}

export interface RegistryIssues {
  readonly missingDependencies: readonly MissingDependency[];
  readonly cycles: readonly (readonly string[])[];
}

export interface SystemHealthReport {
  readonly state: ComponentState;
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly components: readonly ComponentCheckRecord[];
  readonly missingDependencies: readonly MissingDependency[];
  readonly dependencyFailures: readonly DependencyFailure[];
  readonly cycles: readonly (readonly string[])[];
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

export interface LivenessReport {
  readonly alive: boolean;
  readonly uptimeMs: number;
}

export interface SelfTestEntry {
  readonly component: string;
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly message?: string;
  readonly details?: unknown;
}

export interface SelfTestRun {
  readonly runId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly entries: readonly SelfTestEntry[];
  readonly skippedComponents: readonly string[];
}

export interface SelfTestRunResult {
  readonly ran: boolean;
  readonly reason?: "already_running" | "manager_stopped";
  readonly activeRunId?: string;
  readonly run?: SelfTestRun;
}

export interface ComponentSnapshot {
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly required: boolean;
  readonly state: ComponentState;
  readonly since: string | null;
  readonly lastCheck: ComponentCheckRecord | null;
  readonly health: ComponentHealth | null;
  readonly diagnostics: unknown;
}

export interface HealthDiagnostics {
  readonly state: "new" | "running" | "closed";
  readonly uptimeMs: number;
  readonly components: readonly ComponentSnapshot[];
  readonly registry: RegistryIssues;
  readonly history: readonly ComponentCheckRecord[];
  readonly selfTests: readonly SelfTestRun[];
  readonly transitions: readonly HealthTransition[];
  readonly counters: Readonly<{
    checks: number;
    failures: number;
    timeouts: number;
    selfTestRuns: number;
    transitions: number;
  }>;
  readonly lastError: string | null;
}

/** The narrow surface exposed through DI (future health/readiness routes). */
export interface HealthPort {
  checkComponent(name: string, options?: HealthCheckOptions): Promise<ComponentCheckRecord>;
  checkAll(options?: HealthCheckOptions): Promise<SystemHealthReport>;
  liveness(): LivenessReport;
  readiness(): ReadinessReport;
  runSelfTests(options?: SelfTestOptions): Promise<SelfTestRunResult>;
  diagnostics(): HealthDiagnostics;
  subscribe(listener: (transition: HealthTransition) => void): () => void;
}

export interface HealthCheckOptions {
  readonly timeoutMs?: number;
}

export interface SelfTestOptions extends HealthCheckOptions {
  /** Only these components; defaults to every registered component. */
  readonly components?: readonly string[];
}

export type HealthErrorCode =
  | "HEALTH_DUPLICATE_COMPONENT"
  | "HEALTH_INVALID_COMPONENT"
  | "HEALTH_SELF_DEPENDENCY"
  | "HEALTH_UNKNOWN_COMPONENT"
  | "HEALTH_MANAGER_CLOSED";

export class HealthError extends Error {
  readonly code: HealthErrorCode;

  constructor(code: HealthErrorCode, message: string) {
    super(message);
    this.name = "HealthError";
    this.code = code;
  }
}

export interface HealthManagerOptions {
  readonly name?: string;
  readonly checkTimeoutMs?: number;
  readonly selfTestTimeoutMs?: number;
  /** How many check records and transitions diagnostics retain. */
  readonly historyLimit?: number;
}

/* -------------------------------------------------------------- internals */

const DEFAULT_CHECK_TIMEOUT_MS = 2_000;
const DEFAULT_SELF_TEST_TIMEOUT_MS = 5_000;
const DEFAULT_HISTORY_LIMIT = 100;

interface RegisteredComponent {
  readonly component: ManagedComponent;
  readonly required: boolean;
  readonly registeredAt: string;
  last: ComponentCheckRecord | null;
  health: ComponentHealth | null;
}

type Outcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "timeout" };

/* The hook cannot be cancelled once started; a timed-out call is simply no
   longer awaited. Its promise has a rejection handler attached by `work`, so
   a late failure cannot become an unhandled rejection. */
async function runWithTimeout<T>(
  fn: () => T | Promise<T>,
  timeoutMs: number,
): Promise<Outcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });

  const work: Promise<Outcome<T>> = Promise.resolve()
    .then(fn)
    .then(
      (value): Outcome<T> => ({ kind: "ok", value }),
      (error: unknown): Outcome<T> => ({ kind: "error", error }),
    );

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function isComponentHealth(value: unknown): value is ComponentHealth {
  if (typeof value !== "object" || value === null) return false;
  const state = (value as { state?: unknown }).state;
  return state === "HEALTHY" || state === "DEGRADED" || state === "UNHEALTHY";
}

/* ---------------------------------------------------------------- manager */

export class HealthManager implements ManagedComponent, HealthPort {
  readonly name: string;
  readonly dependencies: readonly string[] = [];

  private readonly options: HealthManagerOptions;
  private readonly registry = new Map<string, RegisteredComponent>();
  private readonly states = new Map<string, ComponentState>();
  private readonly since = new Map<string, string>();
  private readonly subscribers = new Set<(transition: HealthTransition) => void>();

  private readonly history: ComponentCheckRecord[] = [];
  private readonly selfTestHistory: SelfTestRun[] = [];
  private readonly recentTransitions: HealthTransition[] = [];
  private readonly counters = {
    checks: 0,
    failures: 0,
    timeouts: 0,
    selfTestRuns: 0,
    transitions: 0,
  };

  private state: "new" | "running" | "closed" = "new";
  private systemState: ComponentState = "INITIALIZING";
  private logger: Logger | null = null;
  private clock: Clock = systemClock;
  private startedAtMs = 0;
  private activeRunId: string | null = null;
  private lastError: string | null = null;

  constructor(options: HealthManagerOptions = {}) {
    this.options = options;
    this.name = options.name ?? "health";
  }

  /* --------------------------------------------------------- lifecycle */

  async init(ctx: InitContext): Promise<void> {
    this.logger = ctx.logger.child({ component: this.name });
    this.clock = ctx.clock;
    this.startedAtMs = this.clock.now().getTime();
    this.state = "running";

    const issues = this.registryIssues();
    if (issues.missingDependencies.length > 0 || issues.cycles.length > 0) {
      this.logger.warn("health_registry_incomplete", {
        missing: issues.missingDependencies.map(
          (issue) => `${issue.component}->${issue.missing.join(",")}`,
        ),
        cycles: issues.cycles.map((cycle) => cycle.join("->")),
      });
    }
    this.logger.info("health_manager_ready", { components: this.registry.size });
  }

  /** Moves every observed component STOPPING → STOPPED. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.state === "closed") return;

    const names = [...this.registry.keys()];
    for (const name of names) this.transition(name, "STOPPING", "shutdown");
    for (const name of names) this.transition(name, "STOPPED", "shutdown");

    this.state = "closed";

    this.logger?.info("health_manager_stopped", {
      components: names.length,
      checks: this.counters.checks,
      self_tests: this.counters.selfTestRuns,
    });
  }

  /* ------------------------------------------------------ registration */

  register(component: ManagedComponent): this {
    if (this.state === "closed") {
      throw new HealthError(
        "HEALTH_MANAGER_CLOSED",
        "Cannot register components after HealthManager has shut down.",
      );
    }

    const name = component.name?.trim();
    if (name === undefined || name === "") {
      throw new HealthError("HEALTH_INVALID_COMPONENT", "A component needs a non-empty name.");
    }
    if (this.registry.has(name)) {
      throw new HealthError(
        "HEALTH_DUPLICATE_COMPONENT",
        `Component "${name}" is already registered.`,
      );
    }

    const dependencies = component.dependencies ?? [];
    if (dependencies.includes(name)) {
      throw new HealthError(
        "HEALTH_SELF_DEPENDENCY",
        `Component "${name}" cannot depend on itself.`,
      );
    }

    this.registry.set(name, {
      component,
      required: component.required !== false,
      registeredAt: this.clock.now().toISOString(),
      last: null,
      health: null,
    });
    this.states.set(name, "INITIALIZING");
    this.since.set(name, this.clock.now().toISOString());

    return this;
  }

  registerAll(components: readonly ManagedComponent[]): this {
    for (const component of components) this.register(component);
    return this;
  }

  names(): readonly string[] {
    return [...this.registry.keys()];
  }

  stateOf(name: string): ComponentState | undefined {
    return this.states.get(name);
  }

  /* ------------------------------------------------------------ checks */

  /**
   * Runs one component's health hook, bounded by a timeout. Resolves with the
   * record; a throwing or hanging hook is a result (UNHEALTHY), not an error.
   */
  async checkComponent(
    name: string,
    options: HealthCheckOptions = {},
  ): Promise<ComponentCheckRecord> {
    const entry = this.requireEntry(name);
    const started = performance.now();

    if (this.state === "closed") {
      return this.record(entry, "STOPPED", started, {
        reason: "manager_closed",
        message: "The health manager has shut down.",
      });
    }

    const hook = entry.component.health;
    if (hook === undefined) {
      return this.record(entry, "HEALTHY", started, {
        reason: "no_health_hook",
        message: "No health hook; a running component is assumed healthy.",
      });
    }

    const timeoutMs =
      options.timeoutMs ?? this.options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    const outcome = await runWithTimeout(() => hook.call(entry.component), timeoutMs);

    if (outcome.kind === "timeout") {
      this.counters.timeouts += 1;
      this.lastError = `${name}: health check timed out after ${timeoutMs}ms`;
      this.logger?.warn("health_check_timeout", { component: name, timeout_ms: timeoutMs });
      return this.record(entry, "UNHEALTHY", started, {
        reason: "timeout",
        message: `Health check timed out after ${timeoutMs}ms.`,
      });
    }

    if (outcome.kind === "error") {
      this.counters.failures += 1;
      this.lastError = `${name}: ${messageOf(outcome.error)}`;
      this.logger?.error("health_check_failed", {
        component: name,
        error: outcome.error,
      });
      return this.record(entry, "UNHEALTHY", started, {
        reason: "error",
        message: messageOf(outcome.error),
      });
    }

    if (!isComponentHealth(outcome.value)) {
      this.counters.failures += 1;
      this.lastError = `${name}: invalid health report`;
      return this.record(entry, "UNHEALTHY", started, {
        reason: "error",
        message: "health() returned an invalid report.",
      });
    }

    entry.health = outcome.value;
    return this.record(entry, outcome.value.state, started, {
      reason: "check",
      message: outcome.value.message,
      details: outcome.value.details,
    });
  }

  /**
   * Full-system check in dependency order. A broken dependency marks its
   * dependents UNHEALTHY and their hooks are not called.
   */
  async checkAll(options: HealthCheckOptions = {}): Promise<SystemHealthReport> {
    const started = performance.now();
    const { order, cycles } = this.resolveOrder();
    const cycleNames = new Set(cycles.flat());

    const records: ComponentCheckRecord[] = [];
    const unhealthy = new Set<string>();
    const missingDependencies: MissingDependency[] = [];
    const dependencyFailures: DependencyFailure[] = [];

    for (const name of order) {
      const entry = this.registry.get(name);
      if (entry === undefined) continue;

      if (cycleNames.has(name)) {
        records.push(
          this.record(entry, "UNHEALTHY", started, {
            reason: "cycle",
            message: "This component is part of a dependency cycle.",
          }),
        );
        unhealthy.add(name);
        continue;
      }

      const dependencies = entry.component.dependencies ?? [];

      const absent = dependencies.filter((dependency) => !this.registry.has(dependency));
      if (absent.length > 0) {
        missingDependencies.push({ component: name, missing: absent });
        records.push(
          this.record(entry, "UNHEALTHY", started, {
            reason: "missing_dependency",
            message: `Missing dependency: ${absent.join(", ")}.`,
          }),
        );
        unhealthy.add(name);
        continue;
      }

      const failed = dependencies.find(
        (dependency) =>
          unhealthy.has(dependency) ||
          this.states.get(dependency) === "UNHEALTHY" ||
          this.states.get(dependency) === "STOPPED",
      );
      if (failed !== undefined) {
        dependencyFailures.push({ component: name, dependency: failed });
        records.push(
          this.record(entry, "UNHEALTHY", started, {
            reason: "dependency_failed",
            message: `Dependency "${failed}" is not healthy.`,
          }),
        );
        unhealthy.add(name);
        continue;
      }

      const record = await this.checkComponent(name, options);
      records.push(record);
      if (record.state === "UNHEALTHY" || record.state === "STOPPED") unhealthy.add(name);
    }

    const state = this.systemStateOf(records);
    const report: SystemHealthReport = Object.freeze({
      state,
      checkedAt: this.clock.now().toISOString(),
      durationMs: roundMs(performance.now() - started),
      components: Object.freeze(records),
      missingDependencies: Object.freeze(missingDependencies),
      dependencyFailures: Object.freeze(dependencyFailures),
      cycles: Object.freeze(cycles),
    });

    if (this.systemState !== state) {
      const from = this.systemState;
      this.systemState = state;
      this.emitTransition("system", from, state, "system check");
    }

    return report;
  }

  /* ---------------------------------------------------- health answers */

  /**
   * Liveness never touches a component: it answers "is this process able to
   * keep running?", so a dead database must not make an orchestrator kill a
   * perfectly live API.
   */
  liveness(): LivenessReport {
    return { alive: this.state !== "closed", uptimeMs: this.uptimeMs() };
  }

  /**
   * Readiness uses the LAST KNOWN component states (run checkAll() first for a
   * fresh answer). DEGRADED is still ready: the app can serve, with a warning.
   */
  readiness(): ReadinessReport {
    const reasons: string[] = [];

    for (const [name, entry] of this.registry) {
      if (!entry.required) continue;
      const state = this.states.get(name) ?? "INITIALIZING";
      if (state === "HEALTHY" || state === "DEGRADED") continue;
      reasons.push(`${name} is ${state}`);
    }

    return {
      ready: this.state === "running" && reasons.length === 0,
      reasons: Object.freeze(reasons),
    };
  }

  health(): ComponentHealth {
    if (this.state === "closed") {
      return { state: "UNHEALTHY", message: "The health manager has stopped." };
    }

    const issues = this.registryIssues();
    if (issues.missingDependencies.length > 0 || issues.cycles.length > 0) {
      return {
        state: "DEGRADED",
        message: "The component registry has unresolved dependencies.",
        details: issues,
      };
    }

    return {
      state: "HEALTHY",
      message: `Observing ${this.registry.size} component(s).`,
      details: { components: this.registry.size },
    };
  }

  /* ---------------------------------------------------------- self-test */

  /**
   * Runs functional self-tests, at most one run at a time. Safe under traffic:
   * the manager only calls hooks, and the hook contract forbids mutations.
   */
  async runSelfTests(options: SelfTestOptions = {}): Promise<SelfTestRunResult> {
    if (this.state === "closed") return { ran: false, reason: "manager_stopped" };
    if (this.activeRunId !== null) {
      return { ran: false, reason: "already_running", activeRunId: this.activeRunId };
    }

    const runId = randomUUID();
    this.activeRunId = runId;

    const startedAt = this.clock.now().toISOString();
    const started = performance.now();
    const timeoutMs =
      options.timeoutMs ?? this.options.selfTestTimeoutMs ?? DEFAULT_SELF_TEST_TIMEOUT_MS;

    try {
      const names = options.components ?? [...this.registry.keys()];
      const entries: SelfTestEntry[] = [];
      const skipped: string[] = [];

      for (const name of names) {
        const entry = this.registry.get(name);
        if (entry === undefined) {
          throw new HealthError(
            "HEALTH_UNKNOWN_COMPONENT",
            `Component "${name}" is not registered.`,
          );
        }

        const hook = entry.component.selfTest;
        if (hook === undefined) {
          skipped.push(name);
          continue;
        }

        const testStarted = performance.now();
        const outcome = await runWithTimeout(() => hook.call(entry.component), timeoutMs);
        const durationMs = roundMs(performance.now() - testStarted);

        if (outcome.kind === "timeout") {
          this.counters.timeouts += 1;
          this.counters.failures += 1;
          this.lastError = `${name}: self-test timed out after ${timeoutMs}ms`;
          this.logger?.warn("health_self_test_timeout", {
            component: name,
            timeout_ms: timeoutMs,
          });
          entries.push({
            component: name,
            ok: false,
            timedOut: true,
            durationMs,
            message: `Self-test timed out after ${timeoutMs}ms.`,
          });
          this.record(entry, "UNHEALTHY", testStarted, {
            reason: "self_test_timeout",
            message: "Self-test timed out.",
          });
          continue;
        }

        if (outcome.kind === "error") {
          this.counters.failures += 1;
          this.lastError = `${name}: ${messageOf(outcome.error)}`;
          this.logger?.error("health_self_test_failed", {
            component: name,
            error: outcome.error,
          });
          entries.push({
            component: name,
            ok: false,
            timedOut: false,
            durationMs,
            message: messageOf(outcome.error),
          });
          this.record(entry, "UNHEALTHY", testStarted, {
            reason: "self_test_error",
            message: messageOf(outcome.error),
          });
          continue;
        }

        const result: SelfTestResult = outcome.value;
        const ok = result.ok === true;
        if (!ok) this.counters.failures += 1;

        entries.push({
          component: name,
          ok,
          timedOut: false,
          durationMs,
          message: result.message,
          details: result.details,
        });
        this.record(entry, ok ? "HEALTHY" : "UNHEALTHY", testStarted, {
          reason: "self_test",
          message: result.message ?? (ok ? "Self-test passed." : "Self-test failed."),
        });
      }

      const run: SelfTestRun = Object.freeze({
        runId,
        startedAt,
        durationMs: roundMs(performance.now() - started),
        entries: Object.freeze(entries),
        skippedComponents: Object.freeze(skipped),
      });

      this.counters.selfTestRuns += 1;
      this.pushSelfTest(run);
      this.logger?.info("health_self_tests_completed", {
        run_id: runId,
        components: entries.length,
        failed: entries.filter((entry) => !entry.ok).length,
      });

      return { ran: true, run };
    } finally {
      this.activeRunId = null;
    }
  }

  /* --------------------------------------------------------------- events */

  subscribe(listener: (transition: HealthTransition) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /* -------------------------------------------------------- diagnostics */

  diagnostics(): HealthDiagnostics {
    const components: ComponentSnapshot[] = [...this.registry.values()].map((entry) => {
      const name = entry.component.name;
      let componentDiagnostics: unknown;
      try {
        componentDiagnostics = entry.component.diagnostics?.() ?? null;
      } catch (err) {
        // A broken diagnostics hook must not break the health endpoint.
        componentDiagnostics = { error: messageOf(err) };
      }

      return {
        name,
        dependencies: entry.component.dependencies ?? [],
        required: entry.required,
        state: this.states.get(name) ?? "INITIALIZING",
        since: this.since.get(name) ?? null,
        lastCheck: entry.last,
        health: entry.health,
        diagnostics: componentDiagnostics,
      };
    });

    return {
      state: this.state,
      uptimeMs: this.uptimeMs(),
      components: Object.freeze(components),
      registry: this.registryIssues(),
      history: Object.freeze([...this.history]),
      selfTests: Object.freeze([...this.selfTestHistory]),
      transitions: Object.freeze([...this.recentTransitions]),
      counters: Object.freeze({ ...this.counters }),
      lastError: this.lastError,
    };
  }

  getState(): "new" | "running" | "closed" {
    return this.state;
  }

  /* ------------------------------------------------------------ internal */

  private requireEntry(name: string): RegisteredComponent {
    const entry = this.registry.get(name);
    if (entry === undefined) {
      throw new HealthError(
        "HEALTH_UNKNOWN_COMPONENT",
        `Component "${name}" is not registered.`,
      );
    }
    return entry;
  }

  private record(
    entry: RegisteredComponent,
    state: ComponentState,
    started: number,
    extra: { reason?: CheckReason; message?: string; details?: unknown },
  ): ComponentCheckRecord {
    const name = entry.component.name;
    const previous = this.states.get(name) ?? "INITIALIZING";
    if (previous !== state) this.transition(name, state, extra.reason ?? "check");

    const record: ComponentCheckRecord = Object.freeze({
      component: name,
      state,
      previous,
      at: this.clock.now().toISOString(),
      durationMs: roundMs(performance.now() - started),
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra.message !== undefined ? { message: extra.message } : {}),
      ...(extra.details !== undefined ? { details: extra.details } : {}),
    });

    this.counters.checks += 1;
    entry.last = record;
    this.history.push(record);

    const limit = this.options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    if (this.history.length > limit) {
      this.history.splice(0, this.history.length - limit);
    }

    return record;
  }

  private transition(
    component: string,
    to: ComponentState,
    reason: string,
    fromOverride?: ComponentState,
  ): void {
    const from = fromOverride ?? this.states.get(component) ?? "INITIALIZING";
    if (from === to) return;

    this.states.set(component, to);
    this.since.set(component, this.clock.now().toISOString());
    this.counters.transitions += 1;
    this.emitTransition(component, from, to, reason);
  }

  private emitTransition(
    component: string,
    from: ComponentState,
    to: ComponentState,
    reason: string,
  ): void {
    const event: HealthTransition = Object.freeze({
      component,
      from,
      to,
      at: this.clock.now().toISOString(),
      reason,
    });

    this.recentTransitions.push(event);
    const limit = this.options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    if (this.recentTransitions.length > limit) {
      this.recentTransitions.splice(0, this.recentTransitions.length - limit);
    }

    for (const listener of [...this.subscribers]) {
      try {
        listener(event);
      } catch (err) {
        // An observer's bug must not change a health verdict.
        this.logger?.error("health_listener_failed", { component, error: err });
      }
    }
  }

  private systemStateOf(records: readonly ComponentCheckRecord[]): ComponentState {
    let degraded = false;

    for (const record of records) {
      const required = this.registry.get(record.component)?.required ?? false;
      if (record.state === "HEALTHY") continue;

      if (record.state === "UNHEALTHY" || record.state === "STOPPED") {
        if (required) return "UNHEALTHY";
        degraded = true;
        continue;
      }

      // DEGRADED or INITIALIZING: serve, but not fully healthy.
      degraded = true;
    }

    return degraded ? "DEGRADED" : "HEALTHY";
  }

  private registryIssues(): RegistryIssues {
    const missingDependencies: MissingDependency[] = [];

    for (const [name, entry] of this.registry) {
      const missing = (entry.component.dependencies ?? []).filter(
        (dependency) => !this.registry.has(dependency),
      );
      if (missing.length > 0) missingDependencies.push({ component: name, missing });
    }

    return {
      missingDependencies: Object.freeze(missingDependencies),
      cycles: Object.freeze(this.resolveOrder().cycles),
    };
  }

  /** DFS topological order of registered components (dependencies first). */
  private resolveOrder(): { order: string[]; cycles: string[][] } {
    const order: string[] = [];
    const cycles: string[][] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        const cycle = [...stack.slice(stack.indexOf(name)), name];
        const key = [...cycle].sort().join("\u0000");
        if (!cycles.some((known) => [...known].sort().join("\u0000") === key)) {
          cycles.push(cycle);
        }
        return;
      }

      visiting.add(name);
      stack.push(name);
      for (const dependency of this.registry.get(name)?.component.dependencies ?? []) {
        if (this.registry.has(dependency)) visit(dependency);
      }
      stack.pop();
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this.registry.keys()) visit(name);

    return { order, cycles };
  }

  private pushSelfTest(run: SelfTestRun): void {
    this.selfTestHistory.push(run);
    const limit = this.options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    if (this.selfTestHistory.length > limit) {
      this.selfTestHistory.splice(0, this.selfTestHistory.length - limit);
    }
  }

  private uptimeMs(): number {
    if (this.startedAtMs === 0) return 0;
    return Math.max(0, this.clock.now().getTime() - this.startedAtMs);
  }
}
