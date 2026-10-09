"use client";

// member-info* avatar (F5.5): cfg/resolve-profile-photo-url for a member row,
// the stored photo served from assets/by-id and a generated initials avatar
// otherwise. The CLJS helper feeds avatars/generate the fullname, or the name
// as fallback; the shell also falls back to the email so a row without both
// still paints something.

import { useEffect, useState } from "react";
import { generateAvatar } from "@/lib/avatars";
import { config } from "@/lib/config";
import { resolveMediaUri } from "@/lib/dashboard";
import type { TeamMember } from "@/lib/team";

export interface MemberAvatarProps {
  member: Pick<TeamMember, "name" | "fullname" | "email" | "photo-id">;
  className?: string;
}

export function MemberAvatar({ member, className }: MemberAvatarProps) {
  const photoId = member["photo-id"];
  const photo =
    typeof photoId === "string" && photoId !== ""
      ? resolveMediaUri(config.publicUri, photoId)
      : null;
  const name = member.fullname ?? member.name ?? member.email;
  const [avatar, setAvatar] = useState<string | null>(null);
  useEffect(() => {
    if (photo !== null) {
      setAvatar(null);
      return;
    }
    setAvatar(generateAvatar({ name }));
  }, [photo, name]);

  return <img className={className} src={photo ?? avatar ?? ""} alt="" />;
}
