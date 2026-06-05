import { z } from "zod";

export const attachmentSchema = z.object({
  type: z.enum(["image", "gif", "file"]),
  url: z.string().min(1).max(2048),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  thumbnailUrl: z.string().min(1).max(2048).optional(),
  filename: z.string().max(255).optional(),
  mimeType: z.string().max(128).optional(),
  size: z.number().int().nonnegative().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

// Matrix m.room.encrypted envelope as serialised by the OlmMachine. We don't
// validate the inner shape (algorithm, ciphertext, sender_key, …) here — the
// client SDK is the source of truth; the server just needs SOMETHING object-y
// to pin to ciphertext_json.
export const ciphertextEnvelopeSchema = z.record(z.string(), z.unknown());
export type CiphertextEnvelope = z.infer<typeof ciphertextEnvelopeSchema>;

export const messageContentSchema = z.object({
  text: z.string().max(8000).default(""),
  // E2EE topics send the Megolm envelope here instead of `text`. The two
  // branches are mutually exclusive (XOR-enforced by the .refine below);
  // the server further checks that ciphertext is present iff topic.isE2ee.
  ciphertextJson: ciphertextEnvelopeSchema.optional(),
  replyToMessageId: z.string().optional(),
  attachments: z.array(attachmentSchema).max(10).optional(),
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
}).superRefine((v, ctx) => {
  const hasCipher = !!v.ciphertextJson;
  const hasText = v.text.trim().length > 0;
  const hasAttach = !!v.attachments && v.attachments.length > 0;
  if (hasCipher) {
    // Ciphertext branch: clients should not also send plaintext / attachments.
    if (hasText || hasAttach) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ciphertextJson is mutually exclusive with text/attachments",
      });
    }
  } else if (!hasText && !hasAttach) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "message must have text or at least one attachment",
    });
  }
});
export type MessageContent = z.infer<typeof messageContentSchema>;

export const sendMessageSchema = z.object({
  topicId: z.string().uuid(),
  content: messageContentSchema,
  hashtags: z
    .array(z.string().regex(/^[#$][a-zA-Z]\w*$/))
    .max(20)
    .optional(),
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

export const createPollSchema = z.object({
  topicId: z.string().uuid(),
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(10),
  isAnonymous: z.boolean().default(false),
  allowsMultiple: z.boolean().default(false),
});
export type CreatePollInput = z.infer<typeof createPollSchema>;

export const pollVoteSchema = z.object({
  pollId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).max(10),
});
export type PollVoteInput = z.infer<typeof pollVoteSchema>;

export const pollCloseSchema = z.object({
  pollId: z.string().uuid(),
});

// Edit payload: either plaintext `text` (for plain topics) XOR a Megolm
// `ciphertextJson` envelope (for E2EE topics). The ws handler additionally
// verifies that the branch matches `topic.isE2ee`.
export const messageEditSchema = z
  .object({
    messageId: z.string(),
    topicId: z.string().uuid(),
    text: z.string().max(8000).optional(),
    ciphertextJson: ciphertextEnvelopeSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const hasCipher = !!v.ciphertextJson;
    const hasText = !!v.text && v.text.trim().length > 0;
    if (hasCipher && hasText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ciphertextJson is mutually exclusive with text",
      });
    }
    if (!hasCipher && !hasText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "edit must include text or ciphertextJson",
      });
    }
  });
export type MessageEditInput = z.infer<typeof messageEditSchema>;

export const messageDeleteSchema = z.object({
  messageId: z.string(),
  topicId: z.string().uuid(),
});
export type MessageDeleteInput = z.infer<typeof messageDeleteSchema>;

export const createTopicSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  iconUrl: z.string().url().nullable().optional(),
  isSticky: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  isE2ee: z.boolean().default(false),
  historyVisibleToNewMembers: z.boolean().default(true),
  autoDeleteMode: z.enum(["none", "age", "count"]).default("none"),
  autoDeleteAgeSeconds: z.number().int().positive().nullable().optional(),
  autoDeleteMaxMessages: z.number().int().positive().nullable().optional(),
});
export type CreateTopicInput = z.infer<typeof createTopicSchema>;
