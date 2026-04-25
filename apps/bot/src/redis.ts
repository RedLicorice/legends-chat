import { Redis } from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
export const subClient = new Redis(url, { maxRetriesPerRequest: null });
export const pubClient = subClient.duplicate();
subClient.on("error", (err) => console.error("[redis] connection error:", err.message));
