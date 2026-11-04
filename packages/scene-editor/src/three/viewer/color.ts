import type * as THREE from "three";

/** `#rrggbb` for a three color — ViewState stores hex only (D22). */
export function toHex(color: THREE.Color): string {
  return `#${color.getHexString()}`;
}
