"use client";

import React from "react";

// Opt-out: set localStorage "lc-error-reporting" = "off" to disable sending.
// Default is on. Kept as a single flag rather than a settings UI for now.
function reportingEnabled(): boolean {
  try {
    return window.localStorage.getItem("lc-error-reporting") !== "off";
  } catch {
    return true;
  }
}

function send(payload: {
  kind: string;
  message: string;
  stack?: string;
  componentStack?: string;
}): void {
  if (!reportingEnabled()) return;
  if (globalReportCount >= GLOBAL_REPORT_CEILING) return;
  globalReportCount++;
  try {
    const body = JSON.stringify({ ...payload, url: location.href });
    // keepalive so a report still flushes if the error is mid-navigation.
    fetch("/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* serialising / network failed — nothing we can do */
  }
}

let globalsInstalled = false;
// Hard global ceiling: stops ALL send() after this many reports per page session
// so a tight error loop can't flood /api/client-error.
// ponytail: module-level counter; resets only on page reload (intentional).
let globalReportCount = 0;
const GLOBAL_REPORT_CEILING = 50;
// Dedupe so a render loop (which logs the same console.error thousands of times)
// doesn't hammer the sink — report each distinct message at most a few times.
const consoleReportCounts = new Map<string, number>();
const CONSOLE_REPORT_CAP = 3;
// Shared dedupe map for window.error + unhandledrejection handlers (same cap).
const windowReportCounts = new Map<string, number>();
// React logs these via console.error WITHOUT throwing, so the error boundary and
// window.onerror never see them. We still want them captured.
const CONSOLE_CAPTURE = /maximum update depth|too many re-?renders|update depth exceeded/i;

function installGlobalHandlers(): void {
  if (globalsInstalled) return;
  globalsInstalled = true;
  window.addEventListener("error", (e) => {
    const msg = e.message || String(e.error ?? "error");
    const key = msg.slice(0, 80);
    const n = windowReportCounts.get(key) ?? 0;
    if (n >= CONSOLE_REPORT_CAP) return;
    windowReportCounts.set(key, n + 1);
    send({
      kind: "window.error",
      message: msg,
      stack: e.error?.stack,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    const msg = typeof r === "string" ? r : r?.message || "unhandled rejection";
    const key = msg.slice(0, 80);
    const n = windowReportCounts.get(key) ?? 0;
    if (n >= CONSOLE_REPORT_CAP) return;
    windowReportCounts.set(key, n + 1);
    send({
      kind: "unhandledrejection",
      message: msg,
      stack: r?.stack,
    });
  });

  // Wrap console.error to catch React's non-throwing error logs (e.g. "Maximum
  // update depth exceeded"). React passes the component stack as a trailing arg,
  // so we forward the whole formatted message.
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    orig(...args);
    try {
      const text = args
        .map((a) =>
          a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : String(a),
        )
        .join(" ");
      if (!CONSOLE_CAPTURE.test(text)) return;
      const key = text.slice(0, 80);
      const n = consoleReportCounts.get(key) ?? 0;
      if (n >= CONSOLE_REPORT_CAP) return;
      consoleReportCounts.set(key, n + 1);
      // React logs this without a component stack, and iOS Chrome has no
      // DevTools. Capture the JS call stack at the log site: a setState-in-
      // useEffect loop flushes through the offending component's function, so
      // its name should appear in these frames.
      send({
        kind: "console.error",
        message: text.slice(0, 300),
        stack: new Error("capture-site").stack,
        componentStack: text,
      });
    } catch {
      /* never let reporting break console.error */
    }
  };
}

interface Props {
  children: React.ReactNode;
}
interface State {
  crashed: boolean;
}

/**
 * Top-level error boundary + global error sink. Catches React render failures
 * (including "Maximum update depth exceeded", which throws during render) along
 * with their component stack, and forwards uncaught window errors / promise
 * rejections to /api/client-error. Renders a minimal recover-by-reload fallback
 * instead of a blank screen when the tree crashes.
 */
export class ClientErrorReporter extends React.Component<Props, State> {
  state: State = { crashed: false };

  componentDidMount(): void {
    installGlobalHandlers();
  }

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    send({
      kind: "react.render",
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  render(): React.ReactNode {
    if (this.state.crashed) {
      return (
        <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-text">
          <h1 className="text-lg font-semibold">Something broke</h1>
          <p className="max-w-sm text-sm text-muted">
            The app hit an unexpected error and stopped to avoid making it worse.
            Reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
