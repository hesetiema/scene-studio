import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createContactShadowRig } from "../../src/three/viewer/contact-shadow";

interface FakeGl {
  isWebGLRenderer: true;
  renderTarget: unknown;
  renders: Array<{ target: unknown; camera: THREE.Camera }>;
  /** Size of the render target last bound (the shadow texture). */
  lastSize: { width: number; height: number } | null;
  clears: Array<{ color: string; alpha: number }>;
  /** Runs at the start of every `render`, while the pass is still set up. */
  onRender: (() => void) | null;
  setRenderTarget(target: unknown): void;
  getRenderTarget(): unknown;
  render(scene: unknown, camera: THREE.Camera): void;
  setClearColor(color: string | number, alpha?: number): void;
  getClearColor(target: THREE.Color): THREE.Color;
  getClearAlpha(): number;
}

function makeFakeRenderer(): FakeGl {
  const fake: FakeGl = {
    isWebGLRenderer: true,
    renderTarget: null,
    renders: [],
    clears: [],
    lastSize: null,
    onRender: null,
    setRenderTarget(target) {
      fake.renderTarget = target;
      if (target) {
        const { width, height } = target as { width: number; height: number };
        fake.lastSize = { width, height };
      }
    },
    getRenderTarget() {
      return fake.renderTarget;
    },
    render(_scene, camera) {
      fake.renders.push({ target: fake.renderTarget, camera });
      fake.onRender?.();
    },
    setClearColor(color, alpha = 1) {
      fake.clears.push({ color: String(color), alpha });
    },
    getClearColor(target) {
      return target.setRGB(0.1, 0.1, 0.1);
    },
    getClearAlpha() {
      return 1;
    },
  };
  return fake;
}

function makeRig(options: { renderer?: unknown; content?: THREE.Object3D[]; animated?: boolean } = {}) {
  const scene = new THREE.Scene();
  const renderer = options.renderer ?? makeFakeRenderer();
  const rig = createContactShadowRig({
    scene,
    renderer,
    ...(options.content ? { contentRoots: () => options.content! } : {}),
    ...(options.animated === undefined ? {} : { animated: () => options.animated! }),
  });
  return { scene, rig, renderer: renderer as FakeGl };
}

/** The catcher is the only mesh the rig adds to the scene. */
function catcherOf(scene: THREE.Scene): THREE.Mesh {
  const catcher = scene.children.find((child) => (child as THREE.Mesh).isMesh === true);
  if (!catcher) throw new Error("contact-shadow catcher was not added");
  return catcher as THREE.Mesh;
}

function catcherUniforms(scene: THREE.Scene): {
  uShadow: { value: THREE.Texture | null };
  uOpacity: { value: number };
} {
  return (catcherOf(scene).material as THREE.ShaderMaterial).uniforms as {
    uShadow: { value: THREE.Texture | null };
    uOpacity: { value: number };
  };
}

/** The shadow camera is the only camera the rig renders with. */
function shadowCameraOf(renderer: FakeGl): THREE.OrthographicCamera {
  const camera = renderer.renders[0]?.camera;
  if (!camera) throw new Error("no shadow pass was rendered");
  return camera as THREE.OrthographicCamera;
}

function unitBox(): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
}

describe("contact shadow rig", () => {
  it("stays hidden until a view enables it", () => {
    const { scene, rig } = makeRig();
    const catcher = catcherOf(scene);
    expect(catcher.visible).toBe(false);

    rig.applyView(undefined, unitBox());
    expect(catcher.visible).toBe(false);

    rig.applyView({ enabled: false }, unitBox());
    expect(catcher.visible).toBe(false);
  });

  it("stays inert without a WebGL renderer (headless stub)", () => {
    const { scene, rig } = makeRig({ renderer: { shadowMap: {} } });
    rig.applyView({ enabled: true, opacity: 1 }, unitBox());
    expect(catcherOf(scene).visible).toBe(false);
    expect(() => rig.update()).not.toThrow();
  });

  it("lays the catcher on the content floor, spanning the footprint", () => {
    const { scene, rig } = makeRig();
    rig.applyView({ enabled: true }, unitBox());

    const catcher = catcherOf(scene);
    expect(catcher.visible).toBe(true);
    // +90° puts the plane's V axis along world +Z, matching the shadow camera's
    // `up` so the texture is not mirrored.
    expect(catcher.rotation.x).toBeCloseTo(Math.PI / 2);
    expect(catcher.position.y).toBeCloseTo(0);
    // Footprint plus the blur pad, so the blurred edge is not clipped.
    expect(catcher.scale.x).toBeGreaterThan(1);
    expect(catcher.scale.x).toBeLessThan(1.3);
    expect(catcher.scale.y).toBeCloseTo(catcher.scale.x);
  });

  it("centres the catcher on the content and honours height/opacity", () => {
    const { scene, rig } = makeRig();
    const bounds = new THREE.Box3(new THREE.Vector3(4, 2, -1), new THREE.Vector3(6, 4, 1));
    rig.applyView({ enabled: true, opacity: 0.6, height: -3 }, bounds);

    const catcher = catcherOf(scene);
    expect(catcher.position.x).toBeCloseTo(5);
    expect(catcher.position.z).toBeCloseTo(0);
    expect(catcher.position.y).toBeCloseTo(-3);
    expect(catcherUniforms(scene).uOpacity.value).toBeCloseTo(0.6);
  });

  it("stands the shadow camera on the floor, aimed up at the content", () => {
    const { rig, renderer } = makeRig();
    // Mid-height is 0.5; the camera must not sit there.
    rig.applyView({ enabled: true, softness: 0.5 }, unitBox());
    rig.update();

    const camera = shadowCameraOf(renderer);
    expect(camera.position.y).toBeCloseTo(0);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(forward.y).toBeCloseTo(1);
    expect(forward.x).toBeCloseTo(0);
    expect(forward.z).toBeCloseTo(0);
  });

  it("trades shadow depth for softness through the far plane", () => {
    const crisp = makeRig();
    crisp.rig.applyView({ enabled: true, softness: 0 }, unitBox());
    crisp.rig.update();

    const soft = makeRig();
    soft.rig.applyView({ enabled: true, softness: 1 }, unitBox());
    soft.rig.update();

    // A crisp shadow reaches the whole model height; a soft one only sees the
    // band just above the floor, which is what makes it hug the feet.
    expect(shadowCameraOf(crisp.renderer).far).toBeCloseTo(1);
    expect(shadowCameraOf(soft.renderer).far).toBeCloseTo(0.5);
  });

  it("gives animated content a larger shadow volume", () => {
    const still = makeRig({ animated: false });
    still.rig.applyView({ enabled: true, softness: 0 }, unitBox());
    still.rig.update();

    const animated = makeRig({ animated: true });
    animated.rig.applyView({ enabled: true, softness: 0 }, unitBox());
    animated.rig.update();

    // Twice the footprint and twice the far plane: an animated model leaves its
    // resting bounds, so a box fitted to them would clip the body. (The frustum
    // ratio is a hair under 2 because the blur pad is a fixed pixel count, so it
    // is proportionally smaller in the larger texture.)
    const ratio = catcherOf(animated.scene).scale.x / catcherOf(still.scene).scale.x;
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2);
    expect(shadowCameraOf(animated.renderer).far).toBeCloseTo(2);
  });

  it("eases the catcher down for hard shadows", () => {
    const hard = makeRig();
    hard.rig.applyView({ enabled: true, opacity: 1, softness: 0 }, unitBox());
    expect(catcherUniforms(hard.scene).uOpacity.value).toBeCloseTo(0.3);

    const soft = makeRig();
    soft.rig.applyView({ enabled: true, opacity: 1, softness: 1 }, unitBox());
    expect(catcherUniforms(soft.scene).uOpacity.value).toBeCloseTo(1);
  });

  it("samples a blurred depth texture instead of a shadow map", () => {
    const { scene, rig, renderer } = makeRig();
    rig.applyView({ enabled: true }, unitBox());
    rig.update();

    // Depth pass + horizontal blur + vertical blur.
    expect(renderer.renders).toHaveLength(3);
    const uniforms = catcherUniforms(scene);
    expect(uniforms.uShadow.value).toBeInstanceOf(THREE.Texture);
    expect((catcherOf(scene).material as THREE.Material).transparent).toBe(true);
  });

  it("renders with an overriding depth material and hides scene furniture", () => {
    const content = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const grid = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const scene = new THREE.Scene();
    scene.add(content, grid);
    const renderer = makeFakeRenderer();
    const rig = createContactShadowRig({
      scene,
      renderer,
      contentRoots: () => [content],
    });

    rig.applyView({ enabled: true }, unitBox());
    rig.update();

    // The grid is hidden for the pass and restored afterwards.
    expect(grid.visible).toBe(true);
    expect(content.visible).toBe(true);
    expect(scene.overrideMaterial).toBeNull();
  });

  it("keeps its own catcher out of the depth pass", () => {
    const { scene, rig, renderer } = makeRig();
    const catcher = catcherOf(scene);
    const seen: boolean[] = [];
    renderer.onRender = () => seen.push(catcher.visible);

    rig.applyView({ enabled: true, softness: 0.6 }, unitBox());
    rig.update();

    // A plane spanning the whole frustum would otherwise be painted by the
    // override depth material and read as a rectangle of shadow around the model.
    expect(seen).toEqual([false, false, false]);
    expect(catcher.visible).toBe(true);
  });

  it("restores the renderer's target and clear colour after the pass", () => {
    const { rig, renderer } = makeRig();
    const previous = { name: "previous-target" };
    renderer.setRenderTarget(previous);

    rig.applyView({ enabled: true }, unitBox());
    rig.update();

    expect(renderer.renderTarget).toBe(previous);
    // One transparent clear for the shadow pass, then the original restored.
    expect(renderer.clears[0]).toEqual({ color: "0", alpha: 0 });
    expect(renderer.clears.at(-1)?.alpha).toBe(1);
  });

  it("only re-renders when invalidated", () => {
    const { rig, renderer } = makeRig();
    rig.applyView({ enabled: true }, unitBox());
    rig.update();
    expect(renderer.renders).toHaveLength(3);

    rig.update();
    expect(renderer.renders).toHaveLength(3);

    rig.invalidate();
    rig.update();
    expect(renderer.renders).toHaveLength(6);
  });

  it("spends texture resolution on softness", () => {
    const { rig, renderer } = makeRig();

    rig.applyView({ enabled: true, softness: 0 }, unitBox());
    rig.update();
    const crispWidth = renderer.lastSize?.width ?? 0;

    rig.applyView({ enabled: true, softness: 1 }, unitBox());
    rig.update();

    // A crisp shadow needs detail; a soft one is a blurred blob, so the texture
    // shrinks instead of paying for pixels the blur would destroy.
    expect(crispWidth).toBeGreaterThan(500);
    expect(renderer.lastSize?.width).toBeGreaterThan(60);
    expect(renderer.lastSize?.width).toBeLessThan(crispWidth / 4);
  });

  it("removes its catcher and releases targets on dispose", () => {
    const { scene, rig } = makeRig();
    rig.applyView({ enabled: true }, unitBox());
    rig.update();
    expect(scene.children.some((child) => (child as THREE.Mesh).isMesh === true)).toBe(true);

    rig.dispose();
    expect(scene.children.some((child) => (child as THREE.Mesh).isMesh === true)).toBe(false);
    expect(() => rig.update()).not.toThrow();
  });
});
