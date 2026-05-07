"use client";
import { apiFetch } from "@/lib/fetch";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { BarChart2, Check, CheckSquare, Copy, CornerDownLeft, FileText, Flag, ImagePlus, Lock, Menu, MessageSquareText, Pencil, PanelLeftOpen, Paperclip, Search, Send, SmilePlus, Square, Sticker, Trash2, Users, X } from "lucide-react";
import { MarkdownContent } from "@/components/MarkdownContent";
import { RichTextEditor, type RichTextEditorHandle } from "@/components/RichTextEditor";
import { io, type Socket } from "socket.io-client";
import { WS_EVENTS, PERMISSIONS } from "@legends/shared";
import { cn } from "@/lib/cn";
import { GifPicker } from "@/components/GifPicker";
import { EmojiPickerPopover } from "@/components/EmojiPickerPopover";
import { PollCreator } from "@/components/PollCreator";
import { PollMessage } from "@/components/PollMessage";
import { UserViewModal } from "@/components/UserViewModal";
import { SearchModal } from "@/components/SearchModal";
import { ThreadPanel } from "@/components/ThreadPanel";
import { E2EESetup } from "@/components/E2EESetup";
import { ImageLightbox } from "@/components/ImageLightbox";
import { TopicInfoModal } from "@/components/TopicInfoModal";
import type {
  E2EEPayload,
} from "@/lib/e2ee";

interface Attachment {
  type: "image" | "gif" | "file";
  url: string;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

interface PollOption {
  id: string;
  text: string;
  position: number;
  voteCount: number;
}

interface PollData {
  id: string;
  question: string;
  options: PollOption[];
  isAnonymous: boolean;
  allowsMultiple: boolean;
  isClosed: boolean;
  totalVotes: number;
}

interface InlineKeyboardButton { text: string; callbackData: string }

interface Message {
  id: string;
  topicId: string;
  senderUserId: string | null;
  senderDisplayName: string | null;
  senderAvatarUrl: string | null;
  senderIsAnon: boolean;
  senderRole: string | null;
  botId: string | null;
  replyToMessageId: string | null;
  text: string;
  attachments: Attachment[];
  inlineKeyboard?: InlineKeyboardButton[][] | null;
  createdAt: string | Date;
  editedAt: string | Date | null;
  poll?: PollData;
}

interface ReactionRow {
  messageId: string;
  userId: string;
  emojiKey: string;
}

// Legacy map for reactions stored with named keys before emoji-mart migration.
const EMOJI_GLYPH: Record<string, string> = {
  thumbs_up: "👍", heart: "❤️", joy: "😂", fire: "🔥",
  tada: "🎉", wow: "😮", cry: "😢", thumbs_down: "👎",
};

interface Member {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  isAnon: boolean;
  joinedAt: string;
}

interface SidebarTopicUpdate {
  topicId: string;
  preview: string;
  senderName: string | null;
  at: string;
}

interface TopicViewProps {
  topic: { id: string; slug: string; title: string; isE2ee: boolean; isFeed: boolean; postRoles: string[]; iconUrl?: string | null; bannerUrl?: string | null; description?: string | null };
  currentUser: { id: string; displayName: string; avatarUrl: string | null; role: string; presenceOptOut: boolean; permissions: string[] };
  mute: { reason: string; expiresAt: string | null } | null;
  giphyEnabled?: boolean;
  highlightMessageId?: string;
  onMenuOpen?: () => void;
  onConnectionChange?: (connected: boolean) => void;
  showExpandSidebar?: boolean;
  onExpandSidebar?: () => void;
  onSidebarUpdate?: (update: SidebarTopicUpdate) => void;
}

function friendlyTime(date: Date | string): string {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: "short" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Avatar({ name, url, size = 8, online }: { name: string | null; url: string | null; size?: number; online?: boolean }) {
  const cls = `h-${size} w-${size} shrink-0 overflow-hidden rounded-full bg-accent2`;
  return (
    <div className="relative shrink-0">
      {url ? (
        <div className={cls}><img src={url} alt="" className="h-full w-full object-cover" /></div>
      ) : (
        <div className={cn(cls, "flex items-center justify-center text-xs font-semibold text-white")}>
          {(name ?? "?").slice(0, 1).toUpperCase()}
        </div>
      )}
      {online && (
        <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-panel bg-green-500" />
      )}
    </div>
  );
}

export function TopicView({ topic, currentUser, mute, giphyEnabled, highlightMessageId, onMenuOpen, onConnectionChange, showExpandSidebar, onExpandSidebar, onSidebarUpdate }: TopicViewProps) {
  const draftKey = `legends-draft-${topic.id}`;

  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<ReactionRow[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showComposeEmoji, setShowComposeEmoji] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersSearch, setMembersSearch] = useState("");
  const [membersLoading, setMembersLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [myPollVotes, setMyPollVotes] = useState<Record<string, string[]>>({});
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [viewingUserId, setViewingUserId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [threadFor, setThreadFor] = useState<Message | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [e2eeSetupNeeded, setE2eeSetupNeeded] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [showTopicInfo, setShowTopicInfo] = useState(false);
  const [e2eeReady, setE2eeReady] = useState(!topic.isE2ee);
  const [e2eeBackup, setE2eeBackup] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const senderKeyCache = useRef<Map<string, Uint8Array<ArrayBuffer>>>(new Map());
  const e2eeKeyPairRef = useRef<CryptoKeyPair | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const fileUploadRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<RichTextEditorHandle | null>(null);
  const composeEmojiRef = useRef<HTMLButtonElement | null>(null);
  const reactionBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const hasScrolledToMsgRef = useRef(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [enterSends, setEnterSends] = useState<boolean>(() => {
    if (typeof window === "undefined") return !topic.isFeed;
    const saved = localStorage.getItem("legends-enter-sends");
    return saved !== null ? saved === "true" : !topic.isFeed;
  });
  const [contextMenu, setContextMenu] = useState<{ msg: Message; kbOffset: number } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressMoved = useRef(false);
  const isSelecting = selectedIds.size > 0;

  const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "🎉", "😮"];

  const canCreatePoll = currentUser.role !== "user";
  const canPost = topic.postRoles.length === 0 || topic.postRoles.includes(currentUser.role);
  const canAttach = currentUser.permissions.includes(PERMISSIONS.CONTENT_ATTACHMENT);
  const canUploadGif = currentUser.permissions.includes(PERMISSIONS.CONTENT_GIF_UPLOAD);
  const canDeleteOwn = currentUser.permissions.includes(PERMISSIONS.MESSAGES_DELETE_OWN);
  const canDeleteAny = currentUser.permissions.includes(PERMISSIONS.MESSAGES_DELETE_ANY);
  const canEditOwn = currentUser.permissions.includes(PERMISSIONS.MESSAGES_EDIT_OWN);
  const canEditAny = currentUser.permissions.includes(PERMISSIONS.MESSAGES_EDIT_ANY);

  // Context menu helpers
  function openContextMenu(msg: Message, _clientX: number, _clientY: number) {
    const kbOffset = Math.max(0, window.innerHeight - (window.visualViewport?.height ?? window.innerHeight));
    setContextMenu({ msg, kbOffset });
  }

  function handleMsgContextMenu(e: React.MouseEvent, msg: Message) {
    e.preventDefault();
    openContextMenu(msg, e.clientX, e.clientY);
  }

  function handleTouchStart(e: React.TouchEvent, msg: Message) {
    const t = e.touches[0];
    const tx = t?.clientX ?? 0;
    const ty = t?.clientY ?? 0;
    longPressMoved.current = false;
    longPressTimer.current = setTimeout(() => {
      if (!longPressMoved.current) {
        openContextMenu(msg, tx, ty);
      }
    }, 500);
  }

  function handleTouchMove() {
    longPressMoved.current = true;
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }

  function handleTouchEnd() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }

  function toggleSelection(msgId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId); else next.add(msgId);
      return next;
    });
  }

  function handleMsgClick(msg: Message) {
    if (isSelecting) { toggleSelection(msg.id); return; }
  }

  function deleteSelected() {
    for (const id of selectedIds) {
      socketRef.current?.emit(WS_EVENTS.MESSAGE_DELETE_REQ, { messageId: id, topicId: topic.id });
    }
    setSelectedIds(new Set());
  }

  async function reportSelected() {
    const reason = window.prompt(`Report ${selectedIds.size} message(s). Reason?`)?.trim();
    if (!reason || reason.length < 3) return;
    await Promise.allSettled(
      Array.from(selectedIds).map((id) =>
        apiFetch("/api/messages/flag", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId: id, reason }),
        }),
      ),
    );
    setSelectedIds(new Set());
  }

  useEffect(() => {
    const saved = localStorage.getItem(draftKey);
    if (saved) setDraft(saved);
  }, [draftKey]);

  useEffect(() => { localStorage.setItem(draftKey, draft); }, [draft, draftKey]);
  useEffect(() => { localStorage.setItem("legends-enter-sends", String(enterSends)); }, [enterSends]);

  // E2EE initialization
  useEffect(() => {
    if (!topic.isE2ee) return;
    void (async () => {
      try {
        const { getOrCreateIdentityKeyPair, exportPublicKey } = await import("@/lib/e2ee");
        const res = await apiFetch("/api/user/keys");
        const data = await res.json() as { registered: boolean; identityPublicKey?: string; backup?: string | null };
        if (!data.registered) { setE2eeSetupNeeded(true); return; }
        const kp = await getOrCreateIdentityKeyPair();
        e2eeKeyPairRef.current = kp;
        const localPub = await exportPublicKey(kp.publicKey);
        if (localPub !== data.identityPublicKey) {
          setE2eeBackup(data.backup ?? null);
          setE2eeSetupNeeded(true);
          return;
        }
        setE2eeReady(true);
      } catch {
        setE2eeReady(false);
      }
    })();
  }, [topic.isE2ee]);

  // Close context menu on outside click / Escape
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : true) setContextMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [contextMenu]);

  // Ctrl+K for search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); setShowSearch(true); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const wsUrl = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    let active = true;
    const socket = io(wsUrl, { withCredentials: true, transports: ["polling", "websocket"] });
    socketRef.current = socket;
    setSocket(socket);

    socket.on("connect", () => {
      if (!active) return;
      setConnected(true);
      onConnectionChange?.(true);
      socket.emit(
        WS_EVENTS.TOPIC_JOIN,
        topic.id,
        (res: { ok: boolean; messages?: Message[]; reactions?: ReactionRow[]; onlineUserIds?: string[]; myPollVotes?: Record<string, string[]>; error?: string }) => {
          if (!active) return;
          if (res.ok) {
            if (res.messages) setMessages(res.messages);
            if (res.reactions) setReactions(res.reactions);
            if (res.onlineUserIds && !currentUser.presenceOptOut) setOnlineUsers(new Set(res.onlineUserIds));
            if (res.myPollVotes) setMyPollVotes(res.myPollVotes);
          }
        },
      );
    });
    socket.on("disconnect", () => { if (active) { setConnected(false); onConnectionChange?.(false); } });
    socket.on(WS_EVENTS.MESSAGE_NEW, (msg: Message) => {
      if (!active || msg.topicId !== topic.id) return;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    });
    socket.on(WS_EVENTS.POLL_UPDATED, (d: { pollId: string; options: PollOption[]; totalVotes: number; isClosed: boolean }) => {
      if (!active) return;
      setMessages((prev) => prev.map((m) =>
        m.poll?.id === d.pollId
          ? { ...m, poll: { ...m.poll, options: d.options, totalVotes: d.totalVotes, isClosed: d.isClosed } }
          : m,
      ));
    });
    socket.on(WS_EVENTS.REACTION_ADD, (r: ReactionRow) => {
      if (!active) return;
      setReactions((prev) =>
        prev.some((x) => x.messageId === r.messageId && x.userId === r.userId && x.emojiKey === r.emojiKey)
          ? prev
          : [...prev, r],
      );
    });
    socket.on(WS_EVENTS.REACTION_REMOVE, (r: ReactionRow) => {
      if (!active) return;
      setReactions((prev) =>
        prev.filter((x) => !(x.messageId === r.messageId && x.userId === r.userId && x.emojiKey === r.emojiKey)),
      );
    });
    socket.on(WS_EVENTS.MESSAGE_EDIT, (updated: Message) => {
      if (!active || updated.topicId !== topic.id) return;
      setMessages((prev) => prev.map((m) => m.id === updated.id ? { ...m, text: updated.text, editedAt: updated.editedAt, attachments: updated.attachments } : m));
    });
    socket.on(WS_EVENTS.MESSAGE_DELETE, (d: { id: string; topicId: string }) => {
      if (!active || d.topicId !== topic.id) return;
      setMessages((prev) => prev.filter((m) => m.id !== d.id));
      setReactions((prev) => prev.filter((r) => r.messageId !== d.id));
    });
    socket.on(WS_EVENTS.PRESENCE_UPDATE, (d: { userId: string; online: boolean }) => {
      if (!active || currentUser.presenceOptOut) return;
      setOnlineUsers((prev) => {
        const next = new Set(prev);
        if (d.online) next.add(d.userId); else next.delete(d.userId);
        return next;
      });
    });
    socket.on(WS_EVENTS.SIDEBAR_UPDATE, (update: SidebarTopicUpdate) => {
      if (!active) return;
      onSidebarUpdate?.(update);
    });

    return () => {
      active = false;
      setSocket(null);
      socket.emit(WS_EVENTS.TOPIC_LEAVE, topic.id);
      socket.disconnect();
    };
  }, [topic.id, wsUrl]);

  // Scroll to bottom when keyboard opens/closes so latest messages stay visible
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    function onVVResize() {
      const el = scrollerRef.current;
      if (!el) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distFromBottom < 150) {
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
      }
    }
    vv.addEventListener('resize', onVVResize);
    return () => vv.removeEventListener('resize', onVVResize);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    if (highlightMessageId && !hasScrolledToMsgRef.current && messages.length > 0) {
      const target = el.querySelector<HTMLElement>(`[data-msg-id="${highlightMessageId}"]`);
      if (target) {
        hasScrolledToMsgRef.current = true;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightedId(highlightMessageId);
        setTimeout(() => setHighlightedId(null), 2500);
        if (last) socketRef.current?.emit(WS_EVENTS.TOPIC_READ, { topicId: topic.id, lastReadMessageId: last.id });
        return;
      }
    }
    el.scrollTop = el.scrollHeight;
    if (last) socketRef.current?.emit(WS_EVENTS.TOPIC_READ, { topicId: topic.id, lastReadMessageId: last.id });
  }, [messages, topic.id, highlightMessageId]);

  // Load members eagerly for mention autocomplete (also drives the members panel)
  useEffect(() => {
    setMembersLoading(true);
    apiFetch(`/api/topics/${topic.id}/members`)
      .then((r) => r.json())
      .then((data) => setMembers(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setMembersLoading(false));
  }, [topic.id]);

  const toggleReaction = useCallback((messageId: string, emojiKey: string) => {
    socketRef.current?.emit(WS_EVENTS.REACTION_TOGGLE, { messageId, emojiKey });
    setPickerFor(null);
  }, []);

  const handleKeyboardCallback = useCallback((msg: Message, callbackData: string) => {
    if (!msg.botId) return;
    socketRef.current?.emit(WS_EVENTS.BOT_KEYBOARD_CALLBACK, {
      botId: msg.botId,
      messageId: msg.id,
      callbackData,
    });
  }, []);

  const submitPoll = useCallback((data: { question: string; options: string[]; isAnonymous: boolean; allowsMultiple: boolean }) => {
    socketRef.current?.emit(WS_EVENTS.POLL_CREATE, { topicId: topic.id, ...data });
  }, [topic.id]);

  const votePoll = useCallback((pollId: string, optionIds: string[]) => {
    socketRef.current?.emit(WS_EVENTS.POLL_VOTE, { pollId, optionIds }, (res: { ok: boolean; myVotes: string[] }) => {
      if (res.ok) setMyPollVotes((prev) => ({ ...prev, [pollId]: res.myVotes }));
    });
  }, []);

  const closePoll = useCallback((pollId: string) => {
    socketRef.current?.emit(WS_EVENTS.POLL_CLOSE, { pollId });
  }, []);

  const reportMessage = useCallback(async (messageId: string) => {
    const reason = window.prompt("Why are you reporting this message?")?.trim();
    if (!reason || reason.length < 3) return;
    const res = await apiFetch("/api/messages/flag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId, reason }),
    });
    window.alert(res.ok ? "Reported. A moderator will review." : "Failed to report.");
  }, []);

  const copyMessage = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
  }, []);

  const deleteMessage = useCallback((messageId: string) => {
    socketRef.current?.emit(WS_EVENTS.MESSAGE_DELETE_REQ, { messageId, topicId: topic.id });
  }, [topic.id]);

  const startEdit = useCallback((m: Message, displayText: string) => {
    setEditingId(m.id);
    setEditText(displayText);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditText("");
  }, []);

  const submitEdit = useCallback(async (messageId: string) => {
    const text = editText.trim();
    if (!text) return;

    let finalText = text;
    if (topic.isE2ee && e2eeReady && e2eeKeyPairRef.current) {
      try {
        const { encryptE2EEMessage, getSenderKey } = await import("@/lib/e2ee");
        const mySenderKey = await getSenderKey(topic.id, currentUser.id);
        if (mySenderKey) {
          finalText = await encryptE2EEMessage(text, currentUser.id, mySenderKey);
        }
      } catch (err) {
        console.error("[e2ee] edit encrypt failed", err);
        return;
      }
    }

    socketRef.current?.emit(
      WS_EVENTS.MESSAGE_EDIT_REQ,
      { messageId, topicId: topic.id, text: finalText },
      (res: { ok: boolean; error?: string }) => {
        if (res.ok) { setEditingId(null); setEditText(""); }
        else console.warn("edit failed", res.error);
      },
    );
  }, [editText, topic.id, topic.isE2ee, e2eeReady, currentUser.id]);

  const replyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of messages) {
      if (m.replyToMessageId) {
        counts.set(m.replyToMessageId, (counts.get(m.replyToMessageId) ?? 0) + 1);
      }
    }
    return counts;
  }, [messages]);

  const reactionsByMessage = useMemo(() => {
    const map = new Map<string, Map<string, string[]>>();
    for (const r of reactions) {
      let perEmoji = map.get(r.messageId);
      if (!perEmoji) { perEmoji = new Map(); map.set(r.messageId, perEmoji); }
      const users = perEmoji.get(r.emojiKey) ?? [];
      users.push(r.userId);
      perEmoji.set(r.emojiKey, users);
    }
    return map;
  }, [reactions]);

  // Async decrypt map — populated when keys load
  const [decryptedTexts, setDecryptedTexts] = useState<Map<string, string>>(new Map());

  // Load sender keys then decrypt all E2EE messages in one pass
  useEffect(() => {
    if (!topic.isE2ee || !e2eeReady || !e2eeKeyPairRef.current) return;
    void (async () => {
      try {
        const {
          decryptSenderKey,
          decryptE2EEMessage,
          importPublicKey,
          getSenderKey,
          storeSenderKey,
        } = await import("@/lib/e2ee");

        // 1. Collect senders that need key loading
        const e2eeMsgs = messages.filter((m) => {
          if (!m.text.startsWith("{")) return false;
          try { const p = JSON.parse(m.text) as { e?: number }; return p.e === 1; } catch { return false; }
        });
        const senderIds = [...new Set(e2eeMsgs.map((m) => m.senderUserId).filter(Boolean) as string[])];
        const missing = senderIds.filter((id) => !senderKeyCache.current.has(id));

        for (const sid of missing) {
          const local = await getSenderKey(topic.id, sid);
          if (local) { senderKeyCache.current.set(sid, local as Uint8Array<ArrayBuffer>); continue; }
          const res = await apiFetch(`/api/topics/${topic.id}/e2ee?distributorId=${sid}`);
          if (!res.ok) continue;
          const dist = await res.json() as { encryptedKey: string; distributorPublicKey: string | null };
          if (!dist.distributorPublicKey) continue;
          const distPubKey = await importPublicKey(dist.distributorPublicKey);
          const sk = await decryptSenderKey(dist.encryptedKey, e2eeKeyPairRef.current!.privateKey, distPubKey);
          await storeSenderKey(topic.id, sid, sk);
          senderKeyCache.current.set(sid, sk);
        }

        // 2. Decrypt all messages that now have keys
        const updates = new Map<string, string>();
        for (const m of e2eeMsgs) {
          if (decryptedTexts.has(m.id)) continue;
          try {
            const payload = JSON.parse(m.text) as E2EEPayload;
            const senderKey = senderKeyCache.current.get(payload.kid);
            if (!senderKey) continue;
            const plain = await decryptE2EEMessage(m.text, senderKey);
            updates.set(m.id, plain);
          } catch {
            updates.set(m.id, "(decryption failed)");
          }
        }
        if (updates.size > 0) {
          setDecryptedTexts((prev) => {
            const next = new Map(prev);
            for (const [k, v] of updates) next.set(k, v);
            return next;
          });
        }
      } catch {
        // silent
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.isE2ee, topic.id, e2eeReady, messages]);

  function getDisplayText(msg: Message): string {
    if (!topic.isE2ee) return msg.text;
    return decryptedTexts.get(msg.id) ?? "(encrypted…)";
  }

  async function uploadFile(file: File, bucket: "uploads" | "files" = "uploads"): Promise<Attachment | null> {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("bucket", bucket);
      const res = await apiFetch("/api/upload", { method: "POST", body: form });
      const data = await res.json() as { url?: string; filename?: string; mimeType?: string; size?: number; error?: string };
      if (!res.ok || !data.url) return null;
      if (bucket === "files") {
        return { type: "file", url: data.url, filename: data.filename, mimeType: data.mimeType, size: data.size };
      }
      return { type: "image", url: data.url };
    } finally {
      setUploading(false);
    }
  }

  function addGif(gif: { url: string; thumbnailUrl: string; width?: number; height?: number }) {
    setPendingAttachments((prev) => [
      ...prev,
      {
        type: "gif",
        url: gif.url,
        thumbnailUrl: gif.thumbnailUrl,
        ...(gif.width && gif.height ? { width: gif.width, height: gif.height } : {}),
      },
    ]);
    setShowGifPicker(false);
  }

  function removePendingAttachment(i: number) {
    setPendingAttachments((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    const att = await uploadFile(file);
    if (att) setPendingAttachments((prev) => [...prev, att]);
  }

  async function send() {
    const text = draft.trim();
    if ((!text && pendingAttachments.length === 0) || mute) return;

    let finalText = text;
    if (topic.isE2ee && e2eeReady && e2eeKeyPairRef.current) {
      try {
        const {
          generateSenderKey,
          getSenderKey,
          storeSenderKey,
          encryptE2EEMessage,
          importPublicKey,
          encryptSenderKeyForRecipient,
        } = await import("@/lib/e2ee");

        // Fetch current members + already-distributed list
        const distRes = await apiFetch(`/api/topics/${topic.id}/e2ee/distribute`);
        const distData = distRes.ok
          ? await distRes.json() as { members: { userId: string; identityPublicKey: string }[]; alreadyDistributed: string[] }
          : { members: [], alreadyDistributed: [] };

        const memberIds = new Set(distData.members.map((m) => m.userId));
        const distributed = new Set(distData.alreadyDistributed);
        // Need new distribution if any member (who has a key) hasn't received ours yet
        const needsRotation = distData.members.some((m) => !distributed.has(m.userId));

        const existingSenderKey = await getSenderKey(topic.id, currentUser.id);
        let mySenderKey: Uint8Array<ArrayBuffer>;

        if (!existingSenderKey || needsRotation) {
          // Generate fresh sender key (covers both first-send and rotation)
          mySenderKey = generateSenderKey();
          await storeSenderKey(topic.id, currentUser.id, mySenderKey);
          senderKeyCache.current.set(currentUser.id, mySenderKey);

          const distributions: { recipientUserId: string; encryptedKey: string }[] = [];
          for (const m of distData.members) {
            try {
              const recipPubKey = await importPublicKey(m.identityPublicKey);
              const encryptedKey = await encryptSenderKeyForRecipient(mySenderKey, e2eeKeyPairRef.current.privateKey, recipPubKey);
              distributions.push({ recipientUserId: m.userId, encryptedKey });
            } catch { /* skip member if key import fails */ }
          }
          // Encrypt for self if not already a member with a registered key
          if (!memberIds.has(currentUser.id)) {
            const encSelf = await encryptSenderKeyForRecipient(mySenderKey, e2eeKeyPairRef.current.privateKey, e2eeKeyPairRef.current.publicKey);
            distributions.push({ recipientUserId: currentUser.id, encryptedKey: encSelf });
          }
          if (distributions.length > 0) {
            await apiFetch(`/api/topics/${topic.id}/e2ee/distribute`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ distributions }),
            });
          }
        } else {
          mySenderKey = existingSenderKey;
        }

        finalText = await encryptE2EEMessage(text, currentUser.id, mySenderKey);
      } catch (err) {
        console.error("[e2ee] encrypt failed", err);
        return;
      }
    }

    socketRef.current?.emit(
      WS_EVENTS.MESSAGE_SEND,
      {
        topicId: topic.id,
        content: {
          text: finalText,
          attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
          replyToMessageId: replyingTo?.id,
        },
      },
      (res: { ok: boolean; error?: string }) => {
        if (!res.ok) console.warn("send failed", res.error);
      },
    );
    setDraft("");
    setPendingAttachments([]);
    setReplyingTo(null);
    localStorage.removeItem(draftKey);
  }

  const canSend = (draft.trim().length > 0 || pendingAttachments.length > 0) && !mute && !uploading && canPost;

  const filteredMembers = useMemo(() => {
    const q = membersSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.displayName.toLowerCase().includes(q));
  }, [members, membersSearch]);

  return (
    <>
      {e2eeSetupNeeded && (
        <E2EESetup
          userId={currentUser.id}
          hasPermanentAccount={!currentUser.role.includes("anon")}
          existingBackup={e2eeBackup}
          onReady={(kp) => {
            e2eeKeyPairRef.current = kp;
            setE2eeSetupNeeded(false);
            setE2eeReady(true);
          }}
          onSkip={() => { setE2eeSetupNeeded(false); }}
        />
      )}
      {showSearch && <SearchModal onClose={() => setShowSearch(false)} currentTopicId={topic.id} />}
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      {showTopicInfo && (
        <TopicInfoModal
          topic={{ title: topic.title, iconUrl: topic.iconUrl ?? null, bannerUrl: topic.bannerUrl ?? null, description: topic.description ?? null }}
          onClose={() => setShowTopicInfo(false)}
        />
      )}

      <header className="sticky top-0 z-10 flex shrink-0 items-center gap-3 border-b border-border bg-panel px-4 pb-4 pt-[calc(1rem+var(--sat))] md:px-6">
        <button
          type="button"
          onClick={onMenuOpen}
          className="shrink-0 rounded-md p-1 hover:bg-panel2 transition md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        {showExpandSidebar && (
          <button
            type="button"
            onClick={onExpandSidebar}
            className="hidden md:flex shrink-0 rounded-md p-1.5 hover:bg-panel2 transition mr-1"
            title="Expand sidebar"
          >
            <PanelLeftOpen className="h-5 w-5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowTopicInfo(true)}
          className="flex-1 text-left min-w-0"
        >
          <h1 className="text-lg font-semibold truncate hover:underline decoration-muted underline-offset-2">{topic.title}</h1>
          <p className="flex items-center gap-1.5 text-xs text-muted">
            {topic.isE2ee
              ? <Lock className="h-3 w-3 text-accent2" />
              : <span className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-yellow-500 animate-pulse"}`} />
            }
            {connected ? "connected" : "connecting…"}
          </p>
        </button>
        <button
          type="button"
          onClick={() => setShowSearch(true)}
          title="Search (Ctrl+K)"
          className="rounded-lg p-2 transition hover:bg-panel2 text-muted hover:text-text"
        >
          <Search className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => setShowUsers((v) => !v)}
          title="Members"
          className={cn("rounded-lg p-2 transition hover:bg-panel2", showUsers && "bg-panel2 text-accent")}
        >
          <Users className="h-5 w-5" />
        </button>
      </header>

      <AnimatePresence>
        {showUsers && (
          <motion.div
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            className="absolute right-0 top-[65px] z-20 flex h-[calc(100%-65px)] w-72 flex-col border-l border-border bg-panel shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-semibold">Members</span>
              <button type="button" onClick={() => setShowUsers(false)} className="text-muted hover:text-text">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-3 py-2">
              <input
                value={membersSearch}
                onChange={(e) => setMembersSearch(e.target.value)}
                placeholder="Search…"
                className="w-full rounded-lg bg-panel2 px-3 py-1.5 text-sm outline-none placeholder:text-muted"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {membersLoading ? (
                <p className="px-2 py-4 text-center text-xs text-muted">Loading…</p>
              ) : filteredMembers.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-muted">No members found.</p>
              ) : (
                filteredMembers.map((m) => (
                  <div key={m.id} className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-panel2">
                    <Avatar name={m.displayName} url={m.avatarUrl} size={8} online={onlineUsers.has(m.id)} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{m.displayName}</div>
                      <div className="text-xs text-muted">{m.role}</div>
                    </div>
                    {onlineUsers.has(m.id) && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                    )}
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-1 min-w-0 min-h-0 overflow-hidden">
      <div ref={scrollerRef} className={cn("flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 py-4", topic.isFeed ? "space-y-4" : "space-y-1")}>
        <AnimatePresence initial={false}>
          {messages.map((m, i) => {
            const mine = m.senderUserId === currentUser.id;
            const perEmoji = reactionsByMessage.get(m.id);
            const prevMsg = messages[i - 1];
            const isNewGroup =
              !prevMsg ||
              prevMsg.senderUserId !== m.senderUserId ||
              new Date(m.createdAt).getTime() - new Date(prevMsg.createdAt).getTime() > 5 * 60 * 1000;
            const showSender = !mine && isNewGroup;

            if (topic.isFeed) {
              const isSelected = selectedIds.has(m.id);
              return (
                <motion.div
                  key={m.id}
                  data-msg-id={m.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  onContextMenu={(e) => handleMsgContextMenu(e, m)}
                  onTouchStart={(e) => handleTouchStart(e, m)}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  onTouchCancel={handleTouchEnd}
                  onClick={() => handleMsgClick(m)}
                  className={cn("group relative rounded-2xl border bg-panel p-5 cursor-default select-none",
                    highlightedId === m.id ? "border-accent ring-2 ring-accent/30" : "border-border",
                    isSelected && "border-accent bg-accent/5",
                    isSelecting && "cursor-pointer")}
                >
                  {isSelecting && (
                    <div className="absolute top-3 right-3 z-10">
                      {isSelected ? <CheckSquare className="h-5 w-5 text-accent" /> : <Square className="h-5 w-5 text-muted" />}
                    </div>
                  )}
                  <div className="mb-3 flex items-center gap-3">
                    <Avatar
                      name={m.senderDisplayName}
                      url={m.senderAvatarUrl}
                      size={9}
                      online={!currentUser.presenceOptOut && !!m.senderUserId && onlineUsers.has(m.senderUserId)}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{m.senderDisplayName ?? "System"}</div>
                      <div suppressHydrationWarning className="text-xs text-muted">{friendlyTime(m.createdAt)}</div>
                    </div>
                    <div className="ml-auto flex gap-2 opacity-0 transition group-hover:opacity-100">
                      <button
                        ref={(el) => { if (el) reactionBtnRefs.current.set(m.id, el); else reactionBtnRefs.current.delete(m.id); }}
                        type="button" className="text-muted hover:text-text"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); setPickerFor(pickerFor === m.id ? null : m.id); }}>
                        <SmilePlus className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {m.attachments.length > 0 && (
                    <div className="mb-3 flex flex-col gap-2">
                      {m.attachments.map((att, ai) =>
                        att.type === "file" ? (
                          <a key={ai} href={att.url} download={att.filename} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-2 rounded-xl border border-border bg-panel2 px-3 py-2 text-sm hover:bg-panel">
                            <FileText className="h-4 w-4 shrink-0 text-muted" />
                            <span className="truncate">{att.filename ?? "Download file"}</span>
                            {att.size && <span className="ml-auto shrink-0 text-xs text-muted">{(att.size / 1024).toFixed(0)} KB</span>}
                          </a>
                        ) : (
                          <img key={ai} src={att.url} alt="" className="max-h-96 w-full rounded-xl object-contain cursor-pointer" loading="lazy" onClick={() => setLightboxSrc(att.url)} />
                        )
                      )}
                    </div>
                  )}

                  {m.text.trim() && (
                    <MarkdownContent content={getDisplayText(m)} className="text-sm" />
                  )}

                  {perEmoji && perEmoji.size > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {Array.from(perEmoji.entries()).map(([key, users]) => {
                        const reacted = users.includes(currentUser.id);
                        return (
                          <button key={key} type="button" onClick={() => toggleReaction(m.id, key)}
                            className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", reacted ? "border-accent bg-accent/20" : "border-border bg-panel2")}>
                            <span>{EMOJI_GLYPH[key] ?? key}</span>
                            <span className="text-muted">{users.length}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {pickerFor === m.id && (
                    <EmojiPickerPopover
                      anchorRef={{ current: reactionBtnRefs.current.get(m.id) ?? null }}
                      onSelect={(glyph) => toggleReaction(m.id, glyph)}
                      onClose={() => setPickerFor(null)}
                    />
                  )}
                </motion.div>
              );
            }

            const isSelected = selectedIds.has(m.id);
            return (
              <motion.div
                key={m.id}
                data-msg-id={m.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                onContextMenu={(e) => handleMsgContextMenu(e, m)}
                onTouchStart={(e) => handleTouchStart(e, m)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchEnd}
                onClick={() => handleMsgClick(m)}
                className={cn("group flex gap-2 rounded-lg select-none",
                  mine ? "flex-row-reverse" : "flex-row",
                  highlightedId === m.id && "ring-2 ring-accent/50 bg-accent/5",
                  isSelected && "bg-accent/10",
                  isSelecting && "cursor-pointer")}
              >
                {!mine ? (
                  <div className="mt-1 w-8 shrink-0 flex items-start justify-center">
                    {isSelecting ? (
                      <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); toggleSelection(m.id); }} className="mt-0.5">
                        {isSelected ? <CheckSquare className="h-5 w-5 text-accent" /> : <Square className="h-5 w-5 text-muted" />}
                      </button>
                    ) : isNewGroup ? (
                      <button type="button" onClick={(e) => { e.stopPropagation(); m.senderUserId && setViewingUserId(m.senderUserId); }} className="rounded-full focus:outline-none">
                        <Avatar name={m.senderDisplayName} url={m.senderAvatarUrl} size={8}
                          online={!currentUser.presenceOptOut && !!m.senderUserId && onlineUsers.has(m.senderUserId)} />
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-1 w-8 shrink-0 flex items-start justify-center">
                    {isSelecting ? (
                      <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); toggleSelection(m.id); }} className="mt-0.5">
                        {isSelected ? <CheckSquare className="h-5 w-5 text-accent" /> : <Square className="h-5 w-5 text-muted" />}
                      </button>
                    ) : isNewGroup ? (
                      <Avatar name={currentUser.displayName} url={m.senderAvatarUrl ?? currentUser.avatarUrl} size={8} />
                    ) : null}
                  </div>
                )}

                <div className={cn("min-w-0 max-w-[72%]", mine ? "items-end" : "items-start", "flex flex-col")}>
                  {showSender && m.senderDisplayName && (
                    <div className="mb-1 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => m.senderUserId && setViewingUserId(m.senderUserId)}
                        className={cn("text-left text-xs font-medium hover:underline", m.senderIsAnon && currentUser.role === "admin" ? "text-muted line-through" : "text-accent2")}
                      >
                        {m.senderDisplayName}
                        {m.senderIsAnon && currentUser.role === "admin" && <span className="ml-1 text-[10px] text-muted">(anon)</span>}
                      </button>
                      {(m.senderRole && m.senderRole !== "user") && (
                        <span className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                          m.senderRole === "admin" && "bg-accent/20 text-accent",
                          m.senderRole === "moderator" && "bg-accent2/20 text-accent2",
                          m.botId && "bg-muted/20 text-muted",
                        )}>
                          {m.botId ? "bot" : m.senderRole}
                        </span>
                      )}
                      {m.botId && (
                        <span className="rounded bg-muted/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted">bot</span>
                      )}
                    </div>
                  )}

                  {m.replyToMessageId && (() => {
                    const parent = messages.find((p) => p.id === m.replyToMessageId);
                    const parentImg = parent?.attachments.find((a) => a.type === "image" || a.type === "gif");
                    return (
                      <div className={cn("mb-1 flex items-center gap-2 rounded-lg border-l-2 border-accent2 bg-panel2/50 px-2 py-1 text-xs text-muted max-w-full overflow-hidden", mine && "border-white/40 bg-white/10")}>
                        {parentImg && (
                          <img src={parentImg.thumbnailUrl ?? parentImg.url} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                        )}
                        <div className="min-w-0 truncate">
                          <span className="font-medium">{parent?.senderDisplayName ?? "Unknown"}: </span>
                          {!parent?.text.trim() && parentImg ? (
                            <span className="opacity-70 italic">📷 Image</span>
                          ) : (
                            <span className="opacity-70">{parent ? getDisplayText(parent).slice(0, 60) : "(message)"}</span>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {m.poll ? (
                    <div className="w-64 max-w-full">
                      <PollMessage
                        poll={m.poll}
                        myVotes={myPollVotes[m.poll.id] ?? []}
                        isMine={mine}
                        canClose={mine || currentUser.role !== "user"}
                        onVote={votePoll}
                        onClose={closePoll}
                      />
                      <div suppressHydrationWarning className={cn("mt-1 text-[10px]", mine ? "text-right text-muted" : "text-muted")}>
                        {friendlyTime(m.createdAt)}
                      </div>
                    </div>
                  ) : editingId === m.id ? (
                    <div className="w-full max-w-xs rounded-2xl bg-panel2 p-2">
                      <textarea
                        className="w-full resize-none rounded-lg bg-panel px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-accent"
                        rows={3}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") cancelEdit();
                          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitEdit(m.id); }
                        }}
                        autoFocus
                      />
                      <div className="mt-1 flex gap-1 justify-end">
                        <button type="button" onClick={cancelEdit} className="rounded px-2 py-1 text-xs text-muted hover:text-text"><X className="h-3 w-3" /></button>
                        <button type="button" onClick={() => void submitEdit(m.id)} className="rounded bg-accent px-2 py-1 text-xs text-white hover:opacity-90"><Check className="h-3 w-3" /></button>
                      </div>
                    </div>
                  ) : (
                  <div className={cn("relative group/bubble rounded-2xl px-4 py-2 text-sm min-w-0 max-w-full", mine ? "bg-accent text-white" : "bg-panel2 text-text",
                    !mine && m.senderIsAnon && currentUser.role === "admin" && "opacity-70",
                    m.text.trim() === "" && m.attachments.length > 0 && "p-1")}>
                    {/* Quick reaction button on bubble */}
                    <button
                      ref={(el) => { if (el) reactionBtnRefs.current.set(m.id, el); else reactionBtnRefs.current.delete(m.id); }}
                      type="button"
                      title="React"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); setPickerFor(pickerFor === m.id ? null : m.id); }}
                      className={cn(
                        "absolute -bottom-2.5 opacity-0 group-hover/bubble:opacity-100 transition z-10",
                        "flex h-6 w-6 items-center justify-center rounded-full border border-border bg-panel shadow-sm hover:bg-panel2",
                        mine ? "-left-3" : "-right-3",
                      )}
                    >
                      <SmilePlus className="h-3.5 w-3.5 text-muted" />
                    </button>
                    {/* Reply button on bubble */}
                    <button
                      type="button"
                      title="Reply"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); setReplyingTo(m); }}
                      className={cn(
                        "absolute -bottom-2.5 opacity-0 group-hover/bubble:opacity-100 transition z-10",
                        "flex h-6 w-6 items-center justify-center rounded-full border border-border bg-panel shadow-sm hover:bg-panel2",
                        mine ? "-right-3" : "-left-3",
                      )}
                    >
                      <CornerDownLeft className="h-3.5 w-3.5 text-muted" />
                    </button>
                    {m.attachments.length > 0 && (
                      <div className={cn("flex flex-col gap-1", m.text.trim() && "mb-2")}>
                        {m.attachments.map((att, ai) =>
                          att.type === "file" ? (
                            <a key={ai} href={att.url} download={att.filename} target="_blank" rel="noopener noreferrer"
                              className={cn("flex items-center gap-2 rounded-xl border px-3 py-2 text-xs hover:opacity-90", mine ? "border-white/20 bg-white/10" : "border-border bg-panel")}>
                              <FileText className="h-4 w-4 shrink-0" />
                              <span className="truncate">{att.filename ?? "Download file"}</span>
                              {att.size && <span className="ml-auto shrink-0 opacity-70">{(att.size / 1024).toFixed(0)} KB</span>}
                            </a>
                          ) : (
                            <img key={ai} src={att.url} alt="" className="max-h-64 max-w-full rounded-xl object-contain cursor-pointer" loading="lazy" onClick={() => setLightboxSrc(att.url)} />
                          )
                        )}
                      </div>
                    )}
                    {m.text.trim() && (
                      <MarkdownContent content={getDisplayText(m)} className={cn("text-sm break-words", mine && "[&_*]:text-white [&_code]:bg-white/20 [&_pre]:bg-white/20")} />
                    )}
                    {m.inlineKeyboard && m.inlineKeyboard.length > 0 && (
                      <div className="mt-2 flex flex-col gap-1">
                        {m.inlineKeyboard.map((row, ri) => (
                          <div key={ri} className="flex flex-wrap gap-1">
                            {row.map((btn, bi) => (
                              <button
                                key={bi}
                                type="button"
                                onClick={() => handleKeyboardCallback(m, btn.callbackData)}
                                className={cn("rounded-lg border px-3 py-1 text-xs font-medium transition hover:bg-accent hover:text-white hover:border-accent", mine ? "border-white/40 text-white/90" : "border-border text-text")}
                              >
                                {btn.text}
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                    <div suppressHydrationWarning className={cn("mt-1 flex items-center gap-1 text-[10px]", mine ? "text-white/70 justify-end" : "text-muted")}>
                      {m.editedAt && <span className="italic opacity-70">edited</span>}
                      {friendlyTime(m.createdAt)}
                    </div>
                  </div>
                  )}

                  {(replyCounts.get(m.id) ?? 0) >= 3 && (
                    <button
                      type="button"
                      onClick={() => setThreadFor(m)}
                      className={cn("mt-1 flex items-center gap-1.5 text-xs text-accent hover:underline", mine && "self-end")}
                    >
                      <MessageSquareText className="h-3 w-3" />
                      View thread ({replyCounts.get(m.id)})
                    </button>
                  )}

                  {perEmoji && perEmoji.size > 0 && (
                    <div className={cn("mt-1 flex flex-wrap gap-1", mine ? "justify-end" : "justify-start")}>
                      {Array.from(perEmoji.entries()).map(([key, users]) => {
                        const reacted = users.includes(currentUser.id);
                        return (
                          <button key={key} type="button" onClick={() => toggleReaction(m.id, key)}
                            className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", reacted ? "border-accent bg-accent/20" : "border-border bg-panel")}>
                            <span>{EMOJI_GLYPH[key] ?? key}</span>
                            <span className="text-muted">{users.length}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {pickerFor === m.id && (
                    <EmojiPickerPopover
                      anchorRef={{ current: reactionBtnRefs.current.get(m.id) ?? null }}
                      onSelect={(glyph) => { toggleReaction(m.id, glyph); setPickerFor(null); }}
                      onClose={() => setPickerFor(null)}
                    />
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {threadFor && (
        <ThreadPanel
          rootMessage={threadFor}
          topicId={topic.id}
          currentUserId={currentUser.id}
          isE2ee={topic.isE2ee}
          onClose={() => setThreadFor(null)}
          onReply={(msgId) => {
            const msg = messages.find((m) => m.id === msgId);
            if (msg) setReplyingTo(msg);
            setThreadFor(null);
          }}
        />
      )}
      </div>

      {/* Multi-select action bar */}
      {isSelecting && (
        <div className="border-t border-border bg-panel px-4 pt-2.5 pb-[calc(0.625rem+var(--sab))] flex items-center gap-3 shrink-0">
          <span className="text-sm font-semibold text-text">{selectedIds.size} selected</span>
          <div className="flex-1" />
          {(canDeleteOwn || canDeleteAny) && (
            <button type="button" onClick={deleteSelected}
              className="flex items-center gap-1.5 rounded-lg bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/20 transition">
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          )}
          <button type="button" onClick={() => void reportSelected()}
            className="flex items-center gap-1.5 rounded-lg bg-panel2 px-3 py-1.5 text-xs font-medium text-muted hover:text-text transition">
            <Flag className="h-3.5 w-3.5" />
            Report
          </button>
          <button type="button" onClick={() => setSelectedIds(new Set())}
            className="rounded-lg p-1.5 text-muted hover:text-text hover:bg-panel2 transition">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {mute ? (
        <div suppressHydrationWarning className="border-t border-border bg-panel px-6 pt-4 pb-[calc(1rem+var(--sab))] text-sm text-danger">
          You are muted: {mute.reason}
          {mute.expiresAt ? ` (until ${new Date(mute.expiresAt).toLocaleString()})` : " (permanent)"}
        </div>
      ) : !canPost ? (
        <div className="border-t border-border bg-panel px-6 pt-4 pb-[calc(1rem+var(--sab))] text-sm text-muted">
          Only {topic.postRoles.join(", ")} can post in this channel.
        </div>
      ) : (
        <div className="border-t border-border bg-panel px-3 pt-2 pb-[calc(0.375rem+var(--sab))]">
          {replyingTo && (
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-panel2 px-3 py-1.5">
              <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-accent2" />
              <span className="text-xs text-muted flex-1 truncate">
                Replying to <span className="font-medium text-text">{replyingTo.senderDisplayName ?? "Unknown"}</span>:{" "}
                {getDisplayText(replyingTo).slice(0, 60)}
              </span>
              <button type="button" onClick={() => setReplyingTo(null)} className="text-muted hover:text-text shrink-0">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {pendingAttachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2 px-1">
              {pendingAttachments.map((att, i) => (
                <div key={i} className="relative">
                  {att.type === "file" ? (
                    <div className="flex h-16 w-32 items-center gap-1.5 rounded-lg border border-border bg-panel2 px-2">
                      <FileText className="h-5 w-5 shrink-0 text-muted" />
                      <span className="truncate text-xs text-muted">{att.filename ?? "file"}</span>
                    </div>
                  ) : (
                    <img src={att.thumbnailUrl ?? att.url} alt="" className="h-16 w-16 rounded-lg object-cover" />
                  )}
                  <button type="button" onClick={() => removePendingAttachment(i)}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-danger text-white">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="relative">
            {showGifPicker && <GifPicker onSelect={addGif} onClose={() => setShowGifPicker(false)} canUploadGif={canUploadGif} giphyEnabled={giphyEnabled} />}
            {showComposeEmoji && (
              <EmojiPickerPopover
                anchorRef={composeEmojiRef}
                onSelect={(glyph) => { editorRef.current?.insertText(glyph); }}
                onClose={() => setShowComposeEmoji(false)}
              />
            )}

            <div className="rounded-xl bg-panel2 px-3 py-2 flex flex-col gap-2">
              <RichTextEditor
                ref={editorRef}
                value={draft}
                onChange={setDraft}
                onSubmit={() => void send()}
                placeholder={uploading ? "Uploading…" : topic.isFeed ? "Write a post… (Ctrl+Enter to send)" : enterSends ? "Write a message… (Enter to send)" : "Write a message… (Ctrl+Enter to send)"}
                compact={!topic.isFeed}
                enterSends={topic.isFeed ? false : enterSends}
                disabled={uploading}
                members={members}
              />
              <div className="flex items-center gap-2">
                {canAttach && (
                  <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                    className="text-muted hover:text-text disabled:opacity-50" title="Attach image">
                    <ImagePlus className="h-4 w-4" />
                  </button>
                )}
                {canAttach && (
                  <button type="button" onClick={() => fileUploadRef.current?.click()} disabled={uploading}
                    className="text-muted hover:text-text disabled:opacity-50" title="Attach file">
                    <Paperclip className="h-4 w-4" />
                  </button>
                )}
                <button type="button" onClick={() => setShowGifPicker((v) => !v)}
                  className={cn("text-muted hover:text-text", showGifPicker && "text-accent")} title="GIF">
                  <Sticker className="h-4 w-4" />
                </button>
                <button ref={composeEmojiRef} type="button" onClick={() => setShowComposeEmoji((v) => !v)}
                  className={cn("text-muted hover:text-text", showComposeEmoji && "text-accent")} title="Emoji">
                  <SmilePlus className="h-4 w-4" />
                </button>
                {canCreatePoll && (
                  <button type="button" onClick={() => setShowPollCreator(true)}
                    className={cn("text-muted hover:text-text", showPollCreator && "text-accent")} title="Create poll">
                    <BarChart2 className="h-4 w-4" />
                  </button>
                )}
                <div className="flex-1" />
                {!topic.isFeed && (
                  <button
                    type="button"
                    title={enterSends ? "Enter sends — click to switch to Ctrl+Enter" : "Ctrl+Enter sends — click to switch to Enter"}
                    onClick={() => setEnterSends((v) => !v)}
                    className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium border transition", enterSends ? "border-accent text-accent bg-accent/10" : "border-border text-muted hover:border-accent hover:text-accent")}
                  >
                    {enterSends ? "⏎ send" : "⌃⏎ send"}
                  </button>
                )}
                <button type="button" onClick={() => void send()} disabled={!canSend}
                  className={cn(
                    "transition disabled:opacity-40",
                    topic.isFeed
                      ? "rounded-lg bg-accent px-4 py-1.5 text-sm text-white hover:opacity-90"
                      : "rounded-lg bg-accent p-1.5 text-white hover:opacity-90",
                  )}>
                  {topic.isFeed ? "Post" : <Send className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                e.target.value = "";
                const att = await uploadFile(file, "uploads");
                if (att) setPendingAttachments((prev) => [...prev, att]);
              }} />
            <input ref={fileUploadRef} type="file" className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                e.target.value = "";
                const att = await uploadFile(file, "files");
                if (att) setPendingAttachments((prev) => [...prev, att]);
              }} />
          </div>
        </div>
      )}

      {showPollCreator && (
        <PollCreator
          onSubmit={submitPoll}
          onClose={() => setShowPollCreator(false)}
        />
      )}

      {viewingUserId && viewingUserId !== currentUser.id && (
        <UserViewModal
          userId={viewingUserId}
          viewerPermissions={currentUser.permissions}
          onClose={() => setViewingUserId(null)}
        />
      )}

      {/* Context menu portal — Telegram-style bottom sheet */}
      {contextMenu && typeof document !== "undefined" && createPortal(
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[9989] bg-black/60"
            onClick={() => setContextMenu(null)}
          />
          {/* Sheet — translated up by keyboard height so it sits at visual viewport bottom */}
          <div
            className="fixed bottom-0 left-0 right-0 z-[9998] rounded-t-2xl border-t border-border bg-panel shadow-2xl overflow-hidden"
            style={{ transform: `translateY(-${contextMenu.kbOffset}px)` }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Message preview */}
            <div className="px-4 pt-3 pb-2.5 border-b border-border">
              {contextMenu.msg.senderDisplayName && (
                <p className="text-xs font-semibold text-accent2 mb-0.5 truncate">{contextMenu.msg.senderDisplayName}</p>
              )}
              <p className="text-sm text-muted line-clamp-2 break-words">
                {getDisplayText(contextMenu.msg).trim() || (contextMenu.msg.attachments.length > 0 ? "📎 Attachment" : "")}
              </p>
            </div>
            {/* Quick reactions */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-xl hover:bg-panel2 active:scale-90 transition"
                  onClick={() => { toggleReaction(contextMenu.msg.id, emoji); setContextMenu(null); }}
                >
                  {emoji}
                </button>
              ))}
              <button
                ref={(el) => { if (el) reactionBtnRefs.current.set(`ctx-${contextMenu.msg.id}`, el); else reactionBtnRefs.current.delete(`ctx-${contextMenu.msg.id}`); }}
                type="button"
                className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-panel2 transition text-muted hover:text-text"
                onClick={() => { setPickerFor(contextMenu.msg.id); setContextMenu(null); }}
              >
                <SmilePlus className="h-5 w-5" />
              </button>
            </div>
            {/* Action items */}
            <div className="py-1 pb-[max(0.25rem,var(--sab))]">
              {[
                { icon: CornerDownLeft, label: "Reply", action: () => { setReplyingTo(contextMenu.msg); setContextMenu(null); } },
                { icon: Copy, label: "Copy", action: () => { void copyMessage(getDisplayText(contextMenu.msg)); setContextMenu(null); } },
                ...(!isSelecting ? [{ icon: CheckSquare, label: "Select", action: () => { toggleSelection(contextMenu.msg.id); setContextMenu(null); } }] : [
                  { icon: CheckSquare, label: selectedIds.has(contextMenu.msg.id) ? "Deselect" : "Add to selection", action: () => { toggleSelection(contextMenu.msg.id); setContextMenu(null); } },
                ]),
                ...((((contextMenu.msg.senderUserId === currentUser.id && canEditOwn) || canEditAny) && !contextMenu.msg.poll)
                  ? [{ icon: Pencil, label: "Edit", action: () => { startEdit(contextMenu.msg, getDisplayText(contextMenu.msg)); setContextMenu(null); } }]
                  : []),
                ...(((contextMenu.msg.senderUserId === currentUser.id && canDeleteOwn) || canDeleteAny)
                  ? [{ icon: Trash2, label: "Delete", danger: true, action: () => { deleteMessage(contextMenu.msg.id); setContextMenu(null); } }]
                  : []),
                { icon: Flag, label: "Report", danger: true, action: () => { void reportMessage(contextMenu.msg.id); setContextMenu(null); } },
              ].map(({ icon: Icon, label, action, danger }) => (
                <button
                  key={label}
                  type="button"
                  onClick={action}
                  className={cn(
                    "flex w-full items-center gap-3 px-5 py-3 text-sm transition hover:bg-panel2 active:bg-panel2",
                    danger ? "text-danger" : "text-text",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
