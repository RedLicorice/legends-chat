/**
 * Chaos bot — two autonomous instances that post random messages to chat topics.
 *
 * Instance A: BOT_TOKEN=<alpha-token>  BOT_INSTANCE=alpha  BOT_TOPICS=<comma-ids>
 * Instance B: BOT_TOKEN=<beta-token>   BOT_INSTANCE=beta   BOT_TOPICS=<comma-ids>
 *
 * They can share topics or have separate ones. Each instance picks a random topic
 * from its BOT_TOPICS list each cycle and sends a random message from its own pool.
 */

import { LegendsBotClient } from "@legends/bot-sdk";

const token = process.env.BOT_TOKEN;
const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const instance = process.env.BOT_INSTANCE ?? "default";
const topicsCsv = process.env.BOT_TOPICS ?? "";

// Min/max delay between messages in ms
const MIN_DELAY = Number(process.env.MIN_DELAY_MS ?? 15_000);
const MAX_DELAY = Number(process.env.MAX_DELAY_MS ?? 60_000);

if (!token) {
  console.error(`[chaos:${instance}] BOT_TOKEN env var required`);
  process.exit(1);
}

if (!topicsCsv) {
  console.error(`[chaos:${instance}] BOT_TOPICS env var required (comma-separated topic IDs)`);
  process.exit(1);
}

const topicIds = topicsCsv.split(",").map((s) => s.trim()).filter(Boolean);
const api = new LegendsBotClient({ token, baseUrl });

// ─── Message pools per instance ───────────────────────────────────────────────

const ALPHA_MESSAGES = [
  "Anyone else think the UI could use more cowbell? 🐄",
  "Hot take: dark mode is a lifestyle.",
  "If this channel were a pizza, what topping would it be?",
  "Quick poll: tabs or spaces? I'll wait.",
  "Just dropped 14 messages into prod. Accidentally. Oops.",
  "Has anyone ever actually read the terms of service?",
  "Reminder: coffee is just hot bean water and it's amazing.",
  "What's everyone shipping this week?",
  "Fun fact: the first computer bug was an actual bug. 🐛",
  "Monday energy: [loading... 23%]",
  "I have opinions about serialization formats and I'm not afraid to use them.",
  "Normalize: asking questions in chat instead of DMs.",
  "Anyone else have 47 browser tabs open right now?",
  "The real MVP is whoever wrote the documentation.",
  "Current mood: `git stash apply` and hope for the best.",
];

const BETA_MESSAGES = [
  "Breaking: local dev environment achieves sentience, demands better coffee.",
  "Plot twist: it was working all along. The bug was in the comments.",
  "Rate my setup: one laptop, two monitors, three energy drinks. 💻",
  "Controversial opinion: semicolons add character.",
  "Just discovered `git reflog`. Life will never be the same.",
  "The merge conflict was between me and my past self. I won.",
  "In n years all code will be written by AI. In n-1 years, we'll all be debugging AI.",
  "Shoutout to everyone who Googles the same syntax every time.",
  "Sleep schedule: undefined. Focus: null. Productivity: NaN.",
  "I fixed the bug. I introduced three more. Balance.",
  "Have you tried turning it off and on again? (Serious question.)",
  "Documentation? We have TODO comments.",
  "When in doubt, add more logs. Then remove them before code review.",
  "The best code is no code. But we still have to ship features.",
  "Rubber duck debugging but the duck talks back now.",
];

const SHARED_MESSAGES = [
  "Hello from the other side 👋",
  "Is this thing on? 🎤",
  "gm",
  "gn",
  "Anyone awake?",
  "Just checking in.",
  "🔥",
  "✅",
  "Thoughts?",
  "Interesting times.",
  "carry on",
  "❤️",
  "good vibes only",
  "back in a bit",
  "making tea, anyone want some?",
];

function getMessagePool(): string[] {
  if (instance === "alpha") return [...ALPHA_MESSAGES, ...SHARED_MESSAGES];
  if (instance === "beta") return [...BETA_MESSAGES, ...SHARED_MESSAGES];
  return [...ALPHA_MESSAGES, ...BETA_MESSAGES, ...SHARED_MESSAGES];
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

async function loop(): Promise<void> {
  const pool = getMessagePool();
  const info = await api.getMe().catch(() => null);
  console.log(`[chaos:${instance}] started${info ? ` as "${info.name}"` : ""}. Topics: ${topicIds.join(", ")}`);

  while (true) {
    const delayMs = jitter(MIN_DELAY, MAX_DELAY);
    console.log(`[chaos:${instance}] next message in ${(delayMs / 1000).toFixed(0)}s`);
    await new Promise((r) => setTimeout(r, delayMs));

    const topicId = pick(topicIds);
    const text = pick(pool);

    try {
      await api.sendMessage({ topicId, text });
      console.log(`[chaos:${instance}] sent to ${topicId}: ${text.slice(0, 40)}`);
    } catch (err) {
      console.error(`[chaos:${instance}] send failed:`, err instanceof Error ? err.message : err);
    }
  }
}

loop().catch((err) => {
  console.error(`[chaos:${instance}] fatal:`, err);
  process.exit(1);
});
