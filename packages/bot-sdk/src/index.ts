// IndexedDB polyfill: the Matrix Rust crypto WASM uses IndexedDB for its
// store, and bots run in Node where `indexedDB` is undefined. Install the
// polyfill at the SDK entry so consumers (jane, chaos, future bots) don't
// have to know about this implementation detail. Must run BEFORE any
// crypto module touches `indexedDB`.
import "fake-indexeddb/auto";

export { LegendsBotClient } from "./client.js";
export { LegendsBot, MessageContext, NewMemberContext, CallbackQueryContext, DmMessageContext } from "./bot.js";
export type {
  BotInfo,
  Update,
  MessageUpdate,
  NewMemberUpdate,
  CallbackQueryUpdate,
  InlineKeyboardButton,
  SendMessageParams,
  DmMessageUpdate,
  SendDmMessageParams,
} from "./types.js";
