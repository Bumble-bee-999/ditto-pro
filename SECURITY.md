# Security

Ditto Pro is a fully offline desktop app. This page explains how it protects you and how to report a problem.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's **Security → Report a vulnerability** form on this repository (private advisory). Include the version (Help → About), what you did and what happened. You'll get a reply within a few days.

## What the app does to protect you

- **No network access.** The window blocks every request that isn't a local file, so the app cannot upload or download anything while you edit. (The only network use is optional and separate: the build scripts that fetch the speech engine, and the Help → *Suggest a feature* link, which opens GitHub in your browser.)
- **Hardened renderer.** Context isolation and the Chromium sandbox are on, Node.js is not available to the page, a strict Content-Security-Policy is applied, pop-ups / navigation / webviews are denied, and so is every permission request except one: the app's own page may use the **microphone** (audio only, never the camera or the screen) for *Record voice-over*. The recording is written to the app's data folder as a WAV file and never leaves the computer.
- **Locked-down IPC.** Privileged calls are accepted only from the app's own top-level page, and every file path the page sends is validated in the main process.
- **Untrusted project files.** Projects (`.dpro`) and imported edit lists (EDL / XML / `.prproj`) can't make FFmpeg open web addresses, FFmpeg pseudo-protocols (`concat:`, `subfile:` …), network shares (UNC paths — a Windows credential-leak vector) or option-looking strings. Such references are disconnected, you are told, and the clip shows as offline. File sizes are capped and XML entity expansion is limited.
- **Hardened executable.** Electron fuses disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, and the app only loads code from its integrity-checked `app.asar`.
- **Local only.** Projects, caches and the autosave stay on your computer. Nothing is sent to anyone.
- **Review files and shared folders.** A `.dreview` file from a colleague is rebuilt field by field before anything is merged: ids are restricted to a safe alphabet, text is length-capped and stripped of control characters, counts are limited, and nothing in it can reach the file system or FFmpeg. CSV export neutralises cells that a spreadsheet could run as formulas. Lock files beside a project hold only a user name, computer name and times, are size-capped, and have their text cleaned before it is shown. If the folder is read-only, locking is skipped rather than blocking you.
- **AI models run locally, in their own process.** Background removal runs the model in a separate process so that a problem in the native inference library cannot affect the editor; the model files are read from the app's own `models` folder and are verified against a pinned SHA-256 checksum when downloaded by `npm run fetch-models`. Nothing is uploaded.
- **Hardware encoders** are only ever chosen from a fixed list of known encoder names; anything else sent by the page is ignored.
- **Dependencies.** `npm run audit` reports 0 known vulnerabilities in the shipped (production) dependencies; Dependabot is configured in `ci/dependabot.yml`.

## What it does not do (yet)

- **The installer is not code-signed**, so Windows SmartScreen warns on first run. Signing needs a certificate that only the publisher can buy; once you have one, set `CSC_LINK` / `CSC_KEY_PASSWORD` in the build environment and electron-builder signs automatically.
- The speech engine and model are downloaded at build time over HTTPS without a pinned checksum. Build from a network you trust, or place your own files in `whisper/`.
- Media files are decoded by FFmpeg and Chromium, which are large codebases. Keep Ditto Pro updated and only open media you trust.
- Network shares: media must use a mapped drive letter (e.g. `Z:\`), not `\\server\share`. (A project file itself can be opened from a network share through the Open dialog.)
- Shared-folder locks are advisory: they warn people, they do not stop a program that ignores them, and they depend on the folder syncing quickly.
