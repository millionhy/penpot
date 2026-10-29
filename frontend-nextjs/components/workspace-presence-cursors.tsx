"use client";

// The multiuser cursors of the viewport overlay (F8.3): the port of
// viewport/presence.cljs (active-cursors and session-cursor*). Every remote
// session of the open page draws its arrow at the world point of its last
// pointer update, scaled by the inverse zoom so it keeps its screen size,
// plus a name bubble.
//
// The layer reads the presence slice of the store and the expiry rule of
// visibleCursors (same page, at most five seconds old); it re-renders once
// per second while some cursor lives, so a session that goes quiet
// disappears on time. The name comes from get-team-members, the directory
// the CLJS workspace loads for the same purpose. A profile outside the team
// (a public-link viewer) renders an empty bubble, where the CLJS would
// render a nil name.
//
// Deviations from the compiled original, documented:
// - The local session is not drawn: lib/workspace-presence never inserts
//   it, and its cursor would only duplicate the OS pointer.
// - The bubble is an HTML div inside a foreignObject, like the CLJS; the
//   text is white on the session color (the CLJS passes --app-white and
//   ignores the :text-color it stores).
// - The cursor draws nothing while its page id is unknown (a pointer
//   update that arrives before the join carries none).

import { useEffect, useState, useSyncExternalStore } from "react";

import { getTeamMembers } from "@/lib/team";
import {
  DEFAULT_PRESENCE_COLOR,
  PRESENCE_TICK_MS,
  hasFreshCursors,
  visibleCursors,
} from "@/lib/workspace-presence";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
} from "@/lib/workspace-store";

// The arrow of session-cursor*, in screen pixels (viewport/presence.cljs).
const POINTER_PATH = [
  "M11.58,-0.47L11.47,-0.35L0.34,10.77L0.30,10.96L-0.46,",
  "15.52L4.29,14.72L15.53,3.47L11.58,-0.47ZL11.58,",
  "-0.47ZL11.58,-0.47ZM11.58,1.3C12.31,2.05,13.02,",
  "2.742,13.76,3.47L4.0053,13.23C3.27,12.50,2.55,",
  "11.78,1.82,11.05L11.58,1.30ZL11.58,1.30ZM1.37,12.15L2.90,",
  "13.68L1.67,13.89L1.165,13.39L1.37,12.15ZL1.37,12.15Z",
].join("");

// session-cursor*: longer than 16 characters, the name keeps its first 12
// and three dots.
const NAME_LIMIT = 16;
const NAME_SLICE = 12;

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();

function shortName(name: string): string {
  return name.length > NAME_LIMIT ? name.slice(0, NAME_SLICE) + "..." : name;
}

// profile-id -> fullname, the map refs/profiles answers with in the CLJS.
function namesOf(rows: { id: string; name?: string; fullname?: string }[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    const name = row.fullname ?? row.name;
    if (typeof name === "string" && name.length > 0) names.set(row.id, name);
  }
  return names;
}

export interface WorkspacePresenceCursorsProps {
  pageId: string;
  // The zoom of the overlay viewBox: the cursors divide by it, so the arrow
  // and the bubble keep one screen size at every zoom.
  zoom: number;
  // The team of the open file, for the name lookup; null leaves every
  // bubble empty and skips the request (the cursors still draw).
  teamId: string | null;
}

export function WorkspacePresenceCursors({
  pageId,
  zoom,
  teamId,
}: WorkspacePresenceCursorsProps) {
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );
  const presence = state.presence;

  // The names of the team members, fetched once per team. A failure leaves
  // the bubbles empty; the cursors do not depend on it.
  const [names, setNames] = useState<ReadonlyMap<string, string>>(EMPTY_NAMES);
  useEffect(() => {
    if (teamId === null) {
      setNames(EMPTY_NAMES);
      return;
    }
    let live = true;
    getTeamMembers(teamId)
      .then((rows) => {
        if (live) setNames(namesOf(rows));
      })
      .catch(() => {
        if (live) setNames(EMPTY_NAMES);
      });
    return () => {
      live = false;
    };
  }, [teamId]);

  // The expiry clock of active-cursors: one tick per second, only while some
  // cursor is still fresh, so the timer stops once every one has expired.
  const [now, setNow] = useState(() => Date.now());
  const ticking = hasFreshCursors(presence, now);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), PRESENCE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const cursors = visibleCursors(presence, pageId, now);
  if (cursors.length === 0) return null;

  return (
    <g className="pp-presence-cursors" data-testid="presence-cursors">
      {cursors.map((cursor) => {
        const color = cursor.color ?? DEFAULT_PRESENCE_COLOR;
        const profileId = cursor.profileId;
        const name = profileId === null ? "" : (names.get(profileId) ?? "");
        return (
          <g
            key={cursor.id}
            className="pp-presence-cursor"
            data-testid="presence-cursor"
            transform={`translate(${cursor.point.x} ${cursor.point.y}) scale(${1 / zoom})`}
          >
            <path d={POINTER_PATH} fill={color} />
            <g transform="translate(17 -10)">
              <foreignObject x={-0.3} y={-12.5} width={300} height={120}>
                <div className="pp-presence-cursor-name" style={{ backgroundColor: color }}>
                  {shortName(name)}
                </div>
              </foreignObject>
            </g>
          </g>
        );
      })}
    </g>
  );
}
