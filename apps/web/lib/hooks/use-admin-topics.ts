"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";

export interface AdminTopicRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  isSticky: boolean;
  sortOrder: number;
  isFeed: boolean;
  isHomeTopic: boolean;
  isE2ee: boolean;
  isP2p: boolean;
  p2pFallbackE2ee: boolean;
  p2pMaxParticipants: number | null;
  viewRoles: string[];
  postRoles: string[];
  readRoles: string[];
  replyRoles: string[];
  autoDeleteMode: "none" | "age" | "count";
  autoDeleteAgeSeconds: number | null;
  autoDeleteMaxMessages: number | null;
  passwordProtected: boolean;
  passwordVersion: number;
  passwordReentryDays: number;
}

export interface AdminTopicsPayload {
  topics: AdminTopicRow[];
}

export function useAdminTopics() {
  return useApiResource<AdminTopicsPayload>("/api/admin/topics/page-data");
}
