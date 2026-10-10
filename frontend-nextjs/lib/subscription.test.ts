// Pin down the headless half of F5.7b: the plan-type reader with its
// nitrate-licence precedence, the subscription-name picker, the two banner
// predicates with their seats/editors arithmetic, the trash deletion-days
// cond with its nitrate branch, the account age and the subscription-warning
// and instant helpers.

import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import {
  accountAgeDays,
  deletionDaysFor,
  formatDayMonthYear,
  formatMonthDay,
  isNitrateActive,
  profileSubscriptionType,
  showSubscriptionDashboardBanner,
  showSubscriptionMembersBanner,
  subscriptionName,
  subscriptionWarningInfo,
  type ProfileSubscription,
  type SubscriptionProfile,
} from "@/lib/subscription";

const originalFlags = config.flags;

afterEach(() => {
  config.flags = originalFlags;
});

function withAdminConsole(): void {
  if (!config.flags.includes("admin-console")) {
    config.flags = [...config.flags, "admin-console"];
  }
}

// Passthrough tr: the assertions pin the key the picker chooses, not the
// translation content.
const tr = (key: string) => key;

function profile(overrides: Partial<SubscriptionProfile> = {}): SubscriptionProfile {
  return { ...overrides };
}

function saasSubscription(overrides: Partial<ProfileSubscription> = {}): ProfileSubscription {
  return { type: "unlimited", quantity: 10, editors: [], ...overrides };
}

function editors(count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `e${index}` }));
}

describe("isNitrateActive / profileSubscriptionType", () => {
  it("reads the nitrate licence of the profile, flag-gated", () => {
    const licensed = profile({ subscription: { type: "nitrate", status: "active" } });
    expect(isNitrateActive(licensed)).toBe(false);
    withAdminConsole();
    expect(isNitrateActive(licensed)).toBe(true);
  });

  it("prefers the active nitrate licence over the SaaS subscription", () => {
    withAdminConsole();
    const licensed = profile({
      subscription: { type: "nitrate", status: "active" },
      props: { subscription: saasSubscription({ type: "unlimited" }) },
    });
    expect(profileSubscriptionType(licensed)).toBe("nitrate");
  });

  it("falls back to the SaaS subscription without a valid licence", () => {
    withAdminConsole();
    const canceled = profile({
      subscription: { type: "nitrate", status: "canceled" },
      props: { subscription: saasSubscription({ type: "unlimited" }) },
    });
    expect(profileSubscriptionType(canceled)).toBe("unlimited");
    // The licence only counts under the admin-console flag.
    config.flags = originalFlags;
    const licensed = profile({
      subscription: { type: "nitrate", status: "active" },
      props: { subscription: saasSubscription({ type: "unlimited" }) },
    });
    expect(profileSubscriptionType(licensed)).toBe("unlimited");
  });

  it("keeps the get-subscription-type fallbacks", () => {
    expect(profileSubscriptionType(profile({ props: { subscription: { status: "unpaid" } } }))).toBe(
      "professional",
    );
    expect(profileSubscriptionType(profile())).toBe("professional");
  });
});

describe("subscriptionName", () => {
  it("prefers the trial names when subscribing to a trial", () => {
    expect(subscriptionName("unlimited", true, tr)).toBe("subscription.settings.unlimited-trial");
    expect(subscriptionName("enterprise", true, tr)).toBe("subscription.settings.enterprise-trial");
    // The trial branch only distinguishes unlimited; everything else is the
    // enterprise trial (get-subscription-name).
    expect(subscriptionName("professional", true, tr)).toBe(
      "subscription.settings.enterprise-trial",
    );
  });

  it("maps the three paid plans", () => {
    expect(subscriptionName("professional", false, tr)).toBe("subscription.settings.professional");
    expect(subscriptionName("unlimited", false, tr)).toBe("subscription.settings.unlimited");
    expect(subscriptionName("enterprise", false, tr)).toBe("subscription.settings.enterprise");
    // The CLJS case has no default and throws on unknown types; the port
    // returns the empty string instead.
    expect(subscriptionName("nitrate", false, tr)).toBe("");
  });
});

describe("showSubscriptionDashboardBanner", () => {
  it("professional: banners once there are more than 8 editors", () => {
    const base = { type: "professional", quantity: 10 };
    expect(
      showSubscriptionDashboardBanner(profile({ props: { subscription: { ...base, editors: editors(9) } } })),
    ).toBe(true);
    expect(
      showSubscriptionDashboardBanner(profile({ props: { subscription: { ...base, editors: editors(8) } } })),
    ).toBe(false);
  });

  it("unlimited: seats < 25 and a difference of 4 or more", () => {
    const sub = (quantity: number, count: number) =>
      profile({ props: { subscription: saasSubscription({ quantity, editors: editors(count) }) } });
    expect(showSubscriptionDashboardBanner(sub(10, 14))).toBe(true);
    expect(showSubscriptionDashboardBanner(sub(10, 13))).toBe(false);
    // Seats at 25 settle the capacity: no banner even with overuse.
    expect(showSubscriptionDashboardBanner(sub(25, 40))).toBe(false);
    // Editors below the seats never trigger the banner.
    expect(showSubscriptionDashboardBanner(sub(20, 19))).toBe(false);
  });

  it("unlimited: the 25+ editors overuse branch", () => {
    const sub = (quantity: number, count: number) =>
      profile({ props: { subscription: saasSubscription({ quantity, editors: editors(count) }) } });
    expect(showSubscriptionDashboardBanner(sub(20, 25))).toBe(true);
    expect(showSubscriptionDashboardBanner(sub(30, 35))).toBe(false);
  });

  it("counts quantity, not the seats field", () => {
    const sub = profile({
      props: { subscription: saasSubscription({ quantity: 10, seats: 99, editors: editors(14) }) },
    });
    expect(showSubscriptionDashboardBanner(sub)).toBe(true);
  });

  it("silences the other plan types and a missing subscription", () => {
    expect(
      showSubscriptionDashboardBanner(
        profile({ props: { subscription: saasSubscription({ type: "enterprise", editors: editors(40) }) } }),
      ),
    ).toBe(false);
    expect(showSubscriptionDashboardBanner(profile())).toBe(false);
    expect(showSubscriptionDashboardBanner(null)).toBe(false);
  });
});

describe("showSubscriptionMembersBanner", () => {
  const teamSubscription = { type: "unlimited", seats: 10 };
  const owner = { "is-owner": true };
  const manyEditors = profile({ props: { subscription: saasSubscription({ editors: editors(14) }) } });

  it("needs the owner, the unlimited team plan, seats < 25 and a difference of 4+", () => {
    expect(showSubscriptionMembersBanner(teamSubscription, owner, manyEditors)).toBe(true);
    expect(showSubscriptionMembersBanner(teamSubscription, {}, manyEditors)).toBe(false);
    expect(showSubscriptionMembersBanner(teamSubscription, null, manyEditors)).toBe(false);
    expect(showSubscriptionMembersBanner({ type: "professional", seats: 10 }, owner, manyEditors)).toBe(
      false,
    );
    expect(showSubscriptionMembersBanner({ type: "unlimited", seats: 25 }, owner, manyEditors)).toBe(
      false,
    );
    const threeApart = profile({
      props: { subscription: saasSubscription({ editors: editors(13) }) },
    });
    expect(showSubscriptionMembersBanner(teamSubscription, owner, threeApart)).toBe(false);
  });

  it("reads the seats of the team subscription, not the profile quantity", () => {
    const overQuota = profile({
      props: { subscription: saasSubscription({ quantity: 99, editors: editors(14) }) },
    });
    expect(showSubscriptionMembersBanner(teamSubscription, owner, overQuota)).toBe(true);
  });
});

describe("deletionDaysFor", () => {
  it("keeps the SaaS windows without a nitrate licence", () => {
    expect(deletionDaysFor("unlimited", profile())).toBe(30);
    expect(deletionDaysFor("enterprise", profile())).toBe(90);
    expect(deletionDaysFor("professional", profile())).toBe(7);
    expect(deletionDaysFor("whatever", profile())).toBe(7);
  });

  it("gives 90 days to an active nitrate licence on enterprise or nitrate", () => {
    withAdminConsole();
    const licensed = (type: string) => profile({ subscription: { type, status: "active" } });
    expect(deletionDaysFor("professional", licensed("nitrate"))).toBe(90);
    expect(deletionDaysFor("professional", licensed("enterprise"))).toBe(90);
    // Other licence types fall through to the team subscription.
    expect(deletionDaysFor("professional", licensed("unlimited"))).toBe(7);
  });

  it("requires the license to be valid", () => {
    withAdminConsole();
    const canceled = profile({ subscription: { type: "nitrate", status: "canceled" } });
    expect(deletionDaysFor("professional", canceled)).toBe(7);
    // Without the admin-console flag the licence never counts.
    config.flags = originalFlags;
    const active = profile({ subscription: { type: "nitrate", status: "active" } });
    expect(deletionDaysFor("professional", active)).toBe(7);
  });
});

describe("accountAgeDays", () => {
  it("counts whole days, floored at 0", () => {
    const now = new Date("2026-10-11T00:00:00Z");
    expect(accountAgeDays(new Date("2026-10-09T00:00:00Z"), now)).toBe(2);
    // A partial day floors down.
    expect(accountAgeDays(new Date("2026-10-09T12:00:00Z"), now)).toBe(1);
    expect(accountAgeDays(new Date("2026-10-12T00:00:00Z"), now)).toBe(0);
  });

  it("accepts ISO strings and refuses missing or invalid instants", () => {
    const now = new Date("2026-10-11T00:00:00Z");
    expect(accountAgeDays("2026-10-01T00:00:00Z", now)).toBe(10);
    expect(accountAgeDays("not-a-date", now)).toBeNull();
    expect(accountAgeDays(new Date("nope"), now)).toBeNull();
    expect(accountAgeDays(null, now)).toBeNull();
    expect(accountAgeDays(undefined, now)).toBeNull();
  });
});

describe("subscriptionWarningInfo", () => {
  const date = new Date("2026-10-20T00:00:00Z");

  it("picks the kebab-case wire keys", () => {
    expect(
      subscriptionWarningInfo({ "days-until-expiry": 5, "expiration-date": date }),
    ).toEqual({ daysUntilExpiry: 5, expirationDate: date });
  });

  it("reads the camelCase spellings defensively", () => {
    expect(subscriptionWarningInfo({ daysUntilExpiry: 5, expirationDate: date })).toEqual({
      daysUntilExpiry: 5,
      expirationDate: date,
    });
    // days-from-expiry is the older spelling of the same count.
    expect(
      subscriptionWarningInfo({ "days-from-expiry": 3, "expiration-date": "2026-10-20" }),
    ).toEqual({ daysUntilExpiry: 3, expirationDate: "2026-10-20" });
  });

  it("hides the banner when either value is missing", () => {
    expect(subscriptionWarningInfo(null)).toBeNull();
    expect(subscriptionWarningInfo(undefined)).toBeNull();
    expect(subscriptionWarningInfo({})).toBeNull();
    expect(subscriptionWarningInfo({ "days-until-expiry": 5 })).toBeNull();
    expect(subscriptionWarningInfo({ "expiration-date": date })).toBeNull();
    expect(subscriptionWarningInfo({ "days-until-expiry": 5, "expiration-date": null })).toBeNull();
  });
});

describe("instant formats", () => {
  // Local-midnight Dates keep the assertions timezone-independent.
  const date = new Date(2026, 9, 9);

  it("formats the month and day", () => {
    expect(formatMonthDay(date)).toBe("October 9");
  });

  it("formats the day, month and year", () => {
    expect(formatDayMonthYear(date)).toBe("9 October, 2026");
  });

  it("returns null for missing or invalid instants", () => {
    expect(formatMonthDay(null)).toBeNull();
    expect(formatMonthDay("nope")).toBeNull();
    expect(formatDayMonthYear(undefined)).toBeNull();
    expect(formatDayMonthYear(new Date("nope"))).toBeNull();
  });
});
