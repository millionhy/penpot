// Release notes (G1). Headless port of app.main.ui.releases: the version
// registry behind render-release-notes, the gate app.main.ui uses to pop the
// modal (show-release-modal?), and the 2.18 content of releases/v2_18.
//
// The shell only ships the newest content (2.18); the registry stays a map so
// a later release can add an entry without touching the modal. Development
// builds report the "0.0" main version and the CLJS aliases it to the newest
// content ((defmethod render-release-notes "0.0")), which is the same rule
// releaseNotesContentVersion applies.

export interface ReleaseNotesSlide {
  image: string;
  alt: string;
  title: string;
  paragraphs: string[];
}

// v/parse in app.common.version keeps only major.minor in :main; the release
// notes gate and stamp use that value, while the menu label prints :base.
const MAIN_VERSION_RE = /^(\d+)\.(\d+)/;

export function mainVersion(version: string | null): string {
  if (version === null) return "0.0";
  const match = MAIN_VERSION_RE.exec(version);
  if (match === null) return "0.0";
  return match[1] + "." + match[2];
}

const NEWEST_RELEASE_NOTES = "2.18";

export const RELEASE_NOTES_INTRO: ReleaseNotesSlide = {
  image: "/images/features/2.18-slide-0.jpg",
  alt: "Penpot 2.18 is here!",
  title: "What’s new in Penpot?",
  paragraphs: [
    "Say hello to Penpot Enterprise, our new paid plan, shipping alongside the most requested stroke-to-path functionality and a fresh batch of features and fixes.",
    "Penpot stays free, unlimited, and open source. Enterprise is meant for organisations that need to govern over people, workflows or content.",
    "Let’s dive in!",
  ],
};

// Slides 0..5 of v2_18.cljs in order; the last one finishes the modal.
export const RELEASE_NOTES_SLIDES: readonly ReleaseNotesSlide[] = [
  {
    image: "/images/features/2.18-enterprise.jpg",
    alt: "Introducing Penpot Enterprise",
    title: "Introducing Penpot Enterprise",
    paragraphs: [
      "As an open source product, Penpot brings the most advanced features to everyone for free.",
      "Penpot Enterprise is a paid layer that overrides, tweaks or restricts how these features can be used at scale.",
    ],
  },
  {
    image: "/images/features/2.18-sso.jpg",
    alt: "One Sign in for everyone",
    title: "One Sign in for everyone",
    paragraphs: [
      "Let your whole organization sign in through your own corporate identity provider, whether that's a generic OpenID Connect provider, Azure Active Directory, or Google.",
      "One consistent way into your organization’s teams and files, governed by the directory you already run. From the Admin Console, you’ll be able to configure your identity provider setup to Penpot in just a few steps.",
    ],
  },
  {
    image: "/images/features/2.18-permissions.jpg",
    alt: "Advanced permissions",
    title: "Advanced permissions",
    paragraphs: [
      "Decide who can do what across every team at once, who can create, edit, administer teams, projects, and files, and who's allowed to invite new people in.",
      "Your rules sit on top of everyone's normal role, so the whole organization stays aligned with how you want to work, and every change takes effect the moment you make it.",
    ],
  },
  {
    image: "/images/features/2.18-console.jpg",
    alt: "An Admin Panel to rule them all",
    title: "An Admin Panel to rule them all",
    paragraphs: [
      "A separate Admin Panel allows authorized users to create independent Organisations to which certain rules can be applied.",
      "We are starting with something straightforward; Per-Organisation SSO (choose between multiple identity providers) and advanced permissions (decide who can do what across every team).",
    ],
  },
  {
    image: "/images/features/2.18-billing.jpg",
    alt: "Penpot Enterprise billing",
    title: "Penpot Enterprise billing",
    paragraphs: [
      "This is equally important. Whether on a monthly or annual subscription, customers using Penpot Enterprise only pay once per identifiable user (email address), regardless of the number of organisations this user is a member of.",
      "Bulk adding or removing users is trivial and we are making sure that you have total transparency and ergonomics around your billing cycle and what it contains.",
    ],
  },
  {
    image: "/images/features/2.18-stroke2path.gif",
    alt: "Stroke to Paths and new drawing tools",
    title: "Stroke to Paths and new drawing tools",
    paragraphs: [
      "Paths can now convert their stroke into a separate, editable path shape, letting you reshape or style the outline independently of the original path. Currently available under the new WebGL renderer.",
      "Lots of smaller wins add up this cycle. A few favorites:",
      "• Draw faster with new shape and free-draw tool flyouts in the toolbar.",
      "• Dedicated Line and Arrow drawing tools (by @davidv399).",
      "On top of that, 2.18 ships plugin API improvements, a broad round of bug fixes, and community-contributed fixes (thanks to @Krishcode264, @filipsajdak, @sawirricardo, and many more).",
    ],
  },
];

const RELEASE_NOTES_CONTENT: Record<string, readonly ReleaseNotesSlide[]> = {
  [NEWEST_RELEASE_NOTES]: RELEASE_NOTES_SLIDES,
};

// release-notes-modal asks the render multimethod for the incoming :main
// version and renders nothing when no content is registered; "0.0" is aliased
// to the newest content before that lookup.
export function releaseNotesContentVersion(version: string | null): string | null {
  const main = mainVersion(version);
  if (main === "0.0") return NEWEST_RELEASE_NOTES;
  return RELEASE_NOTES_CONTENT[main] !== undefined ? main : null;
}

export interface ReleaseNotesGateInput {
  // The build stamp (config.version). A null stamp cannot reach this gate in
  // the shell, but it must not show the modal either.
  version: string | null;
  props: Record<string, unknown> | undefined;
  flags: readonly string[];
  // nitrate-entry-popup-pending?: the /subscribe-nitrate hand-off owns the
  // first dashboard visit, so the release notes stay out of its way.
  nitrateEntryActive: boolean;
}

// show-release-modal? in app.main.ui: the onboarding flag, no
// hide-release-modal flag, no pending nitrate entry, a profile that already
// saw the onboarding, a release stamp that differs from the running version,
// and a real version (development builds never auto-open it).
export function shouldShowReleaseNotes({
  version,
  props,
  flags,
  nitrateEntryActive,
}: ReleaseNotesGateInput): boolean {
  if (!flags.includes("onboarding")) return false;
  if (flags.includes("hide-release-modal")) return false;
  if (nitrateEntryActive) return false;
  if (props?.["onboarding-viewed"] !== true) return false;
  const main = mainVersion(version);
  if (main === "0.0") return false;
  return props["release-notes-viewed"] !== main;
}
