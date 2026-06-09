"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import {
  WS_EVENTS,
  type SessionBootstrap,
  type SessionBootstrapNotification,
} from "@legends/shared";

// Paths that don't run inside the SPA — no socket, no bootstrap.
const PUBLIC_PREFIXES = ["/login", "/register", "/auth/", "/docs/"];

function isPublic(path: string | null): boolean {
  if (!path) return false;
  for (const p of PUBLIC_PREFIXES) {
    if (path === p || path.startsWith(p)) return true;
  }
  return false;
}

interface SessionBootstrapContextValue {
  /** Most recent bootstrap snapshot. null = not yet received. */
  bootstrap: SessionBootstrap | null;
  /** Force a fresh notifications list — used after PATCH /api/user/notifications. */
  reloadNotifications: () => void;
  /** Adjust the mod-queue badge after the user clears flags from the queue UI. */
  setModFlagCount: (n: number) => void;
  /** Prepend a freshly-arrived notification. Fired from NOTIFICATION_NEW. */
  prependNotification: (n: SessionBootstrapNotification) => void;
  /** Mark all visible notifications as read locally (mirrors the panel-open PATCH). */
  markNotificationsRead: () => void;
  /** Shared session-scoped socket so non-topic listeners (mod queue, symbols
   *  refresh, notification stream) can subscribe without each opening a new
   *  websocket. */
  socket: Socket | null;
}

const SessionBootstrapContext = createContext<SessionBootstrapContextValue>({
  bootstrap: null,
  reloadNotifications: () => undefined,
  setModFlagCount: () => undefined,
  prependNotification: () => undefined,
  markNotificationsRead: () => undefined,
  socket: null,
});

export function SessionBootstrapProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [bootstrap, setBootstrap] = useState<SessionBootstrap | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // Skip socket setup on public surfaces (login/register/docs) — no JWT
  // cookie there, the handshake would just fail.
  const skip = isPublic(pathname);

  useEffect(() => {
    if (skip) return;
    if (typeof window === "undefined") return;
    const s = io(window.location.origin, {
      withCredentials: true,
      transports: ["polling", "websocket"],
    });
    socketRef.current = s;
    setSocket(s);

    s.on(WS_EVENTS.SESSION_BOOTSTRAP, (payload: SessionBootstrap) => {
      setBootstrap(payload);
    });

    // Mod-queue badge updates can arrive at any time — propagate into the
    // bootstrap snapshot so any consumer (sidebar, home header) sees it.
    s.on(WS_EVENTS.MOD_FLAG_COUNT, (payload: { count: number }) => {
      setBootstrap((prev) => (prev ? { ...prev, modFlagCount: payload.count } : prev));
    });

    // Symbols-table edits broadcast a refresh signal — re-emit the
    // bootstrap event so admin edits land without a page reload.
    s.on(WS_EVENTS.SYMBOLS_UPDATE, () => {
      // Server will follow with a fresh bootstrap on its next push if the
      // admin tools route through it; for now we fall back to refetching
      // the REST endpoint to stay correct without coupling.
      void reloadSymbolsFromRest(setBootstrap);
    });

    s.on(WS_EVENTS.NOTIFICATION_NEW, (notif: SessionBootstrapNotification) => {
      setBootstrap((prev) => {
        if (!prev) return prev;
        const items = [notif, ...prev.notifications.items].slice(0, 50);
        return {
          ...prev,
          notifications: { items, unread: prev.notifications.unread + 1 },
        };
      });
    });

    return () => {
      socketRef.current = null;
      setSocket(null);
      s.disconnect();
    };
  }, [skip]);

  const reloadNotifications = useCallback(() => {
    void fetch("/api/user/notifications", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items: SessionBootstrapNotification[]; unread: number } | null) => {
        if (!d) return;
        setBootstrap((prev) =>
          prev ? { ...prev, notifications: { items: d.items, unread: d.unread } } : prev,
        );
      });
  }, []);

  const setModFlagCount = useCallback((n: number) => {
    setBootstrap((prev) => (prev ? { ...prev, modFlagCount: n } : prev));
  }, []);

  const prependNotification = useCallback((n: SessionBootstrapNotification) => {
    setBootstrap((prev) => {
      if (!prev) return prev;
      const items = [n, ...prev.notifications.items].slice(0, 50);
      return {
        ...prev,
        notifications: { items, unread: prev.notifications.unread + 1 },
      };
    });
  }, []);

  const markNotificationsRead = useCallback(() => {
    setBootstrap((prev) => {
      if (!prev) return prev;
      const now = new Date().toISOString();
      return {
        ...prev,
        notifications: {
          items: prev.notifications.items.map((n) => ({ ...n, readAt: n.readAt ?? now })),
          unread: 0,
        },
      };
    });
  }, []);

  return (
    <SessionBootstrapContext.Provider
      value={{
        bootstrap,
        reloadNotifications,
        setModFlagCount,
        prependNotification,
        markNotificationsRead,
        socket,
      }}
    >
      {children}
    </SessionBootstrapContext.Provider>
  );
}

export function useSessionBootstrap() {
  return useContext(SessionBootstrapContext);
}

// REST-side refresh used when a SYMBOLS_UPDATE signal arrives — the live
// event doesn't carry the new rows, just a "you should refresh" pulse, so
// we round-trip to /api/symbols to fold the latest set into the bootstrap.
async function reloadSymbolsFromRest(
  set: React.Dispatch<React.SetStateAction<SessionBootstrap | null>>,
) {
  try {
    const r = await fetch("/api/symbols", { credentials: "include" });
    if (!r.ok) return;
    const symbols = (await r.json()) as SessionBootstrap["symbols"];
    set((prev) => (prev ? { ...prev, symbols } : prev));
  } catch {
    // Swallow — next bootstrap on reconnect will heal.
  }
}
