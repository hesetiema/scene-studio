import { DEFAULT_VIEW_STATE } from "./default-view";
import {
  SCHEMA_VERSION,
  type SceneDocument,
  type SceneObjectDTO,
  type Vec3,
  type ViewState,
} from "./schema";
import { SceneEditorError, SceneErrorCode } from "../events/errors";

/**
 * Deep patch for {@link ViewState}.
 *
 * Every level is optional so a caller can move one thing ("this scene is
 * darker") without restating the rest. Arrays (`additional`, `position`,
 * `target`) replace wholesale rather than merging element-wise: a half-merged
 * vector is never what anyone meant.
 */
export interface ViewPatch {
  camera?: Partial<ViewState["camera"]>;
  lights?: {
    ambient?: Partial<ViewState["lights"]["ambient"]>;
    directional?: Partial<ViewState["lights"]["directional"]>;
    additional?: ViewState["lights"]["additional"];
  };
  environment?: Partial<ViewState["environment"]>;
}

/**
 * Apply a patch to a copy of `base`.
 *
 * `base` is never mutated and the result shares nothing with it — documents are
 * handed to the runtime, to the history stack and to the host, and one of those
 * three will eventually edit a nested object in place.
 */
export function applyViewPatch(base: ViewState, patch?: ViewPatch): ViewState {
  const view = structuredClone(base);
  if (!patch) return view;

  if (patch.camera) Object.assign(view.camera, structuredClone(patch.camera));
  if (patch.lights?.ambient) {
    Object.assign(view.lights.ambient, structuredClone(patch.lights.ambient));
  }
  if (patch.lights?.directional) {
    Object.assign(view.lights.directional, structuredClone(patch.lights.directional));
  }
  if (patch.lights?.additional) {
    view.lights.additional = structuredClone(patch.lights.additional);
  }
  if (patch.environment) {
    Object.assign(view.environment, structuredClone(patch.environment));
  }
  return view;
}

export interface CreateSceneDocumentOptions {
  /** Defaults to `"scene"`; pass a stable id to keep the recorded view across reloads. */
  sceneId?: string;
  revision?: number;
  objects?: readonly SceneObjectDTO[];
  /** Merged over `baseView` (or over `DEFAULT_VIEW_STATE`). */
  view?: ViewPatch;
  /**
   * Baseline the patch is applied to. Only useful for the two shipped
   * baselines — `createDefaultViewState()` (editor) and
   * `createPreviewViewState()` (viewer) — or for reinstating a saved view.
   */
  baseView?: ViewState;
}

/**
 * Build a valid {@link SceneDocument} without hand-writing the envelope.
 *
 * The document type has six top-level fields and a `view` of three required
 * branches; hosts that write it by hand end up re-deriving the same envelope on
 * every page and silently drifting when the schema grows. Everything here is
 * plain data (no ids are generated, nothing is registered).
 *
 * ```ts
 * createSceneDocument({ view: { environment: { gridVisible: false } } });
 * ```
 */
export function createSceneDocument(options: CreateSceneDocumentOptions = {}): SceneDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    sceneId: options.sceneId ?? "scene",
    revision: options.revision ?? 0,
    objects: (options.objects ?? []).map((object) => structuredClone(object)),
    view: applyViewPatch(options.baseView ?? DEFAULT_VIEW_STATE, options.view),
  };
}

/** `createSceneDocument` with no objects — the "brand new scene" case. */
export function createEmptyDocument(
  options: Omit<CreateSceneDocumentOptions, "objects"> = {},
): SceneDocument {
  return createSceneDocument({ ...options, objects: [] });
}

export interface CreateDocumentFromAssetOptions {
  /** Id the runtime/`AssetResolver` resolves. Defaults to `url`. */
  assetId?: string;
  /** Source URL; also the name source when `name` is omitted. */
  url?: string;
  /** Display name (object `name`, and the base of the generated ids). */
  name?: string;
  /** Object id. Defaults to `${assetId}-mesh`. */
  objectId?: string;
  sceneId?: string;
  revision?: number;
  /** Placement of the model root; identity when omitted. */
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  view?: ViewPatch;
  baseView?: ViewState;
}

/**
 * One-mesh document for a single model — what "load this file into the editor"
 * means, without the host inventing ids or a camera.
 *
 * The id defaults are derived from the asset id, so dropping the same model
 * twice yields the same document (`sceneId` included) and the recorded view is
 * kept instead of reset.
 */
export function createDocumentFromAsset(
  options: CreateDocumentFromAssetOptions,
): SceneDocument {
  const assetId = options.assetId ?? options.url;
  if (!assetId) {
    throw new SceneEditorError(
      SceneErrorCode.Validation,
      "createDocumentFromAsset() needs an `assetId` or a `url`",
    );
  }

  const name = options.name ?? assetDisplayName(assetId);
  const objectId = options.objectId ?? `${assetId}-mesh`;

  return createSceneDocument({
    sceneId: options.sceneId ?? `scene-${name}`,
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    ...(options.baseView === undefined ? {} : { baseView: options.baseView }),
    ...(options.view === undefined ? {} : { view: options.view }),
    objects: [
      {
        id: objectId,
        type: "mesh",
        name,
        assetId,
        position: copyVec(options.position),
        rotation: copyVec(options.rotation),
        scale: copyVec(options.scale, [1, 1, 1]),
      },
    ],
  });
}

function copyVec(
  value: readonly [number, number, number] | undefined,
  fallback: readonly [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const source = value ?? fallback;
  return [source[0], source[1], source[2]];
}

/**
 * Last path segment of a URL, percent-decoded, without query/hash.
 * Same convention as `<scene-editor src>` uses for the object name.
 */
export function assetDisplayName(url: string): string {
  const clean = url.split("?")[0]?.split("#")[0] ?? url;
  const last = clean.split("/").pop() ?? clean;
  try {
    return decodeURIComponent(last) || "model";
  } catch {
    return last || "model";
  }
}
