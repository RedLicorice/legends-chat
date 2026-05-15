// Thin Shlink REST client. Returns null on any failure so callers can fall
// back to the original long URL — link wrapping is best-effort and must never
// block the send pipeline.

export interface ShortenOpts {
  host: string;
  apiKey: string;
  longUrl: string;
  tags?: string[];
  domain?: string | null;
}

export async function shortenUrl(opts: ShortenOpts): Promise<string | null> {
  const host = opts.host.replace(/\/+$/, "");
  const endpoint = `${host}/rest/v3/short-urls`;
  const body: Record<string, unknown> = {
    longUrl: opts.longUrl,
    findIfExists: true,
  };
  if (opts.tags && opts.tags.length > 0) body.tags = opts.tags;
  if (opts.domain) body.domain = opts.domain;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Api-Key": opts.apiKey,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { shortUrl?: unknown };
    return typeof json.shortUrl === "string" ? json.shortUrl : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
