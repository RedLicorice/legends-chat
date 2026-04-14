export const PERMISSIONS = {
  TOPICS_CREATE: "topics.create",
  TOPICS_MANAGE: "topics.manage",
  MESSAGES_DELETE_OWN: "messages.delete.own",
  MESSAGES_DELETE_ANY: "messages.delete.any",
  MESSAGES_FLAG: "messages.flag",
  INVITES_CREATE: "invites.create",
  BOTS_MANAGE: "bots.manage",
  MODERATION_QUEUE_REVIEW: "moderation.queue.review",
  USERS_BAN_DIRECT: "users.ban.direct",
  USERS_BAN_LIFT: "users.ban.lift",
  USERS_MUTE_DIRECT: "users.mute.direct",
  USERS_MUTE_LIFT: "users.mute.lift",
  ADMIN_CONFIG: "admin.config",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export type Role = "user" | "moderator" | "admin";

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  user: [
    PERMISSIONS.MESSAGES_DELETE_OWN,
    PERMISSIONS.MESSAGES_FLAG,
    PERMISSIONS.INVITES_CREATE,
  ],
  moderator: [
    PERMISSIONS.MESSAGES_DELETE_OWN,
    PERMISSIONS.MESSAGES_FLAG,
    PERMISSIONS.INVITES_CREATE,
    PERMISSIONS.MESSAGES_DELETE_ANY,
    PERMISSIONS.MODERATION_QUEUE_REVIEW,
    PERMISSIONS.USERS_BAN_DIRECT,
    PERMISSIONS.USERS_MUTE_DIRECT,
    PERMISSIONS.USERS_MUTE_LIFT,
    PERMISSIONS.TOPICS_CREATE,
  ],
  admin: Object.values(PERMISSIONS),
};

export const DEFAULT_INVITE_DAILY_LIMIT: Record<Role, number> = {
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
