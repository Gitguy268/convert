import { signal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { X } from "lucide-preact";

import type { Cue } from "src/handlers/modelTools";
import { stripExt } from "src/common";
import StyledButton, { ButtonVariant } from "src/ui/components/StyledButton";

import "./index.css";

/**
 * The editors that open over the page from a result or a tool: Mermaid with a live drawing,
 * and subtitles with the waveform, the video and a burn-in. One glass sheet hosts both.
 */
export type StudioState =
  | { kind: "mermaid"; name: string; text: string }
  | { kind: "subtitles"; name: string; cues: Cue[]; media?: File };

export const Studio = signal<StudioState | null>(null);

function save(data: BlobPart, name: string, type: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([data], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

// ---------------------------------------------------------------------------- Mermaid

function MermaidEditor({ name, text }: { name: string; text: string }) {
  const [code, setCode] = useState(text);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const { renderMermaid } = await import("src/handlers/mermaid");
        const drawn = await renderMermaid(code);
        if (current) {
          setSvg(drawn);
          setError("");
        }
      } catch (e) {
        if (current)
          setError(e instanceof Error ? e.message.split("\n").slice(0, 4).join("\n") : String(e));
      }
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [code]);

  const savePng = async () => {
    const image = new Image();
    image.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    await image.decode();
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth * scale;
    canvas.height = image.naturalHeight * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(image.src);
    canvas.toBlob((blob) => blob && save(blob, `${stripExt(name)}.png`, "image/png"));
  };

  // the SVG is mermaid's own output with securityLevel "strict": no script and no HTML labels
  const preview = useMemo(() => ({ __html: svg }), [svg]);

  return (
    <div className="studio-mermaid">
      <label className="studio-pane">
        <span className="studio-pane-title">Mermaid</span>
        <textarea
          value={code}
          spellcheck={false}
          onInput={(ev) => setCode(ev.currentTarget.value)}
          aria-label="Mermaid code"
        />
      </label>
      <div className="studio-pane">
        <span className="studio-pane-title">Drawing</span>
        {error && (
          <pre className="studio-error" role="status">
            {error}
          </pre>
        )}
        <div className="studio-preview" dangerouslySetInnerHTML={preview} />
      </div>
      <div className="studio-actions">
        <StyledButton onClick={() => save(code, `${stripExt(name)}.mmd`, "text/vnd.mermaid")}>
          Save .mmd
        </StyledButton>
        <StyledButton
          onClick={() => save(svg, `${stripExt(name)}.svg`, "image/svg+xml")}
          disabled={!svg}
        >
          Save SVG
        </StyledButton>
        <StyledButton onClick={savePng} disabled={!svg}>
          Save PNG
        </StyledButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- subtitles

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
};

/** Loudness of the sound in `buckets` columns, for the waveform. */
async function peaksOf(
  file: File,
  buckets = 1600,
): Promise<{ peaks: Float32Array; duration: number }> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await file.arrayBuffer());
    const data = audio.getChannelData(0);
    const peaks = new Float32Array(buckets);
    const step = Math.max(1, Math.floor(data.length / buckets));
    for (let b = 0; b < buckets; b++) {
      let max = 0;
      for (let i = b * step; i < Math.min(data.length, (b + 1) * step); i++)
        max = Math.max(max, Math.abs(data[i]));
      peaks[b] = max;
    }
    return { peaks, duration: audio.duration };
  } finally {
    await context.close();
  }
}

/** Draws the cues on each frame of the video with mediabunny, keeping the sound as it is. */
async function burnIn(
  media: File,
  cues: Cue[],
  onProgress: (p: number) => void,
): Promise<Uint8Array> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(media) });
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  let canvas: OffscreenCanvas | undefined;
  const conversion = await mb.Conversion.init({
    input,
    output,
    video: (track) => ({
      processedWidth: track.displayWidth,
      processedHeight: track.displayHeight,
      quality: mb.QUALITY_HIGH,
      process(sample) {
        canvas ??= new OffscreenCanvas(track.displayWidth, track.displayHeight);
        const ctx = canvas.getContext("2d")!;
        sample.draw(ctx, 0, 0, canvas.width, canvas.height);
        const cue = cues.find((c) => sample.timestamp >= c.start && sample.timestamp < c.end);
        if (cue) {
          const size = Math.round(canvas.height / 18);
          ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.lineJoin = "round";
          ctx.lineWidth = size / 5;
          ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
          ctx.fillStyle = "#fff";
          const lines = cue.text.split("\n");
          lines.forEach((line, i) => {
            const y = canvas!.height - size * 0.9 - (lines.length - 1 - i) * size * 1.2;
            ctx.strokeText(line, canvas!.width / 2, y, canvas!.width * 0.92);
            ctx.fillText(line, canvas!.width / 2, y, canvas!.width * 0.92);
          });
        }
        return canvas;
      },
    }),
  });
  conversion.onProgress = onProgress;
  await conversion.execute();
  if (!output.target.buffer) throw new Error("The video could not be written.");
  return new Uint8Array(output.target.buffer);
}

function SubtitleEditor({
  name,
  cues: initial,
  media: initialMedia,
}: {
  name: string;
  cues: Cue[];
  media?: File;
}) {
  const [cues, setCues] = useState(initial);
  const [media, setMedia] = useState(initialMedia);
  const [wave, setWave] = useState<{ peaks: Float32Array; duration: number } | null>(null);
  const [time, setTime] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ index: number; edge: "start" | "end" } | null>(null);
  const url = useMemo(() => (media ? URL.createObjectURL(media) : ""), [media]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const isVideo =
    !!media && (media.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(media.name));

  useEffect(() => {
    if (!media) return;
    peaksOf(media).then(setWave, () => setWave(null));
  }, [media]);

  const duration = wave?.duration || Math.max(1, ...cues.map((c) => c.end));

  // the waveform, the cues as bands over it and the playhead
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const ctx = c.getContext("2d")!;
    const { width, height } = c;
    ctx.clearRect(0, 0, width, height);
    const x = (s: number) => (s / duration) * width;
    ctx.fillStyle = "rgba(80, 140, 255, 0.22)";
    ctx.strokeStyle = "rgba(80, 140, 255, 0.9)";
    ctx.lineWidth = 2 * ratio;
    for (const cue of cues) {
      ctx.fillRect(x(cue.start), 0, x(cue.end) - x(cue.start), height);
      ctx.strokeRect(x(cue.start), 1, x(cue.end) - x(cue.start), height - 2);
    }
    if (wave) {
      ctx.fillStyle = getComputedStyle(c).color;
      const w = width / wave.peaks.length;
      for (const [i, p] of wave.peaks.entries()) {
        const h = Math.max(1, p * height * 0.9);
        ctx.fillRect(i * w, (height - h) / 2, Math.max(1, w), h);
      }
    }
    ctx.fillStyle = "#ff4d4f";
    ctx.fillRect(x(time) - ratio, 0, 2 * ratio, height);
  }, [cues, wave, time, duration]);

  const update = (index: number, change: Partial<Cue>) =>
    setCues((list) => list.map((c, i) => (i === index ? { ...c, ...change } : c)));
  const seek = (s: number) => {
    setTime(s);
    if (player.current) player.current.currentTime = s;
  };
  const secondsAt = (ev: PointerEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((ev.clientX - rect.left) / rect.width) * duration));
  };
  const onDown = (ev: PointerEvent) => {
    const s = secondsAt(ev);
    const near = (6 / canvas.current!.clientWidth) * duration;
    for (const [index, cue] of cues.entries()) {
      for (const edge of ["start", "end"] as const) {
        if (Math.abs(cue[edge] - s) < near) {
          drag.current = { index, edge };
          canvas.current!.setPointerCapture(ev.pointerId);
          return;
        }
      }
    }
    seek(s);
  };
  const onMove = (ev: PointerEvent) => {
    if (!drag.current) return;
    const { index, edge } = drag.current;
    const s = Math.round(secondsAt(ev) * 100) / 100;
    const cue = cues[index];
    if (edge === "start") update(index, { start: Math.min(s, cue.end - 0.1) });
    else update(index, { end: Math.max(s, cue.start + 0.1) });
  };

  const active = cues.findIndex((c) => time >= c.start && time < c.end);
  const split = (index: number) => {
    const cue = cues[index];
    const at = time > cue.start && time < cue.end ? time : (cue.start + cue.end) / 2;
    const words = cue.text.split(/\s+/);
    const half = Math.ceil(words.length / 2);
    setCues((list) => [
      ...list.slice(0, index),
      { start: cue.start, end: at, text: words.slice(0, half).join(" ") },
      { start: at, end: cue.end, text: words.slice(half).join(" ") },
      ...list.slice(index + 1),
    ]);
  };
  const merge = (index: number) =>
    setCues((list) => [
      ...list.slice(0, index),
      {
        start: list[index].start,
        end: list[index + 1].end,
        text: `${list[index].text} ${list[index + 1].text}`,
      },
      ...list.slice(index + 2),
    ]);

  const saveAs = async (kind: "srt" | "vtt") => {
    const { toSrt, toVtt } = await import("src/handlers/modelTools");
    const sorted = cues.toSorted((a, b) => a.start - b.start);
    save(
      kind === "srt" ? toSrt(sorted) : toVtt(sorted),
      `${stripExt(name)}.${kind}`,
      kind === "srt" ? "application/x-subrip" : "text/vtt",
    );
  };
  const burn = async () => {
    if (!media) return;
    setBusy("Burning in the subtitles... 0%");
    try {
      const bytes = await burnIn(
        media,
        cues.toSorted((a, b) => a.start - b.start),
        (p) => setBusy(`Burning in the subtitles... ${Math.round(p * 100)}%`),
      );
      save(bytes as BlobPart, `${stripExt(media.name)}-subtitled.mp4`, "video/mp4");
      setBusy(null);
    } catch (e) {
      setBusy(`Burning in failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <div className="studio-subtitles">
      <div className="studio-media">
        {media ? (
          <video
            ref={player}
            src={url}
            controls
            playsInline
            className={isVideo ? "" : "studio-audio"}
            onTimeUpdate={(ev) => setTime(ev.currentTarget.currentTime)}
          />
        ) : (
          <label className="studio-add-media">
            Add the video or sound these subtitles belong to, for its waveform and a burn-in:
            <input
              type="file"
              accept="video/*,audio/*"
              onChange={(ev) => setMedia(ev.currentTarget.files?.[0])}
            />
          </label>
        )}
        {active >= 0 && <p className="studio-current">{cues[active].text}</p>}
      </div>
      <canvas
        ref={canvas}
        className="studio-wave"
        aria-label="Waveform with the subtitles: drag an edge to move it, click to go there"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
      />
      <ol className="studio-cues">
        {cues.map((cue, index) => (
          <li key={index} className={index === active ? "studio-cue-active" : ""}>
            <button
              type="button"
              className="studio-time"
              onClick={() => seek(cue.start)}
              title="Play from here"
            >
              {clock(cue.start)} → {clock(cue.end)}
            </button>
            <textarea
              rows={2}
              value={cue.text}
              aria-label={`Subtitle ${index + 1}`}
              onInput={(ev) => update(index, { text: ev.currentTarget.value })}
            />
            <div className="studio-cue-tools">
              <button type="button" onClick={() => split(index)} title="Split at the playhead">
                Split
              </button>
              {index < cues.length - 1 && (
                <button type="button" onClick={() => merge(index)} title="Join with the next one">
                  Join
                </button>
              )}
              <button type="button" onClick={() => setCues((l) => l.filter((_, i) => i !== index))}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div className="studio-actions">
        <StyledButton onClick={() => saveAs("srt")}>Save SRT</StyledButton>
        <StyledButton onClick={() => saveAs("vtt")}>Save WebVTT</StyledButton>
        {isVideo && (
          <StyledButton
            variant={ButtonVariant.Primary}
            onClick={burn}
            disabled={!!busy && busy.endsWith("%")}
          >
            Burn into the video (MP4)
          </StyledButton>
        )}
        {busy && (
          <span className="studio-busy" aria-live="polite">
            {busy}
          </span>
        )}
      </div>
    </div>
  );
}

export default function StudioSheet() {
  const state = Studio.value;
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (state && !dialog.open) dialog.showModal();
    if (!state && dialog.open) dialog.close();
  }, [state]);
  return (
    <dialog ref={ref} className="studio" onClose={() => (Studio.value = null)} aria-label="Editor">
      {state && (
        <>
          <header className="studio-header">
            <h2>
              {state.kind === "mermaid" ? "Diagram" : "Subtitles"}: {state.name}
            </h2>
            <StyledButton
              variant={ButtonVariant.Icon}
              ariaLabel="Close the editor"
              onClick={() => (Studio.value = null)}
            >
              <X size={18} aria-hidden="true" />
            </StyledButton>
          </header>
          {state.kind === "mermaid" ? (
            <MermaidEditor key={state.name} {...state} />
          ) : (
            <SubtitleEditor key={state.name} {...state} />
          )}
        </>
      )}
    </dialog>
  );
}
