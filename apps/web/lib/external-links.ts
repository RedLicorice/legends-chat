export function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/^www\./, "");
}

export function parseWhitelist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((s) => normalizeHost(s))
    .filter(Boolean);
}
