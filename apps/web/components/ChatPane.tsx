"use client";
import { apiFetch } from "@/lib/fetch";
import { stripImageMetadata } from "@/lib/upload";
import { Tooltip } from "@/components/Tooltip";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { BarChart2, Check, CheckSquare, Copy, CornerDownLeft, File as FileIcon, FileText, Flag, Image as ImageIcon, ImagePlus, Lock, Menu, MessageSquareText, Pencil, PanelLeftOpen, Paperclip, Search, Send, SmilePlus, Square, Sticker, Trash2, Users, X } from "lucide-react";
import { MarkdownContent } from "@/components/MarkdownContent";
import { RichTextEditor, type RichTextEditorHandle } from "@/components/RichTextEditor";
import { WS_EVENTS, PERMISSIONS } from "@legends/shared";
import { cn } from "@/lib/cn";
import { GifPicker } from "@/components/GifPicker";
import { EmojiPickerPopover } from "@/components/EmojiPickerPopover";
import { PollCreator } from "@/components/PollCreator";
import { PollMessage } from "@/components/PollMessage";
import { UserViewModal } from "@/components/UserViewModal";
import { SearchModal } from "@/components/SearchModal";
import { ThreadPanel } from "@/components/ThreadPanel";
import { ImageLightbox } from "@/components/ImageLightbox";
import { TopicInfoModal } from "@/components/TopicInfoModal";
import { EncryptedMessageContent } from "@/components/EncryptedMessageContent";
import { EncryptedReasonModal, type EncryptedReason } from "@/components/EncryptedReasonModal";
import type { IncomingEnvelope } from "@/lib/crypto";
import { HashtagClickContext } from "@/contexts/HashtagClickContext";
import { useSymbols } from "@/contexts/SymbolsContext";
import { useTopicHashtags } from "@/hooks/useTopicHashtags";
import type { TopicBootstrapHashtag, TopicBootstrapMember } from "@legends/shared";
import type { ChatSource } from "@/lib/chat-source";
import type { ChatCrypto } from "@/lib/chat-crypto";

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
  /** Megolm envelope for E2EE topic rows. Plain rows: null. */
  ciphertextJson?: Record<string, unknown> | null;
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

export interface ChatPaneTopicMode {
  kind: "topic";
  topic: { id: string; slug: string; title: string; isE2ee: boolean; isFeed: boolean; postRoles: string[]; iconUrl?: string | null; bannerUrl?: string | null; description?: string | null };
  mute: { reason: string; expiresAt: string | null } | null;
  giphyEnabled?: boolean;
  communityName?: string | null;
  communityIconUrl?: string | null;
  canPost: boolean;
  canReply: boolean;
  initialMembers: TopicBootstrapMember[];
  initialHashtags: TopicBootstrapHashtag[];
  onSidebarUpdate?: (update: SidebarTopicUpdate) => void;
}

export interface ChatPaneDmMode {
  kind: "dm";
  conversation: {
    id: string;
    isE2ee: boolean;
    e2eeRoomId: string | null;
    state: "pending" | "accepted" | "blocked";
    /** true when the current user is the recipient of a pending request (i.e. NOT the sender). */
    incoming: boolean;
    peer: { type: "user" | "bot"; id: string; displayName: string; avatarUrl: string | null } | null;
  };
}

export type ChatPaneMode = ChatPaneTopicMode | ChatPaneDmMode;

// Stable empty arrays used when ChatPane runs in DM mode. Re-creating `[]`
// inline per render gave `initialMembers` / `initialHashtags` a fresh identity
// every render, which fired the `useEffect(() => setMembers(initialMembers), [initialMembers])`
// loop and triggered React's "Maximum update depth exceeded" guard.
const EMPTY_MEMBERS: TopicBootstrapMember[] = [];
const EMPTY_HASHTAGS: TopicBootstrapHashtag[] = [];

// Stable empty arrays passed to RichTextEditor when the corresponding cap is
// disabled. The editor mirrors these props into refs via useEffect; passing a
// fresh `[]` per render fires those effects on every parent render even
// though no state actually changes. Same fix shape as EMPTY_MEMBERS / EMPTY_HASHTAGS.
type RteMentionMember = { id: string; displayName: string; avatarUrl: string | null };
type RteTagEntry = { tag: string; count: number };
type RteSymbolEntry = { symbol: string; name: string; avatarUrl: string | null };
const EMPTY_RTE_MEMBERS: RteMentionMember[] = [];
const EMPTY_RTE_TAGS: RteTagEntry[] = [];
const EMPTY_RTE_SYMBOLS: RteSymbolEntry[] = [];

// Maps numeric DecryptionErrorCode (from @matrix-org/matrix-sdk-crypto-wasm)
// to a stable textual tag we can match on in getEncryptedReason. The wasm
// proxy object isn't JSON-serialisable (only exposes `__wbg_ptr`), so we
// read its getters directly here.
const DECRYPT_CODE_NAMES: Record<number, string> = {
  0: "MissingRoomKey",
  1: "UnknownMessageIndex",
  2: "MismatchedIdentityKeys",
  3: "UnknownSenderDevice",
  4: "UnsignedSenderDevice",
  5: "SenderIdentityVerificationViolation",
  6: "UnableToDecrypt",
};

function describeDecryptError(err: unknown): string {
  if (err == null) return "Unknown error";
  if (err instanceof Error) return err.message || err.name || "Decryption failed";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as {
      code?: unknown; description?: unknown; message?: unknown;
      error?: unknown; reason?: unknown; kind?: unknown; name?: unknown;
      toString?: () => string;
    };
    const code = typeof obj.code === "number" ? obj.code : null;
    const desc = typeof obj.description === "string" ? obj.description : null;
    const codeName = code != null ? DECRYPT_CODE_NAMES[code] ?? `code${code}` : null;
    if (codeName && desc) return `${codeName}: ${desc}`;
    if (codeName) return codeName;
    if (desc) return desc;
    for (const k of ["message", "error", "reason", "kind", "name"] as const) {
      const v = obj[k];
      if (typeof v === "string" && v) return v;
    }
    if (typeof obj.toString === "function") {
      try {
        const s = obj.toString();
        if (s && s !== "[object Object]") return s;
      } catch {}
    }
    return "Decryption failed";
  }
  return String(err);
}

interface ChatPaneProps {
  user: { id: string; displayName: string; avatarUrl: string | null; role: string; presenceOptOut: boolean; permissions: string[] };
  mode: ChatPaneMode;
  source: ChatSource;
  chatCrypto: ChatCrypto | null;
  highlightMessageId?: string;
  onMenuOpen?: () => void;
  onConnectionChange?: (connected: boolean) => void;
  showExpandSidebar?: boolean;
  onExpandSidebar?: () => void;
}

async function processLinks(text: string): Promise<string> {
  if (!text.trim()) return text;
  try {
    const res = await apiFetch("/api/links/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return text;
    const data = (await res.json()) as { text?: string };
    return data.text ?? text;
  } catch {
    return text;
  }
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

export function ChatPane({ user: currentUser, mode, source, chatCrypto, highlightMessageId, onMenuOpen, onConnectionChange, showExpandSidebar, onExpandSidebar }: ChatPaneProps) {
  const isTopicMode = mode.kind === "topic";
  const isDmMode = mode.kind === "dm";
  const topic = isTopicMode ? mode.topic : null;
  const dmConversation = isDmMode ? mode.conversation : null;
  const topicMute = isTopicMode ? mode.mute : null;
  const giphyEnabled = isTopicMode ? mode.giphyEnabled : undefined;
  const communityName = isTopicMode ? mode.communityName : null;
  const communityIconUrl = isTopicMode ? mode.communityIconUrl : null;
  const canPost = isTopicMode ? mode.canPost : dmConversation?.state === "accepted";
  const canReply = isTopicMode ? mode.canReply : false;
  const initialMembers = isTopicMode ? mode.initialMembers : EMPTY_MEMBERS;
  const initialHashtags = isTopicMode ? mode.initialHashtags : EMPTY_HASHTAGS;
  const onSidebarUpdate = isTopicMode ? mode.onSidebarUpdate : undefined;

  const roomKey = source.roomKey;
  const caps = source.capabilities;
  const isE2ee = isTopicMode ? topic!.isE2ee : !!dmConversation?.isE2ee;
  const isFeed = isTopicMode ? topic!.isFeed : false;
  const headerTitle = isTopicMode ? topic!.title : (dmConversation?.peer?.displayName ?? "Conversation");
  const conversationKey = isTopicMode ? topic!.id : dmConversation!.id;
  const draftKey = `legends-draft-${conversationKey}`;

  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<ReactionRow[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showComposeEmoji, setShowComposeEmoji] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [membersSearch, setMembersSearch] = useState("");
  const [membersLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showUploadError = useCallback((msg: string, ttlMs = 6000) => {
    setUploadError(msg);
    if (uploadErrorTimerRef.current) clearTimeout(uploadErrorTimerRef.current);
    uploadErrorTimerRef.current = setTimeout(() => setUploadError(null), ttlMs);
  }, []);
  const [myPollVotes, setMyPollVotes] = useState<Record<string, string[]>>({});
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [viewingUserId, setViewingUserId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [threadFor, setThreadFor] = useState<Message | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [e2eeSetupNeeded, setE2eeSetupNeeded] = useState(false);
  const [e2eeError, setE2eeError] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [showTopicInfo, setShowTopicInfo] = useState(false);
  const [hashtagFilter, setHashtagFilter] = useState<string | null>(null);
  const [filteredMessages, setFilteredMessages] = useState<Message[]>([]);
  const [filteredLoading, setFilteredLoading] = useState(false);
  const [e2eeReady, setE2eeReady] = useState(!isE2ee);
  const e2eeRoomId = roomKey;
  const [memberUserIds, setMemberUserIds] = useState<string[]>([]);
  const [adminUserIds, setAdminUserIds] = useState<string[]>([]);
  const [adminDisplayNames, setAdminDisplayNames] = useState<Map<string, string>>(new Map());
  const memberUserIdsRef = useRef<string[]>([]);
  useEffect(() => { memberUserIdsRef.current = memberUserIds; }, [memberUserIds]);
  const e2eeRoomIdRef = useRef<string | null>(e2eeRoomId);
  useEffect(() => { e2eeRoomIdRef.current = e2eeRoomId; }, [e2eeRoomId]);
  const chatCryptoRef = useRef<ChatCrypto | null>(chatCrypto);
  const cryptoInitPromise = useRef<Promise<void> | null>(null);
  useEffect(() => {
    chatCryptoRef.current = chatCrypto;
    // Bug 21: when the chat-crypto identity changes (e.g. DmRightPane's
    // useMemo rebuilds it because roomKey arrived after the first render),
    // the previous instance's "ready" state must NOT carry over. Reset the
    // shared UI flag so the next ensureCrypto() actually calls init() on
    // this new closure. Without this, the new cc's internal `mod` stays
    // null and the next encrypt() throws "chat-crypto: not initialized".
    cryptoInitPromise.current = null;
    if (chatCrypto && !chatCrypto.ready()) {
      setE2eeReady(false);
    }
  }, [chatCrypto]);
  const socketRef = useRef<NonNullable<ChatSource["socket"]> | null>(null);
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
    if (typeof window === "undefined") return !isFeed;
    const saved = localStorage.getItem("legends-enter-sends");
    return saved !== null ? saved === "true" : !isFeed;
  });
  const [contextMenu, setContextMenu] = useState<{
    msg: Message;
    kbOffset: number;
    /** Non-null = desktop right-click; render as cursor-anchored popover at these viewport coords. Null = mobile long-press; render as bottom sheet. */
    anchor: { x: number; y: number } | null;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressMoved = useRef(false);
  const isSelecting = selectedIds.size > 0;
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const [replyingToPost, setReplyingToPost] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [hoverZone, setHoverZone] = useState<"image" | "original" | null>(null);
  const dragCounter = useRef(0);

  const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "🎉", "😮"];

  const { tags: topicTags } = useTopicHashtags(isTopicMode ? topic!.id : "", source.socket, initialHashtags);
  const { symbols, refetch: refetchSymbols } = useSymbols();

  const canCreatePoll = currentUser.role !== "user";
  const canAttach = currentUser.permissions.includes(PERMISSIONS.CONTENT_ATTACHMENT);
  const canUploadGif = currentUser.permissions.includes(PERMISSIONS.CONTENT_GIF_UPLOAD);
  const canDeleteOwn = currentUser.permissions.includes(PERMISSIONS.MESSAGES_DELETE_OWN);
  const canDeleteAny = currentUser.permissions.includes(PERMISSIONS.MESSAGES_DELETE_ANY);
  const canEditOwn = currentUser.permissions.includes(PERMISSIONS.MESSAGES_EDIT_OWN);
  const canEditAny = currentUser.permissions.includes(PERMISSIONS.MESSAGES_EDIT_ANY);

  // Context menu helpers
  function openContextMenu(msg: Message, anchor: { x: number; y: number } | null) {
    const kbOffset = Math.max(0, window.innerHeight - (window.visualViewport?.height ?? window.innerHeight));
    setContextMenu({ msg, kbOffset, anchor });
  }

  function handleMsgContextMenu(e: React.MouseEvent, msg: Message) {
    // Right-click on a link inside the bubble belongs to LinkContextMenu —
    // let that one win. Don't preventDefault here either, otherwise the
    // global link handler would see defaultPrevented and bail.
    if ((e.target as HTMLElement).closest("a[href]")) return;
    e.preventDefault();
    if (isStillEncrypted(msg)) return;
    openContextMenu(msg, { x: e.clientX, y: e.clientY });
  }

  function handleTouchStart(e: React.TouchEvent, msg: Message) {
    if (isStillEncrypted(msg)) return;
    longPressMoved.current = false;
    longPressTimer.current = setTimeout(() => {
      if (!longPressMoved.current) {
        // Touch path: render as a bottom sheet — anchor=null.
        openContextMenu(msg, null);
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
      void source.remove?.(id);
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
  useEffect(() => {
    if (isTopicMode && topic) localStorage.setItem("lc-last-topic", topic.slug);
  }, [isTopicMode, topic]);

  // Drag-and-drop: document-level enter/leave counter to avoid flicker
  // between child elements. Overlay handles the actual drop routing.
  useEffect(() => {
    if (!canAttach || !canPost || topicMute) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    function onEnter(e: DragEvent) {
      if (!hasFiles(e)) return;
      dragCounter.current += 1;
      if (dragCounter.current === 1) setDragActive(true);
    }
    function onLeave(e: DragEvent) {
      if (!hasFiles(e)) return;
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) { setDragActive(false); setHoverZone(null); }
    }
    function onDrop() {
      dragCounter.current = 0;
      setDragActive(false);
      setHoverZone(null);
    }
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [canAttach, canPost, topicMute]);

  // Prevent the browser from opening the file when dropped outside the overlay zones.
  useEffect(() => {
    function onDragOver(e: DragEvent) {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
      }
    }
    function onDrop(e: DragEvent) {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
      }
    }
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const ensureCrypto = useCallback(async (): Promise<ChatCrypto | null> => {
    const cc = chatCryptoRef.current;
    if (!cc) return null;
    // Per-instance readiness check: a freshly-built chat-crypto closure
    // (e.g. after DmRightPane's useMemo deps change) must init itself even
    // if the shared `e2eeReady` flag is true from a previous instance. The
    // underlying cc.init() is idempotent, so we can safely always invoke
    // it; we still short-circuit here to avoid an awaited microtask hop
    // on the hot path once the instance is ready.
    if (cc.ready()) {
      if (!e2eeReady) {
        setE2eeReady(true);
        setE2eeSetupNeeded(false);
      }
      return cc;
    }
    if (cryptoInitPromise.current) {
      await cryptoInitPromise.current;
      return cc;
    }
    cryptoInitPromise.current = (async () => {
      try {
        await cc.init(currentUser.id);
        setE2eeReady(true);
        setE2eeSetupNeeded(false);
        try { localStorage.setItem(`legends-crypto-bootstrapped:${currentUser.id}`, "1"); } catch {}
      } catch (e) {
        setE2eeError((e as Error).message);
        setE2eeSetupNeeded(true);
        throw e;
      } finally {
        cryptoInitPromise.current = null;
      }
    })();
    try { await cryptoInitPromise.current; } catch { return null; }
    return cc;
  }, [currentUser.id, e2eeReady]);

  useEffect(() => {
    if (!isE2ee) return;
    ensureCrypto().catch(() => {});
  }, [isE2ee, ensureCrypto]);

  const refreshRoomMembers = useCallback(async () => {
    if (!isTopicMode || !isE2ee || !e2eeRoomId) return;
    try {
      const r = await apiFetch(`/api/crypto/rooms/${encodeURIComponent(e2eeRoomId)}/members`);
      if (!r.ok) return;
      const d = (await r.json()) as { user_ids: string[]; member_user_ids: string[]; admin_user_ids: string[] };
      setMemberUserIds(d.user_ids);
      setAdminUserIds(d.admin_user_ids);
    } catch { /* network blip — retry on next member change */ }
  }, [isTopicMode, isE2ee, e2eeRoomId]);

  useEffect(() => {
    refreshRoomMembers();
  }, [refreshRoomMembers]);

  // After topic members load, build the admin display-name map. For admins
  // not in topic_members (server auto-adds them to the Megolm room only),
  // resolve their display name via /api/users/<id>. Falls back to a sliced
  // userId only while the fetch is in flight.
  useEffect(() => {
    if (adminUserIds.length === 0) return;
    setAdminDisplayNames((prev) => {
      const next = new Map(prev);
      for (const aid of adminUserIds) {
        const m = members.find((mm) => mm.id === aid);
        if (m) next.set(aid, m.displayName);
        else if (!next.has(aid)) next.set(aid, `${aid.slice(0, 8)}…`);
      }
      return next;
    });
    // For admins not in topic_members, fetch their real display name.
    const missing = adminUserIds.filter((aid) => !members.find((mm) => mm.id === aid));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(missing.map(async (aid) => {
        try {
          const r = await apiFetch(`/api/users/${encodeURIComponent(aid)}`);
          if (!r.ok) return null;
          const d = (await r.json()) as { id: string; displayName: string };
          return d;
        } catch { return null; }
      }));
      if (cancelled) return;
      setAdminDisplayNames((prev) => {
        const next = new Map(prev);
        for (const d of results) {
          if (d && d.displayName) next.set(d.id, d.displayName);
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [adminUserIds, members]);

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

  useEffect(() => {
    if (!caps.members) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); setShowSearch(true); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [caps.members]);

  useEffect(() => {
    let active = true;
    const unsubscribe = source.subscribe({
      onConnect: (initial) => {
        if (!active) return;
        setConnected(true);
        onConnectionChange?.(true);
        if (initial.messages) {
          setMessages(initial.messages);
          for (const m of initial.messages) {
            if (m.ciphertextJson && !decryptedRef.current.has(m.id)) {
              pendingDecryptRef.current.add(m.id);
            }
          }
        }
        if (initial.reactions) setReactions(initial.reactions);
        if (initial.onlineUserIds && !currentUser.presenceOptOut) setOnlineUsers(new Set(initial.onlineUserIds));
        if (initial.myPollVotes) setMyPollVotes(initial.myPollVotes);
      },
      onDisconnect: () => { if (active) { setConnected(false); onConnectionChange?.(false); } },
      onNew: (msg) => {
        if (!active) return;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        if (msg.ciphertextJson && !decryptedRef.current.has(msg.id)) {
          pendingDecryptRef.current.add(msg.id);
        }
        if (msg.replyToMessageId && isFeed) {
          setExpandedThreads((prev) => new Set([...prev, String(msg.replyToMessageId)]));
        }
      },
      onEdit: (updated) => {
        if (!active) return;
        setMessages((prev) => prev.map((m) => m.id === updated.id
          ? { ...m, text: updated.text, editedAt: updated.editedAt, attachments: updated.attachments, ciphertextJson: updated.ciphertextJson ?? m.ciphertextJson }
          : m));
        if (updated.ciphertextJson) {
          setDecryptedTexts((prev) => {
            if (!prev.has(updated.id)) return prev;
            const next = new Map(prev);
            next.delete(updated.id);
            return next;
          });
          pendingDecryptRef.current.add(updated.id);
        }
      },
      onDelete: (id) => {
        if (!active) return;
        setMessages((prev) => prev.filter((m) => m.id !== id));
        setReactions((prev) => prev.filter((r) => r.messageId !== id));
        pendingDecryptRef.current.delete(id);
      },
      onReactionAdd: (r) => {
        if (!active) return;
        setReactions((prev) =>
          prev.some((x) => x.messageId === r.messageId && x.userId === r.userId && x.emojiKey === r.emojiKey)
            ? prev
            : [...prev, r],
        );
      },
      onReactionRemove: (r) => {
        if (!active) return;
        setReactions((prev) =>
          prev.filter((x) => !(x.messageId === r.messageId && x.userId === r.userId && x.emojiKey === r.emojiKey)),
        );
      },
    });
    socketRef.current = source.socket;

    let pollOff: (() => void) | undefined;
    let presenceOff: (() => void) | undefined;
    let sidebarOff: (() => void) | undefined;
    let symbolsOff: (() => void) | undefined;
    let membersOff: (() => void) | undefined;

    if (isTopicMode) {
      const sock = source.socket;
      if (sock) {
        const onPoll = (d: { pollId: string; options: PollOption[]; totalVotes: number; isClosed: boolean }) => {
          if (!active) return;
          setMessages((prev) => prev.map((m) =>
            m.poll?.id === d.pollId
              ? { ...m, poll: { ...m.poll, options: d.options, totalVotes: d.totalVotes, isClosed: d.isClosed } }
              : m,
          ));
        };
        const onPresence = (d: { userId: string; online: boolean }) => {
          if (!active || currentUser.presenceOptOut) return;
          setOnlineUsers((prev) => {
            const next = new Set(prev);
            if (d.online) next.add(d.userId); else next.delete(d.userId);
            return next;
          });
        };
        const onSidebar = (update: SidebarTopicUpdate) => { if (active) onSidebarUpdate?.(update); };
        const onSymbols = () => { refetchSymbols(); };
        const onMembers = async (payload: { topicId: string; action: "join" | "leave"; affectedUserId: string; memberUserIds: string[]; adminUserIds: string[] }) => {
          if (!active || !topic || payload.topicId !== topic.id) return;
          setMemberUserIds(Array.from(new Set([...payload.memberUserIds, ...payload.adminUserIds])).sort());
          setAdminUserIds(payload.adminUserIds);
          const cc = chatCryptoRef.current;
          if (!cc?.onMembershipChange) return;
          const fullMembers = Array.from(new Set([...payload.memberUserIds, ...payload.adminUserIds]));
          try {
            await cc.onMembershipChange(payload.action, payload.affectedUserId, fullMembers);
          } catch (err) {
            console.error("[e2ee] onMembershipChange failed", { topicId: payload.topicId, err });
          }
        };
        sock.on(WS_EVENTS.POLL_UPDATED, onPoll);
        sock.on(WS_EVENTS.PRESENCE_UPDATE, onPresence);
        sock.on(WS_EVENTS.SIDEBAR_UPDATE, onSidebar);
        sock.on(WS_EVENTS.SYMBOLS_UPDATE, onSymbols);
        sock.on(WS_EVENTS.TOPIC_MEMBERS_UPDATED, onMembers);
        pollOff = () => sock.off(WS_EVENTS.POLL_UPDATED, onPoll);
        presenceOff = () => sock.off(WS_EVENTS.PRESENCE_UPDATE, onPresence);
        sidebarOff = () => sock.off(WS_EVENTS.SIDEBAR_UPDATE, onSidebar);
        symbolsOff = () => sock.off(WS_EVENTS.SYMBOLS_UPDATE, onSymbols);
        membersOff = () => sock.off(WS_EVENTS.TOPIC_MEMBERS_UPDATED, onMembers);
      }
    }

    return () => {
      active = false;
      pollOff?.();
      presenceOff?.();
      sidebarOff?.();
      symbolsOff?.();
      membersOff?.();
      unsubscribe();
      socketRef.current = null;
    };
  }, [source, conversationKey, isFeed, isTopicMode, topic]);

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
        if (last) source.markRead?.(last.id);
        return;
      }
    }
    el.scrollTop = el.scrollHeight;
    if (last) source.markRead?.(last.id);
  }, [messages, source, highlightMessageId]);

  // Members ride on the topic bootstrap (TOPIC_JOIN ack). When the slug
  // changes, swap to the new initial list. Live deltas land via
  // TOPIC_MEMBERS_UPDATED, which is wired to the socket listener below.
  useEffect(() => {
    setMembers(initialMembers);
  }, [initialMembers]);

  useEffect(() => {
    if (!hashtagFilter || !isTopicMode || !topic || !caps.hashtags) {
      setFilteredMessages([]);
      return;
    }
    setFilteredLoading(true);
    apiFetch(`/api/topics/${topic.id}/messages?hashtag=${encodeURIComponent(hashtagFilter)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Message[]) => setFilteredMessages(data))
      .catch(() => setFilteredMessages([]))
      .finally(() => setFilteredLoading(false));
  }, [hashtagFilter, isTopicMode, topic, caps.hashtags]);

  const toggleReaction = useCallback((messageId: string, emojiKey: string) => {
    void source.react?.(messageId, emojiKey);
    setPickerFor(null);
  }, [source]);

  const handleKeyboardCallback = useCallback((msg: Message, callbackData: string) => {
    if (!msg.botId) return;
    socketRef.current?.emit(WS_EVENTS.BOT_KEYBOARD_CALLBACK, {
      botId: msg.botId,
      messageId: msg.id,
      callbackData,
    });
  }, []);

  const submitPoll = useCallback((data: { question: string; options: string[]; isAnonymous: boolean; allowsMultiple: boolean }) => {
    if (!isTopicMode || !topic) return;
    socketRef.current?.emit(WS_EVENTS.POLL_CREATE, { topicId: topic.id, ...data });
  }, [isTopicMode, topic]);

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
    void source.remove?.(messageId);
  }, [source]);

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
    if (!text || !source.edit) return;

    if (isE2ee) {
      // Always await ensureCrypto(): chatCryptoRef.current is non-null as
      // soon as the parent passes a chatCrypto prop, so a `?? ensureCrypto()`
      // fallthrough would silently skip cc.init() and the encrypt below
      // would throw "chat-crypto: not initialized" on the first edit of a
      // freshly-mounted DM. ensureCrypto() itself short-circuits when the
      // cc is already ready, so this is cheap on the hot path.
      const cc = await ensureCrypto();
      if (!cc) {
        setE2eeError("Encryption not initialized.");
        return;
      }
      let envelope: Record<string, unknown>;
      try {
        await refreshRoomMembers();
        await cc.ensureSession(memberUserIdsRef.current);
        envelope = (await cc.encrypt(text)) as unknown as Record<string, unknown>;
      } catch (err) {
        try {
          await cc.pumpOutgoing();
          envelope = (await cc.encrypt(text)) as unknown as Record<string, unknown>;
        } catch (err2) {
          console.error("[e2ee] edit encrypt failed", err2);
          setE2eeError("Encryption setup with peers in progress, try again in a moment.");
          return;
        }
      }
      await source.edit(messageId, { ciphertextJson: envelope });
      setDecryptedTexts((prev) => {
        const next = new Map(prev);
        next.set(messageId, text);
        return next;
      });
      setEditingId(null);
      setEditText("");
      return;
    }

    const processed = await processLinks(text);
    await source.edit(messageId, { text: processed });
    setEditingId(null);
    setEditText("");
  }, [editText, isE2ee, ensureCrypto, refreshRoomMembers, source]);

  const replyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of messages) {
      if (m.replyToMessageId) {
        counts.set(m.replyToMessageId, (counts.get(m.replyToMessageId) ?? 0) + 1);
      }
    }
    return counts;
  }, [messages]);

  // Reshape global symbol entries into RichTextEditor's row shape — kept stable
  // across renders so the editor's mirror-ref effects don't re-fire every tick.
  const rteSymbols = useMemo<RteSymbolEntry[]>(
    () => symbols.map((s) => ({ symbol: s.symbol, name: s.name, avatarUrl: s.linkedUserAvatarUrl })),
    [symbols],
  );

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

  // Decrypted plaintext cache keyed by message id. The Map mirrors the legacy
  // shape so the existing `getDisplayText` accessor stays the same.
  const [decryptedTexts, setDecryptedTexts] = useState<Map<string, string>>(new Map());
  const decryptedRef = useRef(decryptedTexts);
  useEffect(() => { decryptedRef.current = decryptedTexts; }, [decryptedTexts]);

  // Last decrypt error per message id. Populated by the drain loops below so
  // the lock-overlay reason modal can show a meaningful explanation.
  const [decryptErrors, setDecryptErrors] = useState<Map<string, string>>(new Map());
  const decryptErrorsRef = useRef(decryptErrors);
  useEffect(() => { decryptErrorsRef.current = decryptErrors; }, [decryptErrors]);

  // Which message's "why is this still encrypted?" modal is open, if any.
  const [encryptedReasonFor, setEncryptedReasonFor] =
    useState<{ messageId: string; reason: EncryptedReason } | null>(null);

  const messagesRef = useRef<Message[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Event-driven decrypt queue: every message that arrives with a ciphertext
  // and has not yet been decrypted gets dropped in this Set. The /api/crypto/
  // sync interval drains the Set instead of scanning the entire messages
  // array on each tick — O(pending) vs O(messages).
  const pendingDecryptRef = useRef<Set<string>>(new Set());

  const toIncomingEnvelope = useCallback((args: {
    envelope: Record<string, unknown>;
    senderUserId: string | null;
    messageId: string;
    createdAt: string | Date;
  }): IncomingEnvelope | null => {
    const cc = chatCryptoRef.current;
    if (!cc) return null;
    return {
      type: "m.room.encrypted",
      sender: cc.matrixSenderFor(args.senderUserId, currentUser.id),
      content: args.envelope as unknown as import("@/lib/crypto").EncryptedEnvelope,
      event_id: `$${args.messageId}`,
      origin_server_ts: typeof args.createdAt === "string"
        ? (Date.parse(args.createdAt) || Date.now())
        : args.createdAt.getTime(),
    };
  }, [currentUser.id]);

  useEffect(() => {
    if (!isE2ee || !e2eeReady || !e2eeRoomId) return;
    const cc = chatCryptoRef.current;
    if (!cc) return;
    for (const m of messagesRef.current) {
      if (m.ciphertextJson && !decryptedRef.current.has(m.id)) {
        pendingDecryptRef.current.add(m.id);
      }
    }
    let cancelled = false;
    void (async () => {
      const newly: Record<string, string> = {};
      for (const id of Array.from(pendingDecryptRef.current)) {
        const m = messagesRef.current.find((x) => x.id === id);
        if (!m?.ciphertextJson) { pendingDecryptRef.current.delete(id); continue; }
        const env = toIncomingEnvelope({
          envelope: m.ciphertextJson,
          senderUserId: m.senderUserId,
          messageId: m.id,
          createdAt: m.createdAt,
        });
        if (!env) continue;
        try {
          const plain = await cc.decrypt(env);
          newly[m.id] = plain;
          pendingDecryptRef.current.delete(id);
        } catch (err) {
          /* Locked row — retry on next drain. */
          const errMsg = describeDecryptError(err);
          if (typeof console !== "undefined" && !decryptErrorsRef.current.has(m.id)) {
            console.warn("[e2ee] decrypt failed", { messageId: m.id, err });
          }
          setDecryptErrors((prev) => {
            if (prev.get(m.id) === errMsg) return prev;
            const next = new Map(prev);
            next.set(m.id, errMsg);
            return next;
          });
        }
      }
      if (cancelled) return;
      const keys = Object.keys(newly);
      if (keys.length > 0) {
        setDecryptedTexts((prev) => {
          const next = new Map(prev);
          for (const k of keys) next.set(k, newly[k]!);
          return next;
        });
        setDecryptErrors((prev) => {
          let next: Map<string, string> | null = null;
          for (const k of keys) {
            if (prev.has(k)) {
              if (!next) next = new Map(prev);
              next.delete(k);
            }
          }
          return next ?? prev;
        });
      }
    })();
    return () => { cancelled = true; };
  }, [isE2ee, e2eeReady, e2eeRoomId, toIncomingEnvelope]);

  useEffect(() => {
    if (!isE2ee || !e2eeReady || !e2eeRoomId) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (interval) return;
      interval = setInterval(async () => {
        const cc = chatCryptoRef.current;
        if (!cc) return;
        try { await cc.pollSync(); } catch { return; }
        if (pendingDecryptRef.current.size === 0) return;
        const newly: Record<string, string> = {};
        for (const id of Array.from(pendingDecryptRef.current)) {
          const m = messagesRef.current.find((x) => x.id === id);
          if (!m?.ciphertextJson) { pendingDecryptRef.current.delete(id); continue; }
          if (decryptedRef.current.has(id)) { pendingDecryptRef.current.delete(id); continue; }
          const env = toIncomingEnvelope({
            envelope: m.ciphertextJson,
            senderUserId: m.senderUserId,
            messageId: m.id,
            createdAt: m.createdAt,
          });
          if (!env) continue;
          try {
            const plain = await cc.decrypt(env);
            newly[m.id] = plain;
            pendingDecryptRef.current.delete(id);
          } catch (err) {
            /* leave in Set; retry next drain */
            const errMsg = describeDecryptError(err);
            setDecryptErrors((prev) => {
              if (prev.get(m.id) === errMsg) return prev;
              const next = new Map(prev);
              next.set(m.id, errMsg);
              return next;
            });
          }
        }
        const keys = Object.keys(newly);
        if (keys.length > 0) {
          setDecryptedTexts((prev) => {
            const next = new Map(prev);
            for (const k of keys) next.set(k, newly[k]!);
            return next;
          });
          setDecryptErrors((prev) => {
            let next: Map<string, string> | null = null;
            for (const k of keys) {
              if (prev.has(k)) {
                if (!next) next = new Map(prev);
                next.delete(k);
              }
            }
            return next ?? prev;
          });
        }
      }, 5000);
    };
    const stopPolling = () => { if (interval) { clearInterval(interval); interval = null; } };
    const onVisibility = () => {
      if (document.visibilityState === "visible") startPolling();
      else stopPolling();
    };
    if (typeof document !== "undefined") {
      onVisibility();
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      stopPolling();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [isE2ee, e2eeReady, e2eeRoomId, toIncomingEnvelope]);

  function getDisplayText(msg: Message): string {
    if (!isE2ee) return msg.text;
    if (!msg.ciphertextJson) return msg.text;
    return decryptedTexts.get(msg.id) ?? "(encrypted…)";
  }

  function isStillEncrypted(msg: Message): boolean {
    return isE2ee && !!msg.ciphertextJson && !decryptedTexts.has(msg.id);
  }

  function getEncryptedReason(msg: Message): EncryptedReason {
    if (e2eeSetupNeeded) return { kind: "setup-required" };
    if (!e2eeReady && e2eeError) return { kind: "bootstrap-failed", error: e2eeError };
    if (!e2eeReady) return { kind: "initializing" };
    const err = decryptErrors.get(msg.id);
    if (err === undefined) return { kind: "missing-key" };
    if (/^UnknownMessageIndex\b/.test(err)) {
      return { kind: "predates-room-key", detail: err };
    }
    // A MissingRoomKey *may* carry a non-"None" withheld code, in which case
    // the sender's device deliberately withheld the key. Otherwise the key
    // simply hasn't arrived yet.
    if (/^MissingRoomKey\b/.test(err)) {
      const m = err.match(/withheld code:\s*([^\s,)]+)/i);
      if (m && m[1] && m[1].toLowerCase() !== "none") {
        return { kind: "withheld", detail: err };
      }
      return { kind: "missing-key", detail: err };
    }
    if (
      /MissingSessionKey|missing.*key|no.*inbound.*session|unknown.*(inbound.*)?session|UNKNOWN_OLM_MESSAGE|m\.no_olm/i.test(
        err,
      )
    ) {
      return { kind: "missing-key", detail: err };
    }
    return { kind: "decrypt-error", error: err };
  }

  async function uploadFile(file: File, bucket: "uploads" | "files" = "uploads", preserveOriginal = false): Promise<Attachment | null> {
    setUploading(true);
    try {
      const safeFile = preserveOriginal ? file : await stripImageMetadata(file);
      const form = new FormData();
      form.append("file", safeFile);
      form.append("bucket", bucket);
      if (preserveOriginal) form.append("preserveOriginal", "true");
      const res = await apiFetch("/api/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => ({})) as { url?: string; filename?: string; mimeType?: string; size?: number; error?: string; scope?: string; retryAfter?: number };
      if (!res.ok || !data.url) {
        if (res.status === 429) {
          const retry = data.retryAfter ?? Number(res.headers.get("retry-after")) ?? 60;
          const mins = Math.max(1, Math.ceil(retry / 60));
          const scopeLabel = data.scope === "hour" ? "hourly" : data.scope === "day" ? "daily" : "";
          showUploadError(`Original-quality upload limit reached (${scopeLabel}). Try again in ${mins} min.`);
        } else if (res.status === 403 && data.error === "originals disabled") {
          showUploadError("Original-quality uploads are disabled by the admin.");
        } else if (data.error === "image contains metadata") {
          showUploadError("Image metadata detected. Re-encode failed — try a different image.");
        } else if (data.error) {
          showUploadError(data.error);
        } else {
          showUploadError(`Upload failed (${res.status})`);
        }
        return null;
      }
      if (bucket === "files") {
        return { type: "file", url: data.url, filename: data.filename, mimeType: data.mimeType, size: data.size };
      }
      return { type: "image", url: data.url };
    } catch (err) {
      showUploadError((err as Error).message || "Upload failed");
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function uploadAsImage(file: File): Promise<Attachment | null> {
    // Image path: strips+resizes via stripImageMetadata, attaches as image.
    return uploadFile(file, "uploads", false);
  }

  async function uploadAsOriginal(file: File): Promise<Attachment | null> {
    // File path: preserve original. Images go to uploads bucket (skip strip),
    // anything else to files bucket.
    const isImage = file.type.startsWith("image/");
    return uploadFile(file, isImage ? "uploads" : "files", true);
  }

  function isMarkdownFile(file: File): boolean {
    if (file.type === "text/markdown" || file.type === "text/x-markdown") return true;
    return /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i.test(file.name);
  }

  async function loadMarkdownIntoDraft(file: File): Promise<void> {
    const text = await file.text();
    setDraft(text);
    editorRef.current?.setContent(text);
    editorRef.current?.focus();
  }

  async function handleDroppedFiles(files: File[], mode: "image" | "original") {
    // Pull .md/.markdown out of the batch and load the first one into the
    // compose editor as draft; the rest (if any) go through the upload path.
    // Multiple .md files: only the first is loaded; extras are ignored to
    // avoid silently clobbering. Could prompt later if needed.
    const mdFiles = files.filter(isMarkdownFile);
    const rest = files.filter((f) => !isMarkdownFile(f));
    if (mdFiles[0]) {
      try { await loadMarkdownIntoDraft(mdFiles[0]); }
      catch (err) { showUploadError(`Failed to read markdown file: ${(err as Error).message}`); }
    }
    if (rest.length > 0) await uploadAndAttach(rest, mode);
  }

  async function uploadAndAttach(files: File[], mode: "image" | "original") {
    for (const file of files) {
      const att = mode === "image"
        ? (file.type.startsWith("image/") ? await uploadAsImage(file) : await uploadAsOriginal(file))
        : await uploadAsOriginal(file);
      if (att) setPendingAttachments((prev) => [...prev, att]);
    }
  }

  function exportDraftAsMarkdown(): void {
    const content = draft.trim();
    if (!content) return;
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${topic?.slug ?? conversationKey}-${stamp}.md`;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
    if ((!text && pendingAttachments.length === 0) || topicMute) return;

    const processed = text ? await processLinks(text) : text;

    let finalText = processed;
    let ciphertextEnvelope: Record<string, unknown> | null = null;
    if (isE2ee) {
      // Always await ensureCrypto() — see submitEdit() above for the full
      // rationale: chatCryptoRef.current being non-null is the common case
      // and would otherwise short-circuit the only call site that drives
      // cc.init(), leaving cc.encrypt to throw "not initialized".
      const cc = await ensureCrypto();
      if (!cc) {
        setE2eeError("encryption not initialized");
        return;
      }
      try {
        await refreshRoomMembers();
        await cc.ensureSession(memberUserIdsRef.current);
        const envelope = await cc.encrypt(processed);
        ciphertextEnvelope = envelope as unknown as Record<string, unknown>;
        finalText = "";
      } catch (err) {
        try {
          await cc.pumpOutgoing();
          const envelope = await cc.encrypt(processed);
          ciphertextEnvelope = envelope as unknown as Record<string, unknown>;
          finalText = "";
        } catch (err2) {
          console.error("[e2ee] encrypt failed", err, err2);
          setE2eeError("Encryption setup with peers in progress, try again in a moment.");
          return;
        }
      }
    }

    const hashtags: string[] = [];
    if (source.capabilities.hashtags) {
      const hashRegex = /#([a-zA-Z]\w*)/g;
      const symRegex = /\$([a-zA-Z]\w*)/g;
      let m: RegExpExecArray | null;
      while ((m = hashRegex.exec(processed)) !== null) {
        const tag = `#${m[1]!.toLowerCase()}`;
        if (!hashtags.includes(tag)) hashtags.push(tag);
      }
      while ((m = symRegex.exec(processed)) !== null) {
        const sym = m[1]!.toLowerCase();
        if (symbols.some((s) => s.symbol === sym)) {
          const tag = `$${sym}`;
          if (!hashtags.includes(tag)) hashtags.push(tag);
        }
      }
    }

    const isE2eeSend = isE2ee && ciphertextEnvelope !== null;
    await source.send({
      text: finalText,
      attachments: isE2eeSend
        ? undefined
        : (pendingAttachments.length > 0 ? pendingAttachments : undefined),
      replyToMessageId: replyingTo?.id,
      hashtags: isE2eeSend ? undefined : (hashtags.length > 0 ? hashtags : undefined),
      ciphertextJson: ciphertextEnvelope ?? undefined,
    });
    setDraft("");
    setPendingAttachments([]);
    setReplyingTo(null);
    localStorage.removeItem(draftKey);
  }

  const canSend = (draft.trim().length > 0 || pendingAttachments.length > 0) && !topicMute && !uploading && canPost;

  function toggleThread(postId: string) {
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  }

  function sendReply(parentId: string, text: string) {
    void source.send({ text, replyToMessageId: parentId });
  }

  const filteredMembers = useMemo(() => {
    const q = membersSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.displayName.toLowerCase().includes(q));
  }, [members, membersSearch]);

  // Render-ready admin recipient list for the banner. Falls back to "no admins"
  // when no admin row resolved (shouldn't happen for E2EE topics in Plan D, but
  // we explicitly distinguish the empty case so support can spot it).
  const adminListLabel = adminUserIds.length === 0
    ? "no admins"
    : adminUserIds
        .map((id) => adminDisplayNames.get(id) ?? `${id.slice(0, 8)}…`)
        .join(", ");

  if (isDmMode && dmConversation && dmConversation.state !== "accepted") {
    return (
      <section className="flex h-full min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border bg-panel px-4 pb-4 pt-[calc(1rem+var(--sat))] md:px-6">
          <button
            type="button"
            onClick={onMenuOpen}
            className="shrink-0 rounded-md p-1 hover:bg-panel2 transition md:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
          {dmConversation.peer && (
            <Avatar name={dmConversation.peer.displayName} url={dmConversation.peer.avatarUrl} size={9} />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold truncate">{headerTitle}</h1>
            <p className="text-xs text-muted">
              {dmConversation.state === "pending"
                ? (dmConversation.incoming ? "Conversation request" : "Awaiting reply")
                : "Conversation blocked"}
            </p>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="rounded-2xl border border-border bg-panel p-6 max-w-md w-full text-center space-y-3">
            <h2 className="text-base font-semibold">
              {dmConversation.state === "pending"
                ? (dmConversation.incoming
                    ? `${dmConversation.peer?.displayName ?? "Someone"} wants to chat`
                    : `Waiting for ${dmConversation.peer?.displayName ?? "them"} to accept`)
                : "This conversation is blocked"}
            </h2>
            {dmConversation.state === "pending" && dmConversation.incoming && (
              <div className="flex gap-2 justify-center">
                <button
                  type="button"
                  onClick={async () => {
                    const r = await apiFetch(`/api/dm/${dmConversation.id}/accept`, { method: "POST" });
                    if (r.ok) window.location.reload();
                  }}
                  className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white"
                >Accept</button>
                <button
                  type="button"
                  onClick={async () => {
                    await apiFetch(`/api/dm/${dmConversation.id}/decline`, { method: "POST" });
                    window.location.href = "/";
                  }}
                  className="rounded-lg bg-panel2 px-3 py-2 text-sm font-medium"
                >Decline</button>
                <button
                  type="button"
                  onClick={async () => {
                    await apiFetch(`/api/dm/${dmConversation.id}/block`, { method: "POST" });
                    window.location.href = "/";
                  }}
                  className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
                >Block</button>
              </div>
            )}
            {dmConversation.state === "pending" && !dmConversation.incoming && (
              <p className="text-sm text-muted">
                Your first message is waiting for the other side to accept. You'll be able to send more once they do.
              </p>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <HashtagClickContext.Provider value={{ onHashtagClick: caps.hashtags ? setHashtagFilter : () => {} }}>
    <>
      {showSearch && caps.members && isTopicMode && topic && <SearchModal onClose={() => setShowSearch(false)} currentTopicId={topic.id} />}
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <EncryptedReasonModal
        open={encryptedReasonFor !== null}
        onClose={() => setEncryptedReasonFor(null)}
        reason={encryptedReasonFor?.reason ?? null}
      />
      {dragActive && (
        <div
          className="fixed inset-0 z-[9990] flex flex-col bg-black/60 backdrop-blur-sm p-4 gap-3"
          onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; }}
        >
          <div
            onDragEnter={() => setHoverZone("original")}
            onDragOver={(e) => { e.preventDefault(); if (hoverZone !== "original") setHoverZone("original"); }}
            onDrop={async (e) => {
              e.preventDefault();
              const files = Array.from(e.dataTransfer.files);
              dragCounter.current = 0;
              setDragActive(false);
              setHoverZone(null);
              if (files.length > 0) await handleDroppedFiles(files, "original");
            }}
            className={cn(
              "flex-1 rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-2 transition",
              hoverZone === "original"
                ? "border-accent bg-accent/10 text-text"
                : "border-border bg-panel/60 text-muted",
            )}
          >
            <FileIcon className="h-10 w-10" />
            <p className="text-base font-semibold text-text">Original quality</p>
            <p className="text-xs text-muted">Sends as a file attachment for any type</p>
          </div>
          <div
            onDragEnter={() => setHoverZone("image")}
            onDragOver={(e) => { e.preventDefault(); if (hoverZone !== "image") setHoverZone("image"); }}
            onDrop={async (e) => {
              e.preventDefault();
              const files = Array.from(e.dataTransfer.files);
              dragCounter.current = 0;
              setDragActive(false);
              setHoverZone(null);
              if (files.length > 0) await handleDroppedFiles(files, "image");
            }}
            className={cn(
              "flex-1 rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-2 transition",
              hoverZone === "image"
                ? "border-accent bg-accent/10 text-text"
                : "border-border bg-panel/60 text-muted",
            )}
          >
            <ImageIcon className="h-10 w-10" />
            <p className="text-base font-semibold text-text">Compressed image</p>
            <p className="text-xs text-muted">Strips metadata and resizes (images only; non-images use Original)</p>
          </div>
        </div>
      )}
      {showTopicInfo && isTopicMode && topic && (
        <TopicInfoModal
          topic={{
            id: topic.id,
            title: topic.title,
            iconUrl: topic.iconUrl ?? null,
            bannerUrl: topic.bannerUrl ?? null,
            description: topic.description ?? null,
          }}
          socket={socketRef.current}
          onClose={() => setShowTopicInfo(false)}
          onHashtagFilter={(tag) => {
            setShowTopicInfo(false);
            setHashtagFilter(tag);
          }}
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
          onClick={() => { if (isTopicMode) setShowTopicInfo(true); }}
          className="flex-1 text-left min-w-0 flex items-center gap-2"
        >
          {isDmMode && dmConversation?.peer && (
            <Avatar name={dmConversation.peer.displayName} url={dmConversation.peer.avatarUrl} size={9} />
          )}
          <div className="min-w-0 flex-1">
            <h1 className={cn("text-lg font-semibold truncate", isTopicMode && "hover:underline decoration-muted underline-offset-2")}>{headerTitle}</h1>
            <p className="flex items-center gap-1.5 text-xs text-muted">
              {isE2ee
                ? <Lock className="h-3 w-3 text-accent2" />
                : <span className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-yellow-500 animate-pulse"}`} />
              }
              {connected ? "connected" : "connecting…"}
            </p>
          </div>
        </button>
        {caps.members && (
          <>
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
          </>
        )}
      </header>

      {hashtagFilter && (
        <div className="flex items-center gap-2 border-b border-border bg-panel2 px-4 py-2 text-sm">
          <span className="text-muted">Filtered:</span>
          <span className={hashtagFilter.startsWith("$") ? "font-mono text-amber-400 font-semibold" : "font-mono text-accent"}>
            {hashtagFilter}
          </span>
          <button
            type="button"
            className="ml-auto rounded p-1 hover:bg-border transition"
            onClick={() => setHashtagFilter(null)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <AnimatePresence>
        {caps.members && showUsers && (
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
      {hashtagFilter ? (
        <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
          {hashtagFilter.startsWith("$") && (() => {
            const sym = symbols.find((s) => s.symbol === hashtagFilter.slice(1));
            if (!sym) return null;
            return (
              <div className="mx-4 mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 shrink-0">
                <div className="flex items-center gap-3">
                  {sym.linkedUserAvatarUrl ? (
                    <img src={sym.linkedUserAvatarUrl} alt="" className="h-10 w-10 rounded-full object-cover shrink-0" />
                  ) : (
                    <div className="h-10 w-10 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                      <span className="text-amber-400 font-bold text-sm">{sym.symbol.slice(0, 1).toUpperCase()}</span>
                    </div>
                  )}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-amber-400 font-semibold">${sym.symbol}</span>
                      <span className="font-medium text-text">{sym.name}</span>
                    </div>
                    {sym.description && <p className="text-xs text-muted mt-0.5">{sym.description}</p>}
                    {sym.linkedUserDisplayName && (
                      <p className="text-xs text-muted mt-0.5">@{sym.linkedUserDisplayName}</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
            {filteredLoading && <p className="text-sm text-muted text-center py-8">Loading…</p>}
            {!filteredLoading && filteredMessages.length === 0 && (
              <p className="text-sm text-muted text-center py-8">No messages with {hashtagFilter} yet.</p>
            )}
            {filteredMessages.map((msg) => {
              const mine = msg.senderUserId === currentUser.id;
              const perEmoji = reactionsByMessage.get(msg.id);
              return (
                <div key={msg.id} className={cn("group flex gap-2 rounded-lg", mine ? "flex-row-reverse" : "flex-row")}>
                  {!mine ? (
                    <div className="mt-1 w-8 shrink-0 flex items-start justify-center">
                      <button type="button" onClick={() => msg.senderUserId && setViewingUserId(msg.senderUserId)} className="rounded-full focus:outline-none">
                        <Avatar name={msg.senderDisplayName ?? (msg.senderUserId ? null : (communityName ?? "System"))} url={msg.senderAvatarUrl ?? (msg.senderUserId ? null : (communityIconUrl ?? null))} size={8} />
                      </button>
                    </div>
                  ) : (
                    <div className="mt-1 w-8 shrink-0 flex items-start justify-center">
                      <Avatar name={currentUser.displayName} url={msg.senderAvatarUrl ?? currentUser.avatarUrl} size={8} />
                    </div>
                  )}
                  <div className={cn("min-w-0 max-w-[72%]", mine ? "items-end" : "items-start", "flex flex-col")}>
                    {!mine && msg.senderDisplayName && (
                      <div className="mb-1 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => msg.senderUserId && setViewingUserId(msg.senderUserId)}
                          className="text-left text-xs font-medium hover:underline text-accent2"
                        >
                          {msg.senderDisplayName}
                        </button>
                      </div>
                    )}
                    <div className={cn("relative group/bubble rounded-2xl px-4 py-2 text-sm min-w-0 max-w-full", mine ? "bg-accent text-white" : "bg-panel2 text-text",
                      !isStillEncrypted(msg) && getDisplayText(msg).trim() === "" && msg.attachments.length > 0 && "p-1")}>
                      {msg.attachments.length > 0 && (
                        <div className={cn("flex flex-col gap-1", (isStillEncrypted(msg) || getDisplayText(msg).trim()) && "mb-2")}>
                          {msg.attachments.map((att, ai) =>
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
                      {isStillEncrypted(msg) ? (
                        <EncryptedMessageContent
                          messageId={msg.id}
                          mine={mine}
                          reasonKind={getEncryptedReason(msg).kind}
                          onShowReason={() => setEncryptedReasonFor({ messageId: msg.id, reason: getEncryptedReason(msg) })}
                        />
                      ) : getDisplayText(msg).trim() && (
                        <MarkdownContent content={getDisplayText(msg)} className={cn("text-sm break-words", mine && "[&_*]:text-white [&_code]:bg-white/20 [&_pre]:bg-white/20")} />
                      )}
                      <div suppressHydrationWarning className={cn("mt-1 flex items-center gap-1 text-[10px]", mine ? "text-white/70 justify-end" : "text-muted")}>
                        {msg.editedAt && <span className="italic opacity-70">edited</span>}
                        {friendlyTime(msg.createdAt)}
                      </div>
                    </div>
                    {caps.reactions && perEmoji && perEmoji.size > 0 && (
                      <div className={cn("mt-1 flex flex-wrap gap-1", mine ? "justify-end" : "justify-start")}>
                        {Array.from(perEmoji.entries()).map(([key, users]) => {
                          const reacted = users.includes(currentUser.id);
                          return (
                            <button key={key} type="button" onClick={() => toggleReaction(msg.id, key)}
                              className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", reacted ? "border-accent bg-accent/20" : "border-border bg-panel")}>
                              <span>{EMOJI_GLYPH[key] ?? key}</span>
                              <span className="text-muted">{users.length}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (<>
      <div ref={scrollerRef} className={cn("flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 py-4", isFeed ? "space-y-4" : "space-y-1")}>
        {isE2ee && (
          <div className="mb-3 rounded-lg border border-border bg-panel2 px-3 py-2 text-xs text-muted">
            <span aria-hidden="true">🔒</span>{" "}
            <span className="font-medium text-text">End-to-end encrypted.</span>{" "}
            Visible to admins: <span className="text-text">{adminListLabel}</span>.{" "}
            New members will NOT see prior messages.
          </div>
        )}
        {isE2ee && e2eeSetupNeeded && !e2eeReady && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-panel2 px-3 py-2 text-xs text-muted">
            <span>Enable encryption to read and send messages in this topic.</span>
            <button
              type="button"
              onClick={() => { ensureCrypto().catch(() => {}); }}
              className="ml-auto rounded bg-accent2 px-3 py-1 text-xs text-white"
            >Initialize</button>
          </div>
        )}
        {e2eeError && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <span className="flex-1">{e2eeError}</span>
            <button type="button" onClick={() => setE2eeError(null)} className="text-danger/70 hover:text-danger underline">dismiss</button>
          </div>
        )}
        {(() => {
          const topLevelMessages = isFeed ? messages.filter((m) => !m.replyToMessageId) : messages;
          const repliesByParent = isFeed
            ? messages.reduce<Map<string, Message[]>>((acc, m) => {
                if (!m.replyToMessageId) return acc;
                const parentId = String(m.replyToMessageId);
                const arr = acc.get(parentId) ?? [];
                arr.push(m);
                acc.set(parentId, arr);
                return acc;
              }, new Map())
            : new Map<string, Message[]>();
          return (
        <AnimatePresence initial={false}>
          {topLevelMessages.map((m, i) => {
            const mine = m.senderUserId === currentUser.id;
            const perEmoji = reactionsByMessage.get(m.id);
            const prevMsg = topLevelMessages[i - 1];
            const isNewGroup =
              !prevMsg ||
              prevMsg.senderUserId !== m.senderUserId ||
              new Date(m.createdAt).getTime() - new Date(prevMsg.createdAt).getTime() > 5 * 60 * 1000;
            const showSender = !mine && isNewGroup;

            if (isFeed) {
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
                      name={m.senderDisplayName ?? (m.senderUserId ? null : (communityName ?? "System"))}
                      url={m.senderAvatarUrl ?? (m.senderUserId ? null : (communityIconUrl ?? null))}
                      size={9}
                      online={!currentUser.presenceOptOut && !!m.senderUserId && onlineUsers.has(m.senderUserId)}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{m.senderDisplayName ?? communityName ?? "System"}</div>
                      <div suppressHydrationWarning className="text-xs text-muted">{friendlyTime(m.createdAt)}</div>
                    </div>
                    {caps.reactions && !isStillEncrypted(m) && (
                      <div className="ml-auto flex gap-2 opacity-0 transition group-hover:opacity-100">
                        <button
                          ref={(el) => { if (el) reactionBtnRefs.current.set(m.id, el); else reactionBtnRefs.current.delete(m.id); }}
                          type="button" className="text-muted hover:text-text"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); setPickerFor(pickerFor === m.id ? null : m.id); }}>
                          <SmilePlus className="h-4 w-4" />
                        </button>
                      </div>
                    )}
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

                  {isStillEncrypted(m) ? (
                    <EncryptedMessageContent
                      messageId={m.id}
                      mine={false}
                      reasonKind={getEncryptedReason(m).kind}
                      onShowReason={() => setEncryptedReasonFor({ messageId: m.id, reason: getEncryptedReason(m) })}
                    />
                  ) : getDisplayText(m).trim() && (
                    <MarkdownContent content={getDisplayText(m)} className="text-sm" />
                  )}

                  {caps.reactions && perEmoji && perEmoji.size > 0 && (
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

                  {caps.reactions && pickerFor === m.id && (
                    <EmojiPickerPopover
                      anchorRef={{ current: reactionBtnRefs.current.get(m.id) ?? null }}
                      onSelect={(glyph) => toggleReaction(m.id, glyph)}
                      onClose={() => setPickerFor(null)}
                    />
                  )}

                  {caps.threads && !isStillEncrypted(m) && (() => {
                    const postId = String(m.id);
                    const replies = repliesByParent.get(postId) ?? [];
                    const isExpanded = expandedThreads.has(postId);
                    return (
                      <div className="mt-3 pt-3 border-t border-border/50">
                        <button
                          type="button"
                          className="text-xs text-muted hover:text-text transition"
                          onClick={(e) => { e.stopPropagation(); toggleThread(postId); }}
                        >
                          {replies.length > 0
                            ? `${isExpanded ? "Hide" : "Show"} ${replies.length} comment${replies.length === 1 ? "" : "s"}`
                            : canReply ? "Leave a comment" : "No comments yet"}
                        </button>

                        {isExpanded && (
                          <div className="mt-3 space-y-3">
                            {replies.map((r) => (
                              <div key={String(r.id)} className="flex items-start gap-2">
                                <Avatar
                                  name={r.senderDisplayName ?? (r.senderUserId ? null : (communityName ?? "System"))}
                                  url={r.senderAvatarUrl ?? (r.senderUserId ? null : null)}
                                  size={6}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-baseline gap-2">
                                    <span className="text-xs font-medium">{r.senderDisplayName ?? communityName ?? "System"}</span>
                                    <span suppressHydrationWarning className="text-[10px] text-muted">{friendlyTime(r.createdAt)}</span>
                                  </div>
                                  <MarkdownContent content={r.text ?? ""} className="text-sm" />
                                </div>
                              </div>
                            ))}

                            {canReply && replyingToPost !== postId && (
                              <button
                                type="button"
                                className="text-xs text-accent mt-1"
                                onClick={(e) => { e.stopPropagation(); setReplyingToPost(postId); }}
                              >
                                + Comment
                              </button>
                            )}

                            {canReply && replyingToPost === postId && (
                              <div className="flex items-start gap-2 mt-2">
                                <textarea
                                  className="flex-1 rounded border border-border bg-panel px-2 py-1.5 text-sm resize-none"
                                  rows={2}
                                  placeholder="Write a comment…"
                                  value={replyDraft}
                                  onChange={(e) => setReplyDraft(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === "Enter" && !e.shiftKey) {
                                      e.preventDefault();
                                      if (!replyDraft.trim()) return;
                                      sendReply(postId, replyDraft.trim());
                                      setReplyDraft("");
                                      setReplyingToPost(null);
                                    }
                                  }}
                                />
                                <button
                                  type="button"
                                  className="rounded bg-accent px-2 py-1.5 text-xs text-white"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!replyDraft.trim()) return;
                                    sendReply(postId, replyDraft.trim());
                                    setReplyDraft("");
                                    setReplyingToPost(null);
                                  }}
                                >
                                  Send
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}
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
                        <Avatar name={m.senderDisplayName ?? (m.senderUserId ? null : (communityName ?? "System"))} url={m.senderAvatarUrl ?? (m.senderUserId ? null : (communityIconUrl ?? null))} size={8}
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
                            <span className="opacity-70">{parent ? (isStillEncrypted(parent) ? "(encrypted)" : getDisplayText(parent).slice(0, 60)) : "(message)"}</span>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {caps.polls && m.poll ? (
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
                    !isStillEncrypted(m) && getDisplayText(m).trim() === "" && m.attachments.length > 0 && "p-1")}>
                    {caps.reactions && !isStillEncrypted(m) && (
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
                    )}
                    {caps.threads && !isStillEncrypted(m) && (
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
                    )}
                    {m.attachments.length > 0 && (
                      <div className={cn("flex flex-col gap-1", (isStillEncrypted(m) || getDisplayText(m).trim()) && "mb-2")}>
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
                    {isStillEncrypted(m) ? (
                      <EncryptedMessageContent
                        messageId={m.id}
                        mine={mine}
                        reasonKind={getEncryptedReason(m).kind}
                        onShowReason={() => setEncryptedReasonFor({ messageId: m.id, reason: getEncryptedReason(m) })}
                      />
                    ) : getDisplayText(m).trim() && (
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

                  {caps.threads && (replyCounts.get(m.id) ?? 0) >= 3 && (
                    <button
                      type="button"
                      onClick={() => setThreadFor(m)}
                      className={cn("mt-1 flex items-center gap-1.5 text-xs text-accent hover:underline", mine && "self-end")}
                    >
                      <MessageSquareText className="h-3 w-3" />
                      View thread ({replyCounts.get(m.id)})
                    </button>
                  )}

                  {caps.reactions && perEmoji && perEmoji.size > 0 && (
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

                  {caps.reactions && pickerFor === m.id && (
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
          );
        })()}
      </div>

      {threadFor && caps.threads && isTopicMode && topic && (
        <ThreadPanel
          rootMessage={threadFor}
          topicId={topic.id}
          currentUserId={currentUser.id}
          isE2ee={isE2ee}
          onClose={() => setThreadFor(null)}
          onReply={(msgId) => {
            const msg = messages.find((m) => m.id === msgId);
            if (msg) setReplyingTo(msg);
            setThreadFor(null);
          }}
        />
      )}
      </>)}
      </div>

      {/* Multi-select action bar */}
      {isSelecting && (
        <div className="border-t border-border bg-panel px-4 pt-2.5 pb-[calc(0.625rem+var(--sab))] flex items-center gap-3 shrink-0">
          <span className="text-sm font-semibold text-text">{selectedIds.size} selected</span>
          <div className="flex-1" />
          {caps.delete && (canDeleteOwn || canDeleteAny) && (
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

      {!hashtagFilter && (topicMute ? (
        <div suppressHydrationWarning className="border-t border-border bg-panel px-6 pt-4 pb-[calc(1rem+var(--sab))] text-sm text-danger shrink-0">
          You are muted: {topicMute.reason}
          {topicMute.expiresAt ? ` (until ${new Date(topicMute.expiresAt).toLocaleString()})` : " (permanent)"}
        </div>
      ) : !canPost ? (
        <div className="border-t border-border bg-panel px-6 pt-4 pb-[calc(1rem+var(--sab))] text-sm text-muted shrink-0">
          {isTopicMode && topic
            ? `Only ${topic.postRoles.join(", ")} can post in this channel.`
            : isDmMode && dmConversation?.state === "pending"
              ? "This conversation is pending approval."
              : "You cannot post in this conversation."}
        </div>
      ) : (
        <div className="border-t border-border bg-panel px-3 pt-2 pb-[calc(0.375rem+var(--sab))] shrink-0">
          {caps.threads && replyingTo && (
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
          {uploadError && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              <span className="flex-1">{uploadError}</span>
              <button
                type="button"
                onClick={() => setUploadError(null)}
                className="text-danger/70 hover:text-danger shrink-0"
                aria-label="Dismiss"
              >
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
                placeholder={uploading ? "Uploading…" : isFeed ? "Write a post… (Ctrl+Enter to send)" : enterSends ? "Write a message… (Enter to send)" : "Write a message… (Ctrl+Enter to send)"}
                compact={!isFeed}
                enterSends={isFeed ? false : enterSends}
                disabled={uploading}
                members={caps.mentions ? members : EMPTY_RTE_MEMBERS}
                topicTags={caps.hashtags ? topicTags : EMPTY_RTE_TAGS}
                symbols={caps.hashtags ? rteSymbols : EMPTY_RTE_SYMBOLS}
              />
              <div className="flex items-center gap-2">
                {canAttach && (
                  <Tooltip label="Attach image — stripped & compressed">
                    <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                      aria-label="Attach image — stripped and compressed"
                      className="text-muted hover:text-text disabled:opacity-50">
                      <ImagePlus className="h-4 w-4" />
                    </button>
                  </Tooltip>
                )}
                {canAttach && (
                  <Tooltip label="Attach file — original quality">
                    <button type="button" onClick={() => fileUploadRef.current?.click()} disabled={uploading}
                      aria-label="Attach file — original quality"
                      className="text-muted hover:text-text disabled:opacity-50">
                      <Paperclip className="h-4 w-4" />
                    </button>
                  </Tooltip>
                )}
                <Tooltip label="GIF picker">
                  <button type="button" onClick={() => setShowGifPicker((v) => !v)}
                    aria-label="GIF picker"
                    className={cn("text-muted hover:text-text", showGifPicker && "text-accent")}>
                    <Sticker className="h-4 w-4" />
                  </button>
                </Tooltip>
                <Tooltip label="Emoji">
                  <button ref={composeEmojiRef} type="button" onClick={() => setShowComposeEmoji((v) => !v)}
                    aria-label="Emoji picker"
                    className={cn("text-muted hover:text-text", showComposeEmoji && "text-accent")}>
                    <SmilePlus className="h-4 w-4" />
                  </button>
                </Tooltip>
                {caps.polls && canCreatePoll && (
                  <button type="button" onClick={() => setShowPollCreator(true)}
                    className={cn("text-muted hover:text-text", showPollCreator && "text-accent")} title="Create poll">
                    <BarChart2 className="h-4 w-4" />
                  </button>
                )}
                {isFeed && (
                  <Tooltip label="Export draft as Markdown">
                    <button
                      type="button"
                      onClick={exportDraftAsMarkdown}
                      disabled={!draft.trim()}
                      aria-label="Export draft as Markdown"
                      className="text-muted hover:text-text disabled:opacity-40"
                    >
                      <FileText className="h-4 w-4" />
                    </button>
                  </Tooltip>
                )}
                <div className="flex-1" />
                {!isFeed && (
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
                    isFeed
                      ? "rounded-lg bg-accent px-4 py-1.5 text-sm text-white hover:opacity-90"
                      : "rounded-lg bg-accent p-1.5 text-white hover:opacity-90",
                  )}>
                  {isFeed ? "Post" : <Send className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length === 0) return;
                await uploadAndAttach(files, "image");
              }} />
            <input ref={fileUploadRef} type="file" multiple className="hidden"
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length === 0) return;
                await uploadAndAttach(files, "original");
              }} />
          </div>
        </div>
      ))}

      {caps.polls && showPollCreator && (
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

      {/* Context menu portal — desktop = cursor-anchored popover, mobile = bottom sheet. Both render the same content (preview header + quick-reactions row + action list); only the container chrome differs. */}
      {contextMenu && typeof document !== "undefined" && (() => {
        const items = [
          ...(caps.threads ? [{ icon: CornerDownLeft, label: "Reply", action: () => { setReplyingTo(contextMenu.msg); setContextMenu(null); } }] : []),
          { icon: Copy, label: "Copy", action: () => { void copyMessage(getDisplayText(contextMenu.msg)); setContextMenu(null); } },
          ...(!isSelecting ? [{ icon: CheckSquare, label: "Select", action: () => { toggleSelection(contextMenu.msg.id); setContextMenu(null); } }] : [
            { icon: CheckSquare, label: selectedIds.has(contextMenu.msg.id) ? "Deselect" : "Add to selection", action: () => { toggleSelection(contextMenu.msg.id); setContextMenu(null); } },
          ]),
          ...((caps.edit && (((contextMenu.msg.senderUserId === currentUser.id && canEditOwn) || canEditAny) && !contextMenu.msg.poll))
            ? [{ icon: Pencil, label: "Edit", action: () => { startEdit(contextMenu.msg, getDisplayText(contextMenu.msg)); setContextMenu(null); } }]
            : []),
          ...((caps.delete && ((contextMenu.msg.senderUserId === currentUser.id && canDeleteOwn) || canDeleteAny))
            ? [{ icon: Trash2, label: "Delete", danger: true as const, action: () => { deleteMessage(contextMenu.msg.id); setContextMenu(null); } }]
            : []),
          { icon: Flag, label: "Report", danger: true as const, action: () => { void reportMessage(contextMenu.msg.id); setContextMenu(null); } },
        ];

        const isDesktop = contextMenu.anchor !== null;

        const Preview = (
          <div className="px-4 pt-3 pb-2.5 border-b border-border">
            {contextMenu.msg.senderDisplayName && (
              <p className="text-xs font-semibold text-accent2 mb-0.5 truncate">{contextMenu.msg.senderDisplayName}</p>
            )}
            <p className="text-sm text-muted line-clamp-2 break-words">
              {getDisplayText(contextMenu.msg).trim() || (contextMenu.msg.attachments.length > 0 ? "📎 Attachment" : "")}
            </p>
          </div>
        );

        const QuickReactionsRow = caps.reactions ? (
          <div className="flex items-center justify-between px-2 py-2 border-b border-border">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={cn(
                  "flex items-center justify-center rounded-full hover:bg-panel2 active:scale-90 transition",
                  isDesktop ? "h-8 w-8 text-base" : "h-10 w-10 text-xl",
                )}
                onClick={() => { toggleReaction(contextMenu.msg.id, emoji); setContextMenu(null); }}
              >
                {emoji}
              </button>
            ))}
            <button
              ref={(el) => { if (el) reactionBtnRefs.current.set(`ctx-${contextMenu.msg.id}`, el); else reactionBtnRefs.current.delete(`ctx-${contextMenu.msg.id}`); }}
              type="button"
              className={cn(
                "flex items-center justify-center rounded-full hover:bg-panel2 transition text-muted hover:text-text",
                isDesktop ? "h-8 w-8" : "h-10 w-10",
              )}
              onClick={() => { setPickerFor(contextMenu.msg.id); setContextMenu(null); }}
            >
              <SmilePlus className={isDesktop ? "h-4 w-4" : "h-5 w-5"} />
            </button>
          </div>
        ) : null;

        const Actions = (
          <div className={isDesktop ? "py-1" : "py-1 pb-[max(0.25rem,var(--sab))]"}>
            {items.map(({ icon: Icon, label, action, danger }) => (
              <button
                key={label}
                type="button"
                onClick={action}
                className={cn(
                  "flex w-full items-center transition hover:bg-panel2 active:bg-panel2 text-left",
                  isDesktop ? "gap-2.5 px-3 py-1.5 text-sm" : "gap-3 px-5 py-3 text-sm",
                  danger ? "text-danger" : "text-text",
                )}
              >
                <Icon className={isDesktop ? "h-3.5 w-3.5 shrink-0" : "h-4 w-4 shrink-0"} />
                {label}
              </button>
            ))}
          </div>
        );

        // ── Desktop: small popover anchored to the cursor, flipped into the viewport if needed.
        if (isDesktop) {
          const W = 260;
          const H = (caps.reactions ? 56 : 0) + 62 /* preview */ + items.length * 34 + 8;
          const x = Math.min(contextMenu.anchor!.x, window.innerWidth - W - 8);
          const y = Math.min(contextMenu.anchor!.y, window.innerHeight - H - 8);
          return createPortal(
            <>
              <div
                className="fixed inset-0 z-[9989]"
                onMouseDown={() => setContextMenu(null)}
                onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
              />
              <div
                role="menu"
                className="fixed z-[9998] w-[260px] overflow-hidden rounded-md border border-border bg-panel shadow-lg"
                style={{ top: y, left: x }}
                onMouseDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.preventDefault()}
              >
                {Preview}
                {QuickReactionsRow}
                {Actions}
              </div>
            </>,
            document.body,
          );
        }

        // ── Mobile: full-width bottom sheet (Telegram-style).
        return createPortal(
          <>
            <div
              className="fixed inset-0 z-[9989] bg-black/60"
              onClick={() => setContextMenu(null)}
            />
            <div
              className="fixed bottom-0 left-0 right-0 z-[9998] rounded-t-2xl border-t border-border bg-panel shadow-2xl overflow-hidden"
              style={{ transform: `translateY(-${contextMenu.kbOffset}px)` }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {Preview}
              {QuickReactionsRow}
              {Actions}
            </div>
          </>,
          document.body,
        );
      })()}
    </>
    </HashtagClickContext.Provider>
  );
}
