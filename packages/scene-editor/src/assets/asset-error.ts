export enum AssetErrorCode {
  NotFound = "asset-not-found",
  ResolveFailed = "asset-resolve-failed",
  LoadFailed = "asset-load-failed",
  UnsupportedFormat = "asset-unsupported-format",
  Disposed = "asset-disposed",
}

/**
 * Which name to put in a message a human reads.
 *
 * The same asset has two names: the id the host asked for, and the URL the
 * loader actually tried. The URL is the one that lets someone fix a 404 — but
 * it is useless when it is a `blob:`/`data:` URI, and for `src` the id is the
 * internal placeholder `__src__`, which tells the reader nothing. So: the URL
 * when it carries information, the id otherwise. Both stay in `detail` either
 * way, so a host that keys on the id is not losing it.
 */
export function describeAsset(assetId: string, url?: string): string {
  if (!url || url === assetId) return assetId;
  return /^(blob|data):/i.test(url) ? assetId : url;
}

export class AssetError extends Error {
  readonly name = "SceneEditorAssetError";
  constructor(
    readonly code: AssetErrorCode,
    message: string,
    options?: { cause?: unknown; detail?: Record<string, unknown> },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.detail = options?.detail ?? {};
  }
  readonly detail: Record<string, unknown>;
}
