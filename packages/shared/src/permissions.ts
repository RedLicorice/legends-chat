export const PERMISSIONS = {
  TOPICS_CREATE: "topics.create",
  TOPICS_MANAGE: "topics.manage",
  MESSAGES_DELETE_OWN: "messages.delete.own",
  MESSAGES_DELETE_ANY: "messages.delete.any",
  MESSAGES_EDIT_OWN: "messages.edit.own",
  MESSAGES_EDIT_ANY: "messages.edit.any",
  MESSAGES_FLAG: "messages.flag",
  INVITES_CREATE: "invites.create",
  INVITES_CREATE_ELEVATED: "invites.create.elevated",
  BOTS_MANAGE: "bots.manage",
  MODERATION_QUEUE_REVIEW: "moderation.queue.review",
  USERS_BAN_DIRECT: "users.ban.direct",
  USERS_BAN_LIFT: "users.ban.lift",
  USERS_MUTE_DIRECT: "users.mute.direct",
  USERS_MUTE_LIFT: "users.mute.lift",
  ADMIN_CONFIG: "admin.config",
  CONTENT_ATTACHMENT: "content.attachment",
  CONTENT_GIF_UPLOAD: "content.gif.upload",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export type Role = string;

export const DEFAULT_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  user: [
    PERMISSIONS.MESSAGES_DELETE_OWN,
    PERMISSIONS.MESSAGES_EDIT_OWN,
    PERMISSIONS.MESSAGES_FLAG,
    PERMISSIONS.INVITES_CREATE,
    PERMISSIONS.CONTENT_ATTACHMENT,
  ],
  moderator: [
    PERMISSIONS.MESSAGES_DELETE_OWN,
    PERMISSIONS.MESSAGES_DELETE_ANY,
    PERMISSIONS.MESSAGES_EDIT_OWN,
    PERMISSIONS.MESSAGES_EDIT_ANY,
    PERMISSIONS.MESSAGES_FLAG,
    PERMISSIONS.INVITES_CREATE,
    PERMISSIONS.MODERATION_QUEUE_REVIEW,
    PERMISSIONS.USERS_BAN_DIRECT,
    PERMISSIONS.USERS_MUTE_DIRECT,
    PERMISSIONS.USERS_MUTE_LIFT,
    PERMISSIONS.TOPICS_CREATE,
    PERMISSIONS.CONTENT_ATTACHMENT,
    PERMISSIONS.CONTENT_GIF_UPLOAD,
  ],
  admin: Object.values(PERMISSIONS),
};

export const DEFAULT_INVITE_DAILY_LIMIT: Record<string, number> = {
  user: 1,
  moderator: 10,
  admin: 100,
};

export interface AuthUser {
  id: string;
  role: Role;
  permissions: ReadonlySet<Permission>;
}

export function can(user: AuthUser | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  return user.permissions.has(permission);
}
