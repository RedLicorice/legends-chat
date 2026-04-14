import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  bigserial,
  jsonb,
  customType,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const userRole = pgEnum("user_role", ["user", "moderator", "admin"]);
export const autoDeleteMode = pgEnum("auto_delete_mode", ["none", "age", "count"]);
export const flagStatus = pgEnum("flag_status", ["pending", "dismissed", "actioned"]);
export const encryptionPurpose = pgEnum("encryption_purpose", ["messages", "attachments"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" }).notNull(),
    telegramUsername: text("telegram_username"),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    role: userRole("role").notNull().default("user"),
    invitedByUserId: uuid("invited_by_user_id"),
    invitedByCodeId: uuid("invited_by_code_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => ({
    telegramUserIdIdx: uniqueIndex("users_telegram_user_id_idx").on(t.telegramUserId),
    invitedByIdx: index("users_invited_by_idx").on(t.invitedByUserId),
  }),
);

export const rolesPermissions = pgTable(
  "roles_permissions",
  {
    role: userRole("role").notNull(),
    permission: text("permission").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.role, t.permission] }),
  }),
);

export const registrationConfig = pgTable("registration_config", {
  id: integer("id").primaryKey().default(1),
  invitesEnabled: boolean("invites_enabled").notNull().default(true),
  publicRegistrationEnabled: boolean("public_registration_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inviteQuotaConfig = pgTable("invite_quota_config", {
  role: userRole("role").primaryKey(),
  dailyLimit: integer("daily_limit").notNull().default(0),
});

export const inviteCodes = pgTable(
  "invite_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    role: userRole("role").notNull().default("user"),
    maxUses: integer("max_uses"),
    usesCount: integer("uses_count").notNull().default(0),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: uniqueIndex("invite_codes_code_idx").on(t.code),
    createdByIdx: index("invite_codes_created_by_idx").on(t.createdByUserId, t.createdAt),
  }),
);

export const authLoginTokens = pgTable(
  "auth_login_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    telegramChatId: bigint("telegram_chat_id", { mode: "bigint" }),
    telegramMessageId: integer("telegram_message_id"),
  },
  (t) => ({
    tokenIdx: uniqueIndex("auth_login_tokens_token_idx").on(t.token),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    deviceLabel: text("device_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
  }),
);

export const encryptionKeys = pgTable("encryption_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  purpose: encryptionPurpose("purpose").notNull(),
  algorithm: text("algorithm").notNull().default("xchacha20poly1305"),
  wrappedKey: bytea("wrapped_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
});

export const topics = pgTable(
  "topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    isSticky: boolean("is_sticky").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    isE2ee: boolean("is_e2ee").notNull().default(false),
    historyVisibleToNewMembers: boolean("history_visible_to_new_members").notNull().default(true),
    autoDeleteMode: autoDeleteMode("auto_delete_mode").notNull().default("none"),
    autoDeleteAgeSeconds: integer("auto_delete_age_seconds"),
    autoDeleteMaxMessages: integer("auto_delete_max_messages"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex("topics_slug_idx").on(t.slug),
  }),
);

export const topicMembers = pgTable(
  "topic_members",
  {
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastReadMessageId: bigint("last_read_message_id", { mode: "bigint" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.topicId, t.userId] }),
    userIdx: index("topic_members_user_idx").on(t.userId),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    senderUserId: uuid("sender_user_id").references(() => users.id, { onDelete: "set null" }),
    botId: uuid("bot_id"),
    replyToMessageId: bigint("reply_to_message_id", { mode: "bigint" }),
    contentCiphertext: bytea("content_ciphertext").notNull(),
    contentNonce: bytea("content_nonce").notNull(),
    keyId: uuid("key_id")
      .notNull()
      .references(() => encryptionKeys.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    topicCreatedIdx: index("messages_topic_created_idx").on(t.topicId, t.createdAt),
    topicIdIdx: index("messages_topic_id_idx").on(t.topicId, t.id),
  }),
);

export const messageReactions = pgTable(
  "message_reactions",
  {
    messageId: bigint("message_id", { mode: "bigint" })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emojiKey: text("emoji_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.userId, t.emojiKey] }),
  }),
);

export const bots = pgTable("bots", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  avatarUrl: text("avatar_url"),
  webhookUrl: text("webhook_url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    deviceLabel: text("device_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    endpointIdx: uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint),
    userIdx: index("push_subscriptions_user_idx").on(t.userId),
  }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actorIdx: index("audit_log_actor_idx").on(t.actorUserId, t.createdAt),
    actionIdx: index("audit_log_action_idx").on(t.action, t.createdAt),
  }),
);

export const messageFlags = pgTable(
  "message_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: bigint("message_id", { mode: "bigint" })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    status: flagStatus("status").notNull().default("pending"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index("message_flags_status_idx").on(t.status, t.createdAt),
    messageIdx: index("message_flags_message_idx").on(t.messageId),
  }),
);

export const userBans = pgTable(
  "user_bans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bannedByUserId: uuid("banned_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    sourceFlagId: uuid("source_flag_id").references(() => messageFlags.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    liftedByUserId: uuid("lifted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
  },
  (t) => ({
    activeIdx: index("user_bans_active_idx")
      .on(t.userId)
      .where(sql`${t.liftedAt} IS NULL`),
  }),
);

export const userMutes = pgTable(
  "user_mutes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mutedByUserId: uuid("muted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    sourceFlagId: uuid("source_flag_id").references(() => messageFlags.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    liftedByUserId: uuid("lifted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
  },
  (t) => ({
    activeIdx: index("user_mutes_active_idx")
      .on(t.userId)
      .where(sql`${t.liftedAt} IS NULL`),
  }),
);
