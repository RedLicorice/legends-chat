export interface BotInfo {
  id: string;
  name: string;
  avatarUrl: string | null;
  webhookUrl: string | null;
}

export interface MessageUpdate {
  message_id: string;
  from: { id: string | null; display_name: string | null };
  chat: { id: string; type: string; title: string };
  text: string;
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

export interface Update {
  update_id: string;
  type: "message" | "callback_query" | "new_member" | string;
  message?: MessageUpdate;
  callback_query?: CallbackQueryUpdate;
  new_member?: NewMemberUpdate;
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
