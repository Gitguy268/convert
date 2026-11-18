"""SHA-256 of every 64 MiB of model files, for src/localModels/models.json.
Usage: python3 scripts/model-chunks.py out.json model.gguf mmproj.gguf ..."""

import hashlib, json, os, sys
CHUNK = 64 * 1024 * 1024
out = {}
for path in sys.argv[2:]:
    hashes = []
    with open(path, "rb") as f:
        while (b := f.read(CHUNK)):
            hashes.append(hashlib.sha256(b).hexdigest())
    out[os.path.basename(path)] = {"size": os.path.getsize(path), "chunks": hashes}
json.dump(out, open(sys.argv[1], "w"), indent=1)
print({k: (v["size"], len(v["chunks"])) for k, v in out.items()})
