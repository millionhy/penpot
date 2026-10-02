// Settings route group logic (F4). Headless port of the profile-facing parts of
// app.main.data.profile and app.main.ui.settings.*: parameter mapping, error
// classification, theme resolution and the flag-gated sidebar list. The views
// live in app/settings/* and components/settings-sidebar.tsx.
//
// Kept free of JSX so it runs in vitest's node environment, like lib/forms.ts
// and lib/auth.ts.

import { RpcError } from "@/lib/errors";
import { tr } from "@/lib/i18n";
import { cmd, cmdUpload } from "@/lib/rpc";
import type { RouteName } from "@/lib/routes";
import type { Profile, RpcParams } from "@/lib/types";

// --- Profile shape ---------------------------------------------------------

// get-profile answers with the whole profile row minus :password and
// :deleted-at (strip-private-attrs in
// backend/src/app/rpc/commands/profile.clj). That is wider than the generated
// schema:profile, so the settings pages read the extra runtime fields through
// this alias instead of widening the generated type.
export interface RuntimeProfile extends Profile {
  lang?: string;
  "photo-id"?: string | null;
  "is-active"?: boolean;
}

// resolve-profile-photo-url in app.config: a stored photo is served from
// assets/by-id, otherwise the caller falls back to the generated avatar.
export function profilePhotoUrl(
  profile: RuntimeProfile | null,
  publicUri: string,
): string | null {
  const photoId = profile?.["photo-id"];
  if (photoId === undefined || photoId === null || photoId === "") return null;
  const base = publicUri.endsWith("/") ? publicUri : publicUri + "/";
  return base + "assets/by-id/" + photoId;
}

// --- Theme -----------------------------------------------------------------

// theme/default in app.util.theme.
export const defaultTheme = "dark";

export type ResolvedTheme = "dark" | "light";
export type ThemeSetting = "light" | "dark" | "system";

// resolve-theme in app.util.theme: "system" follows the OS preference, while
// "default" and an unset theme both mean dark.
export function resolveTheme(
  profileTheme: string | undefined | null,
  systemTheme: ResolvedTheme,
): ResolvedTheme {
  if (profileTheme === "system") return systemTheme;
  if (profileTheme === "light") return "light";
  return "dark";
}

// set-color-scheme in app.util.theme: dark renders under the "default" class,
// which is where styles/tokens.css scopes the semantic color tokens.
export function themeClass(theme: ResolvedTheme): string {
  return theme === "dark" ? "default" : "light";
}

// options.cljs seeds the select with
// (if (= theme "default") "dark" (or theme "dark")).
export function themeFormValue(profileTheme: string | undefined | null): ThemeSetting {
  if (profileTheme === "light" || profileTheme === "system") return profileTheme;
  return "dark";
}

// --- Locales ---------------------------------------------------------------

export interface Locale {
  label: string;
  value: string;
}

// supported-locales in app.util.i18n. The labels are endonyms and are not
// translated, so they stay literal here.
export const supportedLocales: readonly Locale[] = [
  { label: "English", value: "en" },
  { label: "Español", value: "es" },
  { label: "Català", value: "ca" },
  { label: "Deutsch (community)", value: "de" },
  { label: "Dutch (community)", value: "nl" },
  { label: "Euskera (community)", value: "eu" },
  { label: "Français (community)", value: "fr" },
  { label: "Français - Canada (community)", value: "fr_ca" },
  { label: "Gallego (Community)", value: "gl" },
  { label: "Hausa (Community)", value: "ha" },
  { label: "Hrvatski (Community)", value: "hr" },
  { label: "Italiano (community)", value: "it" },
  { label: "Norsk - Bokmål (community)", value: "nb_no" },
  { label: "Polski (community)", value: "pl" },
  { label: "Portuguese - Brazil (community)", value: "pt_br" },
  { label: "Portuguese - Portugal (community)", value: "pt_pt" },
  { label: "Bahasa Indonesia (community)", value: "id" },
  { label: "Rumanian (community)", value: "ro" },
  { label: "Türkçe (community)", value: "tr" },
  { label: "Ελληνική γλώσσα (community)", value: "el" },
  { label: "Русский (community)", value: "ru" },
  { label: "Украї́нська мо́ва (community)", value: "uk" },
  { label: "Český jazyk (community)", value: "cs" },
  { label: "Latviešu valoda (community)", value: "lv" },
  { label: "Српски (community)", value: "sr" },
  { label: "Føroyskt mál (community)", value: "fo" },
  { label: "Korean (community)", value: "ko" },
  { label: "עִבְרִית (community)", value: "he" },
  { label: "आधुनिक मानक हिन्दी (community)", value: "hi" },
  { label: "عربي/عربى (community)", value: "ar" },
  { label: "فارسی (community)", value: "fa" },
  { label: "日本語 (Community)", value: "ja_jp" },
  { label: "简体中文 (community)", value: "zh_cn" },
  { label: "繁體中文 (community)", value: "zh_hant" },
];

// options.cljs prepends the browser-detect entry, whose empty value the backend
// reads as "no explicit language".
export function localeOptions(autoLabel: string): Locale[] {
  return [{ label: autoLabel, value: "" }, ...supportedLocales];
}

// --- Notifications ---------------------------------------------------------

export type NotificationSetting = "all" | "partial" | "none";
export type InviteSetting = "all" | "none";

export interface NotificationSettings {
  "dashboard-comments": NotificationSetting;
  "email-comments": NotificationSetting;
  "email-invites": InviteSetting;
}

// default-notification-settings in app.main.ui.settings.notifications.
export const defaultNotificationSettings: NotificationSettings = {
  "dashboard-comments": "all",
  "email-comments": "partial",
  "email-invites": "all",
};

export function notificationsFromProfile(
  profile: RuntimeProfile | null,
): NotificationSettings {
  const stored = profile?.props?.notifications;
  return {
    "dashboard-comments":
      stored?.["dashboard-comments"] ?? defaultNotificationSettings["dashboard-comments"],
    "email-comments": stored?.["email-comments"] ?? defaultNotificationSettings["email-comments"],
    "email-invites": stored?.["email-invites"] ?? defaultNotificationSettings["email-invites"],
  };
}

// The webgl switch on the options page reads props.renderer (options.cljs).
export function rendererFromProfile(profile: RuntimeProfile | null): "svg" | "wasm" {
  return profile?.props?.renderer === "wasm" ? "wasm" : "svg";
}

// --- Parameter mapping -----------------------------------------------------

export interface ProfileUpdateParams {
  fullname: string;
  lang?: string;
  theme?: string;
}

// profile-update-params in app.main.data.profile: only these three keys ever
// reach update-profile, which is why the email field on the profile form is
// display-only and the change-email flow is a separate command.
export function profileUpdateParams(input: {
  fullname: string;
  lang?: string;
  theme?: string;
}): ProfileUpdateParams {
  const params: ProfileUpdateParams = { fullname: input.fullname };
  if (input.lang !== undefined) params.lang = input.lang;
  if (input.theme !== undefined) params.theme = input.theme;
  return params;
}

// update-password in app.main.data.profile renames the form fields onto the
// backend schema; password-2 is a client-side confirmation and is never sent.
export function passwordParams(values: {
  "password-old": string;
  "password-1": string;
}): RpcParams["update-profile-password"] {
  return { "old-password": values["password-old"], password: values["password-1"] };
}

// --- Errors ----------------------------------------------------------------

export type PasswordError =
  | { kind: "field"; field: string; message: string }
  | { kind: "generic" };

// on-error in app.main.ui.settings.password. The weak-password reasons arrive
// as translation keys under :details; the CLJS form renders them as a bullet
// list, and the shell joins them into the single field message because
// FormState.errors is Record<string, string>. The field view keeps the
// line breaks (white-space: pre-line).
export function passwordError(err: unknown): PasswordError {
  const data = err instanceof RpcError ? err.data : null;
  switch (data?.code) {
    case "old-password-not-match":
      return { kind: "field", field: "password-old", message: tr("errors.wrong-old-password") };
    case "email-as-password":
      return { kind: "field", field: "password-1", message: tr("errors.email-as-password") };
    case "weak-password": {
      const details = data?.details;
      const reasons = Array.isArray(details) ? details.map((key) => tr(String(key))) : [];
      const lines = [tr("errors.weak-password"), ...reasons.map((reason) => "- " + reason)];
      return { kind: "field", field: "password-1", message: lines.join("\n") };
    }
    default:
      return { kind: "generic" };
  }
}

// on-error in app.main.ui.settings.feedback.
export function feedbackError(err: unknown): string {
  const data = err instanceof RpcError ? err.data : null;
  return data?.code === "feedback-disabled" ? tr("labels.feedback-disabled") : tr("errors.generic");
}

// --- Sidebar ---------------------------------------------------------------

export interface SettingsNavItem {
  route: RouteName;
  labelKey: string;
  testId?: string;
}

// The order and flag gates of sidebar-content* in
// app.main.ui.settings.sidebar. release-notes and contact-us sit after a
// separator and are rendered by the view.
export function settingsNav(flags: Iterable<string>): SettingsNavItem[] {
  const on = new Set(flags);
  const items: SettingsNavItem[] = [
    { route: "settings-profile", labelKey: "labels.profile" },
    { route: "settings-password", labelKey: "labels.password" },
    { route: "settings-notifications", labelKey: "labels.notifications" },
  ];
  if (on.has("custom-shortcuts")) {
    items.push({ route: "settings-shortcuts", labelKey: "label.shortcuts" });
  }
  items.push({
    route: "settings-options",
    labelKey: "labels.settings",
    testId: "settings-profile",
  });
  if (on.has("subscriptions") || on.has("admin-console")) {
    items.push({
      route: "settings-subscription",
      labelKey: "subscription.labels",
      testId: "settings-subscription",
    });
  }
  if (on.has("access-tokens") || on.has("mcp")) {
    items.push({
      route: "settings-integrations",
      labelKey: "labels.integrations",
      testId: "settings-integrations",
    });
  }
  return items;
}

export function feedbackVisible(flags: Iterable<string>): boolean {
  return new Set(flags).has("user-feedback");
}

// --- Commands --------------------------------------------------------------

export function updateProfile(params: ProfileUpdateParams): Promise<Profile> {
  return cmd<Profile>("update-profile", params);
}

export function updateProfilePassword(
  params: RpcParams["update-profile-password"],
): Promise<unknown> {
  return cmd("update-profile-password", params);
}

// The backend decodes the "all"/"partial"/"none" strings into keywords through
// the ::sm/one-of json decoder in common/src/app/common/schema.cljc.
export function updateProfileNotifications(params: NotificationSettings): Promise<unknown> {
  return cmd("update-profile-notifications", params);
}

export function updateProfileProps(props: Record<string, unknown>): Promise<Profile> {
  return cmd<Profile>("update-profile-props", { props });
}

// multipart-upload in repo.cljs: the Blob goes out as FormData, not transit.
export function updateProfilePhoto(file: Blob): Promise<unknown> {
  return cmdUpload("update-profile-photo", { file });
}

export function deleteProfilePhoto(): Promise<unknown> {
  return cmd("delete-profile-photo");
}

export function requestEmailChange(email: string): Promise<unknown> {
  return cmd("request-email-change", { email });
}

export function deleteProfile(): Promise<unknown> {
  return cmd("delete-profile");
}

export interface FeedbackParams {
  subject: string;
  type: string;
  content: string;
  "error-href"?: string;
}

export function sendUserFeedback(params: FeedbackParams): Promise<unknown> {
  return cmd("send-user-feedback", params);
}
