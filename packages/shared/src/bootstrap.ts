// Socket bootstrap payloads — the WS server pushes these so /t/<slug>
// navigation avoids the seven REST RTTs that used to fire per topic open.
//
//  • SessionBootstrap is emitted ONCE per socket on connect. It carries the
//    global state that's the same regardless of which topic is open:
//    symbols map, VAPID public key, initial notifications, and the
//    moderation queue flag count (admin/mod only).
//  • TopicBootstrap is the ack payload returned by the TOPIC_JOIN handler.
//    It carries everything a topic view needs to render its first frame —
//    topic metadata, current user's mute, passkey nudge, gating flags,
//    member list, and hashtag cloud.

export interface TopicBootstrapTopic {
  id: string;
  slug: string;
  title: string;
  isE2ee: boolean;
  isP2p: boolean;
  p2pFallbackE2ee: boolean;
  isFeed: boolean;
  postRoles: string[];
  replyRoles: string[];
  iconUrl: string | null;
  bannerUrl: string | null;
  description: string | null;
  hasPassword: boolean;
  passwordVersion: number;
  passwordReentryDays: number;
}

export interface TopicBootstrapMember {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  isAnon: boolean;
  joinedAt: string;
}

export interface TopicBootstrapHashtag {
  tag: string;
  count: number;
}

export interface TopicBootstrap {
  topic: TopicBootstrapTopic;
  mute: { reason: string; expiresAt: string | null } | null;
  hasPasskey: boolean;
  giphyEnabled: boolean;
  canPost: boolean;
  canReply: boolean;
  members: TopicBootstrapMember[];
  hashtags: TopicBootstrapHashtag[];
}

export type TopicBootstrapAck =
  | { ok: true; data: TopicBootstrap }
  | { ok: false; error: "not_found" | "forbidden" | "error" };

export interface SessionBootstrapSymbol {
  id: number;
  symbol: string;
  name: string;
  description: string | null;
  linkedUserId: string | null;
  linkedUserDisplayName: string | null;
  linkedUserAvatarUrl: string | null;
}

export interface SessionBootstrapNotification {
  id: string;
  type: string;
  payload: unknown;
  readAt: string | null;
  createdAt: string;
}

export interface SessionBootstrapNotifications {
  items: SessionBootstrapNotification[];
  unread: number;
}

export interface SessionBootstrap {
  symbols: SessionBootstrapSymbol[];
  pushVapidPublicKey: string | null;
  notifications: SessionBootstrapNotifications;
  /** Null for non-moderators (no MODERATION_QUEUE_REVIEW perm). */
  modFlagCount: number | null;
}
