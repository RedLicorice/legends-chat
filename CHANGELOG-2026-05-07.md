# Changelog — May 7, 2026

## Mobile Keyboard & Viewport Fixes

- **Message input no longer hides behind the keyboard** on Android and iOS. The layout now tracks the visible viewport and shrinks to fit when the keyboard opens.
- **Messages scroll to the latest** when the keyboard opens, so you don't lose your place in the conversation.
- Added `interactive-widget=resizes-content` for Chrome Android — the keyboard pushes content up instead of covering it.

## iOS Safe Area & Notch Fixes

- Sidebar, hamburger button, admin panel header, and settings back button are no longer hidden behind the iPhone notch / Dynamic Island.
- **Black gap at the bottom** in Safari fullscreen / standalone PWA mode is fixed.
- Removed unnecessary bottom whitespace in regular Safari browser (safe area padding now only applies in standalone PWA mode where it's actually needed).

## Topic Info Modal

- **Tap any channel name** in the header to open a topic info panel showing the topic icon, banner image, and description.
- Admins can now upload a **banner image** per topic from the admin area.

## Rich Text & Markdown

- **Markdown links** work in messages: `[link text](https://...)` renders as a clickable link.
- **#hashtags** are highlighted in messages (Telegram-style).
- Blockquotes via `> quoted text` are now styled.
- All links open in a new tab with `rel="noopener noreferrer"` for safety.
- Long messages and long URLs **wrap correctly** and no longer overflow the chat bubble.
- Code blocks in messages scroll horizontally instead of breaking the layout.

## @Mention Popup Fix

- The user suggestion popup when typing `@name` now appears **near the input bar**, not at the top of the screen — especially important on mobile with the keyboard open.

## Message Long-Press Menu (Mobile)

- **Redesigned as a bottom sheet** (like Telegram on mobile). It slides up from the bottom of the screen.
- Shows a preview of the message at the top, followed by quick reactions and action buttons.
- No longer renders off-screen when the keyboard is open.

## iOS Autofill Bar

- Disabled the iOS autofill shortcuts bar (credit cards, addresses, etc.) above the keyboard in the message input area.

## UI Polish

- Notification bell icon resized to match the other sidebar icons.
