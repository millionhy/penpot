"use client";

// Dashboard profile section (F5.1). Port of profile-section* in
// app.main.ui.dashboard.sidebar, which F4 had to leave out of the settings
// sidebar because it belongs to the dashboard.
//
// Deviations from the CLJS original, all documented:
// - The three expandable entries open their submenu in place, inside the same
//   popup, instead of a second floating panel positioned on pointer-enter with a
//   200ms close delay. Behaviour is equivalent for pointer and keyboard, and it
//   needs no positioning library.
// - ev/event telemetry on the external links is dropped; the shell has no
//   analytics seam yet.
// - The about submenu omits the release-notes entry (labels.version-notes):
//   it needs the onboarding/release-notes modal system, scheduled for F5.6.
//   Check-for-updates landed with F5.2 (lib/check-updates.ts +
//   components/check-updates.tsx); its entry renders only when
//   NEXT_PUBLIC_PENPOT_VERSION is set, since without an installed version
//   there is nothing to compare against.
// - nitrate/subscription blocks (profile-section*, F5.7b) render above this
//   menu in components/subscription.tsx; comments-section is still out of the
//   shell.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { runCheckForUpdates } from "@/components/check-updates";
import { useModal } from "@/components/modal";
import { logout } from "@/lib/auth";
import { generateAvatar } from "@/lib/avatars";
import { config } from "@/lib/config";
import { tr } from "@/lib/i18n";
import { routePaths } from "@/lib/routes";
import { useSession } from "@/lib/session";
import { feedbackVisible, profilePhotoUrl, type RuntimeProfile } from "@/lib/settings";

type SubMenuName = "help-learning" | "community-contributions" | "about-penpot";

interface ExternalEntry {
  label: string;
  href: string;
}

function helpEntries(): ExternalEntry[] {
  return [
    { label: tr("labels.help-center"), href: "https://help.penpot.app" },
    { label: tr("labels.learning-center"), href: "https://penpot.app/learning-center" },
    { label: tr("labels.penpot-hub"), href: "https://penpot.app/penpothub" },
  ];
}

function communityEntries(): ExternalEntry[] {
  return [
    { label: tr("labels.github-repo"), href: "https://github.com/penpot/penpot" },
    { label: tr("labels.community"), href: "https://community.penpot.app" },
  ];
}

export function DashboardProfileMenu() {
  const { profile, refresh } = useSession();
  const router = useRouter();
  const runtime = (profile ?? null) as RuntimeProfile | null;

  const [open, setOpen] = useState(false);
  const [subMenu, setSubMenu] = useState<SubMenuName | null>(null);
  const [checking, setChecking] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const modal = useModal();

  const photo = profilePhotoUrl(runtime, config.publicUri);
  const fullname = runtime?.fullname ?? "";
  const [avatar, setAvatar] = useState<string | null>(null);
  useEffect(() => {
    if (photo !== null) {
      setAvatar(null);
      return;
    }
    setAvatar(generateAvatar({ name: fullname }));
  }, [photo, fullname]);

  // dropdown-menu* closes on an outside pointer-down and the shell adds Escape,
  // which the CLJS menu gets from its focus trap.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setSubMenu(null);
  }, [open]);

  const closeAndGo = (path: string) => {
    setOpen(false);
    router.push(path);
  };

  const onLogout = async () => {
    setOpen(false);
    await logout(runtime?.id);
    await refresh();
    router.replace(routePaths["auth-login"]);
  };

  const toggleSubMenu = (name: SubMenuName) => {
    setSubMenu((current) => (current === name ? null : name));
  };

  // check-for-updates in about-penpot-menu*: guarded against a second run
  // while one is in flight, and the profile popup closes when it finishes.
  const onCheckForUpdates = async () => {
    if (checking || config.version === null) return;
    setChecking(true);
    try {
      await runCheckForUpdates(modal, config.version);
    } finally {
      setChecking(false);
      setOpen(false);
    }
  };

  const showFeedback = feedbackVisible(config.flags);

  return (
    <div className="pp-profile-section" ref={rootRef}>
      <button
        type="button"
        className="pp-profile"
        data-testid="profile-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <img className="pp-profile-img" src={photo ?? avatar ?? ""} alt={fullname} />
        <span className="pp-profile-fullname">{fullname}</span>
      </button>

      {open ? (
        <ul className="pp-profile-dropdown" role="menu" id="profile-menu">
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="pp-profile-dropdown-item"
              data-testid="profile-profile-opt"
              onClick={() => closeAndGo(routePaths["settings-profile"])}
            >
              {tr("labels.your-account")}
            </button>
          </li>
          <li className="pp-profile-separator" role="separator" />

          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="pp-profile-dropdown-item"
              data-testid="help-learning"
              aria-expanded={subMenu === "help-learning"}
              onClick={() => toggleSubMenu("help-learning")}
            >
              <span className="pp-item-name">{tr("labels.help-learning")}</span>
              <span aria-hidden="true">›</span>
            </button>
            {subMenu === "help-learning" ? (
              <ul className="pp-sub-menu" role="menu">
                {helpEntries().map((entry) => (
                  <li key={entry.href} role="none">
                    <a
                      role="menuitem"
                      className="pp-submenu-item"
                      href={entry.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {entry.label}
                    </a>
                  </li>
                ))}
                {showFeedback ? (
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className="pp-submenu-item"
                      onClick={() => closeAndGo(routePaths["settings-feedback"])}
                    >
                      {tr("labels.give-feedback")}
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </li>

          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="pp-profile-dropdown-item"
              data-testid="community-contributions"
              aria-expanded={subMenu === "community-contributions"}
              onClick={() => toggleSubMenu("community-contributions")}
            >
              <span className="pp-item-name">{tr("labels.community-contributions")}</span>
              <span aria-hidden="true">›</span>
            </button>
            {subMenu === "community-contributions" ? (
              <ul className="pp-sub-menu" role="menu">
                {communityEntries().map((entry) => (
                  <li key={entry.href} role="none">
                    <a
                      role="menuitem"
                      className="pp-submenu-item"
                      href={entry.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {entry.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>

          <li role="none">
            {/* about-penpot-menu*: the row expands into the changelog, the
                terms and the update check; the release-notes entry lands with
                F5.6 together with its modal. */}
            <button
              type="button"
              role="menuitem"
              className="pp-profile-dropdown-item"
              data-testid="about-penpot"
              aria-expanded={subMenu === "about-penpot"}
              onClick={() => toggleSubMenu("about-penpot")}
            >
              <span className="pp-item-name">{tr("labels.about-penpot")}</span>
              {config.version !== null ? (
                <span className="pp-menu-version" data-testid="penpot-version" title={config.version}>
                  {config.version}
                </span>
              ) : null}
              <span aria-hidden="true">›</span>
            </button>
            {subMenu === "about-penpot" ? (
              <ul className="pp-sub-menu" role="menu">
                <li role="none">
                  <a
                    role="menuitem"
                    className="pp-submenu-item"
                    href="https://github.com/penpot/penpot/blob/develop/CHANGES.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {tr("labels.penpot-changelog")}
                  </a>
                </li>
                <li role="none">
                  <a
                    role="menuitem"
                    className="pp-submenu-item"
                    href="https://penpot.app/terms"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {tr("auth.terms-of-service")}
                  </a>
                </li>
                {config.version !== null ? (
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className="pp-submenu-item"
                      data-testid="check-for-updates"
                      disabled={checking}
                      onClick={() => {
                        void onCheckForUpdates();
                      }}
                    >
                      {checking
                        ? tr("labels.checking-for-updates")
                        : tr("labels.check-for-updates")}
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </li>

          <li className="pp-profile-separator" role="separator" />
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="pp-profile-dropdown-item pp-item-with-icon"
              data-testid="logout-profile-opt"
              onClick={() => {
                void onLogout();
              }}
            >
              <span aria-hidden="true">⎋</span>
              {tr("labels.logout")}
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}