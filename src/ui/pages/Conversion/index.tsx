import "./index.css";

import { h } from "preact";
import { useState, useMemo, useEffect, useRef } from "preact/hooks";
import {
  ConversionOptions,
  SelectedFiles,
  selectFiles,
  type ConversionOption,
  type ConversionOptionsMap,
} from "src/main";
import { Mode, ModeEnum } from "src/ui/ModeStore";
import { formatIdentifier, sameFormat, type FileData, type FileFormat } from "src/FormatHandler";
import { altersContent, compressorsFor, COMPRESS_DEFAULTS, tidyEdits } from "src/edits";
import {
  getMatchingFromFormats,
  groupByTarget,
  rememberTarget,
  resolveTargets,
  siblingKeys,
  toolsFor,
  uniqueNames,
  type Target,
  type TargetGroup,
} from "src/batch";
import { stripExt } from "src/common";
import { filePath } from "src/common/path.ts";

import ConversionHeader from "src/ui/components/Conversion/ConversionHeader";
import FormatExplorer from "src/ui/components/Conversion/FormatExplorer";
import LoadingScreen from "src/ui/components/LoadingScreen";
import Footer from "src/ui/components/Footer";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Braces,
  Clapperboard,
  Combine,
  Eraser,
  Frame,
  Grid3x3,
  ImageUpscale,
  Images,
  Info,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Minimize2,
  Plus,
  ScanText,
  Scissors,
} from "lucide-preact";
import Chip from "src/ui/components/Chip";
import { PopupData } from "src/ui";
import { openPopup, popupOpen } from "src/ui/PopupStore";
import FileInfoBadge, { formatFileSize } from "src/ui/components/FileInfo";
import AudioReport, { readSummaries } from "src/ui/components/AudioReport";
import { ConversionInProgress, CurrentPage, Pages } from "src/ui/AppState";
import { ProgressStore, ROUTE_FAILED } from "src/ui/ProgressStore";
import StyledButton, { ButtonVariant } from "src/ui/components/StyledButton";
import SettingsPanel from "src/ui/components/Conversion/SettingsPanel";
import {
  SettingsPanelOpen,
  ZipPassword,
  applicableSettings,
  availableSettings,
} from "src/ui/ConversionSettingsStore";

type ConversionStep = "select-from" | "select-to" | "converting";

const NO_TARGET: Target = { from: null, to: null };

/** How the shortcuts of {@link toolsFor} are shown, by the `format` of their output. */
const TOOLS: Record<string, { label: string; icon: preact.JSX.Element }> = {
  ocr: { label: "Read text (OCR)", icon: <ScanText size={14} /> },
  nobg: { label: "Remove background", icon: <Eraser size={14} /> },
  "upscaled-photo": { label: "Upscale photo 2×", icon: <ImageUpscale size={14} /> },
  "upscaled-drawing": { label: "Upscale drawing 2×", icon: <ImageUpscale size={14} /> },
  "upscaled-film": { label: "Upscale film 2×", icon: <ImageUpscale size={14} /> },
  "upscaled-animation": { label: "Upscale animation 2×", icon: <ImageUpscale size={14} /> },
  "pdf-pages": { label: "Split into pages", icon: <Scissors size={14} /> },
  "pdf-merged": { label: "Merge PDFs", icon: <Combine size={14} /> },
  "pdf-from-images": { label: "Combine into one PDF", icon: <Images size={14} /> },
  "contact-sheet": { label: "Contact sheet", icon: <LayoutGrid size={14} /> },
  "audio-check": { label: "Check audio", icon: <AudioLines size={14} /> },
  "audio-video": { label: "Make a video", icon: <Clapperboard size={14} /> },
  favicon: { label: "Favicon set", icon: <AppWindow size={14} /> },
  framed: { label: "Frame screenshot", icon: <Frame size={14} /> },
  halftone: { label: "Halftone print", icon: <Grid3x3 size={14} /> },
  depth: { label: "Depth map", icon: <Layers size={14} /> },
  collage: { label: "Collage", icon: <LayoutDashboard size={14} /> },
  metadata: { label: "Metadata", icon: <Info size={14} /> },
  ts: { label: "TypeScript types", icon: <Braces size={14} /> },
};

function countAvailableFormats(
  options: ConversionOptionsMap,
  direction: "from" | "to",
  advancedMode: boolean,
): number {
  const seen = new Set<string>();
  let count = 0;

  for (const [format] of options) {
    if (direction === "from" && !format.from) continue;
    if (direction === "to" && !format.to) continue;

    if (advancedMode) {
      count += 1;
      continue;
    }

    const dedupeKey = formatIdentifier(format);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    count += 1;
  }

  return count;
}

function getConversionOptions(): ConversionOptionsMap {
  if (ConversionOptions.size) return ConversionOptions;
  throw new Error("Can't build format list!", { cause: "UI got empty global format list" });
}

function downloadFile(data: Uint8Array | Blob, name: string, type: string) {
  const blob = new Blob([data as BlobPart], { type: type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  // the download needs a moment to start before the URL can be freed
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

// browsers block all but the first of several automatic downloads, so bundle them
async function downloadAsZip(files: FileData[], name: string, password: string) {
  const { ZipWriter, BlobWriter, Uint8ArrayReader } = await import("@zip.js/zip.js");
  const writer = new ZipWriter(
    new BlobWriter("application/zip"),
    password ? { password, encryptionStrength: 3 } : {},
  );
  // zip.js refuses a second entry with the same name; folders of an extracted archive stay
  const names = uniqueNames(files.map((file) => filePath(file)));
  for (const [i, file] of files.entries()) {
    await writer.add(names[i], new Uint8ArrayReader(file.bytes));
  }
  downloadFile(await writer.close(), name, "application/zip");
}

function totalSize(files: FileData[]) {
  return files.reduce((sum, file) => sum + file.bytes.length, 0);
}

function removeFile(key: string) {
  const { [key as keyof typeof SelectedFiles.value]: _, ...rest } = SelectedFiles.value;
  SelectedFiles.value = rest;
  if (Object.keys(rest).length === 0) CurrentPage.value = Pages.Upload;
}

/**
 * The settings an output format takes. In simple mode a format stands for every handler's
 * version of it, so only the settings they share by name are offered (as upstream does).
 */
function specsFor(options: ConversionOptionsMap, formats: FileFormat[], advanced: boolean) {
  if (advanced) return availableSettings(formats);
  const ids = new Set(formats.map(formatIdentifier));
  return availableSettings(
    [...options.keys()].filter((f) => f.to && ids.has(formatIdentifier(f))),
    true,
  );
}

export default function Conversion() {
  const actionRef = useRef<HTMLButtonElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);
  const actionBarRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const previousStep = useRef<ConversionStep | null>(null);
  const allOptions = getConversionOptions();
  const entries = useMemo(
    () => Object.entries(SelectedFiles.value) as [string, File][],
    [SelectedFiles.value],
  );
  const isAdvanced = Mode.value === ModeEnum.Advanced;

  // targets the user has touched; resolveTargets derives the rest
  const [stored, setStored] = useState<Record<string, Target>>({});
  const targets = useMemo(
    () => resolveTargets(allOptions, entries, stored, Mode.value === ModeEnum.Simple),
    [allOptions, entries, stored],
  );

  const [chosenKey, setChosenKey] = useState<string>();
  const activeKey = chosenKey && targets[chosenKey] ? chosenKey : entries[0]?.[0];
  const activeFile = entries.find(([key]) => key === activeKey)?.[1];
  const { from: fromOption, to: toOption } = targets[activeKey] ?? NO_TARGET;

  const matchingFrom = useMemo(
    () => getMatchingFromFormats(allOptions, activeFile ? [activeFile] : []),
    [allOptions, activeFile],
  );

  const matchingFromSet = useMemo(() => new Set([...matchingFrom].map(([f]) => f)), [matchingFrom]);

  const [step, setStep] = useState<ConversionStep>(fromOption ? "select-to" : "select-from");
  // with no file at all, the page is for browsing the formats
  const [showAll, setShowAll] = useState(entries.length === 0);
  const [applyToAll, setApplyToAll] = useState(true);
  const [isConverting, setIsConverting] = useState(false);
  const [converting, setConverting] = useState<TargetGroup<{ file: File }> | null>(null);

  useEffect(() => {
    if (!activeFile || isConverting) return;
    setStep(fromOption ? "select-to" : "select-from");
    setShowAll(false);
  }, [activeKey]);

  // the next file of the same kind starts from this choice
  useEffect(() => {
    for (const [key, file] of entries) if (targets[key]) rememberTarget(file, targets[key]);
  }, [targets]);

  useEffect(() => {
    if (previousStep.current === "converting" && step !== "converting" && !popupOpen.peek()) {
      actionRef.current?.focus();
    }
    previousStep.current = step;
  }, [step]);

  const toFormats = [...new Set(Object.values(targets).flatMap((t) => (t.to ? [t.to[0]] : [])))];
  const settingSpecs = useMemo(
    () => specsFor(allOptions, toFormats, isAdvanced),
    [allOptions, toFormats.map(formatIdentifier).join(), isAdvanced],
  );
  const settings = applicableSettings(settingSpecs);

  const toSiblings = siblingKeys(entries, targets, activeKey, "to");

  const setOption = (kind: keyof Target, option: ConversionOption | null) => {
    if (!activeKey) return;
    const next = { ...targets };
    const siblings = applyToAll ? siblingKeys(entries, targets, activeKey, kind) : [];
    for (const key of [activeKey, ...siblings]) {
      next[key] = { ...targets[key], [kind]: option };
    }
    setStored(next);
  };

  const handleFromSelect = (option: ConversionOption | null) => setOption("from", option);
  const handleToSelect = (option: ConversionOption | null) => setOption("to", option);

  const handleNext = () => {
    if (step === "select-from" && fromOption) {
      setStep("select-to");
    }
  };

  const handleBack = () => {
    if (step === "select-to") {
      setStep("select-from");
    }
  };

  const handleFromToClickFrom = () => {
    setStep("select-from");
  };

  const handleFromToClickTo = () => {
    setStep("select-to");
  };

  const compressors = fromOption ? compressorsFor(fromOption[0], window.handlerDefs) : [];
  const allReady =
    entries.length > 0 && entries.every(([key]) => targets[key].from && targets[key].to);

  const handleConvert = async () => {
    if (!allReady) return;

    setIsConverting(true);
    ConversionInProgress.value = true;
    setStep("converting");
    ProgressStore.reset();
    const abortController = ProgressStore.controller;

    try {
      const groups = groupByTarget(
        entries.map(([key, file]) => ({ file, from: targets[key].from!, to: targets[key].to! })),
      );
      const outputs: FileData[] = [];
      const summary: string[] = [];
      let outputMime = "";
      let failed = 0;

      for (const group of groups) {
        abortController.signal.throwIfAborted();
        setConverting(group);

        const [fromFormat, fromHandler] = group.from;
        const [toFormat, toHandler] = group.to;
        const label = `${fromFormat.format.toUpperCase()} → ${toFormat.format.toUpperCase()}`;
        const inputs: FileData[] = [];
        for (const { file } of group.items) {
          inputs.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
        }
        const inputSize = totalSize(inputs);

        const compress = sameFormat(fromFormat, toFormat);
        if (compress && !compressorsFor(toFormat, window.handlerDefs).length) {
          outputs.push(...inputs);
          outputMime = toFormat.mime;
          summary.push(`${label}: already in this format, returned as is.`);
          continue;
        }

        // the settings this group's output takes, plus a default quality when compressing
        const groupSpecs = specsFor(allOptions, [toFormat], isAdvanced);
        const chosen = applicableSettings(groupSpecs, settings);
        const defaults = compress ? applicableSettings(groupSpecs, COMPRESS_DEFAULTS) : {};
        const groupSettings = tidyEdits({ ...defaults, ...chosen }, chosen);
        const logStart = ProgressStore.logs.value.length;
        const output = await window.tryConvertByTraversing(
          inputs,
          { handler: fromHandler, format: fromFormat },
          { handler: toHandler, format: toFormat },
          { abort: abortController.signal, settings: groupSettings },
        );

        if (!output) {
          failed++;
          // the route tried first is the most direct one, so its error says most about why
          const reason = ProgressStore.logs.value
            .slice(logStart)
            .find((log) => log.message.startsWith(ROUTE_FAILED))
            ?.message.slice(ROUTE_FAILED.length)
            .split("\n")[0];
          summary.push(
            `${label}: failed, no working conversion route.` +
              (reason ? ` The first route gave: ${reason}` : ""),
          );
          continue;
        }
        outputs.push(...output.files);
        // set here, not earlier, so a group that failed can't label another group's file
        outputMime = toFormat.mime;

        let line = `${label}: via ${output.path.map((c) => c.format.format).join(" → ")}.`;
        if (compress) {
          const outputSize = totalSize(output.files);
          const saved = 1 - outputSize / inputSize;
          const sizes = `${formatFileSize(inputSize)} → ${formatFileSize(outputSize)}`;
          if (saved > 0) line = `${label}: ${Math.round(saved * 100)}% smaller (${sizes}).`;
          else if (altersContent(groupSettings)) line = `${label}: done (${sizes}).`;
          else line = `${label}: could not be made smaller, original kept.`;
          if (groupSettings.protect) line += " Protected with a password.";
          else if (groupSettings.password) line += " Unlocked: it opens without a password now.";
        }
        // a setting that silently did nothing is worse than no setting, above all "remove metadata"
        const applied = new Set(output.path.flatMap((node) => Object.keys(node.options ?? {})));
        const skipped = Object.keys(groupSettings).filter((key) => !applied.has(key));
        if (skipped.length) {
          const names = skipped.map((key) => settingSpecs.get(key)?.label ?? key);
          line += ` Not applied, no step of this route supports it: ${names.join(", ")}.`;
        }
        summary.push(line);
      }

      const password = ZipPassword.value;
      const save = async () => {
        if (outputs.length > 1 || (outputs.length === 1 && password)) {
          const zipName = `${stripExt(entries[0][1].name)}-converted.zip`;
          await downloadAsZip(outputs, zipName, password);
        } else if (outputs.length === 1) {
          downloadFile(outputs[0].bytes, filePath(outputs[0]).replaceAll("/", "_"), outputMime);
        }
      };
      // a report is read here first, and saved only when asked for
      const reports = groups.every((group) => group.to[0].format === "audio-check")
        ? readSummaries(outputs)
        : [];
      if (!reports.length) await save();

      let title = "Conversion complete!";
      if (failed === groups.length) title = "Conversion failed";
      else if (failed) title = "Converted, with failures";
      PopupData.value = {
        dismissible: true,
        buttonText: "OK",
        contents: (
          <>
            <h1>{title}</h1>
            {reports.length > 0 && <AudioReport summaries={reports} onSave={save} />}
            {(!reports.length || failed > 0) && summary.map((line) => <p key={line}>{line}</p>)}
          </>
        ),
      };
      openPopup(() => actionRef.current);
    } catch (e) {
      console.error(e);
      if (e instanceof Error && e.name === "AbortError") {
        // Don't show an error popup for manual cancellation
      } else {
        PopupData.value = {
          title: "Conversion error",
          text: `An unexpected error occurred: ${e}`,
          dismissible: true,
          buttonText: "OK",
        };
        openPopup(() => actionRef.current);
      }
    } finally {
      setIsConverting(false);
      setConverting(null);
      ConversionInProgress.value = false;
      setStep("select-to");
    }
  };

  const addFileRef = useRef<HTMLInputElement>(null);

  const handleAddClick = (ev: MouseEvent) => {
    ev.preventDefault();
    addFileRef.current?.click();
  };

  const handleAddChange = () => {
    selectFiles(Array.from(addFileRef.current?.files ?? []), true);
    // otherwise picking a file that was removed again fires no change event
    if (addFileRef.current) addFileRef.current.value = "";
  };

  const tools =
    step === "select-to" && fromOption
      ? toolsFor(fromOption[0], toSiblings.length + 1, "gpu" in navigator).flatMap((id) => {
          const option = [...allOptions].find(([format]) => format.to && format.format === id);
          return option ? [{ id, option }] : [];
        })
      : [];

  const canProceed = step === "select-from" ? !!fromOption : allReady;
  const multiple = entries.length > 1;

  return (
    <div className="conversion-body">
      <ConversionHeader
        logoDisabled={step === "converting"}
        settingsCount={Object.keys(settings).length}
        settingsDisabled={step === "converting"}
      />

      <main className="conversion-main">
        {step === "converting" ? (
          <LoadingScreen
            fileName={converting?.items[0].file.name || "file"}
            fileSize={converting?.items[0].file.size}
            from={converting?.from[0]}
            to={converting?.to[0]}
          />
        ) : (
          <FormatExplorer
            searchScopeRef={actionBarRef}
            conversionOptions={allOptions}
            matchingFrom={matchingFromSet}
            onBack={handleBack}
            onAdvance={(option) => {
              if (step === "select-from") {
                handleFromSelect(option);
                setStep("select-to");
              } else {
                handleToSelect(option);
                requestAnimationFrame(() => actionRef.current?.focus());
              }
            }}
            onSelect={step === "select-from" ? handleFromSelect : handleToSelect}
            direction={step === "select-from" ? "from" : "to"}
            fromOption={fromOption}
            toOption={toOption}
            fromCount={countAvailableFormats(
              showAll ? allOptions : matchingFrom,
              "from",
              isAdvanced,
            )}
            toCount={countAvailableFormats(allOptions, "to", isAdvanced)}
            onClickFrom={handleFromToClickFrom}
            onClickTo={handleFromToClickTo}
            showAll={showAll}
            onShowAll={() => setShowAll(true)}
            tools={
              tools.length > 0 &&
              tools.map(({ id, option }) => {
                const selected = toOption?.[0].format === id;
                return (
                  <Chip
                    key={id}
                    label={TOOLS[id].label}
                    icon={TOOLS[id].icon}
                    selected={selected}
                    onClick={() => handleToSelect(selected ? null : option)}
                  />
                );
              })
            }
          />
        )}
        {SettingsPanelOpen.value && step !== "converting" && (
          <SettingsPanel
            specs={settingSpecs}
            formatName={toFormats.map((f) => f.format.toUpperCase()).join(", ") || undefined}
          />
        )}
      </main>

      {step !== "converting" &&
        // h() because Preact's JSX types don't know this custom element (src/ui/glass.ts)
        h(
          "dispersive-glass",
          { class: "conversion-dock", refraction: true, "refraction-scale": 28 },
          <div className="conversion-action-bar" ref={actionBarRef}>
            <div className="conversion-action-files" ref={filesRef}>
              {entries.map(([key, file]) => (
                <FileInfoBadge
                  key={key}
                  fileName={file.name}
                  fileSize={file.size}
                  extension={file.name.split(".").pop()}
                  mimeType={file.type}
                  onRemove={() => {
                    // badges render in SelectedFiles order, so the key's index matches the DOM
                    const buttons = [
                      ...(filesRef.current?.querySelectorAll<HTMLButtonElement>(
                        ".file-info-remove",
                      ) ?? []),
                    ];
                    const index = Object.keys(SelectedFiles.value).indexOf(key);
                    const next = buttons[index + 1] ?? buttons[index - 1];
                    removeFile(key);
                    requestAnimationFrame(() => {
                      if (next?.isConnected) next.focus();
                      else addButtonRef.current?.focus();
                    });
                  }}
                  active={multiple && key === activeKey}
                  target={
                    multiple ? (targets[key]?.to?.[0].format.toUpperCase() ?? "?") : undefined
                  }
                  onClick={multiple ? () => setChosenKey(key) : undefined}
                />
              ))}
              <button
                ref={addButtonRef}
                type="button"
                className="file-info-badge file-info-add"
                onClick={handleAddClick}
                aria-label="Add more files"
              >
                <Plus size={16} />
              </button>
              <input ref={addFileRef} type="file" multiple hidden onChange={handleAddChange} />
            </div>
            {step === "select-to" && toSiblings.length > 0 && (
              <label
                className="conversion-apply-all"
                title="Untick to choose a different output for this file only"
              >
                <input
                  type="checkbox"
                  checked={applyToAll}
                  onChange={(ev) => setApplyToAll(ev.currentTarget.checked)}
                />
                All {toSiblings.length + 1} {fromOption?.[0].format.toUpperCase()} files
              </label>
            )}
            {step === "select-to" && compressors.length > 0 && (
              <StyledButton
                onClick={() => handleToSelect(compressors[0])}
                title="Keep the format and make the file smaller"
              >
                <Minimize2 size={16} />
                Compress
              </StyledButton>
            )}
            {step === "select-to" && (
              <StyledButton onClick={handleBack}>
                <ArrowLeft size={16} />
                Back
              </StyledButton>
            )}
            <StyledButton
              buttonRef={actionRef}
              className="conversion-primary-action"
              variant={ButtonVariant.Primary}
              disabled={!canProceed}
              title={
                step === "select-to" && !allReady ? "Choose an output for every file" : undefined
              }
              onClick={step === "select-from" ? handleNext : handleConvert}
            >
              {step === "select-from" ? "Next" : "Convert"}
              {step === "select-from" && <ArrowRight size={16} />}
            </StyledButton>
          </div>,
        )}

      <Footer />
    </div>
  );
}
