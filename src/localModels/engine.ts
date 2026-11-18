import { MODELS, modelFiles, type ModelId } from "./store.ts";

/**
 * llama.cpp in the browser (wllama, public/vendor/wllama), with the model of one tool loaded
 * at a time. It runs threaded only on a cross-origin isolated page, which this site always is:
 * its server sends the headers, and on GitHub Pages public/mini-coi.js adds them.
 */

interface ChatContent {
  type: "text" | "image" | "audio";
  text?: string;
  data?: Uint8Array;
}
interface Chat {
  role: "system" | "user";
  content: string | ChatContent[];
}
interface Wllama {
  loadModel(files: File[], options: Record<string, unknown>): Promise<void>;
  createChatCompletion(
    request: Record<string, unknown>,
  ): Promise<{ choices?: { message?: { content?: string } }[] }>;
  exit(): Promise<void>;
}

let current: { id: ModelId; wllama: Wllama } | undefined;
let loading: Promise<Wllama> | undefined;

const vendor = (path: string) => new URL(`vendor/wllama/${path}`, document.baseURI).href;

async function load(id: ModelId, onProgress: (message: string) => void): Promise<Wllama> {
  if (current?.id === id) return current.wllama;
  if (!crossOriginIsolated) {
    throw new Error(
      "This tool needs the page reloaded once, to turn on the threads the model runs on.",
    );
  }
  if (current) {
    const old = current;
    current = undefined;
    await old.wllama.exit().catch(() => {});
  }
  onProgress(`Loading ${MODELS[id].label}...`);
  const { Wllama } = await import(/* @vite-ignore */ vendor("wllama.js"));
  const wllama: Wllama = new Wllama(
    { default: vendor("wllama.wasm") },
    { suppressNativeLog: true },
  );
  const { files, lora } = await modelFiles(id);
  try {
    await wllama.loadModel(files, {
      n_ctx: 4096,
      n_threads: Math.max(2, Math.min(8, (navigator.hardwareConcurrency ?? 4) - 1)),
      // the vendored wllama puts a file named *.lora.gguf here (public/vendor/wllama/README.md)
      ...(lora && { lora_adapters: [{ path: "/models/lora-1.gguf", scale: 1 }] }),
      // Firefox's WebGPU runs llama.cpp slower than its processor does
      ...(/Firefox\//.test(navigator.userAgent) && { n_gpu_layers: 0 }),
    });
  } catch (error) {
    await wllama.exit().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (/NotReadableError/.test(message)) {
      throw new Error("The model files could not be read. In a private window, try a normal one.", {
        cause: error,
      });
    }
    throw new Error(`${MODELS[id].label} could not be loaded: ${message}`, { cause: error });
  }
  current = { id, wllama };
  return wllama;
}

/** One answer from a tool's model, decoded greedily. */
export async function ask(
  id: ModelId,
  messages: Chat[],
  {
    maxTokens = 700,
    signal,
    onProgress = () => {},
    penalties = false,
  }: {
    maxTokens?: number;
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
    penalties?: boolean;
  } = {},
): Promise<string> {
  // one load at a time: two tools started together would load two models
  const previous = loading;
  loading = (async () => {
    await previous?.catch(() => {});
    return load(id, onProgress);
  })();
  const wllama = await loading;
  const answer = await wllama.createChatCompletion({
    messages,
    max_tokens: maxTokens,
    temperature: 0,
    // small models loop on lists of numbers without these (receipts); a transcript keeps its
    // repeated words, so it goes without
    ...(penalties && { repeat_penalty: 1.15, dry_multiplier: 0.8 }),
    abortSignal: signal,
  });
  signal?.throwIfAborted();
  return answer?.choices?.[0]?.message?.content ?? "";
}

/** Frees the memory of the model that is loaded. */
export async function unloadModel() {
  const old = current;
  current = undefined;
  await old?.wllama.exit().catch(() => {});
}
