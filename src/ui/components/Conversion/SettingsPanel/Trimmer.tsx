import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { ConversionSettings, setSetting } from "src/ui/ConversionSettingsStore";

/** Seconds as m:ss.t, the way the trimmer shows the cut. */
export function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  const minutes = Math.floor(s / 60);
  const rest = (s - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${rest}`;
}

/** Times are kept to a tenth of a millisecond: what FFmpeg's -ss and -to take without loss. */
const round = (n: number) => Math.round(n * 10000) / 10000;

/** How many stills the strip under the video shows. */
const STILLS = 8;
/** One frame at 30 fps: what , and . step by. */
const FRAME = 1 / 30;

/**
 * A preview of the video or song with the cut marked on it. The in and out points are the
 * start and end settings, so the cut is whatever those say, however it was set.
 */
export default function Trimmer({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const media = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [stills, setStills] = useState<string[]>([]);
  const isVideo =
    file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name);

  const start = (ConversionSettings.value.start as number | undefined) ?? 0;
  const end = (ConversionSettings.value.end as number | undefined) ?? duration;

  // the strip of stills is drawn from a second element, so the preview doesn't jump around
  useEffect(() => {
    if (!isVideo || !duration || !Number.isFinite(duration)) return;
    const state = { cancelled: false };
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = url;
    const canvas = document.createElement("canvas");
    (async () => {
      await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
      const height = 54;
      canvas.height = height;
      canvas.width = Math.round((video.videoWidth / video.videoHeight || 16 / 9) * height);
      const out: string[] = [];
      for (let i = 0; i < STILLS && !state.cancelled; i++) {
        video.currentTime = ((i + 0.5) * duration) / STILLS;
        await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
        canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
        out.push(canvas.toDataURL("image/jpeg", 0.6));
      }
      if (!state.cancelled) setStills(out);
    })().catch(() => {});
    return () => {
      state.cancelled = true;
      video.removeAttribute("src");
      video.load();
    };
  }, [url, duration, isVideo]);

  const setIn = (seconds: number) => {
    const value = round(Math.max(0, Math.min(seconds, (end || duration) - FRAME)));
    setSetting("start", value > 0 ? value : undefined);
  };
  const setOut = (seconds: number) => {
    const value = round(Math.min(duration, Math.max(seconds, start + FRAME)));
    setSetting("end", value < duration - 0.001 ? value : undefined);
  };
  const seek = (seconds: number) => {
    if (media.current) media.current.currentTime = Math.max(0, Math.min(duration, seconds));
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if ((ev.target as HTMLElement).closest("input")) return;
    const handled: Record<string, () => void> = {
      i: () => setIn(time),
      o: () => setOut(time),
      ",": () => seek(time - FRAME),
      ".": () => seek(time + FRAME),
      " ": () => (media.current?.paused ? media.current.play() : media.current?.pause()),
    };
    const run = handled[ev.key.toLowerCase()];
    if (!run) return;
    ev.preventDefault();
    run();
  };

  const percent = (seconds: number) => `${duration ? (100 * seconds) / duration : 0}%`;

  return (
    <div className="trimmer" onKeyDown={onKeyDown}>
      <video
        ref={media}
        className={isVideo ? "trimmer-video" : "trimmer-audio"}
        src={url}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={(ev) => setDuration(ev.currentTarget.duration)}
        onTimeUpdate={(ev) => {
          const now = ev.currentTarget.currentTime;
          setTime(now);
          // the preview plays the cut, not past it
          if (end && now >= end && !ev.currentTarget.paused) ev.currentTarget.pause();
        }}
      />
      {duration > 0 && (
        <>
          <div className="trimmer-track" aria-hidden="true">
            <div className="trimmer-stills">
              {stills.map((src, i) => (
                <img key={i} src={src} alt="" />
              ))}
            </div>
            <div
              className="trimmer-cut"
              style={{ left: percent(start), width: `calc(${percent(end)} - ${percent(start)})` }}
            />
            <div className="trimmer-playhead" style={{ left: percent(time) }} />
          </div>
          <div className="trimmer-ranges">
            <label>
              <span>In {clock(start)}</span>
              <input
                type="range"
                min={0}
                max={duration}
                step={FRAME}
                value={start}
                aria-label="Start of the cut"
                onInput={(ev) => {
                  setIn(Number(ev.currentTarget.value));
                  seek(Number(ev.currentTarget.value));
                }}
              />
            </label>
            <label>
              <span>Out {clock(end)}</span>
              <input
                type="range"
                min={0}
                max={duration}
                step={FRAME}
                value={end}
                aria-label="End of the cut"
                onInput={(ev) => {
                  setOut(Number(ev.currentTarget.value));
                  seek(Number(ev.currentTarget.value));
                }}
              />
            </label>
          </div>
          <div className="trimmer-buttons">
            <button type="button" className="settings-panel-reset" onClick={() => setIn(time)}>
              Start here (I)
            </button>
            <button type="button" className="settings-panel-reset" onClick={() => setOut(time)}>
              End here (O)
            </button>
            <button
              type="button"
              className="settings-panel-reset"
              onClick={() => {
                seek(start);
                void media.current?.play();
              }}
            >
              Play the cut
            </button>
            <span className="trimmer-length">{clock(end - start)} kept</span>
          </div>
          <p className="settings-panel-note">
            , and . step a frame. The start and end fields below say the same.
          </p>
        </>
      )}
    </div>
  );
}
