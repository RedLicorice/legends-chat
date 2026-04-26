# P2P Topics — Design Summary

## Overview
WebRTC DataChannel peer-to-peer messaging for selected topics.
Messages go browser→browser directly, never stored in DB.
Volatile by design: no history, no offline delivery.

## Topic Modes
| is_p2p | is_e2ee | p2p_fallback_e2ee | Behavior |
|--------|---------|-------------------|----------|
| false  | true    | —                 | Normal E2EE via server relay |
| true   | false   | —                 | P2P only. Full → queue |
| true   | true    | false             | P2P+E2EE. Full → queue |
| true   | true    | true              | P2P+E2EE. Full → fallback to server E2EE relay |

## Participant Limits
- Global default: `p2p_max_participants` system setting (default 5)
- Per-topic override: `topics.p2p_max_participants` (null = use global)
- "Active" = peer with open DataChannel heartbeat, tracked in Redis

## Queue Behavior (when at limit, no fallback)
1. User tries to join → server checks Redis active count
2. If full: join queue (Redis list `p2p:queue:{topicId}`)
3. Client receives `p2p:queued { position }` event
4. UI shows "Channel full — position N in queue"
5. When active peer leaves/disconnects → server pops queue head → sends `p2p:admitted`
6. Queue TTL: 5 min (user auto-removed if they close tab before admitted)

## Fallback Behavior (E2EE+P2P with fallback enabled, over limit)
1. Participant N+1 joins → server detects over limit
2. Server emits `p2p:fallback` to all peers in topic
3. All peers drop DataChannels, switch to server-relay E2EE mode
4. Normal E2EE flow resumes (WS message relay, DB storage resumes)
5. When count drops to ≤ limit again: server emits `p2p:resume` → peers re-establish DataChannels

## Icons
- P2P only: radio/wifi icon (lucide `Radio`)
- E2EE only: lock icon (existing)
- P2P+E2EE: both icons side by side
- P2P+E2EE+fallback active: both icons, fallback indicator (e.g. dimmed/orange)

## Admin Settings (system_settings table)
| key | type | default | description |
|-----|------|---------|-------------|
| `p2p_max_participants` | int | 5 | Global default peer limit |
| `stun_servers` | JSON | Google STUN | Array of `{ urls: string }` |
| `turn_url` | string | — | TURN server URL |
| `turn_username` | string | — | TURN credential username |
| `turn_credential` | string | — | TURN credential password |

## DB Changes
```sql
-- migration 0019_p2p_topics.sql
ALTER TABLE topics ADD COLUMN is_p2p boolean NOT NULL DEFAULT false;
ALTER TABLE topics ADD COLUMN p2p_fallback_e2ee boolean NOT NULL DEFAULT false;
ALTER TABLE topics ADD COLUMN p2p_max_participants integer;
-- system_settings: new keys added via seed/upsert, no schema change needed
```

## New Files
| File | Purpose |
|------|---------|
| `apps/web/hooks/useP2PRoom.ts` | WebRTC peer management, signaling, heartbeat |
| `apps/web/components/P2PView.tsx` | Message UI for P2P topics |
| `apps/web/components/P2PQueueBanner.tsx` | "Channel full, position N" banner |
| `apps/ws/src/p2p-signaling.ts` | Socket.io offer/answer/ICE relay + queue logic |

## Modified Files
| File | Change |
|------|--------|
| `packages/db/src/schema.ts` | `isP2p`, `p2pFallbackE2ee`, `p2pMaxParticipants` on topics |
| `packages/db/src/migrations/0019_p2p_topics.sql` | SQL above |
| `apps/web/components/TopicLayout.tsx` | Route to P2PView when topic.isP2p |
| `apps/web/components/TopicListItem.tsx` | Show P2P + E2EE icons |
| `apps/web/app/admin/topics/*` | P2P toggle, fallback toggle, per-topic limit |
| `apps/web/components/AdminSettingsForm.tsx` | STUN/TURN/max_participants fields |
| `apps/web/app/api/admin/settings/route.ts` | Persist new settings keys |
| `apps/ws/src/index.ts` | Mount p2p-signaling handlers |

## WS Events
| Event | Direction | Payload |
|-------|-----------|---------|
| `p2p:join` | client→server | `{ topicId, offer: RTCSessionDescription }` |
| `p2p:answer` | server→client | `{ fromUserId, answer }` |
| `p2p:ice` | both | `{ topicId, toUserId?, candidate }` |
| `p2p:leave` | client→server | `{ topicId }` |
| `p2p:peer-left` | server→client | `{ userId }` |
| `p2p:queued` | server→client | `{ position: number }` |
| `p2p:admitted` | server→client | `{ topicId }` |
| `p2p:fallback` | server→client | `{ topicId }` — switch to server E2EE |
| `p2p:resume` | server→client | `{ topicId }` — switch back to P2P |
| `p2p:heartbeat` | client→server | `{ topicId }` — every 15s, proves active |

## Redis Keys
| Key | Type | TTL | Value |
|-----|------|-----|-------|
| `p2p:active:{topicId}` | Hash | — | `{ userId: lastHeartbeat }` |
| `p2p:queue:{topicId}` | List | — | `[userId, ...]` FIFO |
| `p2p:queue-ttl:{topicId}:{userId}` | String | 300s | sentinel for queue expiry |

## ICE Server Config (sent to clients)
```js
// built server-side from system_settings, sent on p2p:join ack
{
  iceServers: [
    ...stun_servers,                          // from settings
    turn_url ? { urls: turn_url, username, credential } : null
  ].filter(Boolean)
}
```

## Effort Estimate
| Task | Days |
|------|------|
| DB migration + schema | 0.5 |
| Admin settings UI (STUN/TURN/limit) | 0.5 |
| Admin topics form (P2P toggles) | 0.5 |
| WS signaling + active tracking + queue | 1.5 |
| Fallback/resume logic (WS + client) | 1 |
| useP2PRoom hook | 1 |
| P2PView + QueueBanner UI | 1 |
| Icons in sidebar/topic header | 0.5 |
| **Total** | **~6.5 days** |

## Out of Scope (v1)
- Message history / export
- Bots / webhooks in P2P topics
- P2P voice/video
- Per-user queue priority
- Persistent queue across server restarts
