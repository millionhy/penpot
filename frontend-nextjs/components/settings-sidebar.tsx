"use client";

// Settings sidebar (F4). View over the nav list computed by settingsNav in
// lib/settings.ts; mirrors sidebar-content* in app.main.ui.settings.sidebar.
//
// The CLJS sidebar is a list of clickable <li>; the shell uses real links so the
// items are keyboard reachable and the App Router handles the navigation.
//
// Two things are deliberately absent. release-notes opens the onboarding /
// release-notes modal system, which the shell has not ported. profile-section*
// (team switcher, comments, version, logout menu) belongs to the dashboard store
// and arrives with F5; until then this renders the identity block plus a direct
// logout, the only action a settings page needs.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { generateAvatar } from "@/lib/avatars";
import { logout } from "@/lib/auth";
import { readLastTeamId } from "@/lib/dashboard";
import { config } from "@/lib/config";
import { tr } from "@/lib/i18n";
import { routePaths } from "@/lib/routes";
import { useSession } from "@/lib/session";
import {
  feedbackVisible,
  profilePhotoUrl,
  settingsNav,
  type RuntimeProfile,
} from "@/lib/settings";

export function SettingsSidebar() {
  const { profile, refresh } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const runtime = (profile ?? null) as RuntimeProfile | null;

  const items = useMemo(() => settingsNav(config.flags), []);
  const showFeedback = useMemo(() => feedbackVisible(config.flags), []);

  // go-to-dashboard-projects in app.main.data.common carries the current
  // team-id. The settings pages live outside the dashboard store, so the back
  // link rebuilds it after mount from the last visited team (or the profile
  // default); localStorage is not readable during SSR, hence the effect.
  const [backHref, setBackHref] = useState(routePaths["dashboard-recent"]);
  useEffect(() => {
    const teamId = readLastTeamId() ?? runtime?.["default-team-id"] ?? null;
    setBackHref(
      teamId === null
        ? routePaths["dashboard-recent"]
        : routePaths["dashboard-recent"] + "?team-id=" + teamId,
    );
  }, [runtime]);

  // resolve-profile-photo-url falls back to the generated initials avatar, which
  // needs a canvas, so it is resolved after mount.
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

  const onLogout = async () => {
    await logout(runtime?.id);
    await refresh();
    router.replace(routePaths["auth-login"]);
  };

  const itemClass = (href: string) =>
    href === pathname ? "pp-settings-item current" : "pp-settings-item";

  return (
    <aside className="pp-settings-sidebar">
      <div className="pp-sidebar-content">
        <div className="pp-sidebar-section">
          <Link className="pp-back-to-dashboard" href={backHref}>
            <span aria-hidden="true">←</span>
            <span className="pp-back-text">{tr("labels.dashboard")}</span>
          </Link>
        </div>

        <hr className="pp-sidebar-separator" />

        <nav className="pp-sidebar-section" aria-label={tr("labels.settings")}>
          <ul className="pp-sidebar-nav">
            {items.map((item) => {
              const href = routePaths[item.route];
              return (
                <li key={item.route} className={itemClass(href)}>
                  <Link
                    href={href}
                    data-testid={item.testId}
                    aria-current={href === pathname ? "page" : undefined}
                  >
                    <span className="pp-element-title">{tr(item.labelKey)}</span>
                  </Link>
                </li>
              );
            })}

            {showFeedback ? (
              <li className={itemClass(routePaths["settings-feedback"])}>
                <Link href={routePaths["settings-feedback"]}>
                  <span className="pp-element-title">{tr("labels.contact-us")}</span>
                </Link>
              </li>
            ) : null}
          </ul>
        </nav>
      </div>

      <div className="pp-profile-section">
        <img
          className="pp-profile-avatar"
          src={photo ?? avatar ?? ""}
          alt=""
          width={32}
          height={32}
        />
        <div className="pp-profile-identity">
          <span className="pp-profile-name">{fullname}</span>
          <span className="pp-profile-email">{runtime?.email ?? ""}</span>
        </div>
        <button
          type="button"
          className="pp-profile-logout"
          data-testid="logout-profile-opt"
          onClick={() => {
            void onLogout();
          }}
        >
          {tr("labels.logout")}
        </button>
      </div>
    </aside>
  );
}
