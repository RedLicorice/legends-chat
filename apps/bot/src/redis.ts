import { Redis } from "ioredis";
import { createLogger } from "@legends/shared";

const log = createLogger("bot:redis");

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
export const subClient = new Redis(url, { maxRetriesPerRequest: null });
export const pubClient = subClient.duplicate();
subClient.on("error", (err) => log.error("connection error", err));
