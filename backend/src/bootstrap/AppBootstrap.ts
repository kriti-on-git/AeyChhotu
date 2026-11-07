/* AppBootstrap — the composition root.

   Sequence (and the reason for it):
     1. validate configuration          → nothing exists if it is wrong
     2. build logger, clock, container   → infrastructure only
     3. register components (in order)   → wiring is explicit
     4. initAll                          → dependencies resolved, no traffic
     5. startAll                         → listeners/timers come up
     6. install signal handlers          → shutdown is available immediately
     7. return the context               → the caller may now serve traffic

   The bootstrap owns no business logic and imports no module. Whatever the
   app is made of arrives through `componentFactory`; that keeps infrastructure
   independent from the domain and lets a test boot the same way production
   does, with fakes.

   FAILURE POLICY
   * Invalid configuration → ConfigError propagates; nothing was initialized.
   * A component fails to init/start → that component is cleaned up, the ones
     that already completed are shut down in reverse, and the
     InitializationError propagates. A half-started server never accepts work.
   * run() twice → BootstrapError (duplicate initialization is a bug, not a
     no-op).
   * shutdown() → idempotent, reverse order, bounded by `shutdownTimeoutMs`. */

import { systemClock, type Clock } from "../infrastructure/clock/Clock.js";
import { loadConfig, type AppConfig } from "../infrastructure/config/ConfigManager.js";
import { createLogger, type Logger } from "../infrastructure/logging/Logger.js";
import { Container } from "./Container.js";
import type { InitContext } from "./InitContext.js";
import {
  LifecycleManager,
  type ManagedComponent,
  type ShutdownReport,
} from "./lifecycle.js";
import { TOKENS } from "./tokens.js";

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export class BootstrapError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BootstrapError";
  }
}

export type BootstrapState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

export interface AppBootstrapOptions {
  /** Defaults to process.env. Injected in tests so no ambient env is read. */
  readonly configSource?: NodeJS.ProcessEnv;
  /** Override the loader itself (a fixture config, a different schema). */
  readonly configLoader?: (source: NodeJS.ProcessEnv) => AppConfig;
  readonly logger?: Logger;
  readonly clock?: Clock;
  /** The composition root's contribution: components, in initialization order. */
  readonly componentFactory?: (ctx: InitContext) => readonly ManagedComponent[];
  /** Off by default so importing the bootstrap in a test never traps signals. */
  readonly installSignalHandlers?: boolean;
  /** When true (default), a handled signal ends the process. Tests set false. */
  readonly exitOnSignal?: boolean;
  readonly shutdownTimeoutMs?: number;
}

export interface AppContext extends InitContext {
  readonly lifecycle: LifecycleManager;
  readonly shutdown: (reason?: string) => Promise<ShutdownReport>;
}

export class AppBootstrap {
  private readonly options: AppBootstrapOptions;
  private state: BootstrapState = "idle";
  private logger: Logger | null = null;
  private lifecycle: LifecycleManager | null = null;
  private shutdownPromise: Promise<ShutdownReport> | null = null;
  private signalsInstalled = false;
  private signalCount = 0;

  constructor(options: AppBootstrapOptions = {}) {
    this.options = options;
  }

  getState(): BootstrapState {
    return this.state;
  }

  async run(): Promise<AppContext> {
    if (this.state !== "idle") {
      throw new BootstrapError(
        `run() called while the bootstrap is "${this.state}" — initialization happens once.`,
      );
    }
    this.state = "starting";

    const logger = this.options.logger ?? createLogger();
    this.logger = logger;

    // 1. Configuration is validated before anything is constructed.
    let config: AppConfig;
    try {
      config = (this.options.configLoader ?? loadConfig)(this.options.configSource ?? process.env);
    } catch (err) {
      this.state = "failed";
      logger.error("bootstrap_config_failed", { error: err });
      throw err;
    }

    const clock = this.options.clock ?? systemClock;

    // 2. Infrastructure only — no business knowledge in this layer.
    const container = new Container();
    container.registerValue(TOKENS.config, config);
    container.registerValue(TOKENS.logger, logger);
    container.registerValue(TOKENS.clock, clock);

    // 3. Components in explicit order.
    const lifecycle = new LifecycleManager(logger);
    this.lifecycle = lifecycle;

    const baseContext: InitContext = Object.freeze({ config, logger, clock, container });

    try {
      for (const component of this.options.componentFactory?.(baseContext) ?? []) {
        lifecycle.register(component);
      }
    } catch (err) {
      this.state = "failed";
      logger.error("bootstrap_registration_failed", { error: err });
      throw new BootstrapError("Component registration failed.", { cause: err });
    }

    // 4 + 5. Initialize everything, then start everything.
    try {
      await lifecycle.initAll(baseContext);
      await lifecycle.startAll();
    } catch (err) {
      this.state = "failed";
      // lifecycle already unwound, but a second pass is harmless (it is
      // idempotent) and guarantees nothing is left holding a resource.
      await lifecycle.shutdownAll("bootstrap-failure").catch(() => undefined);
      logger.error("bootstrap_initialization_failed", { error: err });
      throw err;
    }

    const context: AppContext = Object.freeze({
      ...baseContext,
      lifecycle,
      shutdown: (reason?: string) => this.shutdown(reason),
    });

    // 6. Signals are installed only once a fully running app exists, so a
    //    failure above never leaves a handler that half-shuts a dead app.
    if (this.options.installSignalHandlers) this.installSignalHandlers(logger);

    this.state = "running";
    logger.info("bootstrap_ready", {
      node_env: config.nodeEnv,
      components: lifecycle.names.length,
    });

    return context;
  }

  async shutdown(reason = "shutdown"): Promise<ShutdownReport> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;

    if (this.state === "idle") {
      throw new BootstrapError("shutdown() called before run().");
    }
    if (this.state === "starting") {
      throw new BootstrapError("shutdown() cannot run while initialization is in progress.");
    }
    if (this.state === "failed" && this.lifecycle === null) {
      throw new BootstrapError("shutdown() called after a failed bootstrap.");
    }

    this.state = "stopping";
    const logger = this.logger ?? createLogger();
    const lifecycle = this.lifecycle;

    if (lifecycle === null) {
      this.state = "stopped";
      this.shutdownPromise = Promise.resolve({ reason, failed: [], timedOut: false });
      return this.shutdownPromise;
    }

    const timeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

    this.shutdownPromise = (async (): Promise<ShutdownReport> => {
      logger.info("shutdown_begin", { reason });

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<ShutdownReport>((resolve) => {
        timer = setTimeout(() => resolve({ reason, failed: [], timedOut: true }), timeoutMs);
        // Never keep the process alive just to measure the drain.
        timer.unref();
      });

      const report = await Promise.race([lifecycle.shutdownAll(reason), timeout]);
      if (timer !== undefined) clearTimeout(timer);

      this.state = "stopped";
      logger.info("shutdown_complete", {
        reason,
        failed: report.failed.map((failure) => failure.name),
        timed_out: report.timedOut === true,
      });

      return report;
    })();

    return this.shutdownPromise;
  }

  private installSignalHandlers(logger: Logger): void {
    if (this.signalsInstalled) return;
    this.signalsInstalled = true;

    const handler = (signal: NodeJS.Signals): void => {
      this.signalCount += 1;

      // A second signal means "stop waiting and die" — the operator insists.
      if (this.signalCount > 1) {
        logger.warn("shutdown_second_signal", { signal });
        if (this.options.exitOnSignal !== false) process.exit(1);
        return;
      }

      void this.shutdown(`signal:${signal}`)
        .then((report) => {
          if (this.options.exitOnSignal === false) return;
          process.exit(report.failed.length > 0 || report.timedOut === true ? 1 : 0);
        })
        .catch((err: unknown) => {
          logger.error("shutdown_failed", { error: err });
          if (this.options.exitOnSignal !== false) process.exit(1);
        });
    };

    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
  }
}
