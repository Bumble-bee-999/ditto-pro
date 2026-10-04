Background-removal models (ONNX, run offline with onnxruntime)

  u2netp.onnx              fast model, included in the repository (U2-Net, Apache-2.0)
  isnet-general-use.onnx   best-quality model (IS-Net / DIS, Apache-2.0). Not in the repository because of its size:
                           run "npm run fetch-models" (build-windows.bat does this for you) to download and verify it.

You can also drop either file into the "models" folder inside the app's data folder to add it without rebuilding.
