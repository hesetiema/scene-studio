import * as THREE from "three";
import { HorizontalBlurShader } from "three/examples/jsm/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/examples/jsm/shaders/VerticalBlurShader.js";
import type { ContactShadowDTO } from "../../core/document/schema";

/**
 * Longest edge of the shadow texture at `softness: 0`; halved per unit of
 * softness down to {@link MIN_MAP_SIZE} (model-viewer's `LOG_MAX/MIN_RESOLUTION`).
 */
const MAX_MAP_SIZE = 1024;
const MIN_MAP_SIZE = 64;
/**
 * Extra pixels along each axis for the blur kernel to bleed into (model-viewer's
 * `TAP_WIDTH`). The ortho frustum is widened to match, so the blur does not
 * shrink the shadow's coverage, and the pad is wider than the kernel's reach
 * (±4 texels) so a blurred edge never hits the texture border.
 */
const TAP_WIDTH = 10;
/** `shadow-intensity` 1 → fully opaque catcher; the falloff lives in the texture. */
const DEFAULT_OPACITY = 1;
/** `shadow-softness` when the document does not declare one (model-viewer's default). */
const DEFAULT_SOFTNESS = 1;
/**
 * Hard shadows are not lightened by blur or height falloff, so the reference
 * scales their intensity down to keep them perceptually as heavy as the soft
 * ones; the factor interpolates from this to 1 across the softness range.
 */
const HARD_SHADOW_INTENSITY = 0.3;
/**
 * The catcher sits this fraction of the content's largest dimension below the
 * floor, so a baked-in ground plane in the document does not z-fight with it.
 */
const FLOOR_GAP = 0.001;
/**
 * Animated content is not contained by its resting bounding box, so the
 * reference gives it a shadow volume this many times larger than its largest
 * dimension — bound, resolution and far plane all scale with it, which keeps
 * the shadow's texel density and depth weighting identical to a still model.
 */
const ANIMATION_SCALING = 2;

export interface ContactShadowOptions {
  scene: THREE.Scene;
  /** Real WebGL renderer; stubs cannot render targets, so the rig stays inert. */
  renderer?: unknown;
  /**
   * The document's mounted objects. Everything else in the scene (grid, gizmo,
   * this rig's own plane) is skipped by the shadow pass, which matters because
   * the pass renders with an overriding depth material and would otherwise
   * imprint authoring chrome into the shadow.
   */
  contentRoots?: () => readonly THREE.Object3D[];
  /**
   * Whether the mounted content has animation clips. Animated models are not
   * contained by their resting bounding box, so the reference enlarges their
   * shadow volume ({@link ANIMATION_SCALING}) — without it the far plane clips
   * the body and only the feet contribute.
   */
  animated?: () => boolean;
}

export interface ContactShadowRig {
  /** `settings` undefined or `enabled: false` hides the catcher. */
  applyView(settings: ContactShadowDTO | undefined, bounds: THREE.Box3): void;
  /** Mark the shadow texture stale (content or camera changed). */
  invalidate(): void;
  /** Re-render the texture when stale. Call once per frame, before the main render. */
  update(): void;
  dispose(): void;
}

/**
 * Soft ground shadow under the content, ported from model-viewer's `Shadow`.
 *
 * The reference does not project a shadow map along a light direction. It aims
 * an orthographic camera **straight up from the floor**, renders the content
 * with a depth material that turns distance-from-the-floor into alpha, blurs the
 * result with a fixed two-pass kernel, and draws it on a transparent quad. That
 * is why its shadow hugs the model's footprint and fades out instead of
 * stretching away from it — it is a height-weighted occlusion, not a projection.
 * A directional PCF shadow (what this module used to do) reads as a detached
 * smudge next to the feet no matter how much it is softened.
 *
 * The depth material is three's `MeshDepthMaterial` with its output rewritten,
 * exactly as the reference does it, so skinning and morph targets keep working
 * for animated content. Output format: black RGB, alpha = 1 − depth.
 */
export function createContactShadowRig(options: ContactShadowOptions): ContactShadowRig {
  const { scene } = options;
  const gl = options.renderer as
    | (THREE.WebGLRenderer & { isWebGLRenderer?: boolean })
    | null
    | undefined;
  const canRender = gl?.isWebGLRenderer === true;

  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });
  depthMaterial.side = THREE.DoubleSide;
  // Same rewrite as the reference: three packs depth into RGB, we need it in
  // alpha so the blur and the transparent quad can carry the shadow alone.
  depthMaterial.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      /gl_FragColor\s*=\s*vec4\(\s*vec3\(\s*1\.0\s*-\s*fragCoordZ\s*\),\s*opacity\s*\);/,
      "gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * opacity );",
    );
  };

  const horizontalBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
  const verticalBlur = new THREE.ShaderMaterial(VerticalBlurShader);
  // three's example shaders declare their uniforms untyped.
  const hUniforms = horizontalBlur.uniforms as {
    h: { value: number };
    tDiffuse: { value: THREE.Texture | null };
  };
  const vUniforms = verticalBlur.uniforms as {
    v: { value: number };
    tDiffuse: { value: THREE.Texture | null };
  };
  horizontalBlur.depthTest = false;
  verticalBlur.depthTest = false;

  const blurScene = new THREE.Scene();
  const blurCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), horizontalBlur);
  blurQuad.frustumCulled = false;
  blurScene.add(blurQuad);

  /**
   * Sits on the floor looking **up**. The reference does the same: since the
   * material turns distance-from-camera into alpha, a camera below the content
   * makes the feet fully opaque and everything above them fade out. A camera at
   * the model's mid-height looking down inverts that gradient — the feet vanish
   * and the body's mid-section becomes the silhouette, which reads as a halo
   * around the model rather than contact under it.
   *
   * `up` is +Z so the texture's V axis runs along world +Z, matching the
   * catcher's rotated UVs.
   */
  const shadowCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  shadowCamera.up.set(0, 0, 1);

  /**
   * The catcher samples the blurred depth texture through an explicit uniform
   * instead of `MeshBasicMaterial.map`: a basic material's program is compiled
   * before the shadow texture exists (`USE_MAP` off), and a map assigned later is
   * silently ignored — swapping materials around it is fragile. A `ShaderMaterial`
   * just reads the uniform every frame.
   */
  const catcherMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uShadow: { value: null as THREE.Texture | null },
      uOpacity: { value: DEFAULT_OPACITY },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D uShadow;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        // Black, with the blurred depth as alpha: a shadow is pure absorbance.
        gl_FragColor = vec4(0.0, 0.0, 0.0, texture2D(uShadow, vUv).a * uOpacity);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const catcherUniforms = catcherMaterial.uniforms as {
    uShadow: { value: THREE.Texture | null };
    uOpacity: { value: number };
  };
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), catcherMaterial);
  // +90° lays the plane on the floor with its V axis along world +Z — the same
  // orientation as the shadow camera's `up`, so the texture lands unmirrored.
  catcher.rotation.x = Math.PI / 2;
  catcher.visible = false;
  // Draw last: it is transparent and sits at the floor, where content may dip below.
  catcher.renderOrder = 1;
  scene.add(catcher);

  let depthTarget: THREE.WebGLRenderTarget | null = null;
  let blurTarget: THREE.WebGLRenderTarget | null = null;
  let dirty = false;

  const disposeTargets = (): void => {
    depthTarget?.dispose();
    blurTarget?.dispose();
    depthTarget = null;
    blurTarget = null;
  };

  const ensureTargets = (width: number, height: number): void => {
    if (depthTarget && depthTarget.width === width && depthTarget.height === height) return;
    disposeTargets();
    const params = {
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
    } as const;
    depthTarget = new THREE.WebGLRenderTarget(width, height, params);
    blurTarget = new THREE.WebGLRenderTarget(width, height, params);
    catcherUniforms.uShadow.value = depthTarget.texture;
  };

  /** Run one pass over `scene` with everything but the content hidden. */
  const renderDepth = (): void => {
    const roots = new Set<THREE.Object3D>(options.contentRoots?.() ?? []);
    const hidden: THREE.Object3D[] = [];
    for (const child of scene.children) {
      if (!child.visible) continue;
      // The catcher must be hidden too: it is a plane spanning the whole
      // frustum, and at `softness < 1` the camera's `far` reaches past it, so
      // the depth material would give it a uniform alpha over its entire
      // surface. That reads as a soft-edged rectangle of shadow around the
      // model instead of a blob under it.
      if (child === catcher || (roots.size > 0 && !roots.has(child))) {
        hidden.push(child);
        child.visible = false;
      }
    }

    const previousOverride = scene.overrideMaterial;
    const previousTarget = gl!.getRenderTarget();
    const previousClear = gl!.getClearColor(new THREE.Color());
    const previousAlpha = gl!.getClearAlpha();

    scene.overrideMaterial = depthMaterial;
    gl!.setClearColor(0x000000, 0);
    gl!.setRenderTarget(depthTarget!);
    gl!.render(scene, shadowCamera);

    // Separable blur, both passes into the two targets in turn.
    const width = depthTarget!.width;
    const height = depthTarget!.height;
    hUniforms.h.value = 1 / width;
    vUniforms.v.value = 1 / height;

    blurQuad.material = horizontalBlur;
    hUniforms.tDiffuse.value = depthTarget!.texture;
    gl!.setRenderTarget(blurTarget!);
    gl!.render(blurScene, blurCamera);

    blurQuad.material = verticalBlur;
    vUniforms.tDiffuse.value = blurTarget!.texture;
    gl!.setRenderTarget(depthTarget!);
    gl!.render(blurScene, blurCamera);

    gl!.setRenderTarget(previousTarget);
    gl!.setClearColor(previousClear, previousAlpha);
    scene.overrideMaterial = previousOverride;
    for (const child of hidden) child.visible = true;
  };

  return {
    applyView(settings: ContactShadowDTO | undefined, bounds: THREE.Box3): void {
      const enabled = settings?.enabled === true && canRender;
      catcher.visible = enabled;
      if (!enabled) return;

      // Content footprint, with a floor so a flat or empty document still has
      // a sane frustum instead of a zero-sized one.
      const empty = bounds.isEmpty();
      const center = empty ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
      const spanX = Math.max(empty ? 0 : bounds.max.x - bounds.min.x, 1e-3);
      const spanZ = Math.max(empty ? 0 : bounds.max.z - bounds.min.z, 1e-3);
      const spanY = Math.max(empty ? 0 : bounds.max.y - bounds.min.y, 1e-3);

      const softness = Math.min(Math.max(settings?.softness ?? DEFAULT_SOFTNESS, 0), 1);
      // Animated content gets a cubic shadow volume sized to its largest
      // dimension; the texture grows with it, so texel density is unchanged.
      // (The reference scales the map size twice here and ends up twice as
      // dense for animated models; matching that made the shadow measurably
      // heavier than the reference, so this stays at one scale.)
      const scaled = options.animated?.() === true;
      const scale = scaled ? ANIMATION_SCALING : 1;
      const footprintX = scaled ? Math.max(spanX, spanY, spanZ) * scale : spanX;
      const footprintZ = scaled ? Math.max(spanX, spanY, spanZ) * scale : spanZ;
      const resolution = Math.min(
        Math.max(scale * 2 ** (Math.log2(MAX_MAP_SIZE) - softness * (Math.log2(MAX_MAP_SIZE) - Math.log2(MIN_MAP_SIZE))), MIN_MAP_SIZE),
        MAX_MAP_SIZE * scale,
      );
      const wide = footprintX > footprintZ;
      const baseWidth = Math.max(1, Math.floor(wide ? resolution : (resolution * footprintX) / footprintZ));
      const baseHeight = Math.max(1, Math.floor(wide ? (resolution * footprintZ) / footprintX : resolution));
      ensureTargets(baseWidth + TAP_WIDTH, baseHeight + TAP_WIDTH);

      // Frustum covers the footprint plus the blur pad, so the blurred edge is
      // not clipped by the texture border.
      const frustumWidth = footprintX * (1 + TAP_WIDTH / baseWidth);
      const frustumHeight = footprintZ * (1 + TAP_WIDTH / baseHeight);
      const floor = settings?.height ?? (empty ? 0 : bounds.min.y);

      shadowCamera.left = -frustumWidth / 2;
      shadowCamera.right = frustumWidth / 2;
      shadowCamera.top = frustumHeight / 2;
      shadowCamera.bottom = -frustumHeight / 2;
      // On the floor, aimed straight up: alpha becomes "how far above the floor
      // is this fragment", so contact points are opaque and the body fades out.
      shadowCamera.position.set(center.x, floor, center.z);
      shadowCamera.lookAt(center.x, floor + 1, center.z);
      shadowCamera.near = 0;
      // `softness` trades a tall shadow volume (more of the model contributes,
      // a heavier blob) for a shallow one (only contact points, a tight core).
      shadowCamera.far = THREE.MathUtils.lerp(spanY * scale, spanY / 2, softness);
      shadowCamera.updateProjectionMatrix();
      // Scaling the depth into the 0..1 clip range is what `1 / softness` does
      // in the reference: at low softness the same height reads darker.
      depthMaterial.opacity = 1 / Math.max(softness, 0.05);

      catcher.position.set(center.x, floor - FLOOR_GAP * Math.max(spanX, spanY, spanZ), center.z);
      catcher.scale.set(frustumWidth, frustumHeight, 1);
      // Hard shadows get a lower ceiling so they do not read heavier than the
      // soft ones, which lose density to blur and height falloff.
      catcherUniforms.uOpacity.value =
        (settings?.opacity ?? DEFAULT_OPACITY) *
        THREE.MathUtils.lerp(HARD_SHADOW_INTENSITY, 1, softness * softness);

      dirty = true;
    },
    invalidate(): void {
      dirty = true;
    },
    update(): void {
      if (!dirty || !catcher.visible || !depthTarget || !blurTarget) return;
      dirty = false;
      renderDepth();
    },
    dispose(): void {
      scene.remove(catcher);
      disposeTargets();
      catcher.geometry.dispose();
      catcherMaterial.dispose();
      depthMaterial.dispose();
      horizontalBlur.dispose();
      verticalBlur.dispose();
      blurQuad.geometry.dispose();
    },
  };
}
