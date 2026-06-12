/**
 * HTTP client for the bot-side Matrix crypto routes (`/api/bot/v1/crypto/*`).
 *
 * Mirrors the user-side `/api/crypto/*` shapes one-for-one (spec §6). The bot
 * SDK uses this transport to upload its identity/one-time keys, query peer
 * device bundles, claim OTKs, push to-device envelopes, drain the inbound
 * to-device queue, and resolve room membership for Megolm shares.
 *
 * Bearer-authenticated via the bot's existing token (same shape as
 * {@link ../client.ts}); JSON in / JSON out. On any non-2xx response the
 * transport throws {@link BotCryptoTransportError} so callers can pattern-match
 * on `status` + `code` (e.g. `otk_unavailable`, `device_not_found`).
 *
 * Note: bot DM ciphertext does NOT go through here — it goes through the
 * existing RPC `sendDmMessage` on {@link ../client.ts}. This module only
 * carries crypto-control traffic.
 */

// ── Request / response shapes (spec §6) ────────────────────────────────────

/**
 * Body for `POST /api/bot/v1/crypto/keys/upload`.
 *
 * Shape mirrors `OlmMachine.outgoingRequests()` `KeysUploadRequest.body` —
 * Matrix-style `device_keys`, `one_time_keys`, optional `fallback_keys`. The
 * server treats this opaquely (passes the JSON through to its own key-storage
 * tables), so we leave the inner fields loose.
 */
export interface KeysUploadBody {
  device_keys?: unknown;
  one_time_keys?: Record<string, unknown>;
  fallback_keys?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface KeysUploadResponse {
  one_time_key_counts: Record<string, number>;
}

/** Body for `POST /api/bot/v1/crypto/keys/query`. */
export interface KeysQueryBody {
  /** Matrix user id → device id list (empty list = all devices). */
  device_keys: Record<string, string[]>;
  timeout?: number;
  [key: string]: unknown;
}

export interface KeysQueryResponse {
  device_keys: Record<string, Record<string, unknown>>;
  master_keys?: Record<string, unknown>;
  self_signing_keys?: Record<string, unknown>;
  user_signing_keys?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Body for `POST /api/bot/v1/crypto/keys/claim`. */
export interface KeysClaimBody {
  /** Matrix user id → device id → algorithm (e.g. `"signed_curve25519"`). */
  one_time_keys: Record<string, Record<string, string>>;
  timeout?: number;
  [key: string]: unknown;
}

export interface KeysClaimResponse {
  one_time_keys: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Body for `PUT /api/bot/v1/crypto/sendToDevice/<event_type>/<txn_id>`. */
export interface SendToDeviceBody {
  /** Matrix user id → device id (or `"*"`) → event content. */
  messages: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Response shape from `GET /api/bot/v1/crypto/sync`. */
export interface SyncResponse {
  to_device: { events: unknown[] };
  device_one_time_keys_count: Record<string, number>;
  device_lists?: { changed?: string[]; left?: string[] };
  device_unused_fallback_key_types?: string[];
}

/**
 * Response shape from `GET /api/bot/v1/crypto/rooms/<roomId>`.
 *
 * The field is `devices` (matching the server emission in
 * /api/bot/v1/crypto/rooms/[roomId]/route.ts). Older drafts of this type
 * used `device_ids` which was never what the server returned — latent until
 * the first caller actually read the field.
 */
export interface RoomMembersResponse {
  members: Array<{ matrix_id: string; devices: string[] }>;
}

// ── Error type ─────────────────────────────────────────────────────────────

/**
 * Thrown by {@link BotCryptoTransport} for any non-2xx HTTP response.
 *
 * `status` is the HTTP status. `code` (when present) is the server-supplied
 * machine-readable error code (e.g. `otk_unavailable`, `device_not_found`).
 * `body` is the raw response text, useful for diagnostics when the server
 * returned an unexpected shape.
 */
export class BotCryptoTransportError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body: string;

  constructor({
    status,
    code,
    message,
    body,
  }: {
    status: number;
    code?: string;
    message: string;
    body: string;
  }) {
    super(message);
    this.name = "BotCryptoTransportError";
    this.status = status;
    if (code !== undefined) this.code = code;
    this.body = body;
  }
}

// ── Client ─────────────────────────────────────────────────────────────────

export class BotCryptoTransport {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor({ token, baseUrl = "" }: { token: string; baseUrl?: string }) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async keysUpload(body: KeysUploadBody): Promise<KeysUploadResponse> {
    return this.request<KeysUploadResponse>("POST", "/api/bot/v1/crypto/keys/upload", body);
  }

  async keysQuery(body: KeysQueryBody): Promise<KeysQueryResponse> {
    return this.request<KeysQueryResponse>("POST", "/api/bot/v1/crypto/keys/query", body);
  }

  async keysClaim(body: KeysClaimBody): Promise<KeysClaimResponse> {
    return this.request<KeysClaimResponse>("POST", "/api/bot/v1/crypto/keys/claim", body);
  }

  async sendToDevice(eventType: string, txnId: string, body: SendToDeviceBody): Promise<void> {
    await this.request<unknown>(
      "PUT",
      `/api/bot/v1/crypto/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`,
      body,
    );
  }

  async sync({ timeoutMs }: { timeoutMs?: number }): Promise<SyncResponse> {
    const path =
      timeoutMs === undefined
        ? "/api/bot/v1/crypto/sync"
        : `/api/bot/v1/crypto/sync?timeout=${timeoutMs}`;
    return this.request<SyncResponse>("GET", path);
  }

  async roomMembers(roomId: string): Promise<RoomMembersResponse> {
    // Matrix room ids look like `!<opaque>:<server>`. Both `!` (sub-delim) and
    // `:` (gen-delim) are RFC 3986 reserved characters in a path segment — if
    // we let them through raw, intermediaries (CDN, Next.js router, proxies)
    // can misparse the URL. encodeURIComponent normalises them to %21 / %3A
    // and the server-side decode in /api/bot/v1/crypto/rooms/[roomId]/route.ts
    // already calls decodeURIComponent on the param.
    return this.request<RoomMembersResponse>(
      "GET",
      `/api/bot/v1/crypto/rooms/${encodeURIComponent(roomId)}`,
    );
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const hasBody = body !== undefined;
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (hasBody) headers["content-type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const code = extractErrorCode(text);
      const detail = extractErrorMessage(text);
      throw new BotCryptoTransportError({
        status: res.status,
        code,
        message: `${method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`,
        body: text,
      });
    }

    // Success responses are always JSON in this API (spec §6); callers that
    // expect `void` (sendToDevice) ignore the parsed body.
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      return undefined as T;
    }
  }
}

function extractErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      errcode?: unknown;
      code?: unknown;
      error?: unknown;
    };
    // Matrix convention (and what every /api/bot/v1/crypto/* route emits) is
    // `errcode` — read that first. Fall back to legacy `code` so any older
    // route or external client that still emits `code` keeps working.
    if (typeof parsed.errcode === "string") return parsed.errcode;
    if (typeof parsed.code === "string") return parsed.code;
    // Fall back to `error` if it looks like a snake_case code rather than a sentence.
    if (typeof parsed.error === "string" && /^[a-z][a-z0-9_]*$/.test(parsed.error)) {
      return parsed.error;
    }
  } catch {
    // Non-JSON body — no code to extract.
  }
  return undefined;
}

function extractErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Non-JSON body.
  }
  return undefined;
}
