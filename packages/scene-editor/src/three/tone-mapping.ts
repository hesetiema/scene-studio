import * as THREE from "three";
import type { ToneMappingMode } from "../runtime/runtime-contract";

/**
 * Display mode → three constant. Kept in `three/` so the core stays three-free,
 * and in its own module because both the assembly (initial renderer setup) and
 * the runtime (`setToneMapping`) need it — a value import between those two
 * would close a real cycle.
 */
export const TONE_MAPPINGS: Record<ToneMappingMode, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  linear: THREE.LinearToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};
