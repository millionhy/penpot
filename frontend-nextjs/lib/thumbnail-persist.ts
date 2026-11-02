// Upload of a generated thumbnail (F9.14): the create-file-thumbnail leg of
// the reference's persist-thumbnail in app.main.ui.dashboard.grid.
//
// The backend takes a multipart media upload plus file-id and revn, stores
// the PNG in the file-thumbnail bucket and answers {:uri ... :id ...}; the
// grid then paints assets/by-id/<id>. The call is form-data (repo.cljs
// default-options), so cmdUpload — not cmd — is the right leg.
//
// Failure is silent for the dashboard: a null answer keeps the card on its
// background and loader, and the file gets another try on the next visit.

import { cmdUpload } from "@/lib/rpc";

interface CreateFileThumbnailResult {
  id?: string;
  uri?: string;
}

export async function persistFileThumbnail(
  fileId: string,
  revn: number,
  blob: Blob,
): Promise<string | null> {
  try {
    const result = await cmdUpload<CreateFileThumbnailResult>("create-file-thumbnail", {
      "file-id": fileId,
      revn,
      media: blob,
    });
    return typeof result?.id === "string" && result.id.length > 0 ? result.id : null;
  } catch (cause) {
    console.warn("[thumbnail] could not persist the generated thumbnail:", cause);
    return null;
  }
}