# Mäuse 🐭

Mäuse is a local-first expense tracker for couples. It keeps shared expenses lightweight: open the app, add an amount, choose how to split it, and move on.

## Highlights

- Fast manual entry with percentage or fixed partner split
- Separate voice entry mode with live preview cards for amount, description, date, and partner share
- Monthly overview with combined totals
- Local IndexedDB storage with JSON backup and restore
- Installable PWA that works well on iPhone home screens
- Manual mode works offline; voice mode is online-only

## Voice Mode

Voice mode is disabled by default and must be enabled in Settings.

1. Open `Settings`
2. Paste an OpenAI API key
3. Tap `Verify Key`
4. Turn on `Enable voice mode`
5. Use the mic button next to the `+` button

What voice mode does:

- Opens a dedicated voice sheet instead of the manual form
- Starts listening immediately
- Updates the preview cards live while you speak
- Hides the raw transcript from the UI
- Lets you switch back to manual entry at any time
- Requires an internet connection and microphone access

Voice implementation details:

- Realtime transcription uses OpenAI `gpt-4o-mini-transcribe`
- Structured field extraction uses OpenAI `gpt-5-nano`
- The extractor applies the newest utterance onto the current draft so older corrections stay stable unless you change that field again

Privacy and storage:

- The OpenAI API key is stored locally on the device
- The API key and voice-mode setting are excluded from backup exports
- Voice mode sends microphone audio and hidden transcription data to OpenAI
- Manual expense data stays in the app's local storage unless you export it

## Manual Entry

Manual entry is always available from the `+` button.

- Enter amount, description, and date
- Choose a percentage split or a fixed amount for your partner
- Save directly into the current month

## Backup And Restore

The app can export expenses to JSON and import them back on another device.

- Export creates a portable backup of expense data
- Import replaces the current local expense data after confirmation
- Voice secrets are intentionally not included in the backup

## Install On iPhone

1. Open the app URL in Safari
2. Tap the Share button
3. Select `Add to Home Screen`
4. Launch Mäuse from the home screen like a native app

## Development

There is no build step.

1. Clone the repo
2. Serve the folder with any static file server, or open `index.html` directly
3. Make changes in `index.html`, `style.css`, `app.js`, and `voice-utils.js`

Useful checks:

- `node --test`
- `node --check app.js`
- `node --check voice-utils.js`
- `node --check sw.js`

## Tech

- Vanilla HTML, CSS, and JavaScript
- IndexedDB for local persistence
- Service Worker for offline caching
- Progressive Web App manifest
- OpenAI Realtime + Responses APIs for voice mode
