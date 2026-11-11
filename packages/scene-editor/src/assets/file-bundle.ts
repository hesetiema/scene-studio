import { AssetError, AssetErrorCode } from "./asset-error";
import {
  UNIVERSAL_SUPPORTED_FORMATS,
  detectFormatFromUrl,
  type Supported3DFormat,
} from "./universal-asset-loader";

export interface FileBundle {
  /** URL the asset loader should fetch — a Blob URL for the primary file. */
  readonly url: string;
  /**
   * Asset id that carries the format hint. Blob URLs have no extension, so the
   * id is what tells the universal loader whether a `.obj` is an OBJ.
   */
  readonly assetId: string;
  /** Primary file name without its extension (use it as the object name). */
  readonly name: string;
  readonly format: Supported3DFormat;
  /** Primary file first, the rest in drop order. */
  readonly files: readonly File[];
  /** Revoke every Blob URL this bundle created. Idempotent. */
  dispose(): void;
}

export interface FileBundleOptions {
  /**
   * Asset id prefix. The format extension is always appended, because the
   * universal loader reads it back (`detectFormatFromUrl(url, assetId)`).
   */
  assetIdPrefix?: string;
}

const PRIMARY_PRIORITY: readonly Supported3DFormat[] = ["gltf", "glb", "obj", "stl"];

/**
 * Turn a dropped/picked file set into one loadable URL.
 *
 * `.glb` / `.obj` / `.stl` are self-contained, so this is just an object URL.
 * A `.gltf` is not: its `buffers[].uri` / `images[].uri` are relative paths that
 * only resolve against the original folder, which a file drop does not have.
 * Every relative URI is therefore rewritten to a Blob URL for the matching
 * dropped file, and the whole JSON is served from one Blob URL (the reference
 * implementation of this is three-gltf-viewer's `assetMap` URL modifier).
 *
 * Absolute URLs, `data:` URIs and existing `blob:` URLs are left alone. A
 * missing buffer or image is an error worth raising here: the loader would
 * otherwise fail on the first texture with no hint at which file was missing.
 */
export async function createFileBundleUrl(
  files: readonly File[] | FileList,
  options: FileBundleOptions = {},
): Promise<FileBundle> {
  const list = Array.from(files);
  if (list.length === 0) {
    throw new AssetError(
      AssetErrorCode.UnsupportedFormat,
      "No files to load (drop a .glb / .gltf / .obj / .stl)",
    );
  }

  const primary = pickPrimary(list);
  if (!primary) {
    throw new AssetError(
      AssetErrorCode.UnsupportedFormat,
      `Unsupported 3D file (expected .${UNIVERSAL_SUPPORTED_FORMATS.join(", .")})`,
      { detail: { files: list.map((file) => file.name) } },
    );
  }

  const format = detectFormatFromUrl(primary.name);
  const name = stripExtension(primary.name) || "model";
  const assetId = `${options.assetIdPrefix ?? "upload"}-${name}.${format}`;
  const created = new Set<string>();
  let disposed = false;

  const createObjectUrl = (blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    created.add(url);
    return url;
  };

  const url =
    format === "gltf" ? await bundleGltf(primary, list, createObjectUrl) : createObjectUrl(primary);

  return {
    url,
    assetId,
    name,
    format,
    files: [primary, ...list.filter((file) => file !== primary)],
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const createdUrl of created) URL.revokeObjectURL(createdUrl);
      created.clear();
    },
  };
}

/** Drop order does not matter; a `.gltf` bundle wins because it owns its resources. */
function pickPrimary(files: readonly File[]): File | null {
  for (const format of PRIMARY_PRIORITY) {
    const match = files.find((file) => detectFormatFromUrl(file.name) === format && hasExtension(file.name));
    if (match) return match;
  }
  return null;
}

function hasExtension(name: string): boolean {
  const ext = name.split("?")[0]?.split(".").pop()?.toLowerCase();
  return ext !== undefined && (UNIVERSAL_SUPPORTED_FORMATS as readonly string[]).includes(ext);
}

function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, "");
}

async function bundleGltf(
  primary: File,
  files: readonly File[],
  createObjectUrl: (blob: Blob) => string,
): Promise<string> {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(await primary.text()) as Record<string, unknown>;
  } catch (error) {
    throw new AssetError(AssetErrorCode.LoadFailed, `${primary.name} is not valid glTF JSON`, {
      cause: error,
    });
  }

  const index = new Map<string, File>();
  for (const file of files) {
    if (file === primary) continue;
    index.set(file.name.toLowerCase(), file);
    const base = file.name.split("/").pop()?.toLowerCase();
    if (base) index.set(base, file);
  }

  const missing: string[] = [];
  const rewrite = (entry: { uri?: unknown }): void => {
    const uri = entry.uri;
    if (typeof uri !== "string" || !isRelative(uri)) return;
    const file = lookup(uri, index);
    if (!file) {
      missing.push(uri);
      return;
    }
    entry.uri = createObjectUrl(file);
  };

  for (const key of ["buffers", "images"] as const) {
    const list = json[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list as Array<{ uri?: unknown }>) {
      if (entry && typeof entry === "object") rewrite(entry);
    }
  }

  if (missing.length > 0) {
    throw new AssetError(
      AssetErrorCode.ResolveFailed,
      `${primary.name} references files that were not dropped: ${missing.join(", ")}`,
      { detail: { missing } },
    );
  }

  return createObjectUrl(new Blob([JSON.stringify(json)], { type: "model/gltf+json" }));
}

function isRelative(uri: string): boolean {
  if (!uri) return false;
  if (uri.startsWith("data:") || uri.startsWith("blob:") || uri.startsWith("//")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(uri);
}

/** Match on the full relative path first, then on the bare file name. */
function lookup(uri: string, index: Map<string, File>): File | undefined {
  let clean = uri.replace(/^\.\//, "");
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // Not valid percent-encoding: match the raw string instead.
  }
  const base = clean.split("/").pop()?.toLowerCase();
  return index.get(clean.toLowerCase()) ?? (base ? index.get(base) : undefined);
}
