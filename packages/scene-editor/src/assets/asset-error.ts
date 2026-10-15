export enum AssetErrorCode {
  NotFound = "asset-not-found",
  ResolveFailed = "asset-resolve-failed",
  LoadFailed = "asset-load-failed",
  UnsupportedFormat = "asset-unsupported-format",
  Disposed = "asset-disposed",
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
