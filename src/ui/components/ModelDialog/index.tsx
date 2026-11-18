import { useRef, useState } from "preact/hooks";

import { PopupData } from "src/ui/AppState";
import { closePopup, openPopup, popupOpen } from "src/ui/PopupStore";
import { formatFileSize } from "src/ui/components/FileInfo";
import {
  MODELS,
  downloadModel,
  modelPage,
  modelSize,
  modelState,
  useOwnFiles,
  type ModelId,
  type Progress,
} from "src/localModels/store";

import "./index.css";

/**
 * Asks before a tool's model is downloaded: what it is, how large, from where, and that it is
 * kept in this browser. Or the reader picks the files from their own disk instead.
 */
function ModelDialog({ id, onDone }: { id: ModelId; onDone: (ready: boolean) => void }) {
  const model = MODELS[id];
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const abort = useRef<AbortController>(null);
  const picker = useRef<HTMLInputElement>(null);
  const busy = progress !== null && !error;

  const run = async (work: (onProgress: (p: Progress) => void) => Promise<void>) => {
    setError("");
    setProgress({ loaded: 0, total: 1 });
    try {
      await navigator.storage.persist?.().catch(() => false);
      await work(setProgress);
      onDone(true);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        onDone(false);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const download = () => {
    abort.current = new AbortController();
    void run((onProgress) => downloadModel(id, onProgress, abort.current!.signal));
  };

  const pickFiles = () => {
    const files = [...(picker.current?.files ?? [])];
    if (picker.current) picker.current.value = "";
    if (files.length) void run((onProgress) => useOwnFiles(id, files, onProgress));
  };

  const percent = progress ? Math.floor((100 * progress.loaded) / Math.max(1, progress.total)) : 0;

  return (
    <div className="model-dialog">
      <h1>This tool runs an AI model in your browser</h1>
      <p>
        <strong>{model.label}</strong> ({model.licence}) reads the file here, on this device:
        nothing you convert is sent anywhere. The model itself is {formatFileSize(modelSize(id))}.
        It is downloaded once from{" "}
        <a href={modelPage(id)} target="_blank" rel="noreferrer">
          Hugging Face
        </a>
        , checked, and kept in this browser for next time.
      </p>
      {busy ? (
        <>
          <progress max={100} value={percent} aria-label="Download progress" />
          <p className="model-dialog-status" aria-live="polite">
            {formatFileSize(progress.loaded)} of {formatFileSize(progress.total)} ({percent}%)
          </p>
          <div className="model-dialog-buttons">
            <button type="button" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          </div>
        </>
      ) : (
        <>
          {error && (
            <p className="model-dialog-error" role="alert">
              {error}
            </p>
          )}
          <div className="model-dialog-buttons">
            <button type="button" className="model-dialog-primary" onClick={download}>
              Download {formatFileSize(modelSize(id))}
            </button>
            <button type="button" onClick={() => picker.current?.click()}>
              Use files from my disk
            </button>
            <button type="button" onClick={() => onDone(false)}>
              Cancel
            </button>
          </div>
          <p className="model-dialog-note">
            Your own files: pick the GGUF model and its mmproj projector together
            {model.files.some((f) => f.role === "lora") ? " (and the LoRA, if you have it)" : ""}.
          </p>
          <input ref={picker} type="file" accept=".gguf" multiple hidden onChange={pickFiles} />
        </>
      )}
    </div>
  );
}

/**
 * Makes sure a model is in this browser before a conversion that needs it starts.
 * @returns Whether it is there now.
 */
export async function ensureModel(id: ModelId): Promise<boolean> {
  if ((await modelState(id)) !== "missing") return true;
  return new Promise((resolve) => {
    let stop: (() => void) | undefined;
    const finish = (ready: boolean) => {
      // settled before the popup closes: closing it would otherwise answer "no" first
      stop?.();
      resolve(ready);
      closePopup();
    };
    PopupData.value = {
      dismissible: false,
      className: "model-dialog-popup",
      contents: <ModelDialog id={id} onDone={finish} />,
    };
    openPopup();
    // closed some other way (it can't be by Escape or a click outside, but be safe)
    stop = popupOpen.subscribe((open) => {
      if (!open) finish(false);
    });
  });
}
