"use client";
import { useMemo } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import type { EncryptedReason } from "./EncryptedReasonModal";

interface Props {
  messageId: string;
  mine: boolean;
  reasonKind: EncryptedReason["kind"];
  onShowReason: () => void;
}

// Nonsense word pool — looks vaguely English/Italian-ish without being real
// Latin lorem ipsum. Used for the blurred placeholder body.
const WORDS = [
  "veloria", "quanta", "mosset", "tareni", "wisp", "thalor", "brindel", "moltro",
  "sevvit", "lunara", "porric", "kasten", "florae", "drisken", "ombret", "vasque",
  "tenari", "morric", "selvon", "gravell", "calmir", "perinda", "rastel", "voltic",
  "minera", "soltari", "krenal", "phastel", "thoren", "yulvic",
];

function hashString(str: string): number {
  // djb2 — produces a stable 32-bit-ish hash.
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPlaceholder(messageId: string): string {
  const seed = hashString(messageId);
  const rand = mulberry32(seed);
  // 15–40 words
  const count = 15 + Math.floor(rand() * 26);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(WORDS[Math.floor(rand() * WORDS.length)]!);
  }
  const joined = out.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
}

export function EncryptedMessageContent({
  messageId,
  mine,
  reasonKind: _reasonKind,
  onShowReason,
}: Props) {
  // Deterministic per-message placeholder. useMemo keyed by messageId means it
  // never reshuffles on re-render. (reasonKind is intentionally NOT a dep —
  // changing the reason should not change the blur text underneath.)
  const placeholder = useMemo(() => buildPlaceholder(messageId), [messageId]);

  // Render as a Fragment: the blurred placeholder flows normally inside the
  // bubble so it contributes to the bubble's intrinsic size, and the lock
  // button is positioned absolute against the bubble itself (the closest
  // `relative` ancestor), so it lands at the bubble's dead center — including
  // the padding and the metadata row underneath.
  return (
    <>
      <span
        aria-hidden="true"
        className="select-none pointer-events-none block break-words text-sm filter blur-[4px]"
      >
        {placeholder}
      </span>
      <button
        type="button"
        onClick={onShowReason}
        aria-label="Why is this message still encrypted?"
        className="absolute inset-0 z-10 flex items-center justify-center"
      >
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm transition",
            mine
              ? "border-white/30 bg-white/15 text-white hover:bg-white/25"
              : "border-border bg-panel/90 text-text hover:bg-panel",
          )}
        >
          <Lock className="h-3 w-3" />
          Locked
        </span>
      </button>
    </>
  );
}
