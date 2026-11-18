// app.util.mime: the mimetype and extension of each export type.

export type ExportType = "png" | "jpeg" | "webp" | "svg" | "pdf" | "zip";

const EXTENSIONS: Record<ExportType, string> = {
  png: ".png",
  jpeg: ".jpg",
  webp: ".webp",
  svg: ".svg",
  pdf: ".pdf",
  zip: ".zip",
};

const MIMETYPES: Record<ExportType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
};

export function getExtension(type: ExportType): string {
  return EXTENSIONS[type];
}

export function get(type: ExportType): string {
  return MIMETYPES[type];
}