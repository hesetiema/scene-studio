/**
 * Which format a loader should assume for a resolved URL.
 *
 * The URL cannot always answer this. `loadFiles()` and `src` hand the loader a
 * Blob URL (`blob:http://host/uuid`) and a host may serve `/api/model?id=3`;
 * neither carries an extension, and guessing "glb" from a URL that also serves
 * `.obj` is how a model ends up parsed by the wrong loader. The asset id is the
 * stable place for that hint — the element keeps the real extension on it.
 *
 * `null` means "no opinion": the caller decides whether that is an error or a
 * default. A segment that does not look like an extension (`1:4173/uuid`,
 * `gltf-binary;base64,AAAA`) is also `null` — a dot in a URL is not a format.
 */
export function assetFormatHint(url: string, assetId?: string): string | null {
  const fromUrl = extensionOf(url);
  if (fromUrl) return fromUrl;
  return assetId ? extensionOf(assetId) : null;
}

const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;

function extensionOf(value: string): string | null {
  const clean = value.split("?")[0]?.split("#")[0] ?? "";
  const last = clean.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = last.slice(dot + 1).toLowerCase();
  return EXTENSION_PATTERN.test(ext) ? ext : null;
}
