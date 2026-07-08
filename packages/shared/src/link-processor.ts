import { shortenUrl } from "./shlink-client";

export interface LinkProcessorSettings {
  shlinkEnabled: boolean;
  shlinkHost: string | null;
  shlinkApiKey: string | null;
  shlinkDefaultDomain: string | null;
  shlinkTagWithUser: boolean;
  // When shlink is enabled, only wrap URLs matching this regex.
  // Empty/null/invalid pattern → wrap nothing (safe default).
  // Tested against the full (post-strip) URL string.
  shlinkWrapRegex: string | null;
  stripTracking: boolean;
  publicOrigin: string | null;
}

function compileWrapRegex(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  try { return new RegExp(pattern); } catch { return null; }
}

// Global tracking params — stripped from every host when stripTracking is on.
const GLOBAL_TRACKING = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "fbclid", "fbid",
  "gclid", "gclsrc", "dclid",
  "msclkid",
  "yclid",
  "igsh", "igshid", "ig_rid",
  "mc_cid", "mc_eid",
  "_hsenc", "_hsmi", "hsCtaTracking",
]);

// Host-scoped param keys (exact). Wildcard prefixes go through hostPrefixMatches.
const HOST_TRACKING: Array<{ suffix: string; exact: Set<string>; prefixes: string[] }> = [
  { suffix: "twitter.com",   exact: new Set(["s", "t"]),                                  prefixes: [] },
  { suffix: "x.com",         exact: new Set(["s", "t"]),                                  prefixes: [] },
  { suffix: "youtube.com",   exact: new Set(["si", "feature"]),                           prefixes: [] },
  { suffix: "youtu.be",      exact: new Set(["si", "feature"]),                           prefixes: [] },
  { suffix: "tiktok.com",    exact: new Set(["_t", "_r", "_d", "is_from_webapp", "sender_device"]), prefixes: [] },
];

const AMAZON_PREFIXES = ["pf_rd_", "pd_rd_"];
const AMAZON_EXACT = new Set(["ref", "ref_", "tag", "linkCode"]);

function normalizedHost(url: URL): string {
  return url.hostname.replace(/^www\./, "").toLowerCase();
}

function hostEndsWith(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function isAmazonHost(host: string): boolean {
  // amazon.<anything> — e.g. amazon.com, amazon.co.uk, amazon.de
  return /(^|\.)amazon\.[a-z.]+$/i.test(host);
}

function isNitterHost(host: string): boolean {
  return host === "nitter" || host.startsWith("nitter.") || host.includes(".nitter.");
}

function stripTrackingParams(url: URL): void {
  const host = normalizedHost(url);
  const toDelete: string[] = [];
  for (const key of url.searchParams.keys()) {
    if (GLOBAL_TRACKING.has(key)) { toDelete.push(key); continue; }
    // host-scoped exact
    for (const h of HOST_TRACKING) {
      if (hostEndsWith(host, h.suffix) && h.exact.has(key)) { toDelete.push(key); break; }
    }
    // nitter mirrors share twitter params
    if (isNitterHost(host) && (key === "s" || key === "t")) toDelete.push(key);
    // amazon (any TLD)
    if (isAmazonHost(host)) {
      if (AMAZON_EXACT.has(key)) { toDelete.push(key); continue; }
      if (AMAZON_PREFIXES.some((p) => key.startsWith(p))) toDelete.push(key);
    }
  }
  // Dedupe
  for (const k of new Set(toDelete)) url.searchParams.delete(k);
}

const URL_REGEX = /\bhttps?:\/\/[^\s<>\)\]"']+/gi;

// Trailing punctuation that's commonly *not* part of the URL even though the
// regex grabs it (e.g. "see http://example.com." or "(http://x.com)").
function trimTrailingPunct(raw: string): { url: string; tail: string } {
  let i = raw.length;
  while (i > 0 && /[.,;:!?]$/.test(raw.slice(i - 1, i))) i--;
  return { url: raw.slice(0, i), tail: raw.slice(i) };
}

export async function processMessageLinks(
  text: string,
  settings: LinkProcessorSettings,
  senderUserId: string | null,
): Promise<string> {
  if (!text) return text;
  if (!settings.stripTracking && !settings.shlinkEnabled) return text;

  const matches = text.match(URL_REGEX);
  if (!matches || matches.length === 0) return text;

  const publicHost = settings.publicOrigin ? safeHost(settings.publicOrigin) : null;
  const shlinkHost = settings.shlinkHost ? safeHost(settings.shlinkHost) : null;
  const wrapRegex = compileWrapRegex(settings.shlinkWrapRegex);

  // Process each unique raw URL once; cache the replacement.
  const replacements = new Map<string, string>();
  for (const raw of matches) {
    if (replacements.has(raw)) continue;
    const { url: rawClean, tail } = trimTrailingPunct(raw);
    try {
      const parsed = new URL(rawClean);
      const host = normalizedHost(parsed);

      // Skip internal links — never strip, never wrap.
      if (publicHost && hostEndsWith(host, publicHost)) {
        replacements.set(raw, raw);
        continue;
      }
      // Skip URLs already on the shlink host — don't double-wrap.
      if (shlinkHost && hostEndsWith(host, shlinkHost)) {
        replacements.set(raw, raw);
        continue;
      }

      if (settings.stripTracking) stripTrackingParams(parsed);

      let finalUrl = parsed.toString();

      if (
        settings.shlinkEnabled
        && settings.shlinkHost
        && settings.shlinkApiKey
        && wrapRegex
        // Bound the tested input — a catastrophic admin pattern's backtracking
        // scales with input length; cap it so one long URL can't hang the send
        // path. ponytail: full ReDoS immunity needs RE2 (a dep) — deferred.
        && wrapRegex.test(finalUrl.slice(0, 2048))
      ) {
        const tags: string[] = [];
        if (settings.shlinkTagWithUser && senderUserId) tags.push(`user:${senderUserId}`);
        const shortened = await shortenUrl({
          host: settings.shlinkHost,
          apiKey: settings.shlinkApiKey,
          longUrl: finalUrl,
          tags: tags.length > 0 ? tags : undefined,
          domain: settings.shlinkDefaultDomain ?? null,
        });
        if (shortened) finalUrl = shortened;
      }

      replacements.set(raw, finalUrl + tail);
    } catch {
      replacements.set(raw, raw); // unparseable → keep original
    }
  }

  let out = text;
  for (const [orig, sub] of replacements) {
    if (orig === sub) continue;
    out = out.split(orig).join(sub);
  }
  return out;
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
