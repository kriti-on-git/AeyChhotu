import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, describe, it } from "node:test";
import express from "express";

/* The public health endpoints must reflect HealthManager, not static JSON.
   Liveness stays independent of dependencies; readiness checks the actual
   registry and never leaks the component error text. */

import { HealthManager } from "../src/infrastructure/health/HealthManager.js";
import { createHealthRouter } from "../src/routes/health.js";
import { createReadyRouter } from "../src/routes/ready.js";
import { initContext } from "./helpers/init-context.js";

const servers: Array<ReturnType<typeof createServer>> = [];

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function managerWith(state: "HEALTHY" | "UNHEALTHY"): Promise<HealthManager> {
  const manager = new HealthManager({ checkTimeoutMs: 100 });
  manager.register({
    name: "database",
    health: () => ({
      state,
      message: state === "UNHEALTHY" ? "password authentication failed" : undefined,
    }),
  });
  await manager.init(initContext());
  return manager;
}

describe("health and readiness routes", () => {
  it("keeps liveness up while readiness reports an unavailable dependency", async () => {
    const health = await managerWith("UNHEALTHY");
    const app = express();
    app.use("/health", createHealthRouter(health));
    app.use("/ready", createReadyRouter(health));
    const base = await listen(app);

    const live = await fetch(`${base}/health`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { data: { ok: true } });

    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 503);
    const body = await ready.text();
    assert.match(body, /Dependency check failed/);
    assert.doesNotMatch(body, /password|UNHEALTHY|database is/);

    await health.shutdown();
  });

  it("reports readiness only after the registered dependencies are healthy", async () => {
    const health = await managerWith("HEALTHY");
    const app = express();
    app.use("/health", createHealthRouter(health));
    app.use("/ready", createReadyRouter(health));
    const base = await listen(app);

    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { data: { ready: true, database: "up" } });

    await health.shutdown();
  });

  it("refuses readiness when no health manager was composed", async () => {
    const app = express();
    app.use("/ready", createReadyRouter());
    const base = await listen(app);

    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 503);
    assert.match(await ready.text(), /NOT_READY/);
  });
});
