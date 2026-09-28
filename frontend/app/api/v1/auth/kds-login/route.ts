import { NextResponse } from "next/server";

/* POST /api/v1/auth/kds-login — DEVELOPMENT-ONLY fallback for the offline
   demo store.

   The real endpoint is E2 on the Express backend: it validates the PIN with
   a constant-time compare and issues a signed 8-hour shift JWT that the
   staff routes actually verify. This route exists solely so `next dev` with
   the API down can still open the kitchen board, and it grants no authority.

   Two rules keep it from becoming a production liability:

     1. In a production build it refuses outright. A second, unauthenticated
        PIN endpoint on the public origin that answers with nothing but a
        boolean is a free oracle for brute-forcing the kitchen PIN — even
        though it hands out no token, it leaks "that PIN is correct".
     2. It answers with the same envelope as every other endpoint
        (docs/7-api-contract.md §1.1), so the client parses one shape.

   The PIN comes from STAFF_PIN; the documented example is the fallback so a
   fresh clone still runs. It is never echoed back. */

const PIN_RE = /^\d{4,6}$/;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "NOT_FOUND",
          message: "Route POST /api/v1/auth/kds-login does not exist.",
        },
      },
      { status: 404 },
    );
  }

  const body = (await request.json().catch(() => null)) as { pin?: unknown } | null;
  const pin = typeof body?.pin === "string" ? body.pin.trim() : "";

  if (!PIN_RE.test(pin)) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request payload failed validation.",
          fields: { pin: "PIN must be 4 to 6 digits." },
        },
      },
      { status: 400 },
    );
  }

  // Matches the copy shown on the PIN wall: an unset STAFF_PIN means a fresh
  // clone, which the docs say falls back to 1234. Development only.
  const expectedPin = process.env.STAFF_PIN?.trim() || "1234";
  if (pin !== expectedPin) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "INVALID_PIN", message: "That PIN does not match." },
      },
      { status: 401 },
    );
  }

  return NextResponse.json({
    success: true,
    data: {
      ok: true,
      message: "Demo shift unlocked (offline fallback — no token issued).",
    },
  });
}
