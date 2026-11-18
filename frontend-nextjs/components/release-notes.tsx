"use client";

// Release notes modal (G1). Port of app.main.ui.releases/release-notes* and
// release-notes-modal, with the 2.18 content of releases/v2_18.
//
// The shell keeps the CLJS content verbatim (English copy, 888x500 two-column
// frame) because the modal is product announcement artwork, not UI chrome.
// Deviations, all documented:
// - The version registry lives in lib/release-notes.ts; openers resolve the
//   content version first, so the component always has content (the CLJS
//   release-notes-modal re-dispatches through the render multimethod).
// - alt+mod opening the onboarding modal is dropped: the shell has no
//   onboarding flow to hand over to.
// - Marking the notes as viewed is best effort. ModalProvider sits above
//   NotificationsProvider, so a failed stamp has no toast to reach; the CLJS
//   also fires update-profile-props without handling the failure.

import { useCallback, useEffect, useRef, useState } from "react";
import { useModal } from "@/components/modal";
import { RELEASE_NOTES_INTRO, RELEASE_NOTES_SLIDES } from "@/lib/release-notes";
import { updateProfileProps } from "@/lib/settings";
import { useSession } from "@/lib/session";

type Slide = "start" | number;

export function ReleaseNotesModal({ version }: { version: string }) {
  const { close } = useModal();
  const { refresh } = useSession();
  const [slide, setSlide] = useState<Slide>("start");
  const [fadeClass, setFadeClass] = useState<string | null>("pp-relnotes-fade-in-down");
  const marked = useRef(false);

  // du/mark-onboarding-as-viewed {:version version}: mount is the
  // acknowledgement, the finish button repeats it in the CLJS so a reload in
  // the middle of the carousel still counts.
  const markViewed = useCallback(() => {
    void updateProfileProps({
      "onboarding-viewed": true,
      "release-notes-viewed": version,
    })
      .then(() => refresh())
      .catch(() => undefined);
  }, [version, refresh]);

  useEffect(() => {
    if (marked.current) return;
    marked.current = true;
    markViewed();
  }, [markViewed]);

  // release-notes* fades each slide in and clears the class after 300ms, so
  // the next navigation animates again.
  useEffect(() => {
    if (slide !== "start") setFadeClass("pp-relnotes-fade-in");
    const timer = setTimeout(() => setFadeClass(null), 300);
    return () => {
      clearTimeout(timer);
      setFadeClass(null);
    };
  }, [slide]);

  const intro = slide === "start";
  const content = intro ? RELEASE_NOTES_INTRO : RELEASE_NOTES_SLIDES[slide];
  const isLast = slide === RELEASE_NOTES_SLIDES.length - 1;

  const next = () => {
    setSlide((current) => (current === "start" ? 0 : current + 1));
  };

  const finish = () => {
    markViewed();
    close();
  };

  return (
    <div className="pp-relnotes" data-testid="release-notes">
      <div className={`pp-relnotes-animated ${fadeClass ?? ""}`}>
        <div className="pp-relnotes-container">
          <img className="pp-relnotes-image" src={content.image} alt={content.alt} />
          <div className="pp-relnotes-content">
            <div className="pp-relnotes-header">
              <h1 className="pp-relnotes-title">{content.title}</h1>
              {intro ? <div className="pp-relnotes-version-tag">Version {version}</div> : null}
            </div>

            <div
              className={`pp-relnotes-features${intro ? " pp-relnotes-features-intro" : ""}`}
            >
              {content.paragraphs.map((paragraph, index) => (
                <p key={index} className="pp-relnotes-paragraph">
                  {paragraph}
                </p>
              ))}
            </div>

            <div className="pp-relnotes-navigation">
              {intro ? null : (
                <ul className="pp-relnotes-dots">
                  {RELEASE_NOTES_SLIDES.map((item, index) => (
                    <li key={item.image}>
                      <button
                        type="button"
                        className={`pp-relnotes-dot${
                          index === slide ? " pp-relnotes-dot-current" : ""
                        }`}
                        aria-label={item.title}
                        aria-current={index === slide ? "step" : undefined}
                        data-testid={`release-notes-dot-${index}`}
                        onClick={() => setSlide(index)}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="pp-btn-primary pp-relnotes-next"
                data-testid="release-notes-next"
                onClick={isLast ? finish : next}
              >
                {isLast ? "Let's go" : "Continue"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
