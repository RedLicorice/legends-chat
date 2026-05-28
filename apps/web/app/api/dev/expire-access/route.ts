import { NextResponse } from "next/server";
import { ACCESS_COOKIE } from "@legends/shared";

// Dev-only helper used for E2E testing of session-expiry flow.
// Removes ACCESS_COOKIE so middleware exercises the refresh shell on next nav.
export async function POST() {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
