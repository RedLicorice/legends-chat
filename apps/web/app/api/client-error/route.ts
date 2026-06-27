import { NextResponse } from "next/server";

// Minimal client-error sink. The browser posts uncaught errors / React render
// failures here; we log them server-side so they show up in normal app logs
// (and in dev, in the terminal). No external telemetry service, no storage —
// deliberately small. Reporting is opt-out client-side (see ClientErrorReporter),
// so by the time a request reaches here the user has not opted out.

// ponytail: in-memory rate limit — max 20 requests per 10 s per IP.
// Module-level; resets on cold start. Good enough for a logging endpoint.
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 20;
const ipTimestamps = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const times = (ipTimestamps.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_LIMIT) return true;
  times.push(now);
  ipTimestamps.set(ip, times);
  return false;
}

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for") ?? "anon";
  if (isRateLimited(ip)) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > 16 * 1024) {
    return NextResponse.json({ ok: false }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const line = {
    at: new Date().toISOString(),
    kind: typeof b.kind === "string" ? b.kind : "error",
    message: typeof b.message === "string" ? b.message.slice(0, 2000) : "",
    url: typeof b.url === "string" ? b.url.slice(0, 500) : "",
    stack: typeof b.stack === "string" ? b.stack.slice(0, 6000) : "",
    componentStack:
      typeof b.componentStack === "string" ? b.componentStack.slice(0, 6000) : "",
    userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? "",
  };
  // Single tagged line so it's greppable in logs.
  console.error("[client-error]", JSON.stringify(line));
  return NextResponse.json({ ok: true });
}
