# Bundled third-party assets

These assets are served from the local application. No CDN request is needed when using Face Lab. Uploaded images stay in the browser; the local server only serves application files.

## MediaPipe Tasks Vision

- Package: `@mediapipe/tasks-vision`
- Pinned version: **1.0.1** (stable npm/CDN release resolved on 2026-10-01)
- Upstream: https://github.com/google-ai-edge/mediapipe
- Package source: https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/
- License: Apache 2.0. The `LICENSE` file is the upstream MediaPipe license, retrieved from https://cdn.jsdelivr.net/gh/google-ai-edge/mediapipe@v0.10.32/LICENSE .
- Included runtime: `vision_bundle.mjs` and the SIMD and non-SIMD JavaScript/WebAssembly pairs. Use `FilesetResolver.forVisionTasks('./vendor/wasm')` with its default second argument (`false`). The optional ES-module loader variant is not bundled.

## Face Landmarker model

- Model: Face Landmarker, float16, version **1**
- Download source: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
- Model documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker
- Local path: `face_landmarker.task`
- The task model estimates face landmarks. It does not supply a beauty or attractiveness score. Face Lab's scores are application heuristics, not a model output or validated aesthetic judgment.

## SHA-256 checksums

The runtime files were verified against the jsDelivr package metadata. The model checksum identifies the exact downloaded artifact.

| File | SHA-256 |
| --- | --- |
| `vision_bundle.mjs` | `d885630c297c0b20b1fe86096cb06291c4c8080876f27852e724f24ac603713f` |
| `wasm/vision_wasm_internal.js` | `e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73` |
| `wasm/vision_wasm_internal.wasm` | `8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886` |
| `wasm/vision_wasm_nosimd_internal.js` | `e81d715a3d42cc3373602eb2f7aff795d164934db680e32496b65dab537f9658` |
| `wasm/vision_wasm_nosimd_internal.wasm` | `a28483cd42e74e855bf5ebdb6b40d9b66a5b49e35e95020bc97669e6822a3192` |
| `face_landmarker.task` | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |
| `LICENSE` | `8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8` |
