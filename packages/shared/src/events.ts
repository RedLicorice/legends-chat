export const WS_EVENTS = {
  // server -> client
  MESSAGE_NEW: "message:new",
  MESSAGE_EDIT: "message:edit",
  MESSAGE_DELETE: "message:delete",
  REACTION_ADD: "reaction:add",
  REACTION_REMOVE: "reaction:remove",
  TOPIC_UPDATED: "topic:updated",
  PRESENCE_UPDATE: "presence:update",
  TYPING_START: "typing:start",
  TYPING_STOP: "typing:stop",
  USER_BANNED: "user:banned",
  USER_MUTED: "user:muted",

  // client -> server
  MESSAGE_SEND: "message:send",
  MESSAGE_EDIT_REQ: "message:edit:req",
  MESSAGE_DELETE_REQ: "message:delete:req",
  REACTION_TOGGLE: "reaction:toggle",
  TOPIC_READ: "topic:read",
  TOPIC_JOIN: "topic:join",
  TOPIC_LEAVE: "topic:leave",
  TYPING: "typing",
  BOT_KEYBOARD_CALLBACK: "bot:keyboard:callback",
} as const;

export type WsEvent = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];

export const REDIS_CHANNELS = {
  USER_BANNED: "legends:user:banned",
  USER_MUTED: "legends:user:muted",
  USER_UNMUTED: "legends:user:unmuted",
  USER_UNBANNED: "legends:user:unbanned",
  LOGIN_TOKEN_CONSUMED: "legends:login:token:consumed",
} as const;

export const REDIS_KEYS = {
  REVOKED_JTI: (jti: string) => `legends:jti:revoked:${jti}`,
  BAN_CACHE: (userId: string) => `legends:ban:${userId}`,
  MUTE_CACHE: (userId: string) => `legends:mute:${userId}`,
} as const;
