/**
 * Unified structured logger shared across every app (web / ws / bot / sdk).
 *
 *   const log = createLogger("webhook");
 *   log.info("delivered", { botId, topicId, ms });
 *   log.error("delivery failed", err);                 // Error → structured
 *   log.error("delivery failed", { botId, err });      // Error inside fields too
 *   const scoped = log.child("callback", { botId });   // bound category + fields
 *
 * Output:
 *   LOG_FORMAT=json  (default in production) → one JSON object per line:
 *     {"ts":"…","level":"info","category":"webhook","msg":"delivered","botId":"…","ms":12}
 *   LOG_FORMAT=pretty (default otherwise)    → human line:
 *     2026-07-15T… INFO  [webhook] delivered {"botId":"…","ms":12}
 *
 * Level gate: LOG_LEVEL=debug|info|warn|error (default "info").
 * error/warn → stderr; info/debug → stdout.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

const MIN = LEVELS[(env("LOG_LEVEL") as LogLevel) ?? "info"] ?? LEVELS.info;
const FORMAT = env("LOG_FORMAT") ?? (env("NODE_ENV") === "production" ? "json" : "pretty");

type Fields = Record<string, unknown>;
/** Second arg to a log call: a field bag, an Error (→ {err}), or any caught
 * value (→ {err} for Errors, {detail} otherwise). `unknown` keeps
 * `catch (e: unknown)` / `reason: unknown` callers ergonomic. */
export type LogArg = unknown;

function serializeError(e: Error): Fields {
  return { name: e.name, message: e.message, stack: e.stack };
}

// Normalize the caller's second arg into a flat field bag, serializing Error
// values (top-level Error → `err`, nested Errors in place). Non-object values
// (a caught string/number/etc.) go under `detail`.
function normalize(arg: LogArg): Fields {
  if (arg === undefined || arg === null) return {};
  if (arg instanceof Error) return { err: serializeError(arg) };
  if (typeof arg !== "object") return { detail: arg };
  const out: Fields = {};
  for (const [k, v] of Object.entries(arg as Fields)) {
    out[k] = v instanceof Error ? serializeError(v) : v;
  }
  return out;
}

export interface Logger {
  debug: (msg: string, fields?: LogArg) => void;
  info: (msg: string, fields?: LogArg) => void;
  warn: (msg: string, fields?: LogArg) => void;
  error: (msg: string, fields?: LogArg) => void;
  /** Derive a scoped logger: appends to the category and/or binds fields. */
  child: (subCategory: string, boundFields?: Fields) => Logger;
}

function make(category: string, bound: Fields): Logger {
  function emit(level: LogLevel, msg: string, arg: LogArg): void {
    if (LEVELS[level] < MIN) return;
    const ts = new Date().toISOString();
    const fields = { ...bound, ...normalize(arg) };
    const stream = level === "error" || level === "warn" ? console.error : console.log;
    if (FORMAT === "json") {
      stream(JSON.stringify({ ts, level, category, msg, ...fields }));
    } else {
      const tail = Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
      stream(`${ts} ${level.toUpperCase().padEnd(5)} [${category}] ${msg}${tail}`);
    }
  }
  return {
    debug: (msg, f) => emit("debug", msg, f),
    info: (msg, f) => emit("info", msg, f),
    warn: (msg, f) => emit("warn", msg, f),
    error: (msg, f) => emit("error", msg, f),
    child: (sub, boundFields) => make(`${category}:${sub}`, { ...bound, ...(boundFields ?? {}) }),
  };
}

export function createLogger(category: string): Logger {
  return make(category, {});
}
