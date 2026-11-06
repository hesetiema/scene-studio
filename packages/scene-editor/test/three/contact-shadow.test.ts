import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createContactShadowRig } from "../../src/three/viewer/contact-shadow";

function makeFakeRenderer() {
  return { shadowMap: { enabled: false, type: THREE.BasicShadowMap } };
}

function makeRig(renderer: unknown = makeFakeRenderer()) {
  const scene = new THREE.Scene();
  const rig = createContactShadowRig({ scene, renderer });
  return { scene, rig };
}

/** The catch plane is the only mesh the rig adds to the scene. */
function planeOf(scene: THREE.Scene): THREE.Mesh {
  const plane = scene.children.find((child) => (child as THREE.Mesh).isMesh === true);
  if (!plane) throw new Error("contact-shadow plane was not added");
  return plane as THREE.Mesh;
}

/** The rig owns a shadow-only directional light (intensity 0, never in the view). */
function lightOf(scene: THREE.Scene): THREE.DirectionalLight {
  const light = scene.children.find(
    (child) => (child as THREE.DirectionalLight).isDirectionalLight === true,
  );
  if (!light) throw new Error("contact-shadow light was not added");
  return light as THREE.DirectionalLight;
}

function unitBox(): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
}

describe("contact shadow rig", () => {
  it("stays hidden until a view enables it", () => {
    const { scene, rig } = makeRig();

    const plane = planeOf(scene);
    expect(plane.visible).toBe(false);

    rig.applyView(undefined, unitBox());
    expect(plane.visible).toBe(false);
    expect(lightOf(scene).castShadow).toBe(false);

    rig.applyView({ enabled: false }, unitBox());
    expect(plane.visible).toBe(false);
  });


  it("sits on the content floor and covers the footprint", () => {
    const { scene, rig } = makeRig();
    rig.applyView({ enabled: true }, unitBox());

    const plane = planeOf(scene);
    expect(plane.visible).toBe(true);
    expect(plane.receiveShadow).toBe(true);
    expect(plane.rotation.x).toBeCloseTo(-Math.PI / 2);
    expect(plane.position.y).toBeCloseTo(0);
    expect(plane.scale.x).toBeCloseTo(1.6);
    expect(plane.scale.y).toBeCloseTo(1.6);
  });

  it("centres the plane horizontally on the content", () => {
    const { scene, rig } = makeRig();
    const bounds = new THREE.Box3(
      new THREE.Vector3(4, 2, -1),
      new THREE.Vector3(6, 4, 1),
    );
    rig.applyView({ enabled: true }, bounds);

    const plane = planeOf(scene);
    expect(plane.position.x).toBeCloseTo(5);
    expect(plane.position.z).toBeCloseTo(0);
    expect(plane.position.y).toBeCloseTo(2);
    // 2 units of span → 2 * 1.6, not the 1-unit minimum.
    expect(plane.scale.x).toBeCloseTo(3.2);
  });

  it("honours the opacity and height overrides", () => {
    const { scene, rig } = makeRig();
    const plane = planeOf(scene);
    const material = plane.material as THREE.ShadowMaterial;

    rig.applyView({ enabled: true }, unitBox());
    expect(material.opacity).toBeCloseTo(0.35);

    rig.applyView({ enabled: true, opacity: 0.8, height: -2 }, unitBox());
    expect(material.opacity).toBeCloseTo(0.8);
    expect(plane.position.y).toBeCloseTo(-2);
  });

  it("fits the shadow camera to the content", () => {
    const { scene, rig } = makeRig();
    rig.applyView({ enabled: true }, unitBox());

    const light = lightOf(scene);
    expect(light.castShadow).toBe(true);
    const camera = light.shadow.camera;
    // The half-extent never drops below 1, so a tiny model keeps usable map density.
    expect(camera.right).toBeCloseTo(1);
    expect(camera.left).toBeCloseTo(-1);
    expect(camera.far).toBeGreaterThan(camera.near);
  });

  it("enables soft shadow mapping on the renderer", () => {
    const renderer = makeFakeRenderer();
    const { rig } = makeRig(renderer);
    rig.applyView({ enabled: true }, unitBox());

    expect(renderer.shadowMap.enabled).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap);
  });

  it("survives a renderer without a shadow map (headless stub)", () => {
    const { rig } = makeRig(undefined);
    expect(() => rig.applyView({ enabled: true }, unitBox())).not.toThrow();
  });

  it("removes its plane and light on dispose", () => {
    const { scene, rig } = makeRig();
    rig.applyView({ enabled: true }, unitBox());
    expect(scene.children.some((child) => (child as THREE.Mesh).isMesh === true)).toBe(true);

    rig.dispose();
    expect(scene.children.some((child) => (child as THREE.Mesh).isMesh === true)).toBe(false);
    expect(
      scene.children.some((child) => (child as THREE.DirectionalLight).isDirectionalLight === true),
    ).toBe(false);
  });

  it("casts from the direction it is told, without lighting the scene", () => {
    const { scene, rig } = makeRig();
    rig.applyView({ enabled: true }, unitBox());

    rig.setLightDirection([0, 2, 0]);
    const light = lightOf(scene);
    // Only the orientation matters for a directional light; length is arbitrary.
    expect(light.position.x).toBeCloseTo(0);
    expect(light.position.y).toBeGreaterThan(0);
    expect(light.position.z).toBeCloseTo(0);
    // Shadow-only: it must not add a second key light on top of the IBL.
    expect(light.intensity).toBe(0);

    rig.applyView({ enabled: true }, new THREE.Box3(
      new THREE.Vector3(-10, 0, -10),
      new THREE.Vector3(10, 4, 10),
    ));
    // A bigger scene pushes the light back, so the shadow camera still sees it.
    expect(light.position.y).toBeGreaterThan(10);
  });

  it("ignores a degenerate light direction", () => {
    const { scene, rig } = makeRig();
    rig.setLightDirection([1, 1, 1]);
    const before = lightOf(scene).position.clone();

    rig.setLightDirection([0, 0, 0]);
    expect(lightOf(scene).position.equals(before)).toBe(true);
  });
});
