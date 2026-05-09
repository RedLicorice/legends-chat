"use client";

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/fetch";

interface TopicPasswordEntry {
  version: number;
  expiresAt: number;
}

type GateState = "checking" | "locked" | "unlocked";

interface UseTopicPasswordOptions {
  topicId: string;
  passwordVersion: number;
  passwordReentryDays: number;
  hasPassword: boolean;
  isAdmin: boolean;
}

interface UseTopicPasswordResult {
  state: GateState;
  error: string | null;
  submitting: boolean;
  submit: (password: string) => Promise<void>;
}

function storageKey(topicId: string) {
  return `lc_tpw_${topicId}`;
}

function readEntry(topicId: string): TopicPasswordEntry | null {
  try {
    const raw = localStorage.getItem(storageKey(topicId));
    if (!raw) return null;
    return JSON.parse(raw) as TopicPasswordEntry;
  } catch {
    return null;
  }
}

function isEntryValid(entry: TopicPasswordEntry | null, passwordVersion: number): boolean {
  if (!entry) return false;
  if (entry.version !== passwordVersion) return false;
  if (Date.now() >= entry.expiresAt) return false;
  return true;
}

function writeEntry(topicId: string, version: number, reentryDays: number) {
  const entry: TopicPasswordEntry = {
    version,
    expiresAt: Date.now() + reentryDays * 86400000,
  };
  localStorage.setItem(storageKey(topicId), JSON.stringify(entry));
}

export function useTopicPassword({
  topicId,
  passwordVersion,
  passwordReentryDays,
  hasPassword,
  isAdmin,
}: UseTopicPasswordOptions): UseTopicPasswordResult {
  const [state, setState] = useState<GateState>("checking");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!hasPassword || isAdmin) {
      setState("unlocked");
      return;
    }
    const entry = readEntry(topicId);
    if (isEntryValid(entry, passwordVersion)) {
      setState("unlocked");
    } else {
      setState("locked");
    }
  }, [topicId, passwordVersion, hasPassword, isAdmin]);

  const submit = useCallback(async (password: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/topics/${topicId}/verify-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setError("Incorrect password. Please try again.");
        return;
      }
      const data = await res.json() as { ok: boolean; version: number; reentryDays: number };
      writeEntry(topicId, data.version, data.reentryDays);
      setState("unlocked");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [topicId]);

  return { state, error, submitting, submit };
}
