/** Shared limits for public GridFS images (logo, embed assistant avatar, etc.). */
export const MAX_PUBLIC_IMAGE_BYTES = 2 * 1024 * 1024;

export function isAllowedPublicImageMime(mime: string): boolean {
  if (!mime.startsWith("image/")) return false;
  const allowed = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "image/svg+xml",
  ]);
  return allowed.has(mime);
}
