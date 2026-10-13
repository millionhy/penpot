"use client";

// Port of the viewer slice of the static exception page (app.main.ui.static,
// F6.6): error-container*, not-found*, request-dialog* and the
// request-access* flow. The viewer renders it when the page id does not
// resolve (the ex/raise :not-found of viewer-content*) and when the bundle
// fetch fails with :not-found / :authentication; lib/exception-page.ts
// holds the branching logic and the RPC calls.
//
// Deviations from the CLJS original, documented:
// - The anonymous visitor gets the not-found content with the login button
//   of error-container* instead of the login-modal* dialog; the auth dialog
//   stack (login, register, recovery) is out of scope for the viewer port.
//   The CLJS branches on the profile id being present and the anonymous
//   profile carries the zero uuid, so the port branches on
//   isAuthenticatedProfile instead to reach the login button.
// - The request-access dialog sits on the exception layout instead of the
//   viewer skeleton (context-wrapper*), so its overlay fixes to the
//   viewport; lib/exception-page.ts records the rest.
// - The overlay covers the deco strips of the layout, where the CLJS keeps
//   them visible; the skeleton is not ported.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowIcon, CloseIcon, PenpotLogoIcon } from "@/components/viewer-icons";
import { dashboardHref } from "@/lib/dashboard";
import {
  createTeamAccessRequest,
  exceptionStage,
  loadAccessInfo,
  requestAccessParams,
  requestAccessStage,
  type AccessInfo,
} from "@/lib/exception-page";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { isAuthenticatedProfile } from "@/lib/session";
import type { Profile } from "@/lib/types";

// logo-error-screen.svg (the tall deco strip), inlined so the stylesheet
// paints the fill like the CLJS raw-svg* does.
function ErrorScreenDeco() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="2462.648 7069.559 79 1537">
      <path d="m2483.255 7069.559-10.973 15.432v1441.521l-9.547 4.535-.087-.039v56.915l37.226 17.564 2.274 1.072 2.276-1.072 37.224-17.564v-56.915l-.07.032-9.55-4.536V7084.991l-.334-.468-10.639-14.964-10.973 15.432v.016l-7.983-11.231-7.923 11.144-.282-.397-10.639-14.964Zm1.941 8.964 4.244 5.968h-12.37l4.195-5.899 3.931-.069Zm37.8 0 4.244 5.968h-12.37l4.193-5.899 3.933-.069Zm-18.956 4.219 4.244 5.968h-12.37l4.194-5.898 3.932-.07Zm-28.143 4.758h5.866v1452.525l-5.866-2.768V7087.5Zm8.878 0h5.838v1456.7l-5.838-2.754V7087.5Zm28.923 0h5.866v1453.925l-5.866 2.768V7087.5Zm8.877 0h5.838v1449.75l-5.838 2.754V7087.5Zm-27.834 4.219h5.866v1457.196l-5.866-2.768V7091.719Zm8.879 0h5.837v1454.476l-5.837 2.754v-1457.23Zm28.407 1439.28 5.165 2.11-5.165 2.437v-4.547Zm-59.745.009v4.544l-5.164-2.436 5.164-2.108Zm-5.084 7.17 32.676 15.416v46.867l-32.676-15.415v-46.868Zm69.901 0v46.868l-32.675 15.415v-46.867l32.675-15.416Z" />
    </svg>
  );
}

// error-container* in static.cljs: the page frame with the logo button, the
// deco strips and the copyright footer. The go-back wrapper shows for an
// authenticated profile, the login button for an anonymous visitor.
function ErrorContainer({ children }: { children: ReactNode }) {
  const { profile } = useSession();
  const router = useRouter();
  const authenticated = isAuthenticatedProfile(profile);

  // on-nav-root: the default team's dashboard when the profile has one,
  // the app root otherwise (the root page sends anonymous visitors to the
  // login screen).
  const navigateHome = useCallback(() => {
    const teamId = profile?.["default-team-id"];
    if (isAuthenticatedProfile(profile) && teamId !== undefined && teamId !== null) {
      router.push(dashboardHref("dashboard-recent", { teamId }));
    } else {
      router.push("/");
    }
  }, [profile, router]);

  return (
    <section className="pp-exception-layout">
      <button type="button" className="pp-exception-header" onClick={navigateHome}>
        <PenpotLogoIcon className="pp-exception-penpot-logo" />
        {authenticated ? (
          <span className="pp-exception-go-back">
            <ArrowIcon />
            <span>{tr("not-found.no-permission.go-dashboard")}</span>
          </span>
        ) : null}
      </button>
      <div className="pp-exception-deco-before">
        <ErrorScreenDeco />
      </div>
      {authenticated ? null : (
        <button type="button" className="pp-exception-login-header" onClick={navigateHome}>
          {tr("labels.login")}
        </button>
      )}

      <div className="pp-exception-content">
        <div className="pp-exception-container">{children}</div>
      </div>

      <div className="pp-exception-deco-after2">
        <span>{tr("labels.copyright-period")}</span>
        <ErrorScreenDeco />
        <span>{tr("not-found.made-with-love")}</span>
      </div>
    </section>
  );
}

// not-found* in static.cljs.
function NotFoundContent() {
  return (
    <ErrorContainer>
      <div className="pp-exception-main-message">{tr("labels.not-found.main-message")}</div>
      <div className="pp-exception-desc-message">{tr("not-found.desc-message.error")}</div>
      <div className="pp-exception-desc-message">{tr("not-found.desc-message.doesnt-exist")}</div>
    </ErrorContainer>
  );
}

interface RequestDialogProps {
  title: string;
  content: string[];
  buttonText: string;
  cancelText?: string;
  onButtonClick?: () => void;
  onClose: () => void;
}

// request-dialog* in static.cljs: the overlay dialog with the close button,
// the body lines and the primary action (which falls back to on-close).
function RequestDialog({
  title,
  content,
  buttonText,
  cancelText,
  onButtonClick,
  onClose,
}: RequestDialogProps) {
  const onAccept = onButtonClick ?? onClose;
  return (
    <div className="pp-exception-overlay">
      <div className="pp-exception-dialog">
        <div className="pp-exception-modal-close">
          <button
            type="button"
            className="pp-exception-close-btn"
            aria-label={tr("labels.close")}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="pp-exception-dialog-title">{title}</div>
        {content.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
        <div className="pp-exception-sign-info">
          {cancelText !== undefined ? (
            <button type="button" className="pp-exception-cancel-button" onClick={onClose}>
              {cancelText}
            </button>
          ) : null}
          <button type="button" className="pp-exception-primary-button" onClick={onAccept}>
            {buttonText}
          </button>
        </div>
      </div>
    </div>
  );
}

interface RequestAccessProps {
  fileId: string | undefined;
  teamId: string | undefined;
  isDefault: boolean | undefined;
  profile: Profile;
}

// request-access* in static.cljs: the cond order of requestAccessStage is
// part of the behavior; the command rejects map to the already-requested
// copy (the CLJS on-error).
function RequestAccess({ fileId, teamId, isDefault, profile }: RequestAccessProps) {
  const router = useRouter();
  const [requested, setRequested] = useState({ sent: false, alreadyRequested: false });

  const onClose = useCallback(() => {
    const teamId = profile["default-team-id"] ?? null;
    router.push(dashboardHref("dashboard-recent", { teamId }));
  }, [profile, router]);

  const onRequestAccess = useCallback(() => {
    const params = requestAccessParams({ fileId, teamId, isWorkspace: false });
    createTeamAccessRequest(params).then(
      () => setRequested({ sent: true, alreadyRequested: false }),
      () => setRequested({ sent: true, alreadyRequested: true }),
    );
  }, [fileId, teamId]);

  const stage = requestAccessStage({
    isDefault,
    fileId,
    teamId,
    sent: requested.sent,
    alreadyRequested: requested.alreadyRequested,
  });

  switch (stage) {
    case "default-team":
      return (
        <RequestDialog
          title={tr("not-found.no-permission.project")}
          content={[]}
          buttonText={tr("not-found.no-permission.go-dashboard")}
          onClose={onClose}
        />
      );
    case "already-file":
      return (
        <RequestDialog
          title={tr("not-found.no-permission.already-requested.file")}
          content={[tr("not-found.no-permission.already-requested.or-others.file")]}
          buttonText={tr("not-found.no-permission.go-dashboard")}
          onClose={onClose}
        />
      );
    case "already-project":
      return (
        <RequestDialog
          title={tr("not-found.no-permission.already-requested.project")}
          content={[tr("not-found.no-permission.already-requested.or-others.project")]}
          buttonText={tr("not-found.no-permission.go-dashboard")}
          onClose={onClose}
        />
      );
    case "sent":
      return (
        <RequestDialog
          title={tr("not-found.no-permission.done.success")}
          content={[tr("not-found.no-permission.done.remember")]}
          buttonText={tr("not-found.no-permission.go-dashboard")}
          onClose={onClose}
        />
      );
    case "file":
      return (
        <RequestDialog
          title={tr("not-found.no-permission.file")}
          content={[
            tr("not-found.no-permission.you-can-ask.file"),
            tr("not-found.no-permission.if-approves"),
          ]}
          buttonText={tr("not-found.no-permission.ask")}
          onButtonClick={onRequestAccess}
          cancelText={tr("not-found.no-permission.go-dashboard")}
          onClose={onClose}
        />
      );
    case "team":
      return (
        <RequestDialog
          title={tr("not-found.no-permission.project")}
          content={[
            tr("not-found.no-permission.you-can-ask.project"),
            tr("not-found.no-permission.if-approves"),
          ]}
          buttonText={tr("not-found.no-permission.ask")}
          onButtonClick={onRequestAccess}
          cancelText={tr("not-found.no-permission.go-dashboard")}
          onClose={onClose}
        />
      );
  }
}

// exception-page* in static.cljs for the not-found/authentication causes:
// anonymous visitors keep the not-found content (the login-modal deviation
// above), an authenticated visitor waits for the access info and then sees
// either the request-access dialog or the not-found content. The CLJS
// renders nothing while the info loads; so does the port.
export function ExceptionPage({
  fileId,
  teamId,
}: {
  fileId: string | null;
  teamId?: string | null;
}) {
  const { profile } = useSession();
  const authenticated = isAuthenticatedProfile(profile);

  const [info, setInfo] = useState<AccessInfo | null>(null);

  // load-info of static.cljs: skipped for anonymous visitors, whose branch
  // never reads the info; a failure falls back to the empty info so the
  // page still resolves.
  useEffect(() => {
    if (!authenticated) return;
    let live = true;
    loadAccessInfo({ fileId, teamId }).then(
      (next) => {
        if (live) setInfo(next);
      },
      () => {
        if (live) setInfo({});
      },
    );
    return () => {
      live = false;
    };
  }, [authenticated, fileId, teamId]);

  const stage = exceptionStage(authenticated, info);
  if (stage === "pending") return null;
  if (stage === "not-found" || profile === null) return <NotFoundContent />;

  return (
    <ErrorContainer>
      <RequestAccess
        fileId={info?.fileId}
        teamId={info?.teamId}
        isDefault={info?.teamDefault}
        profile={profile}
      />
    </ErrorContainer>
  );
}
