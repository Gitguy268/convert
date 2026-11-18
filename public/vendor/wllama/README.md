# wllama

[ngxson/wllama](https://github.com/ngxson/wllama) 3.11.0 (MIT), llama.cpp for the browser, built
from `1a5687ef7c` on `master` (llama.cpp `5c8854f`). This is the same build as
[textarea](https://github.com/Gitguy268/textarea)'s `vendor/wllama`: `wllama.js` is
`esm/index.min.js` and `wllama.wasm` is `src/wasm/wllama.wasm`, the JSPI + memory64 + WebGPU
build. The compatibility build for browsers without JSPI or memory64 is left out (16 MB). The
model tools say so in the README's limits.

Used by `src/localModels/engine.ts`. It's loaded only when a model tool runs.

## Local changes to `wllama.js`

1. **Thread pool:** the pool is created with twice the threads llama.cpp gets, plus four
   (`new ProxyToWorker(h,this.useMultiThread?2*g+4:0,` where upstream has `g`). The image
   and audio encoders start threads of their own, and a WebAssembly thread can only start on a
   worker that already exists. With upstream's pool, an image or audio request hangs without an
   error. The change comes from textarea.
2. **LoRA files:** in `prepareBlobs`, a file whose name ends in `.lora.gguf` is written to
   `/models/lora-N.gguf` instead of being taken as a shard of the model. `loadModel` can then
   be given `lora_adapters: [{ path: "/models/lora-1.gguf" }]`. Upstream has no way to hand a
   LoRA file to the worker.

Re-apply both after refreshing the bundle. Each one is one exact string replacement, and each
string occurs once.
