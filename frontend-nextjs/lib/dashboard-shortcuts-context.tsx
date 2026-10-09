"use client";

// Dashboard shortcut runtime provider (F5.6). Mounts the keydown matcher of
// lib/shortcuts for the set the current route uses (see dashboardSetForPath)
// and exposes the custom-shortcut transforms the settings pages drive, wired
// to the profile props of the session.
//
// Port of the mounting points of hooks/use-shortcuts on the dashboard and
// settings pages, of the set/reset/reset-all events of
// data/dashboard/shortcuts/customize and of du/toggle-theme (data/profile).
//
// Deviations from the CLJS original, documented:
// - The matcher lives in React state, not in the Potok store; the CLJS shell
//   re-binds through effect timing (see lib/dashboard-shortcuts-runtime).
// - toggle-theme persists through update-profile without the analytics
//   origin marker; the shell has no analytics channel yet.
// - go-to-search focuses #search-input after a timeout; the CLJS event does
//   it on rt/navigated. The element sits in the dashboard layout, so the
//   delay only lets the navigation start.
// - create-element is a page-owned handler: the pages call
//   registerCreateElement while they mount (the CLJS event reaches the
//   project grid the page renders).
// - check-platform? :macos reads the user agent; the first render happens
//   before the probe, so the initial matcher binds without mac glyphs and
//   rebinds right after mount.
//
// The transforms keep the latest customs in a ref: the profile prop lags
// behind the persist round-trip, so two edits in a row would otherwise drop
// the first one.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useNotifications } from "@/components/notifications";
import type { DashboardShortcutActions } from "@/lib/dashboard-shortcuts";
import {
  buildDashboardBindings,
  dashboardSetForPath,
  dispatchDashboardKeydown,
  nextTheme,
} from "@/lib/dashboard-shortcuts-runtime";
import { useDashboard, type DashboardNavigateParams } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";
import type { RouteName } from "@/lib/routes";
import { useSession } from "@/lib/session";
import { profileUpdateParams, updateProfile, updateProfileProps } from "@/lib/settings";
import {
  createShortcutMatcher,
  customShortcutsFromProfile,
  customShortcutsWire,
  isMacos,
  resetCustomShortcut as resetCustomShortcutTransform,
  setCustomShortcut as setCustomShortcutTransform,
  type CustomShortcuts,
  type ShortcutTarget,
} from "@/lib/shortcuts";

export interface DashboardShortcutsState {
  // The current customs ([:profile :props :custom-shortcuts]).
  customShortcuts: CustomShortcuts;
  macos: boolean;
  // set/reset of customize.cljs over the profile props; the groupKey defaults
  // to "dashboard", the group the dashboard sets mount under.
  setCustomShortcut: (
    shortcutKey: string,
    command: string,
    conflictingKey: string | null,
    groupKey?: string,
  ) => void;
  resetCustomShortcut: (
    shortcutKey: string,
    defaultCommand: string | string[] | null,
    groupKey?: string,
  ) => void;
  resetAllCustomShortcuts: () => void;
  // The settings page writes wholesale maps (import and restore flows).
  persistCustomShortcuts: (next: CustomShortcuts) => void;
  // The "+" handler owner; null unregisters.
  registerCreateElement: (handler: (() => void) | null) => void;
}

const defaultValue: DashboardShortcutsState = {
  customShortcuts: {},
  macos: false,
  setCustomShortcut: () => undefined,
  resetCustomShortcut: () => undefined,
  resetAllCustomShortcuts: () => undefined,
  persistCustomShortcuts: () => undefined,
  registerCreateElement: () => undefined,
};

const DashboardShortcutsContext = createContext<DashboardShortcutsState>(defaultValue);

// The event target in the shape the matcher's stop guard reads (mousetrap
// stopCallback): html targets only; svg and text targets never stop.
function shortcutTarget(event: KeyboardEvent): ShortcutTarget | null {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return null;
  return {
    tagName: target.tagName,
    className: target.className,
    contentEditable: target.contentEditable,
    dataset: target.dataset,
  };
}

export function DashboardShortcutsProvider({ children }: { children: ReactNode }) {
  const { profile, refresh } = useSession();
  const { navigate, defaultProject } = useDashboard();
  const pathname = usePathname();
  const notifications = useNotifications();

  const [macos, setMacos] = useState(false);
  useEffect(() => {
    setMacos(isMacos());
  }, []);

  const customShortcuts = useMemo(() => customShortcutsFromProfile(profile), [profile]);

  const customsRef = useRef(customShortcuts);
  useEffect(() => {
    customsRef.current = customShortcuts;
  }, [customShortcuts]);

  const persist = useCallback(
    (next: CustomShortcuts) => {
      customsRef.current = next;
      void updateProfileProps({ "custom-shortcuts": customShortcutsWire(next) })
        .then(() => refresh())
        .catch(() => notifications.error(tr("generic.error")));
    },
    [refresh, notifications],
  );

  const setCustomShortcutAction = useCallback(
    (
      shortcutKey: string,
      command: string,
      conflictingKey: string | null,
      groupKey: string = "dashboard",
    ) => {
      persist(
        setCustomShortcutTransform(customsRef.current, shortcutKey, command, conflictingKey, groupKey),
      );
    },
    [persist],
  );

  const resetCustomShortcutAction = useCallback(
    (
      shortcutKey: string,
      defaultCommand: string | string[] | null,
      groupKey: string = "dashboard",
    ) => {
      persist(resetCustomShortcutTransform(customsRef.current, shortcutKey, defaultCommand, groupKey));
    },
    [persist],
  );

  const resetAllCustomShortcuts = useCallback(() => persist({}), [persist]);

  const toggleTheme = useCallback(() => {
    const next = nextTheme(profile?.theme);
    void updateProfile(profileUpdateParams({ fullname: profile?.fullname ?? "", theme: next }))
      .then(() => refresh())
      .catch(() => notifications.error(tr("generic.error")));
  }, [profile, refresh, notifications]);

  const navigateAction = useCallback(
    (section: RouteName, params?: DashboardNavigateParams) => {
      navigate(section, params);
      if (section === "dashboard-search") {
        setTimeout(() => document.getElementById("search-input")?.focus(), 0);
      }
    },
    [navigate],
  );

  const createElementRef = useRef<(() => void) | null>(null);
  const registerCreateElement = useCallback((handler: (() => void) | null) => {
    createElementRef.current = handler;
  }, []);

  const actions = useMemo<DashboardShortcutActions>(
    () => ({
      navigate: navigateAction,
      defaultProjectId: defaultProject?.id ?? null,
      toggleTheme,
      createElement: () => createElementRef.current?.(),
    }),
    [navigateAction, defaultProject, toggleTheme],
  );

  const setName = dashboardSetForPath(pathname ?? "");
  useEffect(() => {
    if (setName === null) return;
    const matcher = createShortcutMatcher(
      buildDashboardBindings(setName, macos, customShortcuts, actions),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      const fired = dispatchDashboardKeydown(matcher, event, macos, shortcutTarget(event));
      if (fired) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      matcher.dispose();
    };
  }, [setName, macos, customShortcuts, actions]);

  const value = useMemo<DashboardShortcutsState>(
    () => ({
      customShortcuts,
      macos,
      setCustomShortcut: setCustomShortcutAction,
      resetCustomShortcut: resetCustomShortcutAction,
      resetAllCustomShortcuts,
      persistCustomShortcuts: persist,
      registerCreateElement,
    }),
    [
      customShortcuts,
      macos,
      setCustomShortcutAction,
      resetCustomShortcutAction,
      resetAllCustomShortcuts,
      persist,
      registerCreateElement,
    ],
  );

  return (
    <DashboardShortcutsContext.Provider value={value}>
      {children}
    </DashboardShortcutsContext.Provider>
  );
}

export function useDashboardShortcuts(): DashboardShortcutsState {
  return useContext(DashboardShortcutsContext);
}
