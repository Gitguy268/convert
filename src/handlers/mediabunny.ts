import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { Category } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import normalizeMimeType from "src/normalizeMimeType.ts";
import * as mb from "mediabunny";
import { changeExt } from "src/common/index.ts";
import { NothingToConvertError } from "src/errors.ts";
import type { FormatOptions } from "src/Settings.ts";

const FORMATS = new Map<string, [name: string, input: mb.InputFormat, output: mb.OutputFormat]>([
  ["mp4", ["MPEG-4 Part 14", mb.MP4, new mb.Mp4OutputFormat()]],
  ["mov", ["QuickTime / MOV", mb.QTFF, new mb.MovOutputFormat()]],
  ["matroska", ["Matroska / WebM", mb.MATROSKA, new mb.MkvOutputFormat()]],
  ["webm", ["Matroska / WebM / webm", mb.WEBM, new mb.WebMOutputFormat()]],
  ["wav", ["Waveform Audio File Format", mb.WAVE, new mb.WavOutputFormat()]],
  ["ogg", ["Ogg Audio", mb.OGG, new mb.OggOutputFormat()]],
  ["flac", ["Free Lossless Audio Codec", mb.FLAC, new mb.FlacOutputFormat()]],
  ["mp3", ["MP3 Audio", mb.MP3, new mb.Mp3OutputFormat()]],
  ["aac", ["raw ADTS AAC (Advanced Audio Coding)", mb.ADTS, new mb.AdtsOutputFormat()]],
  ["mpegts", ["MPEG-TS (MPEG-2 Transport Stream)", mb.MPEG_TS, new mb.MpegTsOutputFormat()]],
  // needs segmenting bs
  // ["m3u8", ["HTTP Live Streaming", mb.HLS, new mb.HlsOutputFormat({ segmentFormat: new mb.MpegTsOutputFormat() })]],
]);

const supported = async <T>(items: readonly T[], fn: (item: T) => Promise<boolean>) => {
  const ok = await Promise.all(items.map((item) => fn(item)));
  return items.filter((_, i) => ok[i]);
};
const can = async <T>(items: readonly T[], fn: (item: T) => Promise<boolean>) =>
  !items.length || (await supported(items, fn)).length > 0;

const LOSSLESS_FORMATS = ["wav", "flac"];

const LAZY_ENCODERS = ["flac", "mp3", "aac"];

const FFMPEG_NAMES: Record<string, string> = { avc: "h264", ulaw: "pcm_mulaw", alaw: "pcm_alaw" };
const toFFmpegName = (codec: string) =>
  FFMPEG_NAMES[codec] ?? (/^pcm-[sf]\d+$/.test(codec) ? `${codec}le` : codec).replaceAll("-", "_");
const fromFFmpegName = <T extends string>(codecs: readonly T[], name?: string) =>
  name === undefined ? undefined : codecs.find((codec) => toFFmpegName(codec) === name);

class mediabunnyHandler implements FormatHandler {
  public readonly name = "mediabunny";
  public supportedFormats: FileFormat[] = [];
  public ready = false;
  public abortable = true;

  async init() {
    this.supportedFormats = [];
    for (const [format, [name, input, output]] of FORMATS) {
      const videoCodecs = output.getSupportedVideoCodecs();
      const audioCodecs = output.getSupportedAudioCodecs();

      const encodableVideo = await supported(videoCodecs, mb.canEncodeVideo);
      const encodableAudio = await supported(
        audioCodecs,
        async (c) => LAZY_ENCODERS.includes(c) || (await mb.canEncodeAudio(c)),
      );
      const canDecodeVideo = await can(videoCodecs, mb.canDecodeVideo);
      const canEncodeVideo = !videoCodecs.length || encodableVideo.length > 0;
      const canDecodeAudio = await can(audioCodecs, mb.canDecodeAudio);
      const canEncodeAudio = !audioCodecs.length || encodableAudio.length > 0;

      let category;
      let from, to;
      const options: FormatOptions = {
        sampleRate: true,
        channels: true,
        audioBitrate: true,
        // the fork's edits that mediabunny can make (the audio edits are FFmpeg's)
        start: true,
        end: true,
        stripMetadata: true,
      };
      const tracks = output.getSupportedTrackCounts();
      if (tracks.video.max > 0) {
        category = Category.VIDEO;
        from = canDecodeAudio && canDecodeVideo;
        to = canEncodeAudio && canEncodeVideo;
        Object.assign(options, {
          width: true,
          height: true,
          maxSize: true,
          fps: true,
          videoBitrate: true,
        });
        if (encodableVideo.length > 1)
          options.videoCodec = { type: "enum", values: encodableVideo.map(toFFmpegName) };
      } else {
        category = Category.AUDIO;
        from = canDecodeAudio;
        to = canEncodeAudio;
      }
      if (encodableAudio.length > 1)
        options.audioCodec = { type: "enum", values: encodableAudio.map(toFFmpegName) };

      this.supportedFormats.push({
        name,
        format,
        extension: output.fileExtension.slice(1),
        mime: normalizeMimeType(input.mimeType),
        from,
        to,
        internal: format,
        category,
        lossless: LOSSLESS_FORMATS.includes(format),
        options: to ? options : undefined,
      });
    }
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];
    const mbInputFormat = FORMATS.get(inputFormat.internal)?.[1];
    if (!mbInputFormat) throw new Error(`could not get format: ${inputFormat.internal}`);
    const mbOutputFormat = FORMATS.get(outputFormat.internal)?.[2];
    if (!mbOutputFormat) throw new Error(`could not get format: ${outputFormat.internal}`);
    const options = ctx?.options ?? {};
    const outAudioCodecs = mbOutputFormat.getSupportedAudioCodecs();
    const audioCodec = fromFFmpegName(outAudioCodecs, options.audioCodec);
    // the chosen codec, or the one mediabunny will fall back to
    const wanted = audioCodec
      ? [audioCodec]
      : outAudioCodecs.every((c) => LAZY_ENCODERS.includes(c))
        ? outAudioCodecs
        : [];
    if (wanted.includes("mp3") && !(await mb.canEncodeAudio("mp3"))) {
      const { registerMp3Encoder } = await import("@mediabunny/mp3-encoder");
      registerMp3Encoder();
    } else if (wanted.includes("flac") && !(await mb.canEncodeAudio("flac"))) {
      const { registerFlacEncoder } = await import("@mediabunny/flac-encoder");
      registerFlacEncoder();
    } else if (wanted.includes("aac") && !(await mb.canEncodeAudio("aac"))) {
      const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
      registerAacEncoder();
    }

    for (const [i, inputFile] of inputFiles.entries()) {
      ctx?.log(`Processing ${inputFile.name}...`);
      const source = new mb.BufferSource(inputFile.bytes);
      const input = new mb.Input({
        formats: [mbInputFormat],
        source,
      });
      const output = new mb.Output({
        format: mbOutputFormat,
        target: new mb.BufferTarget(),
      });
      const { maxSize, start, end, stripMetadata } = options;
      // a start past the end gives a file without a single packet, which is no result
      if (start !== undefined && start >= (await input.computeDuration()))
        throw new NothingToConvertError(
          `Nothing of ${inputFile.name} lies between the start and the end that were set.`,
        );
      // without a bitrate mediabunny copies the streams, which makes a same-format run pointless
      const fallbackBitrate = inputFormat.internal === outputFormat.internal && mb.QUALITY_MEDIUM;
      const videoCodec = fromFFmpegName(
        mbOutputFormat.getSupportedVideoCodecs(),
        options.videoCodec,
      );
      const conversion = await mb.Conversion.init({
        input,
        output,
        video: (track) => {
          const landscape = track.displayWidth >= track.displayHeight;
          const tooLarge =
            !options.width &&
            !options.height &&
            maxSize &&
            Math.max(track.displayWidth, track.displayHeight) > maxSize;
          return {
            // the other side follows from the aspect ratio
            width: options.width ?? (tooLarge && landscape ? maxSize : undefined),
            height: options.height ?? (tooLarge && !landscape ? maxSize : undefined),
            fit: options.width && options.height ? "fill" : undefined,
            frameRate: options.fps,
            codec: videoCodec,
            // settings are in kbps, mediabunny wants an integer of bits per second
            bitrate:
              (options.videoBitrate && Math.round(options.videoBitrate * 1000)) ||
              fallbackBitrate ||
              undefined,
          };
        },
        audio: {
          sampleRate: options.sampleRate,
          numberOfChannels: options.channels,
          codec: audioCodec,
          bitrate:
            (options.audioBitrate && Math.round(options.audioBitrate * 1000)) ||
            fallbackBitrate ||
            undefined,
        },
        trim: { start, end },
        tags: stripMetadata ? {} : undefined,
      });

      conversion.onProgress = (progress, seconds) => {
        ctx?.progress(
          `Transcoding... (${seconds.toFixed(1)}s processed)`,
          (i + progress) / inputFiles.length,
        );
      };

      await conversion.execute({
        pauseSignal: ctx?.signal,
      });

      ctx?.throwIfAborted();

      if (conversion.state !== "done" || !output.target.buffer)
        throw new Error("conversion isnt done after completing");

      const name = changeExt(inputFile.name, outputFormat.extension);

      outputFiles.push({ name, bytes: new Uint8Array(output.target.buffer) });
    }

    return outputFiles;
  }
}

export default mediabunnyHandler;
