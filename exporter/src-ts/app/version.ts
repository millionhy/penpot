// app.common.version/parse. The regex and the resulting fields mirror the CLJS
// helper; every value stays a string, as `cf/version` hands them around.

export interface Version {
  full: string;
  branch: string | undefined;
  base: string;
  main: string;
  major: string;
  minor: string;
  patch: string;
  modifier: string | undefined;
  commit: string | undefined;
  "commit-hash": string | undefined;
}

// Mirrors the numbered groups: 2 branch, 3 base, 4 major, 5 minor, 6 patch,
// 8 modifier, 12 commit, 14 commit hash.
const VERSION_RE = /^(([A-Za-z]+)-?)?((\d+)\.(\d+)\.(\d+))(-?((RC|DEV)(\d+)?))?(-?(\d+))?(-?g(\w+))?$/;

const DEVELOP: Version = {
  full: "develop",
  branch: "develop",
  base: "0.0.0",
  main: "0.0",
  major: "0",
  minor: "0",
  patch: "0",
  modifier: undefined,
  commit: undefined,
  "commit-hash": undefined,
};

export function parseVersion(data: string): Version {
  if (data.startsWith("%") || data === "develop") return DEVELOP;

  const result = VERSION_RE.exec(data);
  if (result === null) {
    // The CLJS parse returns nil; callers only read :full/:main, so keep a
    // usable record instead of crashing on an unexpected build stamp.
    return { ...DEVELOP, full: data, branch: undefined };
  }

  const major = result[4] ?? "0";
  const minor = result[5] ?? "0";

  return {
    full: data,
    branch: result[2],
    base: result[3] ?? data,
    main: `${major}.${minor}`,
    major,
    minor,
    patch: result[6] ?? "0",
    modifier: result[8],
    commit: result[12],
    "commit-hash": result[14],
  };
}

// `%version%` is replaced by the build script, as it was in the CLJS bundle;
// an unreplaced stamp parses as develop, which is what the original did.
export const version: Version = parseVersion("%version%");