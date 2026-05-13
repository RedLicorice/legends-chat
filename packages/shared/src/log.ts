/**
 * Tiny structured logger shared across apps. Use createLogger(category) at
 * module scope, then call .debug/.info/.warn/.error.
 *
 * Output format: `<ISO-timestamp> <LEVEL> [<category>] <message…>`
 *
 * Level filtering: LOG_LEVEL env var (debug|info|warn|error), default "info".
 * Errors and warns go to stderr; info/debug go to stdout.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function envLevel(): number {
  const raw = (typeof process !== "undefined" ? process.env.LOG_LEVEL : undefined) as
    | LogLevel
    | undefined;
  return LEVELS[raw ?? "info"] ?? 20;
}

const MIN = envLevel();

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  child: (subCategory: string) => Logger;
}

export function createLogger(category: string): Logger {
  function emit(level: LogLevel, args: unknown[]): void {
    if (LEVELS[level] < MIN) return;
    const ts = new Date().toISOString();
    const prefix = `${ts} ${level.toUpperCase().padEnd(5)} [${category}]`;
    const stream = level === "error" || level === "warn" ? console.error : console.log;
    stream(prefix, ...args);
  }
  return {
    debug: (...args) => emit("debug", args),
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
    child: (sub) => createLogger(`${category}:${sub}`),
  };
}
