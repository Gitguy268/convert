import registry from "./models.json";

/**
 * The large models some tools run (Mermaid from a picture, receipts, speech to text), kept in
 * the browser's private storage (OPFS). They are too large for this site to serve, so they
 * come from Hugging Face, once, after the page has asked: every 64 MiB is checked against the
 * SHA-256 in models.json before it is kept. Or the reader picks the files from their own disk.
 */

export type ModelId = keyof typeof registry.models;
export type ModelFile = (typeof registry.models)[ModelId]["files"][number];
export interface ModelInfo {
  label: string;
  licence: string;
  files: ModelFile[];
}

export const CHUNK = registry.chunkSize;
export const MODELS = registry.models as Record<ModelId, ModelInfo>;

export const isModelId = (id: unknown): id is ModelId =>
  typeof id === "string" && Object.hasOwn(MODELS, id);

/** Bytes a model takes, all its files together. */
export const modelSize = (id: ModelId) => MODELS[id].files.reduce((n, f) => n + f.size, 0);

/** Where the files come from: Hugging Face, or the same site in test/localModels.browser.test.ts. */
const testBase = () => (globalThis as { __LOCAL_MODELS_BASE__?: string }).__LOCAL_MODELS_BASE__;

export const fileUrl = (file: ModelFile) =>
  testBase()
    ? `${testBase()}${encodeURIComponent(file.path)}`
    : `https://huggingface.co/${file.repo}/resolve/${file.revision}/${encodeURIComponent(file.path)}`;

export const modelPage = (id: ModelId) => `https://huggingface.co/${MODELS[id].files[0].repo}`;

/** Where a model's files live in OPFS. */
async function folder(id: ModelId, create = false) {
  const root = await navigator.storage.getDirectory();
  const models = await root.getDirectoryHandle("local-models", { create });
  return models.getDirectoryHandle(id, { create });
}

/** The name a file has in OPFS: its role, so files the reader picked fit the same place. */
const stored = (file: ModelFile) => `${file.role}.gguf`;

const COMPLETE = "complete.json";

/** Whether a model is in this browser, whole, and where it came from. */
export async function modelState(id: ModelId): Promise<"ready" | "own" | "missing"> {
  try {
    const dir = await folder(id);
    const marker = await (await dir.getFileHandle(COMPLETE)).getFile();
    const { source } = JSON.parse(await marker.text()) as { source: "download" | "own" };
    return source === "own" ? "own" : "ready";
  } catch {
    return "missing";
  }
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Progress {
  loaded: number;
  total: number;
}

/**
 * Downloads a model into OPFS. A download that was interrupted goes on from the last whole
 * 64 MiB it kept, with a Range request.
 */
export async function downloadModel(
  id: ModelId,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
) {
  const dir = await folder(id, true);
  await dir.removeEntry(COMPLETE).catch(() => {});
  const total = modelSize(id);
  let done = 0;
  for (const file of MODELS[id].files) {
    const handle = await dir.getFileHandle(stored(file), { create: true });
    const existing = (await handle.getFile()).size;
    // only whole, checked chunks were ever written, so a partial file ends on a chunk boundary
    let offset = Math.min(existing - (existing % CHUNK), file.size);
    if (existing === file.size) offset = file.size;
    done += offset;
    onProgress({ loaded: done, total });
    if (offset === file.size) continue;

    const writable = await handle.createWritable({ keepExistingData: true });
    try {
      await writable.truncate(offset);
      await writable.seek(offset);
      const response = await fetch(fileUrl(file), {
        headers: offset ? { Range: `bytes=${offset}-` } : {},
        signal,
      });
      if (!response.ok || !response.body)
        throw new Error(`Hugging Face answered ${response.status} for ${file.path}.`);
      if (offset && response.status !== 206)
        throw new Error("The download could not go on where it stopped.");
      const reader = response.body.getReader();
      let chunk = new Uint8Array(Math.min(CHUNK, file.size - offset));
      let filled = 0;
      let index = offset / CHUNK;
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (value) {
          let at = 0;
          while (at < value.length) {
            if (!chunk.length) throw new Error(`${file.path} is larger than it should be.`);
            const n = Math.min(chunk.length - filled, value.length - at);
            chunk.set(value.subarray(at, at + n), filled);
            filled += n;
            at += n;
            done += n;
            if (filled === chunk.length) {
              if ((await sha256(chunk)) !== file.chunks[index]) {
                throw new Error(
                  `Part ${index + 1} of ${file.path} did not arrive intact. Try again.`,
                );
              }
              // 16 MB at a time: Firefox stalls on one large write
              for (let s = 0; s < chunk.length; s += 16 << 20)
                await writable.write(chunk.subarray(s, s + (16 << 20)));
              index++;
              const left = file.size - index * CHUNK;
              chunk = new Uint8Array(Math.max(0, Math.min(CHUNK, left)));
              filled = 0;
            }
          }
          onProgress({ loaded: done, total });
        }
        if (ended) break;
      }
      if (index !== file.chunks.length) throw new Error(`${file.path} ended early. Try again.`);
    } finally {
      await writable.close();
    }
  }
  await writeMarker(dir, "download");
}

async function writeMarker(dir: FileSystemDirectoryHandle, source: "download" | "own") {
  const marker = await (await dir.getFileHandle(COMPLETE, { create: true })).createWritable();
  await marker.write(JSON.stringify({ source, at: new Date().toISOString() }));
  await marker.close();
}

/** Whether a GGUF file is a projector (images or sound) rather than a language model. */
export async function isProjector(file: Blob) {
  const head = new TextDecoder("latin1").decode(await file.slice(0, 1 << 17).arrayBuffer());
  return /general\.architecture.{12}clip/s.test(head);
}

/**
 * Keeps model files the reader picked from their own disk, by role: the projector is told
 * apart by what it says it is, a LoRA (receipts) by "lora" in its name.
 */
export async function useOwnFiles(id: ModelId, files: File[], onProgress: (p: Progress) => void) {
  const roles = new Map<string, File>();
  for (const file of files) {
    const role = /lora/i.test(file.name) ? "lora" : (await isProjector(file)) ? "mmproj" : "model";
    roles.set(role, file);
  }
  const missing = MODELS[id].files.filter((f) => f.role !== "lora" && !roles.has(f.role));
  if (missing.length) {
    throw new Error(
      `Pick both files: the model and its projector (mmproj). Missing: ${missing.map((f) => f.role).join(", ")}.`,
    );
  }
  const dir = await folder(id, true);
  await dir.removeEntry(COMPLETE).catch(() => {});
  const total = [...roles.values()].reduce((n, f) => n + f.size, 0);
  let done = 0;
  for (const [role, file] of roles) {
    const writable = await (
      await dir.getFileHandle(`${role}.gguf`, { create: true })
    ).createWritable();
    for (let s = 0; s < file.size; s += 16 << 20) {
      await writable.write(await file.slice(s, s + (16 << 20)).arrayBuffer());
      done += Math.min(16 << 20, file.size - s);
      onProgress({ loaded: done, total });
    }
    await writable.close();
  }
  await writeMarker(dir, "own");
}

/** The model's files as wllama takes them; a LoRA is named so the vendored wllama knows it. */
export async function modelFiles(id: ModelId): Promise<{ files: File[]; lora: boolean }> {
  const dir = await folder(id);
  const files: File[] = [];
  let lora = false;
  for (const role of ["model", "mmproj", "lora"]) {
    try {
      const file = await (await dir.getFileHandle(`${role}.gguf`)).getFile();
      files.push(new File([file], role === "lora" ? "adapter.lora.gguf" : `${role}.gguf`));
      lora ||= role === "lora";
    } catch {
      if (role !== "lora")
        throw new Error(`The ${MODELS[id].label} files are not in this browser.`);
    }
  }
  return { files, lora };
}

/** Removes a model from this browser. */
export async function forgetModel(id: ModelId) {
  const root = await navigator.storage.getDirectory();
  const models = await root.getDirectoryHandle("local-models", { create: true });
  await models.removeEntry(id, { recursive: true }).catch(() => {});
}
