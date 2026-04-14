import { z } from "zod";

export const messageContentSchema = z.object({
  text: z.string().min(1).max(8000),
  replyToMessageId: z.string().optional(),
  inlineKeyboard: z
    .array(
      z.array(
        z.object({
          text: z.string().min(1).max(64),
          callbackData: z.string().max(64).optional(),
          url: z.string().url().optional(),
        }),
      ),
    )
    .optional(),
});
export type MessageContent = z.infer<typeof messageContentSchema>;

export const sendMessageSchema = z.object({
  topicId: z.string().uuid(),
  content: messageContentSchema,
});

export const reactionToggleSchema = z.object({
  messageId: z.string(),
  emojiKey: z.string().min(1).max(64),
});

export const topicReadSchema = z.object({
  topicId: z.string().uuid(),
  lastReadMessageId: z.string(),
});

export const banReasonSchema = z.string().trim().min(3).max(500);
export const banDurationSchema = z
  .object({
    seconds: z.number().int().positive().nullable(),
  })
  .describe("seconds=null means permanent");

export const flagReasonSchema = z.string().trim().min(3).max(500);

export const createTopicSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  isSticky: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  isE2ee: z.boolean().default(false),
  historyVisibleToNewMembers: z.boolean().default(true),
  autoDeleteMode: z.enum(["none", "age", "count"]).default("none"),
  autoDeleteAgeSeconds: z.number().int().positive().nullable().optional(),
  autoDeleteMaxMessages: z.number().int().positive().nullable().optional(),
});
export type CreateTopicInput = z.infer<typeof createTopicSchema>;
