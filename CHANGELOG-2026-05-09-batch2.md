# Changelog — 2026-05-09 (Batch 2)

## Fine-Grained Permissions & Feed Threading

### Database

- Add fine-grained permissions schema: topic grants, permission overrides, bot roles, temp roles
- Add notNull constraint to topics.replyRoles schema definition
- Add CHECK constraints, IF NOT EXISTS to indexes, fix uniqueIndex alignment in migration 0032
- Correct migration when timestamps so Drizzle runs 0029-0031 automatically

### Core Permission Logic

- Add resolvePermissions, canPrincipal helpers and grant types to shared library
- Implement server-side canPost/canReply with topic grant resolution
- Enforce canPrincipal in WebSocket message handler and bot sendMessage

### Auth & Bot Auth

- Add lazy role expiry revert + apply permission overrides in getCurrentUser
- Add role resolution, lazy expiry, permission overrides to getBotFromRequest
- Align bot permission-overrides auth with BOTS_MANAGE

### API

- Implement topic grants CRUD + replyRoles in topic admin endpoints
- Add user temp role fields + permission overrides CRUD endpoints
- Add bot temp role fields + permission overrides CRUD endpoints

### Admin UI

- Add topic grants section + replyRoles in AdminTopicsForm
- Add temp role block + permission overrides in user detail modal
- Add bot role + temp role + permission overrides in AdminBotsForm

### Feed Threading

- Implement threaded comments on feed posts with per-post expand/collapse
- Use MarkdownContent for thread reply rendering
