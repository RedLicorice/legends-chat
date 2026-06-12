import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BotCryptoTransport, BotCryptoTransportError } from "../src/transport-crypto.js";

describe("BotCryptoTransport", () => {
  const fetchSpy = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fetchSpy.mockReset();
  });

  function okResponse(body: unknown, init: { status?: number } = {}): Response {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("keysUpload POSTs to /api/bot/v1/crypto/keys/upload with bearer + JSON body", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ one_time_key_counts: { signed_curve25519: 50 } }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    const out = await t.keysUpload({ device_keys: { foo: "bar" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chat.test/api/bot/v1/crypto/keys/upload");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer tok",
      "content-type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ device_keys: { foo: "bar" } }));
    expect(out).toEqual({ one_time_key_counts: { signed_curve25519: 50 } });
  });

  it("keysQuery POSTs to /api/bot/v1/crypto/keys/query", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ device_keys: {} }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    const out = await t.keysQuery({ device_keys: { "@u:legends.local": [] } });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chat.test/api/bot/v1/crypto/keys/query");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer tok",
      "content-type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ device_keys: { "@u:legends.local": [] } }));
    expect(out).toEqual({ device_keys: {} });
  });

  it("keysClaim POSTs to /api/bot/v1/crypto/keys/claim", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ one_time_keys: {} }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    const out = await t.keysClaim({ one_time_keys: {} });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chat.test/api/bot/v1/crypto/keys/claim");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer tok",
      "content-type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ one_time_keys: {} }));
    expect(out).toEqual({ one_time_keys: {} });
  });

  it("sendToDevice PUTs to /api/bot/v1/crypto/sendToDevice/<eventType>/<txnId>", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({}));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    await t.sendToDevice("m.room.encrypted", "txn-1", { messages: { "@u:legends.local": { DEV: { foo: 1 } } } });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chat.test/api/bot/v1/crypto/sendToDevice/m.room.encrypted/txn-1");
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({
      authorization: "Bearer tok",
      "content-type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ messages: { "@u:legends.local": { DEV: { foo: 1 } } } }));
  });

  it("sync GETs /api/bot/v1/crypto/sync with timeout query string", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ to_device: { events: [] }, device_one_time_keys_count: {} }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    const out = await t.sync({ timeoutMs: 30_000 });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chat.test/api/bot/v1/crypto/sync?timeout=30000");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok" });
    // GET request should not carry a body.
    expect(init.body).toBeUndefined();
    expect(out).toEqual({ to_device: { events: [] }, device_one_time_keys_count: {} });
  });

  it("sync defaults to no timeout query string when timeoutMs is omitted", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ to_device: { events: [] }, device_one_time_keys_count: {} }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    await t.sync({});
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chat.test/api/bot/v1/crypto/sync");
  });

  it("roomMembers URL-encodes the room id (Matrix room ids contain reserved ':' which proxies misparse)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ members: [{ matrix_id: "@u:legends.local", devices: ["DEV"] }] }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    const out = await t.roomMembers("!abc-uuid:legends.local");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // ':' is a gen-delim (RFC 3986) — it must be encoded so intermediaries
    // (CDN, Next.js router) don't treat the trailing `:server` as a port.
    // encodeURIComponent leaves '!' raw (it's a sub-delim that's safe in
    // path segments per RFC 3986 §2.3), so we don't assert on it.
    expect(url).toBe(
      `https://chat.test/api/bot/v1/crypto/rooms/${encodeURIComponent("!abc-uuid:legends.local")}`,
    );
    expect(url).toContain("%3A");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(init.body).toBeUndefined();
    // Server emits `devices`, not `device_ids` — the SDK type now matches.
    expect(out).toEqual({ members: [{ matrix_id: "@u:legends.local", devices: ["DEV"] }] });
  });

  it("strips a trailing slash from baseUrl", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ one_time_key_counts: {} }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test/" });
    await t.keysUpload({});
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chat.test/api/bot/v1/crypto/keys/upload");
  });

  it("throws BotCryptoTransportError on non-2xx", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "boom", code: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    let caught: unknown;
    try {
      await t.keysUpload({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BotCryptoTransportError);
    const e = caught as BotCryptoTransportError;
    expect(e.status).toBe(500);
    expect(e.code).toBe("internal_error");
    expect(e.body).toContain("boom");
  });

  // Finding 14: every /api/bot/v1/crypto/* route returns `{ errcode, error }`
  // per Matrix convention. The SDK previously only read `code`, so the
  // structured machine-readable id was lost. Read `errcode` first, fall back
  // to `code` to keep any legacy callers working.
  it("extractErrorCode reads `errcode` per Matrix convention", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ errcode: "M_FORBIDDEN", error: "you may not" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    await expect(t.keysUpload({})).rejects.toMatchObject({
      status: 403,
      code: "M_FORBIDDEN",
    });
  });

  it("extractErrorCode falls back to legacy `code` when no errcode present", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "legacy_code", error: "old shape" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    await expect(t.keysUpload({})).rejects.toMatchObject({
      status: 500,
      code: "legacy_code",
    });
  });

  it("BotCryptoTransportError exposes status + code + body fields", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "otk_unavailable", code: "otk_unavailable" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    await expect(
      t.sendToDevice("m.room.encrypted", "txn-2", { messages: {} }),
    ).rejects.toMatchObject({
      name: "BotCryptoTransportError",
      status: 404,
      code: "otk_unavailable",
    });
  });
});
