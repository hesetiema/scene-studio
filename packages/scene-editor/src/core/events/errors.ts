/** Stable public error codes (D6). Serialized as strings on the error event. */
export const SceneErrorCode = {
  Validation: "validation",
  AssetResolveFailed: "asset-resolve-failed",
  AssetLoadFailed: "asset-load-failed",
  RenderInitFailed: "render-init-failed",
  Lifecycle: "lifecycle",
  Conflict: "conflict",
} as const;

export type SceneErrorCode = (typeof SceneErrorCode)[keyof typeof SceneErrorCode];

export interface SceneEditorErrorOptions {
  cause?: unknown;
  detail?: Record<string, unknown>;
}

export class SceneEditorError extends Error {
  readonly code: SceneErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: SceneErrorCode, message: string, options: SceneEditorErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SceneEditorError";
    this.code = code;
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
  }
}
