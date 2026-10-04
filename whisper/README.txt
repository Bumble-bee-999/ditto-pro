Speech engine folder (offline captions)
=======================================
build-windows.bat / the GitHub workflow download whisper.cpp (whisper-cli.exe + DLLs) and the ggml-base.en.bin
speech model into this folder before packaging, and the installer ships them. Nothing here is committed to git.

To add or change a model by hand: drop any ggml-*.bin file (e.g. ggml-small.bin for better accuracy, or a
multilingual ggml-base.bin) in this folder and rebuild. The app prefers the biggest model it finds.
