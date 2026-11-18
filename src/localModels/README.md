# Local models

`models.json` lists the files of each model tool, pinned to a Hugging Face revision, with a
SHA-256 for every 64 MiB (`chunkSize`). `store.ts` checks each chunk before it writes it to
OPFS. To change a model, download its files and run:

```bash
python3 scripts/model-chunks.py chunks.json model.gguf mmproj.gguf
```

Then update `revision`, `path`, `size` and `chunks` in `models.json`. `engine.ts` loads one model
at a time with the vendored wllama (`public/vendor/wllama`).
