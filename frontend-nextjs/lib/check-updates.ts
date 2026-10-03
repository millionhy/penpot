// Update check (F5.2). Headless port of app.main.ui.dashboard.check-updates:
// fetch the staging CHANGES.md over CORS, parse the released version headings
// and their ":rocket: Epics and highlights" bullets, then classify the result
// against the installed version. The modals live in components/check-updates.tsx.
//
// The telemetry events (explore-changelog-click and friends) are dropped; the
// shell has no analytics seam yet, same as the rest of the dashboard slices.

// changelog-md-url in check_updates.cljs.
export const CHANGELOG_MD_URL =
  "https://raw.githubusercontent.com/penpot/penpot/refs/heads/staging/CHANGES.md";
export const CHANGELOG_URL = "https://github.com/penpot/penpot/blob/main/CHANGES.md";
export const RELEASE_NOTES_URL = "https://penpot.app/release-notes";

// version-re in app.common.version, reduced to the X.Y.Z base: anything the
// regex does not parse compares as 0.0.0, matching (d/parse-integer x 0).
const VERSION_RE = /^([A-Za-z]+-?)?((\d+)\.(\d+)\.(\d+))/;

function versionComponents(version: string): [number, number, number] {
  const match = VERSION_RE.exec(version);
  if (match === null) return [0, 0, 0];
  return [Number(match[3]), Number(match[4]), Number(match[5])];
}

// v/newer? (app.common.version): positive when a > b on (major, minor, patch).
export function versionNewer(a: string, b: string): boolean {
  const [majorA, minorA, patchA] = versionComponents(a);
  const [majorB, minorB, patchB] = versionComponents(b);
  if (majorA !== majorB) return majorA > majorB;
  if (minorA !== minorB) return minorA > minorB;
  return patchA > patchB;
}

// version-heading-re: "## X.Y.Z<suffix>" at line start.
const VERSION_HEADING_RE = /^##\s+(\d+\.\d+\.\d+)(.*)$/gm;
const ROCKET_HEADING_RE = /^###\s+:rocket:\s+Epics and highlights\s*$/m;
const NEXT_HEADING_RE = /^#{2,3}\s/m;
const BULLET_RE = /^-\s+(.+)$/;

function unreleasedSuffix(suffix: string): boolean {
  return suffix.toLowerCase().includes("unreleased");
}

// parse-latest-released-version: the first non-unreleased "## X.Y.Z" heading.
export function parseLatestReleasedVersion(markdown: string | null): string | null {
  if (typeof markdown !== "string") return null;
  VERSION_HEADING_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VERSION_HEADING_RE.exec(markdown)) !== null) {
    if (!unreleasedSuffix(match[2] ?? "")) return match[1];
  }
  return null;
}

export interface HighlightsSection {
  version: string;
  items: string[];
}

// extract-rocket-items: bullets of the ":rocket:" subsection of one version
// section, nil when the section has none.
function rocketItems(sectionBody: string): string[] | null {
  const start = ROCKET_HEADING_RE.exec(sectionBody);
  if (start === null) return null;
  const rest = sectionBody.slice(start.index + start[0].length);
  const next = NEXT_HEADING_RE.exec(rest);
  const subsection = next === null ? rest : rest.slice(0, next.index);
  const items: string[] = [];
  for (const line of subsection.split("\n")) {
    const bullet = BULLET_RE.exec(line.trim());
    if (bullet !== null) items.push(bullet[1]);
  }
  return items.length > 0 ? items : null;
}

// parse-highlights: released version sections with rocket bullets, in file
// order (newest first). Split points mirror the CLJS lookahead on
// "## X.Y.Z" headings.
export function parseHighlights(markdown: string | null): HighlightsSection[] {
  if (typeof markdown !== "string") return [];
  const parts = markdown.split(/(?=^##\s+\d+\.\d+\.\d+)/m);
  const sections: HighlightsSection[] = [];
  for (const part of parts) {
    VERSION_HEADING_RE.lastIndex = 0;
    const match = VERSION_HEADING_RE.exec(part);
    if (match === null) continue;
    if (unreleasedSuffix(match[2] ?? "")) continue;
    const items = rocketItems(part);
    if (items === null) continue;
    sections.push({ version: match[1], items });
  }
  return sections;
}

// highlights-until-installed: keep the sections strictly newer than the
// installed version, stopping at the first one that is not.
export function highlightsUntilInstalled(
  sections: readonly HighlightsSection[],
  installed: string,
): HighlightsSection[] {
  const out: HighlightsSection[] = [];
  for (const section of sections) {
    if (!versionNewer(section.version, installed)) break;
    out.push(section);
  }
  return out;
}

// --- Inline markdown of one highlight bullet --------------------------------

export type HighlightFragment =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "link"; text: string; href: string };

// inline-md-re: [text](url) or **bold**; anything else stays plain text and
// non-http links degrade to text, exactly like parse-highlight-item.
const INLINE_MD_RE = /\[([^\]]+)\]\(((?:\([^)]*\)|[^)\s])*)\)|\*\*([^*]+)\*\*/;

function httpUrl(url: string): boolean {
  return /^https?:\/\/.*$/.test(url);
}

export function parseHighlightItem(text: string | null | undefined): HighlightFragment[] {
  if (typeof text !== "string" || text === "") return [];
  const out: HighlightFragment[] = [];
  let rest = text;
  for (;;) {
    if (rest === "") return out;
    const match = INLINE_MD_RE.exec(rest);
    if (match === null) {
      out.push({ type: "text", text: rest });
      return out;
    }
    const index = match.index;
    if (index > 0) out.push({ type: "text", text: rest.slice(0, index) });
    const after = rest.slice(index + match[0].length);
    if (match[1] !== undefined) {
      const href = match[2] ?? "";
      if (httpUrl(href)) out.push({ type: "link", text: match[1], href });
      else out.push({ type: "text", text: match[0] });
    } else {
      out.push({ type: "bold", text: match[3] ?? "" });
    }
    rest = after;
  }
}

// --- Check flow -----------------------------------------------------------------

export type UpdateCheckResult =
  | { kind: "unable" }
  | { kind: "uptodate"; version: string }
  | { kind: "available"; installed: string; latest: string; highlights: HighlightsSection[] };

// handle-highlights: no parseable version -> unable, not newer -> uptodate,
// otherwise available with the sections newer than the installed one.
export function classifyUpdateCheck(
  installed: string,
  markdown: string | null,
): UpdateCheckResult {
  const latest = parseLatestReleasedVersion(markdown);
  if (latest === null) return { kind: "unable" };
  if (!versionNewer(latest, installed)) return { kind: "uptodate", version: installed };
  return {
    kind: "available",
    installed,
    latest,
    highlights: highlightsUntilInstalled(parseHighlights(markdown), installed),
  };
}

// check-for-updates!: the fetch itself; any network or HTTP failure is the
// "unable" dialog. fetchText is injectable for tests.
export async function checkForUpdates(
  installed: string,
  fetchText: (url: string) => Promise<string | null> = fetchChangelogText,
): Promise<UpdateCheckResult> {
  const markdown = await fetchText(CHANGELOG_MD_URL);
  return classifyUpdateCheck(installed, markdown);
}

export async function fetchChangelogText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}
