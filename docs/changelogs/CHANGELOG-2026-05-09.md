# Changelog — May 9, 2026

## PWA Launch Fix

- **No more blank/white screen** when opening the app from a home screen shortcut. The app now shows the correct background colour immediately and redirects to the last topic you were in without a visible flash.

## Admin: User Management

- **Banned and muted users are now visually flagged** in the users list with red (banned) and yellow (muted) badges, so you can spot moderated accounts at a glance without opening each one.
- **User details panel.** A new info button on each user row opens a modal showing the full picture: avatar, profile fields, registered passkeys, active bans and mutes, and the last 10 entries of ban/mute history including reasons, durations, and who lifted them.
- **Apply ban and apply mute now work correctly.** A bug where clicking "Apply ban" or "Apply mute" did nothing has been fixed.

## Admin: Invite Codes

- **Invite creation now has full scheduling control:** set a _valid from_ date (defaults to now), an expiry datetime (or no expiry), and a max-uses count (or unlimited for user-role invites). Elevated-role invites remain forced single-use.
- **Each code can be disabled and re-enabled** without deleting it — useful for temporarily pausing a code. The list shows the current status of every code (active, disabled, expired, not yet valid, used up).
- **Delete individual codes** directly from the list.
- **Optional notes field.** Attach a short note to any invite code (e.g. "for @username", "community event") — shown in the codes list for easy tracking.

## Admin: User Activity Log

- **Activity log in user detail modal.** When you open any user's details in the admin panel, a new "Activity Log" section shows a reverse-chronological timeline of significant events: sessions created/revoked, bans applied/lifted, mutes applied/lifted, topics joined, and per-topic message counts.
- **Configurable limit.** A selector in the section header lets you show the last 30, 50, or 100 events.

## Topic Password Protection

- **Optional password gate on topics.** Admins can set a password on any topic — users must enter it before seeing the messages. The unlock state is cached locally for a configurable number of days (default 7).
- **Re-entry control.** Configure how many days before a user must re-enter the password, or choose "never re-enter" for a one-time gate.
- **Immediate invalidation.** When changing a password, tick "Require immediate re-entry" to instantly expire all cached unlocks — every user will be prompted again on next visit.
- **Admin bypass.** Admin-role users are never shown the password gate.

## Chat: Hashtag and Symbol Tracking

- **Hashtags extracted from messages.** Any `#word` typed in a message is extracted and stored. Messages can carry up to 20 tags.
- **Tag cloud in the topic profile modal.** Click the info icon on any topic to see a live tag cloud sorted by frequency. Tags update in real time as new messages arrive.
- **Click-to-filter.** Clicking a `#hashtag` or `$symbol` in the tag cloud (or inline in a message) activates a filtered view showing only messages containing that tag within the current topic. A banner at the top shows the active filter with a dismiss button.
- **`#` and `$` autocomplete in the composer.** Typing `#` suggests recent hashtags used in the topic; typing `$` suggests admin-defined symbols.
- **`$symbol` vendor cards.** Filtering by a symbol shows a vendor profile card above the results (name, description, linked user) when the symbol is admin-defined.
- **Admin: Symbols panel.** A new Symbols section in the admin sidebar provides CRUD management for `$symbol` definitions — set symbol, name, description, and optionally link to a user account.

## Chat: System Message Branding

- **System messages now show your community identity.** Messages without a sender (join notifications, admin broadcasts, etc.) display your community name and PWA icon instead of the generic "System" label and placeholder avatar. Configure both in Admin → Settings.

## Admin: Topics and Roles — Master-Detail Layout

- The Topics and Roles admin panels have been redesigned as **master-detail views**: a scrollable list on the left lets you select an item, and the full editor opens on the right — no more long stacked cards.
- Creating a new topic or role now opens the create form in the detail panel. After creation, the new item is selected automatically.
- The Clone button in role editing now prefills the create form and switches directly to it.
- Both panels are responsive: on small screens the list and the detail are shown one at a time with a back button.
