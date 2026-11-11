/**
 * Hand a Blob to the browser as a download.
 *
 * The element returns Blobs (`exportScene()` / `snapshot()`) instead of
 * triggering downloads itself: a host may want to upload the bytes, show a
 * preview, or skip the file system entirely. This is the "just save it" button.
 *
 * @returns the file name actually used (sanitized, with a timestamp when empty).
 */
export function downloadBlob(blob: Blob, filename = ""): string {
  const name = safeFileName(filename, `${timestamp()}.${extensionFor(blob.type)}`);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return name;
}

function safeFileName(value: string, fallback: string): string {
  const cleaned = value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

/** `2026-11-12T01-46-26` — local time, filesystem-safe. */
function timestamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

function extensionFor(mime: string): string {
  switch (mime) {
    case "model/gltf-binary":
      return "glb";
    case "model/gltf+json":
      return "gltf";
    case "model/obj":
      return "obj";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "text/plain":
      return "txt";
    default:
      return "png";
  }
}
