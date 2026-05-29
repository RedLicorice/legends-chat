"use client";
import { useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { WS_EVENTS } from "@legends/shared";

// Shape of the DM_NEW event payload emitted by apps/ws (Task 8).
export type DmIncoming = {
  id: string;
  conversationId: string;
  senderId: string;
  senderType: string;
  text: string;
  createdAt: string;
};

/**
 * Subscribes to DM_NEW ws events.
 *
 * TopicView creates its socket inline — no shared singleton exists — so this
 * hook opens its own connection. Connection options mirror TopicView exactly:
 *   url:            window.location.origin  (same origin as the ws server)
 *   withCredentials: true
 *   transports:     ["polling", "websocket"]
 * The ws server joins every authenticated connection to its `user:<id>` room
 * on connect, so DM_NEW emits published to that room arrive here automatically.
 *
 * The socket is created once (stable — does not reconnect on activeId changes).
 * onMessage is captured in a ref so the latest callback always fires without
 * being listed as an effect dependency.
 */
export function useDmSocket(onMessage: (m: DmIncoming) => void) {
  const handlerRef = useRef(onMessage);
  useEffect(() => { handlerRef.current = onMessage; });
  useEffect(() => {
    const socket = io(window.location.origin, { withCredentials: true, transports: ["polling", "websocket"] });
    const handler = (m: DmIncoming) => handlerRef.current(m);
    socket.on(WS_EVENTS.DM_NEW, handler);
    return () => { socket.off(WS_EVENTS.DM_NEW, handler); socket.disconnect(); };
  }, []);
}
