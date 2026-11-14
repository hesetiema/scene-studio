# BIM loading (app-level)

This folder used to be `packages/scene-editor/src/bim/`, published as the SDK's optional
`@scenio/scene-editor/bim` entry. It had exactly one consumer, so 0.7.0 moved it out of the
package: the SDK now ships three entries (`.`, `./element`, `./three`) and nothing format-specific.

`vent-demo.ts` imports it as `./bim/bim-entry`. The module is **not** in the npm tarball and has no
unit tests — `tsc --noEmit` plus `vite build` in `apps/playground` are its only automated checks.

## Contract
Structural loading only. Every function here **reads assets and builds scene-graph nodes**; none of them
writes to the scene document, picks a unit, or creates a material you did not ask for. Materials, colour,
scale, camera framing and interactivity stay with the host — that is what lets the same loader serve a
white-massing overview and a plan-view floor plan.

### Scene loader

| Export | Description |
|---|---|
| `loadBimScene(options)` | Reads `{baseUrl}/{sceneName}/Scene.json`, loads each listed chunk as binary FBX, mounts meshes into a `THREE.Group`. Returns a `BimSceneHandle` |
| `floorKeyOf(meshName)` | Normalises a mesh name to a storey key: `1F`→`F1`, `B3F`/`B1FM`→`B3`/`B1`, `RF`/`RFding`→`RF`, anything else → `null` |
| `BimSceneHandle` | `group`, `floorKeys`, `meshesByFloor: Map<string, THREE.Mesh[]>`, `meshByName`, `meshInfo`, `materials`, `setFloorsVisible(keys \| null)`, `dispose()` |
| `LoadBimSceneOptions` | `baseUrl`, `sceneName`, plus `fetchFn`, `mainBuildingsOnly` (default `true`), `includeDecor` (default `true`), `resolveFloorKey`, `resolveMaterial`, `onMesh` |

`resolveMaterial(info, mesh)` returns a `THREE.Material` to **replace** the chunk's own material, or
`null`/`undefined` to keep it. Whatever you return is yours to dispose — the handle's `dispose()` frees only
geometries and the group. `onMesh` runs after mount, for `userData` tags, overlays or per-mesh visibility.

`includeDecor` covers the separate `图形*` wireframe chunks. They carry no storey of their own, so the loader
pairs each with the sibling solid chunk by its `_N` suffix; when the listing does not line up, the pairing map
comes back empty and decor meshes hide in `setFloorsVisible` filter mode.

```ts
const scene = await loadBimScene({ baseUrl: "/bim", sceneName: "07_building_relation" });
scene.setFloorsVisible(["F6"]); // click-through storey filter; null shows all
runtime.scene.add(scene.group);
```

### Lightweight floor loader

| Export | Description |
|---|---|
| `loadRevitFloor(options)` | Reads `{baseUrl}/{floorId}.json` — one storey, per-category merged vertex/index buffers as base64 typed arrays — and mounts one mesh per category |
| `RevitFloorHandle` | `group`, `byCategory: Map<string, THREE.Mesh[]>`, `categories`, `bbox: THREE.Box3`, `floorId`, `unit`, `up`, `dispose()` |
| `LoadRevitFloorOptions` | `baseUrl`, `floorId`, plus `categories` (whitelist), `resolveMaterial(info)`, `onMesh(mesh, info)`, `signal` |
| `RevitCategoryInfo` | `category` (e.g. `CFCSWL` wall, `CFCSFL` slab), `vertexCount`, `triangleCount`, `bbox` |

`resolveMaterial` gets one call per category before mounting: return a material to use it, `null` to **skip**
the category entirely, `undefined` to fall back to a plain untextured `MeshBasicMaterial`. Vertices are used
exactly as stored — the loader applies no scale, so `unit` and `up` are informational and the host's unit
conversion is the single place that decides real-world size.

### Outline helpers

| Export | Description |
|---|---|
| `parseOutline(outline)` | Accepts a JSON string or parsed `OutlineJson` (`OutlinePoint[][][]`, rings of `{X, Y}`, first ring = outer, rest = holes); `null` when empty or malformed |
| `parseBimLocation(value)` | `"x,y,z"` placement string → `[number, number, number]`; `null` when missing, short or non-finite |
| `outlineToShapes(parsed, { scale })` | Parsed outline → `THREE.Shape[]` with holes wired up, in outline-plan space (shape XY = point XY × scale); the caller decides how plan maps to world |
| `extrudedOutlineGeometry(outline, { depth, scale?, rotateToYUp? })` | Extruded solid, **no bevel**, rotated −90° about X by default so plan maps to world XZ and depth to +Y |
| `outlinePlaneGeometry(outline, { scale?, rotateToYUp? })` | Flat triangulated plane. Prefer this over a near-zero extrusion in plan views — a `0.01`-unit extrusion puts two coplanar faces closer than the depth buffer resolves, which shows up as stripe artifacts |
| `outlinePlanCentroid(outline)` | Average of the first ring's vertices, in raw outline units — for label anchors |

Both geometry helpers return `null` for a missing or degenerate outline rather than throwing, so a floor with
one bad space still renders the rest.
