"use client";
import type { Socket } from "socket.io-client";

export interface ChatAttachment {
  type: "image" | "gif" | "file";
  url: string;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

export interface ChatPollOption {
  id: string;
  text: string;
  position: number;
  voteCount: number;
}

export interface ChatPollData {
  id: string;
  question: string;
  options: ChatPollOption[];
  isAnonymous: boolean;
  allowsMultiple: boolean;
  isClosed: boolean;
  totalVotes: number;
}

export interface ChatInlineKeyboardButton {
  text: string;
  callbackData: string;
}

export interface ChatMessage {
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
  attachments: ChatAttachment[];
  inlineKeyboard?: ChatInlineKeyboardButton[][] | null;
  createdAt: string | Date;
  editedAt: string | Date | null;
  poll?: ChatPollData;
  ciphertextJson?: Record<string, unknown> | null;
}

export interface ChatReactionRow {
  messageId: string;
  userId: string;
  emojiKey: string;
}

export interface ChatSourceJoinData {
  messages?: ChatMessage[];
  reactions?: ChatReactionRow[];
  onlineUserIds?: string[];
  myPollVotes?: Record<string, string[]>;
}

export interface ChatSourceHandlers {
  onNew(m: ChatMessage): void;
  onEdit(m: ChatMessage): void;
  onDelete(id: string): void;
  onReactionAdd(r: ChatReactionRow): void;
  onReactionRemove(r: ChatReactionRow): void;
  onConnect?(initial: ChatSourceJoinData): void;
  onDisconnect?(): void;
}

export interface ChatSendPayload {
  text: string;
  attachments?: ChatAttachment[];
  replyToMessageId?: string | null;
  ciphertextJson?: Record<string, unknown>;
  hashtags?: string[];
}

export interface ChatSourceCapabilities {
  edit: boolean;
  delete: boolean;
  reactions: boolean;
  polls: boolean;
  hashtags: boolean;
  mentions: boolean;
  members: boolean;
  presence: boolean;
  threads: boolean;
}

export interface ChatSource {
  readonly kind: "topic" | "dm";
  readonly capabilities: ChatSourceCapabilities;
  /** Stable identifier used as the encryption room/peer key. */
  readonly roomKey: string | null;
  /** Socket used by hooks that still need to talk to the ws directly (presence, hashtags). Null for sources without one. */
  readonly socket: Socket | null;
  subscribe(handlers: ChatSourceHandlers): () => void;
  send(payload: ChatSendPayload): Promise<void>;
  edit?(messageId: string, payload: { text?: string; ciphertextJson?: Record<string, unknown> }): Promise<void>;
  remove?(messageId: string): Promise<void>;
  react?(messageId: string, emojiKey: string): Promise<void>;
  markRead?(lastReadMessageId: string): void;
}
