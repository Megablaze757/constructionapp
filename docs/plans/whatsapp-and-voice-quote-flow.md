# Implementation Plan: One-Tap WhatsApp Quote Sharing & Voice Creation

## Overview
This plan breaks down the implementation of the WhatsApp Quote Sharing and Voice-First Creation UI spec into 4 ordered, testable tasks. Each task touches isolated files and leaves the application fully functional and testable.

---

## Task 1: Add Primary WhatsApp Share Action to Quote Builder UI

**Description:** Add a prominent green WhatsApp share button (`#whatsapp-share-btn`) to `web/builder.html` and wire the WhatsApp URI scheme generator in `web/assets/js/builder.js`.

**Acceptance criteria:**
- [ ] A green **"Send via WhatsApp"** button appears on `builder.html` when a quote URL exists or is saved.
- [ ] Tapping the button generates a valid `https://wa.me/?text=...` or `whatsapp://send?text=...` URI containing client name, site address, and public quote URL.
- [ ] Clicking the button opens WhatsApp in a new tab/window on desktop or launches native WhatsApp on mobile devices.
- [ ] If no client phone is entered, it opens WhatsApp contact picker; if phone is present, pre-targets the contact.

**Verification:**
- [ ] Open `http://localhost:8788/builder.html?id=quote-123` in browser.
- [ ] Click "Send via WhatsApp" and verify `wa.me` URL contains properly encoded quote parameters.

**Files touched:**
- `web/builder.html`
- `web/assets/js/builder.js`

**Estimated scope:** Small (2 files)

---

## Task 2: Enlarge & Standardize Voice Recording Touch Target

**Description:** Upgrade the voice recording trigger (`#record-btn`) in `web/builder.html` to a high-contrast, large touch-target button with active recording animation and status feedback.

**Acceptance criteria:**
- [ ] `#record-btn` has minimum 52px height and prominent microphone styling for easy site use with gloved hands.
- [ ] Holding/tapping toggle reflects real-time visual recording states (*"Listening... Speak now"* vs. *"Tap to speak quote"*).
- [ ] Speech transcript automatically appends to `#description` textarea.
- [ ] Falls back gracefully to standard typing if Web Speech API / microphone access is unavailable.

**Verification:**
- [ ] Open `http://localhost:8788/builder.html` on mobile or inspect view.
- [ ] Verify button height, contrast, and speech-to-text transcript population.

**Files touched:**
- `web/builder.html`
- `web/assets/app.css`
- `web/assets/js/builder.js`

**Estimated scope:** Small (3 files)

---

## Task 3: Add Quick WhatsApp Resend Action to Quotes List

**Description:** Add a quick WhatsApp share icon next to each quote entry in `web/index.html` list view, allowing builders to resend existing quotes in 1 click without entering the builder.

**Acceptance criteria:**
- [ ] Each recent quote row on `web/index.html` displays a compact green WhatsApp share icon.
- [ ] Tapping the WhatsApp icon on a quote row instantly constructs the client message and launches WhatsApp.
- [ ] Works seamlessly for both local WebAssembly/SQLite quotes and cloud Worker quotes.

**Verification:**
- [ ] Navigate to `http://localhost:8788/index.html`.
- [ ] Click WhatsApp icon on any listed quote and verify the opened share message.

**Files touched:**
- `web/index.html`
- `web/assets/js/list.js`

**Estimated scope:** Small (2 files)

---

## Task 4: Add Web Share API & Clipboard Copy Fallback

**Description:** Add graceful fallback logic when WhatsApp is not installed or when running on desktop browsers without direct WhatsApp URI support.

**Acceptance criteria:**
- [ ] Uses `navigator.share()` API if native device sharing is available.
- [ ] Copies quote URL to clipboard and shows a toast notification (*"Quote link copied to clipboard!"*) if sharing API/WhatsApp is blocked.
- [ ] Ensures quote links are never lost or uncopied.

**Verification:**
- [ ] Test share button in desktop browser without WhatsApp protocol handler.
- [ ] Confirm clipboard toast notification appears and quote URL is copied.

**Files touched:**
- `web/assets/js/builder.js`
- `web/assets/js/list.js`

**Estimated scope:** Small (2 files)
