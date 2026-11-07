/* Container — a deliberately small dependency-injection mechanism.

   WHY NOT A DI FRAMEWORK: this app needs wiring, not autowiring. There is no
   decorator metadata, no scanning and no reflection — every provider is
   registered explicitly by the composition root, which is what makes startup
   predictable and greppable.

   RULES
   * Tokens are opaque (a Symbol + a human description). String keys invite
     collisions and typos that only fail at runtime; a typed Token<T> makes
     `resolve` return T without a cast at the call site.
   * Registration is explicit and SINGLE: registering the same token twice is
     an error, not a silent override. A test that wants a fake provides it
     first; production wiring cannot be accidentally replaced later.
   * Factories run at most once (singleton semantics), lazily on first
     resolve.
   * There is no module-level container. Each bootstrap creates its own, so two
     bootstraps in one process (tests, future multi-app hosting) cannot share
     mutable state. */

export interface Token<T> {
  readonly key: symbol;
  readonly description: string;
  /** Phantom type: never read at runtime, only used for inference. */
  readonly __type?: T;
}

export function createToken<T>(description: string): Token<T> {
  return Object.freeze({ key: Symbol(description), description });
}

export class ContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerError";
  }
}

export class Container {
  private readonly providers = new Map<symbol, () => unknown>();
  private readonly descriptions = new Map<symbol, string>();
  private readonly instances = new Map<symbol, unknown>();

  /** Register a lazily-created singleton. */
  register<T>(token: Token<T>, factory: () => T): this {
    this.assertUnregistered(token);
    this.providers.set(token.key, factory);
    this.descriptions.set(token.key, token.description);
    return this;
  }

  /** Register an already-built value (config, logger, an existing pool). */
  registerValue<T>(token: Token<T>, value: T): this {
    this.assertUnregistered(token);
    this.instances.set(token.key, value);
    this.descriptions.set(token.key, token.description);
    return this;
  }

  has(token: Token<unknown>): boolean {
    return this.providers.has(token.key) || this.instances.has(token.key);
  }

  resolve<T>(token: Token<T>): T {
    if (this.instances.has(token.key)) {
      return this.instances.get(token.key) as T;
    }

    const factory = this.providers.get(token.key);
    if (!factory) {
      throw new ContainerError(
        `No provider is registered for "${token.description}". ` +
          "Register it in the composition root before resolving it.",
      );
    }

    const instance = factory();
    this.instances.set(token.key, instance);
    this.providers.delete(token.key);
    return instance as T;
  }

  /** Number of registered tokens — diagnostics and tests only. */
  get size(): number {
    return new Set([...this.providers.keys(), ...this.instances.keys()]).size;
  }

  private assertUnregistered(token: Token<unknown>): void {
    if (this.providers.has(token.key) || this.instances.has(token.key)) {
      throw new ContainerError(`"${token.description}" is already registered.`);
    }
  }
}
