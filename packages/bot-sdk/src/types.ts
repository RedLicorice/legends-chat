export interface BotInfo {
  id: string;
  name: string;
  avatarUrl: string | null;
  webhookUrl: string | null;
  e2ee_state?: "disabled" | "pending" | "ready";
  e2ee_device_id?: string | null;
}

export interface MessageUpdate {
  message_id: string;
  from: { id: string | null; display_name: string | null };
  chat: { id: string; type: string; title: string };
  text: string;
  ciphertext?: string;
  e2ee_room_id?: string;
  sender_matrix_id?: string;
  reply_to_message_id?: string;
  date: number;
}

export interface CallbackQueryUpdate {
  id: string;
  from: { id: string; display_name: string | null };
  message: { message_id: string; chat: { id: string } };
  data: string;
}

export interface NewMemberUpdate {
  user_id: string;
  display_name: string;
  username: string | null;
  topic_id: string;
  topic_title: string;
}

export interface DmMessageUpdate {
  message_id: string;
  conversation_id: string;
  from: { id: string; display_name: string | null };
  text: string;
  ciphertext?: string;
  e2ee_room_id?: string;
  sender_matrix_id?: string;
  reply_to_message_id?: string;
  date: number;
}

export interface SendDmMessageParams {
  conversationId: string;
  text: string;
  replyToMessageId?: string;
}

export interface Update {
  update_id: string;
  type: "message" | "callback_query" | "new_member" | "dm_message" | string;
  message?: MessageUpdate;
  callback_query?: CallbackQueryUpdate;
  new_member?: NewMemberUpdate;
  dm_message?: DmMessageUpdate;
}

export interface InlineKeyboardButton {
  text: string;
  callbackData: string;
}

export interface SendMessageParams {
  topicId: string;
  text: string;
  replyToMessageId?: string;
  inlineKeyboard?: InlineKeyboardButton[][];
}
