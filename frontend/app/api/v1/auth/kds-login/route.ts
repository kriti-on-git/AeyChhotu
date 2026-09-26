import { NextResponse } from "next/server";

/* POST /api/v1/auth/kds-login — gatekeeps the kitchen board.
   The expected PIN comes from the STAFF_PIN environment variable. The
   documented example PIN is used as a fallback so a fresh clone still runs. */

export async function POST(request: Request) {
  const expectedPin = process.env.STAFF_PIN || "1234";
  const body = (await request.json().catch(() => null)) as { pin?: unknown } | null;
  const pin = typeof body?.pin === "string" ? body.pin.trim() : "";

  if (!pin) {
    return NextResponse.json({ ok: false, message: "Enter the kitchen PIN." }, { status: 400 });
  }

  if (pin !== expectedPin) {
    return NextResponse.json({ ok: false, message: "That PIN does not match." }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
