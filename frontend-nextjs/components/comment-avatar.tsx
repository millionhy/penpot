"use client";

// Port of comment-avatar* (app.main.ui.comments): the round owner picture.
// A stored photo is served from assets/by-id (cf/resolve-profile-photo-url);
// without one the initials tile is generated on a canvas — client-only, so
// the generation runs in an effect like TeamPicture does, never during SSR.

import { useEffect, useState } from "react";

import { generateAvatar } from "@/lib/avatars";
import { config } from "@/lib/config";
import { profilePhotoUrl } from "@/lib/settings";

export interface CommentAvatarProps {
  // The joined owner-photo-id of the comment row; null falls to the tiles.
  photoId?: string | null;
  // The owner fullname: the alt text and the initials source.
  name: string;
  className?: string;
}

export function CommentAvatar({ photoId, name, className }: CommentAvatarProps) {
  const photo = profilePhotoUrl({ "photo-id": photoId ?? null }, config.publicUri);
  const [fallback, setFallback] = useState<string | null>(null);

  useEffect(() => {
    if (photo !== null) {
      setFallback(null);
      return;
    }
    setFallback(generateAvatar({ name }) || null);
  }, [photo, name]);

  return (
    <img
      className={["pp-comment-avatar", className ?? ""].filter((c) => c.length > 0).join(" ")}
      src={photo ?? fallback ?? undefined}
      alt={name}
    />
  );
}
