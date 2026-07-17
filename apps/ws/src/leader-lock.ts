import { randomUUID } from "node:crypto";
import { createLogger } from "@legends/shared";
import { cacheClient } from "./redis";

const log = createLogger("leader-lock");

const PROCESS_INSTANCE_ID = randomUUID();

// Atomic compare-and-del: only release the lock if we still own it. Avoids
// the classic "A acquires, A pauses, lease expires, B acquires, A wakes and
// DELs B's lock" race when SIGTERM fires near the TTL boundary.
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface LeaderLockOpts {
  key: string;
  intervalMs: number;
  lockTtlMs: number;
  tick: () => Promise<void>;
  label?: string;
}

export function runAsLeader(opts: LeaderLockOpts): () => void {
  if (opts.lockTtlMs <= opts.intervalMs * 2) {
    throw new Error(
      `[leader-lock] lockTtlMs (${opts.lockTtlMs}) must be > intervalMs * 2 (${opts.intervalMs * 2}) for key ${opts.key}`,
    );
  }
  const label = opts.label ?? opts.key;
  let stopped = false;
  let tickInFlight = false;

  const tryAcquireOrRefresh = async (): Promise<boolean> => {
    const result = await cacheClient.set(
      opts.key,
      PROCESS_INSTANCE_ID,
      "PX",
      opts.lockTtlMs,
      "NX",
    );
    if (result === "OK") return true;
    const owner = await cacheClient.get(opts.key);
    if (owner !== PROCESS_INSTANCE_ID) return false;
    await cacheClient.pexpire(opts.key, opts.lockTtlMs);
    return true;
  };

  const runTick = async () => {
    if (stopped || tickInFlight) return;
    tickInFlight = true;
    try {
      const isLeader = await tryAcquireOrRefresh();
      if (!isLeader) return;
      await opts.tick();
    } catch (err) {
      log.error("tick failed", { label, err });
    } finally {
      tickInFlight = false;
    }
  };

  const handle = setInterval(runTick, opts.intervalMs);
  // Fire one tick on boot so we don't wait a full interval before the first run.
  // Tiny stagger so concurrent processes don't dogpile the lock at the same ms.
  setTimeout(runTick, Math.floor(Math.random() * Math.min(opts.intervalMs, 5_000)));

  return function cancel() {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
    // Best-effort atomic release. If we crash before this runs, the next
    // leader picks it up after lockTtlMs.
    cacheClient
      .eval(RELEASE_LUA, 1, opts.key, PROCESS_INSTANCE_ID)
      .catch((err) => log.error("release failed", { label, err }));
  };
}
