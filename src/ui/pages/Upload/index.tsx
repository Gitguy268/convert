import useFirstTabTarget from "src/ui/scripts/useFirstTabTarget";
import { useEffect, useRef } from "preact/hooks";
import { CurrentPage, LoadingToolsText, Pages } from "src/ui/AppState";
import { goToUploadHome, selectFiles } from "src/main";
import { Files, Upload } from "lucide-preact";
import tippy from "tippy.js";

import Logo from "src/ui/components/Logo";
import HelpButton from "src/ui/components/HelpButton";
import SettingsButton from "src/ui/components/SettingsButton";
import Footer from "src/ui/components/Footer";
import StyledButton, { ButtonVariant } from "src/ui/components/StyledButton";

import "./index.css";

export default function UploadPage() {
  const uploadRef = useRef<HTMLDivElement>(null);
  useFirstTabTarget(uploadRef);
  const fileRef = useRef<HTMLInputElement>(null);
  const formatsRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!formatsRef.current) return;
    const instance = tippy(formatsRef.current, {
      content: "View supported formats",
      placement: "bottom",
      delay: [300, 0],
    });
    return () => instance.destroy();
  }, []);

  const handleClick = (ev: MouseEvent) => {
    ev.preventDefault();
    if (!formatsReady) return;
    fileRef.current?.click();
  };

  const formatsReady = LoadingToolsText.value === undefined;

  const handleChange = () => {
    if (!formatsReady) return;
    selectFiles(Array.from(fileRef.current?.files ?? []));
  };

  const handleLogoClick = (event: MouseEvent) => {
    (event.currentTarget as HTMLButtonElement)
      .querySelector(".logo-icon svg")
      ?.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(-720deg)" }], {
        duration: 1000,
        easing: "cubic-bezier(0.33, 1, 0.68, 1)",
      });
    goToUploadHome();
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="upload-page">
      <div className="upload-card">
        <div className="upload-card-header">
          <Logo showName={true} size={36} onClick={handleLogoClick} />
        </div>

        <div
          ref={uploadRef}
          aria-label="Select files to convert"
          aria-disabled={!formatsReady}
          className={`upload-dropzone ${!formatsReady ? "upload-dropzone--pending" : ""}`}
          onClick={handleClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (!formatsReady) return;
              fileRef.current?.click();
            }
          }}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            name="uploadFile"
            id="uploadFile"
            onClick={(ev) => ev.stopPropagation()}
            tabIndex={-1}
            disabled={!formatsReady}
            onChange={handleChange}
          />
          <div className="upload-icon-wrap">
            <Upload />
          </div>
          <span className="upload-cta">
            {window.matchMedia("(pointer: coarse)").matches ? "Tap" : "Click"} to select a file
          </span>
          <span className="upload-hint">
            {window.matchMedia("(pointer: coarse)").matches ? "" : "or drag and drop"}
          </span>
        </div>

        <div className="upload-card-actions">
          <SettingsButton />
          <HelpButton />
          <StyledButton
            buttonRef={formatsRef}
            variant={ButtonVariant.Icon}
            ariaLabel="View supported formats"
            onClick={() => {
              if (!formatsReady) return;
              CurrentPage.value = Pages.Conversion;
            }}
            disabled={!formatsReady}
          >
            <Files size={18} aria-hidden="true" />
          </StyledButton>
        </div>
      </div>

      <Footer loadingText={LoadingToolsText.value} />
    </div>
  );
}
