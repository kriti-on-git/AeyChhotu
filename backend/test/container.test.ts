import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for the DI container (phase 2A). The properties that matter are
   explicitness and failure loudness: no silent overrides, no ambient
   container shared between bootstraps, factories run once. */

import { Container, ContainerError, createToken } from "../src/bootstrap/Container.js";

describe("Container — registration and resolution", () => {
  it("resolves a registered value", () => {
    const container = new Container();
    const token = createToken<{ name: string }>("widget");

    container.registerValue(token, { name: "w" });

    assert.equal(container.resolve(token).name, "w");
  });

  it("runs a factory at most once (singleton semantics)", () => {
    const container = new Container();
    const token = createToken<object>("expensive");
    let calls = 0;

    container.register(token, () => {
      calls += 1;
      return { id: calls };
    });

    const first = container.resolve(token);
    const second = container.resolve(token);

    assert.equal(calls, 1);
    assert.equal(first, second);
  });

  it("creates instances lazily", () => {
    const container = new Container();
    const token = createToken<string>("lazy");
    let created = false;

    container.register(token, () => {
      created = true;
      return "value";
    });

    assert.equal(created, false);
    assert.equal(container.has(token), true);
    container.resolve(token);
    assert.equal(created, true);
  });
});

describe("Container — misuse is an error", () => {
  it("rejects a duplicate registration instead of overriding it", () => {
    const container = new Container();
    const token = createToken<number>("counter");

    container.registerValue(token, 1);

    assert.throws(() => container.registerValue(token, 2), ContainerError);
    assert.throws(() => container.register(token, () => 3), ContainerError);
  });

  it("marks an already-resolved token as registered", () => {
    const container = new Container();
    const token = createToken<number>("counted");

    container.register(token, () => 1);
    container.resolve(token);

    assert.throws(() => container.registerValue(token, 2), ContainerError);
  });

  it("throws a descriptive error for an unknown token", () => {
    const container = new Container();
    const token = createToken<number>("missing.provider");

    assert.throws(
      () => container.resolve(token),
      (err: unknown) => {
        assert.ok(err instanceof ContainerError);
        assert.match(err.message, /missing\.provider/);
        return true;
      },
    );
  });
});

describe("Container — isolation", () => {
  it("keeps two containers independent", () => {
    const token = createToken<string>("shared.name");
    const first = new Container();
    const second = new Container();

    first.registerValue(token, "first");

    assert.equal(first.resolve(token), "first");
    assert.equal(second.has(token), false);
    assert.throws(() => second.resolve(token), ContainerError);
  });
});
