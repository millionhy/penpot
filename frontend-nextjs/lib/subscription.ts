// Subscription helpers (F5.7b). Headless port of the slices of
// app.main.ui.dashboard.subscription and app.main.data.nitrate the
// subscription banners, the members CTA, the settings blocks and the
// /settings/subscription page need: the plan-type reader, the two banner
// predicates, the capacity math, the nitrate-licence reader, the trash
// deletion-days cond with its nitrate branch, the account age and the two
// instant formats.
//
// Kept free of JSX so it runs in vitest's node environment, like lib/team.ts
// and lib/nitrate.ts; the views live in components/subscription.tsx and the
// settings page under app/settings/subscription.
//
// Deviations from the CLJS original, documented:
// - get-subscription-type already lives in lib/dashboard.ts (F5.3, the trash
//   reuses it); this module imports it instead of duplicating the port.
// - Instants format through Intl (en-US) instead of goog.i18n; the two
//   patterns the CLJS uses are reproduced token for token ("MMMM d" and
//   "d MMMM, yyyy").

import type { InstantValue } from "@/lib/dashboard";
import { subscriptionType, type Subscription } from "@/lib/dashboard";
import {
  isValidLicense,
  type LicensedProfile,
  type SubscriptionWarning,
} from "@/lib/nitrate";

export { subscriptionType };
export type { Subscription, SubscriptionWarning };

// --- Subscription shapes -----------------------------------------------------

// props.subscription of the profile (SaaS): what get-subscription-type reads
// plus the seats/editors bookkeeping the banners count. Runtime-only field
// (the with-subscription layer adds it on hosted deployments); the generated
// Profile type does not carry it.
export interface ProfileSubscription extends Subscription {
  quantity?: number;
  editors?: Array<{ id: string; name?: string }>;
  "start-date"?: InstantValue | null;
}

// profile.subscription (the nitrate licence, under the :admin-console flag).
// See the LicensedProfile note in lib/nitrate.ts.
export interface NitrateLicense {
  type?: string | null;
  status?: string | null;
  manual?: boolean;
  "cancel-at"?: InstantValue | null;
  "created-at"?: InstantValue | null;
  [key: string]: unknown;
}

export interface SubscriptionProfile extends LicensedProfile {
  "created-at"?: InstantValue | null;
  subscription?: NitrateLicense | null;
  props?: {
    subscription?: ProfileSubscription | null;
    [key: string]: unknown;
  } & Record<string, unknown>;
}

function profilePropsSubscription(
  profile: SubscriptionProfile | null | undefined,
): ProfileSubscription | null {
  return profile?.props?.subscription ?? null;
}

// is-valid-license? over the profile (kept as the named re-export so callers
// read like the CLJS).
export function isNitrateActive(profile: SubscriptionProfile | null | undefined): boolean {
  return isValidLicense(profile);
}

// The subscription-type of a profile: the nitrate licence when one is active,
// the SaaS subscription otherwise (subscription-type in subscription.cljs /
// nitrate-sidebar*).
export function profileSubscriptionType(profile: SubscriptionProfile | null | undefined): string {
  const nitrateLicense = profile?.subscription;
  if (isNitrateActive(profile)) {
    return subscriptionType(nitrateLicense as Subscription | null | undefined);
  }
  return subscriptionType(profilePropsSubscription(profile));
}

// --- Subscription name -------------------------------------------------------

// get-subscription-name (settings/subscription.cljs).
export function subscriptionName(
  type: string,
  subscribeToTrial: boolean,
  tr: (key: string) => string,
): string {
  if (subscribeToTrial) {
    return type === "unlimited"
      ? tr("subscription.settings.unlimited-trial")
      : tr("subscription.settings.enterprise-trial");
  }
  switch (type) {
    case "professional":
      return tr("subscription.settings.professional");
    case "unlimited":
      return tr("subscription.settings.unlimited");
    case "enterprise":
      return tr("subscription.settings.enterprise");
    default:
      // The CLJS case has no default and throws on an unknown type; the port
      // returns the empty string instead.
      return "";
  }
}

// --- Banner predicates -------------------------------------------------------

// show-subscription-dashboard-banner? (dashboard/subscription.cljs).
export function showSubscriptionDashboardBanner(
  profile: SubscriptionProfile | null | undefined,
): boolean {
  const subscription = profilePropsSubscription(profile);
  const type = subscriptionType(subscription);
  const seats = subscription?.quantity ?? 0;
  const editors = subscription?.editors?.length ?? 0;

  if (type === "professional") return editors > 8;
  if (type !== "unlimited") return false;
  // common: seats < 25 and diff >= 4; special: reached 25+ editors, seats <
  // 25 and there is overuse.
  return (
    (seats < 25 && editors - seats >= 4) ||
    (seats < 25 && editors >= 25 && editors > seats)
  );
}

// show-subscription-members-banner? (dashboard/subscription.cljs): the seats
// of the *team* subscription against the editors of the profile one.
export function showSubscriptionMembersBanner(
  teamSubscription: Subscription | null | undefined,
  teamPermissions: { "is-owner"?: boolean } | null | undefined,
  profile: SubscriptionProfile | null | undefined,
): boolean {
  const type = subscriptionType(teamSubscription);
  const seats = teamSubscription?.seats ?? 0;
  const editors = profilePropsSubscription(profile)?.editors?.length ?? 0;
  const isOwner = teamPermissions?.["is-owner"] === true;
  return isOwner && type === "unlimited" && seats < 25 && editors - seats >= 4;
}

// --- Trash deletion days -----------------------------------------------------

// The deletion-days cond of deleted-section* (deleted.cljs): a valid nitrate
// licence on an enterprise or nitrate plan keeps files 90 days; the SaaS
// types keep their own windows.
export function deletionDaysFor(
  teamSubscriptionType: string,
  profile: SubscriptionProfile | null | undefined,
): number {
  const nitrateType = profile?.subscription?.type;
  if (
    isNitrateActive(profile) &&
    (nitrateType === "enterprise" || nitrateType === "nitrate")
  ) {
    return 90;
  }
  if (teamSubscriptionType === "unlimited") return 30;
  if (teamSubscriptionType === "enterprise") return 90;
  return 7;
}

// --- Account age -------------------------------------------------------------

// age-days (app.main.data.nitrate-audit): whole days since `created-at`,
// floored at 0; null when the instant is missing or invalid.
export function accountAgeDays(
  createdAt: InstantValue | null | undefined,
  now: Date = new Date(),
): number | null {
  const date = toDate(createdAt);
  if (date === null) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}

// --- Subscription warning ----------------------------------------------------

// The SubscriptionWarning wire type lives in lib/nitrate.ts next to
// fetchSubscriptionWarning; the picks below are the nitrate-sidebar* reads
// (the kebab-case and camelCase spellings of both keys are all defended).

export interface SubscriptionWarningInfo {
  daysUntilExpiry: number;
  expirationDate: InstantValue;
}

// The picks of nitrate-sidebar*: nil when either value is missing, which is
// what hides the warning banner.
export function subscriptionWarningInfo(
  warning: SubscriptionWarning | null | undefined,
): SubscriptionWarningInfo | null {
  if (!warning) return null;
  const daysUntilExpiry =
    warning["days-until-expiry"] ?? warning.daysUntilExpiry ??
    warning["days-from-expiry"] ?? warning.daysFromExpiry;
  const expirationDate = warning["expiration-date"] ?? warning.expirationDate;
  if (daysUntilExpiry === undefined || expirationDate === undefined || expirationDate === null) {
    return null;
  }
  return { daysUntilExpiry, expirationDate };
}

// --- Instants ----------------------------------------------------------------

function toDate(value: InstantValue | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ct/format-inst "MMMM d" (e.g. "October 9").
export function formatMonthDay(value: InstantValue | Date | null | undefined): string | null {
  const date = toDate(value);
  if (date === null) return null;
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(date);
}

// ct/format-inst "d MMMM, yyyy" (e.g. "9 October, 2026"). Intl renders
// "October 9, 2026" for en-US, so the parts are reassembled.
export function formatDayMonthYear(value: InstantValue | Date | null | undefined): string | null {
  const date = toDate(value);
  if (date === null) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return pick("day") + " " + pick("month") + ", " + pick("year");
}
