// Port of app.util.avatars/generate: the profile initials painted on a canvas
// and returned as a data URL. Needs document/canvas, so it is client-only and
// returns "" during SSR; callers fall back to the stored photo URL.

const cache = new Map<string, string>();

export interface AvatarOptions {
  name: string;
  color?: string;
  size?: number;
}

// str/words on the uppercased name, then the first letter of the first word, or
// of the first two words when there are more.
export function initials(name: string): string {
  const parts = name.toUpperCase().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].charAt(0);
  return parts[0].charAt(0) + parts[1].charAt(0);
}

export function generateAvatar({ name, color, size = 128 }: AvatarOptions): string {
  const key = name + "|" + (color ?? "") + "|" + size;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return "";

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context === null) return "";

  context.fillStyle = color ?? "#000000";
  context.fillRect(0, 0, size, size);
  context.font = size / 2 + "px Arial";
  context.textAlign = "center";
  context.fillStyle = color !== undefined ? "#2e3434" : "#fff";
  context.fillText(initials(name), size / 2, size / 1.5);

  const url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}
