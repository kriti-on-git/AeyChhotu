#!/usr/bin/env node
/* AeyChhotu! — hold the free Render API awake for a bounded window.
 *
 * WHY THIS EXISTS
 *   Render spins a Free web service down after 15 minutes with no inbound
 *   traffic, and spinning back up "takes about one minute". That is fine
 *   day-to-day — the client surfaces "Serving line taking a moment to spin up,
 *   please try again!" and the production demo-fallback gate keeps it honest —
 *   but it is exactly the wrong thing to discover mid-demo.
 *
 *   This script pings the readiness probe on a fixed interval for a fixed
 *   window, then stops on its own. That matters: Render grants 750 Free
 *   instance hours per workspace per calendar month, and one always-on service
 *   already costs up to 744 h — so a *permanent* pinger leaves no margin (and
 *   only fits at all if this is the sole Free web service in the workspace).
 *   A bounded run spends hours only for the window you actually asked for.
 *
 * USAGE
 *   cd backend
 *   npm run keep-alive -- https://aeychhotu-api-bkp8.onrender.com
 *
 *   KEEP_ALIVE_URL           target base URL          (default http://localhost:4000)
 *   KEEP_ALIVE_HOURS         how long to run          (default 3)
 *   KEEP_ALIVE_INTERVAL_MIN  minutes between pings    (default 10)
 *
 *   The longest safe interval is just under 15 minutes; 10 leaves room for a
 *   slow tick and a cold start. Run it detached so closing the terminal does
 *   not kill it:
 *
 *     nohup npm run keep-alive -- <url> > /tmp/aeychhotu-keepalive.log 2>&1 &
 *
 *   `/api/v1/ready` is the right target, not `/health`: it runs a real
 *   `SELECT 1` against Postgres, so the ping also proves the database link is
 *   alive, and it is the same path Render's own health check uses.
 */

const BASE = (process.argv[2] ?? process.env.KEEP_ALIVE_URL ?? "http://localhost:4000")
  .trim()
  .replace(/\/+$/, "");

const HOURS = Number(process.env.KEEP_ALIVE_HOURS ?? 3);
const INTERVAL_MIN = Number(process.env.KEEP_ALIVE_INTERVAL_MIN ?? 10);

/* A spun-down service takes ~60 s to wake, so a short timeout would report a
   false failure on the very first ping — the one that matters most. */
const REQUEST_TIMEOUT_MS = 90_000;

/* Anything slower than this means we almost certainly paid a cold start. */
const COLD_START_HINT_MS = 5_000;

if (!Number.isFinite(HOURS) || HOURS <= 0) {
  console.error(`[keep-alive] FATAL: KEEP_ALIVE_HOURS must be a positive number, got "${HOURS}".`);
  process.exit(1);
}
if (!Number.isFinite(INTERVAL_MIN) || INTERVAL_MIN <= 0) {
  console.error(`[keep-alive] FATAL: KEEP_ALIVE_INTERVAL_MIN must be a positive number, got "${INTERVAL_MIN}".`);
  process.exit(1);
}
if (INTERVAL_MIN >= 15) {
  console.error(
    `[keep-alive] FATAL: KEEP_ALIVE_INTERVAL_MIN=${INTERVAL_MIN} is >= 15 — the service will spin ` +
      `down between pings. Use something under 15 (10 is the default).`,
  );
  process.exit(1);
}

const URL = `${BASE}/api/v1/ready`;
const INTERVAL_MS = INTERVAL_MIN * 60_000;
const WINDOW_MS = HOURS * 3_600_000;
const deadline = Date.now() + WINDOW_MS;

let sent = 0;
let awakePings = 0;
let failures = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** "1 h 20 min" / "45 s" — for the countdown lines. */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

/** Local wall-clock time — easier to line up with a demo run-sheet than a UTC stamp. */
function clock(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function ping(index, total) {
  const started = Date.now();
  const label = `[${String(index).padStart(2, " ")}/${total}] ${clock()}`;

  try {
    const res = await fetch(URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const elapsed = Date.now() - started;
    sent += 1;

    if (res.ok) {
      awakePings += 1;
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 48);
      const cold = elapsed > COLD_START_HINT_MS;
      console.log(
        `${label}  ${cold ? "💤" : "✅"} 200 in ${(elapsed / 1000).toFixed(1)} s` +
          `${cold ? "  — was spun down, now awake" : ""}${body ? `   ${body}` : ""}`,
      );
    } else {
      failures += 1;
      console.log(`${label}  ⚠️  ${res.status} in ${(elapsed / 1000).toFixed(1)} s — readiness probe unhealthy`);
    }
  } catch (error) {
    sent += 1;
    failures += 1;
    const elapsed = Date.now() - started;
    const reason = error?.name === "TimeoutError" ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} s` : error?.message;
    console.log(`${label}  ❌ ${reason} (after ${(elapsed / 1000).toFixed(1)} s)`);
  }
}

const totalPings = Math.max(1, Math.ceil(WINDOW_MS / INTERVAL_MS));

console.log(`[keep-alive] target ${URL}`);
console.log(
  `[keep-alive] window ${HOURS} h · every ${INTERVAL_MIN} min · up to ${totalPings} ping(s) · ` +
    `stops at ${clock(deadline)}`,
);
if (BASE.includes("localhost") || BASE.includes("127.0.0.1")) {
  console.log(
    `[keep-alive] note: that is a local address. For the deployed API pass the Render URL, e.g.\n` +
      `             npm run keep-alive -- https://aeychhotu-api-bkp8.onrender.com`,
  );
}
console.log(`[keep-alive] Ctrl-C stops early — Render hours are only spent while it is awake.\n`);

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});

let index = 0;
while (index < totalPings && Date.now() < deadline && !interrupted) {
  index += 1;
  await ping(index, totalPings);

  const remaining = deadline - Date.now();
  if (remaining <= 0 || index >= totalPings || interrupted) break;

  const wait = Math.min(INTERVAL_MS, remaining);
  console.log(`            next ping at ${clock(Date.now() + wait)} (in ${formatDuration(wait)})`);
  await sleep(wait);
}

const ranFor = WINDOW_MS - Math.max(0, deadline - Date.now());
const failedNote = failures > 0 ? `, ${failures} failed` : "";
console.log(
  `\n[keep-alive] ${interrupted ? "stopped early" : "done"} — ${awakePings}/${sent} healthy ping(s)` +
    `${failedNote} · ran ${formatDuration(ranFor)} of ${HOURS} h`,
);
if (failures > 0) {
  console.log(
    `[keep-alive] a failing /ready means the service is not serving: check the Render logs and that\n` +
      `             DATABASE_URL is the Supabase *session pooler* host, not the IPv6-only db.<ref> one.`,
  );
}
