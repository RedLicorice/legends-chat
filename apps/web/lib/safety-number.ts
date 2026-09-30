"use client";

// Local record of which safety numbers the user has compared out of band
// (cr-h3). Deliberately per-device and client-only: a server-stored
// "verified" flag would be set by the very party the comparison defends
// against.

const PREFIX = "legends-e2ee-verified:";

export type SafetyTarget =
  | { kind: "self"; userId: string }
  | { kind: "peer"; peerMatrixId: string; peerName: string }
  | { kind: "room"; roomId: string; userIds: string[]; roomName: string };

export interface VerificationRecord {
  /** The fingerprint that was marked verified. */
  fingerprint: string;
  /** ms epoch. */
  at: number;
}

export function storageKeyFor(target: SafetyTarget): string {
  switch (target.kind) {
    case "self": return `${PREFIX}self:${target.userId}`;
    case "peer": return `${PREFIX}peer:${target.peerMatrixId}`;
    case "room": return `${PREFIX}room:${target.roomId}`;
  }
}

export function readVerification(target: SafetyTarget): VerificationRecord | null {
  try {
    const raw = localStorage.getItem(storageKeyFor(target));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VerificationRecord>;
    if (typeof parsed.fingerprint !== "string" || typeof parsed.at !== "number") return null;
    return { fingerprint: parsed.fingerprint, at: parsed.at };
  } catch {
    return null;
  }
}

export function writeVerification(target: SafetyTarget, fingerprint: string): VerificationRecord {
  const record: VerificationRecord = { fingerprint, at: Date.now() };
  try {
    localStorage.setItem(storageKeyFor(target), JSON.stringify(record));
  } catch { /* private mode / quota — the modal still shows the number */ }
  return record;
}

export function clearVerification(target: SafetyTarget): void {
  try {
    localStorage.removeItem(storageKeyFor(target));
  } catch { /* ignore */ }
}

export type VerificationState = "unverified" | "verified" | "changed";

export function verificationState(
  record: VerificationRecord | null,
  current: string | null,
): VerificationState {
  if (!record || !current) return "unverified";
  return record.fingerprint === current ? "verified" : "changed";
}
