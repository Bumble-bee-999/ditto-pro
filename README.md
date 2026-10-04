# Ditto Pro

A free, offline desktop video editor for Windows. Multi-track timeline, keyframe animation, transitions, titles, colour effects and a real FFmpeg export engine — all running on your own computer. Nothing is uploaded anywhere.

> Ditto Pro is an independent project. It is **not** affiliated with Adobe and is not a clone of any Adobe product; it uses its own name, design and code.

## What it does

| Area | Features |
| --- | --- |
| **Timeline** | Multiple video and audio tracks, drag / trim / split, razor tool, snapping, ripple delete, copy / paste / duplicate, markers, in / out range, zoom, undo & redo, track mute / hide / lock |
| **Preview** | Live program monitor with Full / ½ / ¼ quality,  frame stepping, audio playback, waveforms, drag the picture in the monitor to reposition it |
| **Animation** | Keyframes on position, scale, rotation, opacity, brightness, contrast, saturation, hue, vignette and clip volume with linear, ease and hold interpolation |
| **Transitions** | Cross dissolve, dip to black, four slide-ins and nineteen wipes (directional, iris, clock, barn doors, blinds, diagonal, diamond, plus, wave, checkerboard, blocks, spiral), plus fade in / out on every clip |
| **Titles & graphics** | Text clips with font, size, colour, outline, shadow, line spacing and background box — animatable like any clip. **Rolling credits** (the text scrolls bottom to top over the clip's length). Colour mattes, rectangles and ellipses (rounded corners, outline) on their own or behind text |
| **Blend modes** | Multiply, screen, overlay, darken, lighten, add, difference, exclusion and hard light per clip (Transform ▸ Blend mode); the preview and the export use the same formulas |
| **Effects** | Brightness, contrast, saturation, hue, blur, sharpen, vignette, black & white, sepia, flip, chroma key, **adjustment layers** |
| **Audio** | Per-clip volume with **volume keyframes** (drawn as a line on the clip), fades, speed change, track and clip mute, high-/low-pass filters, 3-band EQ, compressor, **echo**, pan, loudness normalisation on export — all audible in the preview. **Auto-duck** turns music down under speech, **Normalise clip volume** sets a clip's peak to −1 dB, **Detach audio** puts a clip's sound on its own track, **Record voice-over** records the microphone onto the timeline, and an output level meter sits under the transport |
| **Track mixer** | Every track has a fader and the same effects as a clip (EQ, filters, compressor, noise reduction) applied after its clips are mixed — click the sliders icon on a track header |
| **5.1 surround** | Sequence settings ▸ Audio layout ▸ 5.1: place clips with a surround pad (left–right, front–back, centre and bass sends); export six-channel WAV, M4A, MP4 / MOV / WebM, or a stereo mix-down |
| **Colour & geometry** | Import `.cube` 3D LUTs per clip (GPU-accelerated in the preview, identical in export), crop, reverse playback, enable / disable a clip without deleting it |
| **Smart tools** | Remove silences automatically, split at scene changes, noise reduction on export |
| **Colour** | A Colour tab with a Lumetri-style grade per clip or adjustment layer: exposure, temperature, tint, highlights, shadows, whites, blacks, vibrance, RGB and master curves, shadow / midtone / highlight colour wheels, auto tone, and live scopes (waveform, RGB parade, vectorscope, histogram). The grade is baked into one 3D LUT that the preview and the export both use |
| **Stylize** | Invert, posterize, threshold, mosaic, emboss, find edges, film grain, glow and RGB split, plus a luma key, on clips and adjustment layers |
| **Captions** | Speech-to-text with a local Whisper engine, editable caption clips on a CC track, import `.srt` / `.vtt` / `.ass` / `.ssa` / `.sbv`, export `.srt`, burned in on export |
| **Multicam** | Sync angles by audio, switch live with keys `1`–`9`, cuts are written to the timeline, **live grid view** of every angle (click a tile to cut) |
| **Speed ramps** | Clip ▸ Speed ramp…: ease in / out / dip curves between any two speeds, built from frame-aligned pieces so preview and export match; one click back to constant speed |
| **Stabilisation** | Clip ▸ Stabilize…: Ditto Pro's own motion tracker measures camera shake (movement, rotation, zoom), smooths the path or locks the camera, and writes a corrected copy; original kept |
| **Masks & tracking** | Ellipse / rectangle masks with feather and invert (Effect controls ▸ Mask) that can follow a moving object; Clip ▸ Track motion… follows a point you click and either moves another clip with it, holds the picture steady on it, or drives a mask |
| **Auto reframe** | Sequence ▸ Auto reframe…: switch to 9:16, 1:1, 4:5 and more; each clip is panned to keep the movement in view, as editable keyframes |
| **Transcript editing** | Transcript tab: word-level speech-to-text, click a word to jump, delete words (or all "um/uh") to cut that moment from picture and sound on every track, search, fix wording |
| **Background removal** | Clip ▸ Remove background…: an offline AI model (U²-Net / IS-Net, run on this computer, on the graphics card through DirectML when Windows offers it) cuts out the subject of a video clip or a photo. Ditto Pro's own refinement snaps the edge to the real picture (guided filter), smooths over time and handles cuts. The result is a transparent copy (ProRes 4444 / PNG); the picture underneath shows through in preview and export. One click brings the background back |
| **Collaboration** | **Review** tab: comment threads on markers, resolve / reopen, signed with your name. Export a `.dreview` file, send it to a colleague, merge theirs back (comments are united, newer decisions win, hostile files are rejected). Export the comment list as CSV. Working from a shared folder (network drive, OneDrive, Dropbox): a lock file shows who has the project open, you can open a private copy instead, and saving warns before overwriting someone else's changes. No server, nothing is uploaded; it is not live co-editing |
| **Nested sequences** | Nest any selection into one clip, double-click to edit inside, full transform / effects / keyframes on the nest, transparency preserved |
| **Import** | Other editors' projects (CMX3600 EDL, Premiere-style "Final Cut Pro XML" / xmeml, FCPXML, OpenTimelineIO `.otio`, experimental `.prproj`); numbered image sequences (File → Import image sequence, PNG keeps transparency); media: MP4, MOV, MKV, AVI, WebM, MXF, WMV, MP3, WAV, FLAC, AAC, PNG, JPG and more (anything FFmpeg can read). Formats the preview can't play directly get an automatic low-res proxy; export always uses your original files |
| **Editing tools** | Lift and Extract between the in / out points (`;` and `'`), ripple trim to the playhead (`Q` / `W`), ripple trim and roll by dragging a clip edge with `Ctrl` / `Alt`, slip by `Alt`-dragging a clip, nudge (`Alt` + arrows), insert edit from the Project panel, paste effects / paste motion, close gaps, Freeze frame at the playhead (inserts a 2 s still and ripples the track), Export current frame as PNG or JPEG at full sequence size, clip label colours, safe-margin guides in the monitor |
| **Export** | Render queue (batch export), one-click presets (YouTube 1080p / 4K, vertical, square, small web file, ProRes master, GIF, podcast MP3), EDL export for other editors, timeline markers written as MP4 / MOV / M4A chapters; formats: MP4 (H.264 / H.265), ProRes MOV, WebM (VP9), GIF, PNG sequence, WAV, MP3, M4A — any frame size, quality slider, whole sequence or just the in / out range. Optional **graphics-card encoding** (NVIDIA NVENC, Intel Quick Sync, AMD AMF): the export dialog lists only the encoders that passed a real test on your computer, and a failed hardware export is redone in software automatically |
| **Projects** | Save / open `.dpro` files, crash-recovery autosave, relink offline media, **Collect project files** (copies every file the project uses into one folder with a copy of the project; when that folder is moved or opened on another computer the files are found beside the project) |

## Install (end users)

Download `Ditto-Pro-Setup-x.y.z.exe` from the **Releases** page and run it. The build is not code-signed, so Windows SmartScreen may say "unknown publisher" the first time — choose **More info → Run anyway**.

## Build the installer yourself

You need [Node.js](https://nodejs.org) 20 or newer (LTS is fine) on **Windows**.

```bat
build-windows.bat
```

That installs dependencies and produces `dist\Ditto-Pro-Setup-<version>.exe`. Or by hand:

```bat
npm install
npm run dist
```

> The installer must be built on Windows, because the bundled FFmpeg is downloaded for the operating system you build on.

To run from source without building an installer: `run-dev.bat` (or `npm install && npm start`).

## Publish a release on GitHub

`ci/build.yml` is a GitHub Actions workflow that builds the installer on GitHub's Windows machines and attaches it to a release. Before the first release, copy it to `.github/workflows/build.yml` in your repository (create the folders if needed), commit, then:

```bash
git tag v0.1.0
git push origin v0.1.0
```

You can also run it by hand from the **Actions** tab (**Build Windows installer → Run workflow**); the installer is then available as a downloadable build artifact.

## Security and feedback

Ditto Pro runs fully offline with a sandboxed, network-blocked window, validated IPC and hardened handling of untrusted project files — see [SECURITY.md](SECURITY.md). Missing a feature? Use **Help → Suggest a feature / report a bug** (opens the GitHub issue form). Before the first release, copy `ci/ISSUE_TEMPLATE/` and `ci/dependabot.yml` into `.github/`.

## Keyboard shortcuts

`Space` play / pause · `←` `→` step a frame (Shift: one second) · `↑` `↓` previous / next cut · `V` select · `C` razor · `Ctrl+K` split at playhead · `Delete` delete · `Shift+Delete` ripple delete · `Ctrl+C` / `V` / `D` copy / paste / duplicate · `Ctrl+Z` / `Ctrl+Shift+Z` undo / redo · `S` snapping · `M` marker · `I` / `O` in / out · `;` lift · `'` extract · `Q` / `W` ripple trim to playhead · `Alt+←/→` nudge · `Ctrl+Alt+←/→` slip · `Ctrl+Alt+V` paste effects · `=` `-` `\` zoom · `Ctrl+I` import · `Ctrl+E` export · `Ctrl+S` save

## Known limitations

Ditto Pro is a young project, not a replacement for a full professional suite.

- **Preview vs. export.** The live preview is composited on the graphics card (WebGL2) when available and on the 2D canvas otherwise; the export is rendered by FFmpeg. They match closely but not pixel-for-pixel. Audio EQ and compressor in the preview match the export to within about 1 dB.
- **Heavy projects.** Media larger than 1440p, or in formats the preview cannot decode, gets a low-res proxy automatically for preview; export always uses your originals. Very layered 4K timelines can still play below real time.
- **Keyframed opacity and rotation** make exports slower than static values.
- **5.1 surround.** A 5.1 project places each clip around six channels (stereo sources are spread, not up-mixed by guesswork); the preview plays a stereo mix-down of that placement (centre and surrounds at −3 dB, bass channel dropped), so judge final surround balance on a real 5.1 system. MP3 is always stereo. Surround is for mixing and delivery; there is no surround meter yet.
- **Captions need a speech engine.** `npm run fetch-whisper` (run automatically by `build-windows.bat` and the CI workflow) downloads whisper.cpp and an English model into `whisper/`, and the installer bundles them. Without it, the Captions → Generate command tells you what is missing; importing `.srt` files always works. Accuracy depends on the model you place there (e.g. swap in a larger `ggml-*.bin`).
- **Project import is best-effort.** EDL, xmeml, FCPXML and OpenTimelineIO bring in cuts, tracks, speed and basic transitions (OTIO has no picture size, so you get 1920×1080 to adjust). AAF, Avid bins / ALE and Premiere's own effect settings are not read, and effects and many other editor-specific settings are not translated. `.prproj` reading is **experimental**: the format is undocumented and varies between versions, so expect to relink media and re-check results.
- **Noise reduction** is applied on export only (no preview). **Reversed clips** preview frame by frame without sound; export is exact.
- **Nested sequences** are rendered once to a cache (ProRes 4444) and re-rendered when their contents change; the first render of a big nest takes a moment.
- **Speed ramps** are built from short constant-speed pieces (about 2–3 per second of footage), so audio pitch changes in steps and Ctrl+Z / the Clip menu treat the ramp as a group. **Stabilisation** re-encodes the clip (H.264, near-lossless) and zooms in slightly to hide edges; it corrects camera shake, not rolling-shutter wobble inside a frame.
- **Tracking** follows one point (movement only: no rotation or size change) and, if the patch is hidden or leaves the frame, holds the last position and tells you how many frames were lost. **Auto reframe** follows movement, not faces or people; check the result and adjust the pan keyframes where it guessed wrong. A fixed mask is cheap to export; a tracked mask is drawn at reduced resolution during export, so its edge is a little softer.
- **Background removal** finds the main subject (people, animals, products, vehicles); it does not pick between several subjects and can miss very thin or semi-transparent parts (smoke, glass, fine hair against a similar background) — raise "Edge softness" or use "Grow / shrink" to adjust. It processes only the part of the clip in use, and writes a large, high-quality copy (ProRes 4444). The bundled fast model (U²-Netp) is weaker than the optional best-quality model (IS-Net, fetched by `npm run fetch-models`, about 170 MB); on a processor alone IS-Net takes several seconds per frame, so use "Run the AI on every 2nd / 4th frame" for long clips or let it use the graphics card. A stabilised or already cut-out clip can't be stabilised again.
- **Collaboration is file-based, not live.** Comments travel as `.dreview` files, and shared-folder locks rely on the folder syncing promptly; a sync service that delays files can show an out-of-date lock or hide a colleague's save for a while. There is no merging of timeline edits between two people: the app warns and lets you keep both versions.
- **Hardware encoders** depend on your graphics driver; the quality at a given file size is a little lower than the software encoders, which stay the default. Not every NVIDIA / Intel / AMD part supports HEVC.
- **Not available:** Adobe's cloud services (Firefly generative fill, Enhance Speech, Adobe Stock, Creative Cloud libraries) — they are Adobe's servers and cannot be reproduced offline; Ditto Pro is fully offline and contains no generative-AI features.
- **GPU.** The preview has its own GPU compositor (`renderer/gpu.js`, WebGL2): every layer's transform, crop, flips, LUT, sharpen, vignette, chroma key, brightness / contrast / saturation / hue / grey / sepia, blur, mask and opacity, plus adjustment layers, are drawn on the card without reading pixels back. Choose *Compositor: Auto / GPU / Canvas* in the Program panel; Auto falls back to the canvas path if WebGL2 is missing. A test compares the two paths on 16 scenes (plus every Stylize effect and all nineteen wipes) and requires them to agree (mean difference ≤ 3–4 / 255). Film grain is random, so the preview and the export match in strength, not pixel for pixel. Video **decoding** is Chromium's own hardware decoder (D3D11 on Windows); Ditto Pro does not ship a decoder of its own, because FFmpeg-in-software or a custom one would be slower than the hardware path. The compositor has only been measured on a software GL stack here, not on a real graphics card. Very heavy timelines still rely on proxies and the preview-quality setting.
- The installer is not code-signed. UNC network paths in projects are blocked for safety; use a mapped drive letter.

## Development

```text
src/main.js        Electron main process: windows, file dialogs, FFmpeg probing, proxies, export
src/exporter.js    Turns a project into an FFmpeg filter graph (pure Node, unit-testable)
src/shared.js      Project model, keyframe maths, title drawing (shared by app and exporter)
src/importers.js   EDL / xmeml / FCPXML / .prproj readers; also lut, analysis, srt, whisper, sync modules
src/bgremove.js    Offline background removal (onnxruntime + guided-filter refinement); runs in src/bgjob.js, its own process
src/review.js      Comment threads and review-file merging; src/collab.js shared-folder locks; src/hwenc.js hardware encoders
whisper/           Speech engine + model (fetched at build time, see whisper/README.txt)
models/            Background-removal models (ONNX): u2netp included, isnet fetched by `npm run fetch-models`
renderer/          The editor UI (plain JavaScript, no build step)
test/              Export tests (real FFmpeg renders) and an Electron smoke test
```

- `npm test` renders real files with the bundled FFmpeg and checks the results.
- `npm run test:app` boots the real app under a virtual display (Linux, needs `xvfb`) and drives it.

## Licence

MIT for the Ditto Pro code. The bundled FFmpeg build has its own licence (GPL/LGPL) — see <https://ffmpeg.org/legal.html>.
