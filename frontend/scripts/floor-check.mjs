#!/usr/bin/env node
/* AeyChhotu! — Floor view browser check.
 *
 * The floor screen is the one surface where "the code compiles" says almost
 * nothing: it is gated behind a PIN, depends on a staff bearer token, and its
 * whole value is rendering live E17 data. This drives real headless Chrome
 * over the DevTools protocol and asserts what a person would actually see.
 *
 * What it proves:
 *   • the PIN gate is wired (locked ⇒ the PIN wall, not the board)
 *   • unlocking shows the LIVE board, not the demo store
 *   • the fired ticket's status and its ALLERGY ALERT reach the card
 *   • no console errors or uncaught exceptions along the way
 *
 * Usage (both servers must be running):
 *   1. cd backend && npm run dev
 *   2. cd frontend && npm run dev
 *   3. cd frontend && npm run check:floor
 *
 *   CHROME_PATH=/usr/bin/google-chrome   (override)
 *   FLOOR_WEB_URL=http://localhost:3000  (override)
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/** Minimal .env reader — the frontend has no dotenv dependency. */
function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* absent file is fine — values may come from the real environment */
  }
}
loadEnvFile(new URL("../.env.local", import.meta.url).pathname);

const WEB = (process.env.FLOOR_WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const API = (process.env.FLOOR_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const CHROME = process.env.CHROME_PATH ?? "google-chrome";
const PORT = Number(process.env.CDP_PORT ?? 9222);
const TABLE_TOKEN = "k7x2p";
const DOSA = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d"; // Masala Dosa (seed)

let passed = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// --------------------------------------------------------------------- chrome
const profileDir = mkdtempSync(join(tmpdir(), "aeychhotu-chrome-"));
const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws = null;

async function cleanup() {
  try {
    ws?.close();
  } catch {
    /* already closed */
  }
  chrome.kill("SIGKILL");
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

async function targetUrl() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome not up yet */
    }
    await sleep(300);
  }
  throw new Error(`Chrome did not expose a page target on port ${PORT}`);
}

/** Minimal CDP client over Node's global WebSocket. */
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const consoleErrors = [];

    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);

      if (msg.id && pending.has(msg.id)) {
        const { resolve: done, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message));
        else done(msg.result);
        return;
      }

      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        consoleErrors.push(
          (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "),
        );
      }
      if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(msg.params?.exceptionDetails?.text ?? "uncaught exception");
      }
    });

    socket.addEventListener("error", () => reject(new Error("CDP socket error")));
    socket.addEventListener("open", () => {
      const send = (method, params = {}) =>
        new Promise((done, fail) => {
          const id = nextId++;
          pending.set(id, { resolve: done, reject: fail });
          socket.send(JSON.stringify({ id, method, params }));
        });
      resolve({ send, consoleErrors, close: () => socket.close() });
    });
  });
}

let createdOrderId = null;
let staffToken = null;

/* Resets the demo table to a clean slate: clears the cart and serves out any
   active ticket, since prune is only valid from `ready`.

   This MUST run with a bearer token — an earlier version of this script ran
   it unauthenticated, every call silently 401'd, and the leftover `pending`
   order then broke the next suite that ran. Anything in here reports its own
   failure loudly for the same reason. */
async function resetDemoTable(token) {
  const cleared = [];

  const cart = await api(`/api/v1/cart/items?table_token=${TABLE_TOKEN}&limit=100`);
  for (const line of cart.body?.data ?? []) {
    const res = await api("/api/v1/cart/items", {
      method: "DELETE",
      body: { table_token: TABLE_TOKEN, cart_item_id: line.id },
    });
    if (res.status !== 200) cleared.push(`cart line ${line.id}: HTTP ${res.status}`);
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const active = await api(`/api/v1/sessions/${TABLE_TOKEN}/active-check`);
    const orderId = active.body?.data?.order_id;
    if (!active.body?.data?.has_active_order || !orderId) break;

    await api(`/api/v1/kds/tickets/${orderId}/status`, {
      method: "PATCH",
      token,
      body: { status: "preparing" },
    });
    await api(`/api/v1/kds/tickets/${orderId}/status`, {
      method: "PATCH",
      token,
      body: { status: "ready" },
    });
    const pruned = await api(`/api/v1/kds/tickets/${orderId}/prune`, {
      method: "PATCH",
      token,
    });
    if (pruned.status !== 200) cleared.push(`prune ${orderId}: HTTP ${pruned.status}`);
  }

  return cleared;
}

try {
  const wsUrl = await targetUrl();
  const { send, consoleErrors, close } = await connect(wsUrl);
  ws = { close };

  await send("Page.enable");
  await send("Runtime.enable");

  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result?.value;
  };

  const goto = async (url) => {
    await send("Page.navigate", { url });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const ready = await evaluate("document.readyState").catch(() => null);
      if (ready === "complete") return;
      await sleep(200);
    }
  };

  const bodyText = () => evaluate("document.body ? document.body.innerText : ''");
  /* Case-insensitive because the allergy alert is rendered with a CSS
     `uppercase` class, and innerText reflects text-transform — asserting on
     the exact casing would make the check depend on a style detail. */
  const waitForText = async (needle, timeoutMs = 20_000) => {
    const wanted = needle.toLowerCase();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await bodyText().catch(() => "");
      if (text.toLowerCase().includes(wanted)) return text;
      await sleep(300);
    }
    return null;
  };

  // ---------------------------------------------------------------- fixtures
  section("0. Fixtures — a live ticket with an allergy");
  const pin = process.env.STAFF_PIN;
  if (!pin) throw new Error("STAFF_PIN missing from frontend/.env(.local)");

  const login = await api("/api/v1/auth/kds-login", { method: "POST", body: { pin } });
  staffToken = login.body?.data?.token ?? null;
  check("staff login for the browser session", Boolean(staffToken), `HTTP ${login.status}`);

  // Idempotent: a leftover ticket from an interrupted run must not fail this.
  const preflight = await resetDemoTable(staffToken);
  if (preflight.length > 0) {
    console.log(`  ℹ️  pre-flight reset reported: ${preflight.join(", ")}`);
  }

  await api("/api/v1/cart/items", {
    method: "POST",
    body: {
      table_token: TABLE_TOKEN,
      menu_item_id: DOSA,
      quantity: 2,
      added_by: "floor-check",
      allergy_note: "NO PEANUTS - FLOOR CHECK",
    },
  });
  const fired = await api("/api/v1/orders/fire", { method: "POST", body: { table_token: TABLE_TOKEN } });
  createdOrderId = fired.body?.data?.order_id ?? null;
  check("live ticket fired for the check", Boolean(createdOrderId), `HTTP ${fired.status}`);

  // ------------------------------------------------------------- locked state
  section("1. Locked — the gate must ask for a PIN");
  await goto(`${WEB}/`);
  await evaluate(
    "localStorage.removeItem('aeychhotu.kds_token'); sessionStorage.removeItem('aeychhotu.floor.unlocked'); 'ok'",
  );
  await goto(`${WEB}/floor`);

  const lockedText = await waitForText("Enter floor staff PIN", 15_000);
  check("floor shows the PIN wall when locked", Boolean(lockedText));
  check("board content is NOT rendered while locked", !(lockedText ?? "").includes("Floor"));

  // ----------------------------------------------------------- unlocked state
  section("2. Unlocked — the live board renders");
  await evaluate(
    [
      `localStorage.setItem('aeychhotu.kds_token', ${JSON.stringify(staffToken)});`,
      "sessionStorage.setItem('aeychhotu.floor.unlocked', '1');",
      "'ok'",
    ].join(" "),
  );
  await goto(`${WEB}/floor`);

  // The card needs: the header, a seeded table code, and the allergy alert.
  const boardText = await waitForText("Floor", 20_000);
  check("floor board renders after unlocking", Boolean(boardText));

  const withTable = await waitForText("k7x2p", 20_000);
  check("live table code appears on a card", Boolean(withTable));

  check("board reports the Live source (not Demo data)", Boolean(withTable?.includes("Live")));
  check("demo badge is absent", !(withTable ?? "").includes("Demo data"));


  const withStatus = await waitForText("Pending", 20_000);
  check("active ticket status is shown", Boolean(withStatus));

  const withAllergy = await waitForText("allerg", 20_000);
  check(
    "allergy alert reaches the floor card (E17 items)",
    Boolean(withAllergy),
    "the card must surface the ticket's allergy_note",
  );

  section("3. Console hygiene");
  const realErrors = consoleErrors.filter(
    (line) => !/favicon|404 \(Not Found\)/i.test(line),
  );
  check("no console errors or uncaught exceptions", realErrors.length === 0, realErrors.join(" | "));
} catch (err) {
  console.error(`\n[floor] aborted: ${err.message}`);
  failures.push(`runner crashed: ${err.message}`);
}

// ------------------------------------------------------------------ cleanup
// Fails loudly: a silent cleanup failure leaves an active order behind and
// breaks the NEXT suite to run, which is a miserable thing to debug.
try {
  const problems = await resetDemoTable(staffToken);
  if (problems.length > 0) {
    console.log(`\n[floor] ⚠️  cleanup incomplete — ${problems.join(", ")}`);
    failures.push("cleanup left the demo table dirty");
  } else {
    console.log("\n[floor] demo table restored (cart cleared, tickets served)");
  }

  const after = await api(`/api/v1/sessions/${TABLE_TOKEN}/active-check`);
  const stillActive = after.body?.data?.has_active_order === true;
  if (stillActive) {
    console.log("[floor] ⚠️  an active order is still on the table after cleanup");
    failures.push("demo table still has an active order");
  }
} catch (err) {
  console.log(`\n[floor] ⚠️  cleanup crashed: ${err.message}`);
  failures.push("cleanup crashed");
}

await cleanup();

console.log(
  `\n[floor] ${passed} check(s) passed` +
    (failures.length ? `, ${failures.length} FAILED:\n  • ${failures.join("\n  • ")}` : ""),
);
process.exit(failures.length > 0 ? 1 : 0);
