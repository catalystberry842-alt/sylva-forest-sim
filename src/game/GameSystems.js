import * as THREE from 'three';
import { WATER_LEVEL } from '../world/Terrain.js';
import { STRUCTURE_SITES } from '../world/WalkableStructures.js';
import { clamp, lerp } from '../utils/random.js';

const STYLE_ELEMENT_ID = 'sylva-game-systems-styles';
const COMPASS_ROOT_ID = 'sylva-compass-hud';
const TOAST_ROOT_ID = 'sylva-relic-toast';

const PICKUP_RADIUS = 1.95;
const PICKUP_RADIUS_SQ = PICKUP_RADIUS * PICKUP_RADIUS;
const RELIC_LIGHT_DISTANCE = 8.5;
const RELIC_COLLECT_ANIM_DURATION = 0.44;
const TOAST_DURATION_SEC = 4.0;

const MAX_PARTICLES = 384;
const COMPASS_PX_PER_DEG = 1.75;
const COMPASS_DEFAULT_VIEW_WIDTH = 296;
const COMPASS_HALF_FOV_DEG = 86;

const CARDINAL_LABELS = [
  { deg: 0, text: 'N', major: true },
  { deg: 45, text: 'NE', major: false },
  { deg: 90, text: 'E', major: true },
  { deg: 135, text: 'SE', major: false },
  { deg: 180, text: 'S', major: true },
  { deg: 225, text: 'SW', major: false },
  { deg: 270, text: 'W', major: true },
  { deg: 315, text: 'NW', major: false },
];

function wrapPi(angle) {
  let a = (angle + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

function wrapDeg360(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

function toVec3(v, target = new THREE.Vector3()) {
  if (!v) return null;
  const x = v.x;
  const y = v.y;
  const z = v.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return target.set(x, y, z);
}

/**
 * Procedural soft radial halo texture (DataTexture, 100% headless-Node safe).
 */
function createRadialGlowTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ny = (y / (size - 1)) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      const r = Math.hypot(nx, ny);
      const falloff = Math.pow(clamp(1.0 - r, 0, 1), 2.35);
      const core = Math.pow(clamp(1.0 - r * 1.9, 0, 1), 1.6);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = Math.round(lerp(215, 255, core));
      data[idx + 2] = Math.round(lerp(130, 245, core));
      data[idx + 3] = Math.round(clamp(falloff * 0.9 + core * 0.35, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds an elongated hexagonal double-pointed crystal monolith BufferGeometry
 * with crisp facets so each ancient relic catches warm/cyan highlights cleanly.
 */
function createCrystalMonolithGeometry() {
  const radialSegs = 6;
  const ringRadii = [0.0, 0.145, 0.21, 0.175, 0.0];
  const ringHeights = [-0.34, -0.17, 0.02, 0.21, 0.42];
  const positions = [];
  const indices = [];

  for (let r = 0; r < ringHeights.length; r++) {
    const rad = ringRadii[r];
    const y = ringHeights[r];
    const twist = r === 2 ? 0.08 : r === 3 ? -0.04 : 0;
    for (let s = 0; s < radialSegs; s++) {
      const a = (s / radialSegs) * Math.PI * 2 + twist;
      positions.push(Math.cos(a) * rad, y, Math.sin(a) * rad);
    }
  }

  for (let r = 0; r < ringHeights.length - 1; r++) {
    for (let s = 0; s < radialSegs; s++) {
      const next = (s + 1) % radialSegs;
      const a = r * radialSegs + s;
      const b = r * radialSegs + next;
      const c = (r + 1) * radialSegs + next;
      const d = (r + 1) * radialSegs + s;
      indices.push(a, b, c, a, c, d);
    }
  }

  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  indexed.setIndex(indices);
  const faceted = indexed.toNonIndexed();
  indexed.dispose();
  faceted.computeVertexNormals();
  return faceted;
}

const COMPASS_CSS = /* css */ `
.gs-compass-wrap {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 14;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  font-family: var(--font-sans, 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
}

.gs-compass-bar {
  position: relative;
  width: 312px;
  height: 34px;
  border-radius: 999px;
  background: rgba(15, 20, 17, 0.64);
  border: 1px solid rgba(214, 224, 212, 0.16);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.28),
    inset 0 1px 0 rgba(242, 245, 238, 0.08);
  overflow: hidden;
  display: flex;
  align-items: center;
}

.gs-compass-bar::before,
.gs-compass-bar::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 44px;
  z-index: 4;
  pointer-events: none;
}

.gs-compass-bar::before {
  left: 0;
  background: linear-gradient(90deg, rgba(15, 20, 17, 0.92), rgba(15, 20, 17, 0));
}

.gs-compass-bar::after {
  right: 0;
  background: linear-gradient(270deg, rgba(15, 20, 17, 0.92), rgba(15, 20, 17, 0));
}

.gs-compass-caret {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 4.5px solid transparent;
  border-right: 4.5px solid transparent;
  border-top: 6px solid #e2a452;
  z-index: 5;
  filter: drop-shadow(0 0 4px rgba(226, 164, 82, 0.6));
}

.gs-compass-center-line {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 1px;
  height: 6px;
  background: rgba(226, 164, 82, 0.72);
  z-index: 5;
}

.gs-compass-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.gs-compass-tape {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  will-change: transform;
}

.gs-compass-tick {
  position: absolute;
  bottom: 4px;
  width: 1px;
  height: 5px;
  background: rgba(214, 224, 212, 0.24);
  transform: translateX(-50%);
}

.gs-compass-tick.is-minor {
  height: 7px;
  background: rgba(142, 182, 126, 0.42);
}

.gs-compass-cardinal {
  position: absolute;
  top: 6px;
  transform: translateX(-50%);
  font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: rgba(206, 216, 202, 0.7);
  line-height: 1;
}

.gs-compass-cardinal.is-major {
  font-size: 10.5px;
  font-weight: 700;
  color: rgba(242, 245, 238, 0.94);
}

.gs-compass-cardinal.is-north {
  color: #e2a452;
  text-shadow: 0 0 8px rgba(226, 164, 82, 0.45);
}

.gs-compass-markers {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
}

.gs-relic-marker {
  position: absolute;
  top: 23px;
  left: 50%;
  width: 7.5px;
  height: 7.5px;
  margin-left: -3.75px;
  border-radius: 1.5px;
  background: linear-gradient(135deg, #fff1ba 0%, #e2a452 55%, #b87424 100%);
  border: 1px solid rgba(255, 246, 212, 0.88);
  box-shadow: 0 0 9px rgba(226, 164, 82, 0.85);
  will-change: transform, opacity;
  opacity: 0;
  transition: opacity 120ms linear;
}

.gs-relic-marker.is-aquatic {
  background: linear-gradient(135deg, #d8feff 0%, #4ce8f8 58%, #1e94b8 100%);
  border-color: rgba(215, 254, 255, 0.92);
  box-shadow: 0 0 10px rgba(76, 232, 248, 0.85);
}

.gs-relic-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 11px;
  border-radius: 999px;
  background: rgba(15, 20, 17, 0.68);
  border: 1px solid rgba(226, 164, 82, 0.28);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.26);
  color: rgba(242, 245, 238, 0.92);
  font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  transition: border-color 240ms ease, background 240ms ease, transform 220ms ease, box-shadow 240ms ease;
}

.gs-relic-pill-gem {
  width: 8px;
  height: 8px;
  transform: rotate(45deg);
  border-radius: 1px;
  background: linear-gradient(135deg, #ffe8a3, #e2a452);
  box-shadow: 0 0 7px rgba(226, 164, 82, 0.72);
  flex-shrink: 0;
}

.gs-relic-pill.is-pulse {
  transform: scale(1.08);
  border-color: rgba(226, 164, 82, 0.85);
  box-shadow: 0 0 18px rgba(226, 164, 82, 0.42);
}

.gs-relic-pill.is-complete {
  background: rgba(24, 38, 26, 0.82);
  border-color: rgba(142, 182, 126, 0.72);
  color: #f6dca0;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.3),
    0 0 16px rgba(226, 164, 82, 0.3);
}

/* Celebratory Relic Discovery Toast Banner */
.gs-toast {
  position: fixed;
  top: 86px;
  left: 50%;
  transform: translateX(-50%) translateY(-10px) scale(0.96);
  z-index: 16;
  pointer-events: none;
  user-select: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 9px 18px;
  border-radius: 12px;
  background: rgba(15, 20, 17, 0.84);
  border: 1px solid rgba(226, 164, 82, 0.62);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.42),
    0 0 24px rgba(226, 164, 82, 0.24),
    inset 0 1px 0 rgba(255, 236, 184, 0.16);
  opacity: 0;
  transition: opacity 280ms ease, transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
  text-align: center;
  max-width: min(360px, calc(100vw - 36px));
}

.gs-toast.is-visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0px) scale(1);
}

.gs-toast.is-complete {
  border-color: rgba(142, 182, 126, 0.85);
  background: rgba(18, 28, 21, 0.9);
  box-shadow:
    0 14px 36px rgba(0, 0, 0, 0.46),
    0 0 32px rgba(226, 164, 82, 0.36),
    inset 0 1px 0 rgba(255, 240, 192, 0.24);
}

.gs-toast-title {
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #f8d88d;
  text-shadow: 0 1px 6px rgba(226, 164, 82, 0.32);
}

.gs-toast-sub {
  font-size: 11px;
  font-weight: 500;
  color: rgba(214, 224, 212, 0.86);
  letter-spacing: 0.02em;
}

@media (max-width: 880px) {
  .gs-compass-wrap {
    top: 12px;
    gap: 4px;
  }

  .gs-compass-bar {
    width: min(232px, calc(100vw - 356px));
    min-width: 170px;
    height: 29px;
  }

  .gs-compass-cardinal {
    top: 5px;
    font-size: 8.5px;
  }

  .gs-compass-cardinal.is-major {
    font-size: 9.5px;
  }

  .gs-relic-marker {
    top: 20px;
    width: 6.5px;
    height: 6.5px;
    margin-left: -3.25px;
  }

  .gs-relic-pill {
    padding: 2px 9px;
    font-size: 9.5px;
  }

  .gs-toast {
    top: 74px;
    padding: 7px 14px;
  }
}

@media (max-width: 640px) {
  .gs-compass-wrap {
    top: 66px;
  }

  .gs-compass-bar {
    width: min(244px, calc(100vw - 32px));
  }

  .gs-toast {
    top: 128px;
  }
}
`;

/**
 * RPG Forest Relics, Golden Celebration Particle Bursts, and Top-Center
 * Dynamic Compass Bar HUD for Sylva.
 */
export class GameSystems {
  constructor(scene, terrain, surfaceSolver, structures, audio) {
    this.scene = scene || null;
    this.terrain = terrain || null;
    this.surfaceSolver = surfaceSolver || null;
    this.structures = structures || null;
    this.audio = audio || null;

    this.group = new THREE.Group();
    this.group.name = 'GameSystems';

    this._geometries = [];
    this._materials = [];
    this._textures = [];
    this._lights = [];

    this._relics = [];
    this._collectedCount = 0;

    // Live camera look azimuth (radians & degrees, 0 = North (-Z), +90 = East (+X))
    this.cameraAzimuthRad = 0;
    this.cameraAzimuthDeg = 0;

    // Toast notification timer state
    this._toastTimer = 0;
    this.lastToastMessage = '';
    this._pillPulseTimer = 0;

    // DOM handles
    this._compassWrap = null;
    this._tapeViewport = null;
    this._tapeTrack = null;
    this._markersLayer = null;
    this._relicPill = null;
    this._relicCountEl = null;
    this._toastEl = null;
    this._toastTitleEl = null;
    this._toastSubEl = null;
    this._relicMarkerEls = new Map();

    // Scratch vectors to avoid per-frame allocations
    this._scratchPlayerPos = new THREE.Vector3();
    this._scratchBurstPos = new THREE.Vector3();

    this._disposed = false;

    // Shared geometries & halo texture
    this._glowTex = this._trackTex(createRadialGlowTexture(64));
    this._crystalGeo = this._trackGeo(createCrystalMonolithGeometry());
    this._collarGeo = this._trackGeo(new THREE.CylinderGeometry(0.18, 0.18, 0.055, 6));
    this._ringGeo = this._trackGeo(new THREE.TorusGeometry(0.42, 0.017, 10, 36));
    this._outerRingGeo = this._trackGeo(new THREE.TorusGeometry(0.54, 0.008, 8, 32));
    this._runePipGeo = this._trackGeo(new THREE.OctahedronGeometry(0.032, 0));
    this._moteGeo = this._trackGeo(new THREE.OctahedronGeometry(0.026, 0));
    this._haloPlaneGeo = this._trackGeo(new THREE.PlaneGeometry(1.18, 1.18));

    // Build all 7 ancient relics + reusable golden particle burst pool
    this._buildRelics();
    this._buildParticleBurstSystem();

    if (this.scene) {
      this.scene.add(this.group);
    }

    // Build translucent forest-glass RPG Compass HUD & discovery toast
    this._injectStyles();
    this._buildCompassHud();
  }

  _trackGeo(geo) {
    this._geometries.push(geo);
    return geo;
  }

  _trackMat(mat) {
    this._materials.push(mat);
    return mat;
  }

  _trackTex(tex) {
    this._textures.push(tex);
    return tex;
  }

  // ---------------------------------------------------------------------------
  // 1. 7 Ancient Forest Relics Placement & 3D Construction
  // ---------------------------------------------------------------------------

  _resolveRelicDefinitions() {
    const wp = this.structures?.waypoints || {};
    const waterLevel = this.terrain?.waterLevel ?? WATER_LEVEL;
    const sampleGroundY = (x, z, fallback = 0) =>
      typeof this.terrain?.getHeightAt === 'function' ? this.terrain.getHeightAt(x, z) : fallback;

    // 1. Inside Rustic Timber Ranger Cabin (beside the stone hearth)
    const cabinWp = wp.cabinInterior;
    const cabinYaw = cabinWp?.yaw ?? STRUCTURE_SITES.cabin.yaw;
    const cabinBaseX = cabinWp?.x ?? STRUCTURE_SITES.cabin.x;
    const cabinBaseY = cabinWp?.y ?? STRUCTURE_SITES.cabin.floorY;
    const cabinBaseZ = cabinWp?.z ?? STRUCTURE_SITES.cabin.z;
    // Local (+0.32, -1.32) shifts cleanly from cabinInterior right in front of the stone hearth
    const cabinCos = Math.cos(cabinYaw);
    const cabinSin = Math.sin(cabinYaw);
    const cabinX = cabinBaseX + 0.32 * cabinCos + -1.32 * cabinSin;
    const cabinZ = cabinBaseZ - 0.32 * cabinSin + -1.32 * cabinCos;
    const cabinY = cabinBaseY + 0.85;

    // 2. Inside Walk-In Hollow Giant Ancient Redwood (right in the dappled sunbeam)
    const redwoodWp = wp.redwoodInterior;
    const redwoodX = redwoodWp?.x ?? STRUCTURE_SITES.redwood.x;
    const redwoodZ = redwoodWp?.z ?? STRUCTURE_SITES.redwood.z;
    const redwoodFloorY = redwoodWp?.y ?? sampleGroundY(redwoodX, redwoodZ, 7.8);
    const redwoodY = redwoodFloorY + 0.95;

    // 3. Deep inside Walk-In Mossy Stone Cavern (deeper into the vaulted crystal apse)
    const cavernWp = wp.cavernInterior;
    const cavernYaw = cavernWp?.yaw ?? STRUCTURE_SITES.cavern.yaw;
    const cavernBaseX = cavernWp?.x ?? STRUCTURE_SITES.cavern.x;
    const cavernBaseY = cavernWp?.y ?? STRUCTURE_SITES.cavern.floorY;
    const cavernBaseZ = cavernWp?.z ?? STRUCTURE_SITES.cavern.z;
    // Local -Z leads deeper into the chamber (-1.45m behind cavernInterior)
    const cavernX = cavernBaseX - Math.sin(cavernYaw) * 1.45;
    const cavernZ = cavernBaseZ - Math.cos(cavernYaw) * 1.45;
    const cavernY = cavernBaseY + 0.95;

    // 4. Tucked underneath the Arched Wooden Footbridge (wade beneath the arch!)
    const bridgeWp = wp.bridgeCenter;
    const bridgeZ = bridgeWp?.z ?? STRUCTURE_SITES.bridge.z;
    const bridgeX =
      bridgeWp?.x ??
      (typeof this.terrain?.getStreamCenterX === 'function'
        ? this.terrain.getStreamCenterX(bridgeZ)
        : -2.47);
    const bridgeY = waterLevel + 0.45;

    // 5. Submerged underwater near the floor of the Deep Swimming Lagoon (z = 29.0)
    const lagoonZ = 29.0;
    const lagoonX =
      typeof this.terrain?.getStreamCenterX === 'function'
        ? this.terrain.getStreamCenterX(lagoonZ)
        : 2.4;
    const lagoonY = sampleGroundY(lagoonX, lagoonZ, -3.2) + 0.65;

    // 6. Sunlit Birch Glade north of the clearing (5.5, -14.5)
    const birchX = 5.5;
    const birchZ = -14.5;
    const birchY = sampleGroundY(birchX, birchZ, 3.28) + 0.95;

    // 7. Whispering Ridge overlook across the bridge (-16.5, -3.5)
    const ridgeX = -16.5;
    const ridgeZ = -3.5;
    const ridgeY = sampleGroundY(ridgeX, ridgeZ, 0.27) + 0.95;

    return [
      {
        id: 'cabin_hearth',
        name: 'Hearthstone Relic',
        position: new THREE.Vector3(cabinX, cabinY, cabinZ),
        crystalColor: 0xffce6e,
        emissiveColor: 0xff8d24,
        ringColor: 0xf4c766,
        lightColor: 0xffaa44,
        aquatic: false,
      },
      {
        id: 'hollow_redwood',
        name: 'Heartwood Relic',
        position: new THREE.Vector3(redwoodX, redwoodY, redwoodZ),
        crystalColor: 0xffe282,
        emissiveColor: 0xe69f28,
        ringColor: 0xf5cc6c,
        lightColor: 0xffbe52,
        aquatic: false,
      },
      {
        id: 'mossy_cavern',
        name: 'Cavern Crystal Relic',
        position: new THREE.Vector3(cavernX, cavernY, cavernZ),
        crystalColor: 0x6af6ff,
        emissiveColor: 0x1cd8f0,
        ringColor: 0xf4c968,
        lightColor: 0x4ce6ff,
        aquatic: true,
      },
      {
        id: 'under_bridge',
        name: 'Brookstone Relic',
        position: new THREE.Vector3(bridgeX, bridgeY, bridgeZ),
        crystalColor: 0x72fae4,
        emissiveColor: 0x20d4bc,
        ringColor: 0xf2c664,
        lightColor: 0x52ebd6,
        aquatic: true,
      },
      {
        id: 'deep_lagoon',
        name: 'Abyssal Lagoon Relic',
        position: new THREE.Vector3(lagoonX, lagoonY, lagoonZ),
        crystalColor: 0x58eeff,
        emissiveColor: 0x16c8ff,
        ringColor: 0xf6cf70,
        lightColor: 0x3edcff,
        aquatic: true,
      },
      {
        id: 'birch_glade',
        name: 'Sunlit Birch Relic',
        position: new THREE.Vector3(birchX, birchY, birchZ),
        crystalColor: 0xfce078,
        emissiveColor: 0xdda232,
        ringColor: 0xf2c664,
        lightColor: 0xf6c052,
        aquatic: false,
      },
      {
        id: 'west_ridge',
        name: 'Whispering Ridge Relic',
        position: new THREE.Vector3(ridgeX, ridgeY, ridgeZ),
        crystalColor: 0xb6fac8,
        emissiveColor: 0x52d688,
        ringColor: 0xf2c664,
        lightColor: 0x84eca8,
        aquatic: false,
      },
    ];
  }

  _buildRelics() {
    const defs = this._resolveRelicDefinitions();

    const bronzeCollarMat = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x9b7432,
        emissive: new THREE.Color(0x3a260a),
        emissiveIntensity: 0.45,
        roughness: 0.34,
        metalness: 0.86,
      })
    );

    const runeRingMat = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xf4c966,
        emissive: new THREE.Color(0xe2a452),
        emissiveIntensity: 1.55,
        roughness: 0.24,
        metalness: 0.88,
      })
    );

    const runePipMat = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xfff3c4,
        emissive: new THREE.Color(0xffc95e),
        emissiveIntensity: 2.35,
        roughness: 0.16,
        metalness: 0.5,
      })
    );

    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      const root = new THREE.Group();
      root.name = `AncientRelic_${def.id}`;
      root.position.copy(def.position);

      const crystalMat = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: def.crystalColor,
          emissive: new THREE.Color(def.emissiveColor),
          emissiveIntensity: def.id === 'deep_lagoon' ? 2.4 : 1.95,
          roughness: 0.14,
          metalness: 0.24,
        })
      );

      const haloMat = this._trackMat(
        new THREE.MeshBasicMaterial({
          map: this._glowTex,
          color: new THREE.Color(def.lightColor),
          transparent: true,
          opacity: def.id === 'deep_lagoon' ? 0.62 : 0.46,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );

      // Core carved crystal monolith + bronze equatorial rune collar
      const monolithGroup = new THREE.Group();
      const crystalMesh = new THREE.Mesh(this._crystalGeo, crystalMat);
      crystalMesh.castShadow = false;
      crystalMesh.receiveShadow = false;
      monolithGroup.add(crystalMesh);

      const collarMesh = new THREE.Mesh(this._collarGeo, bronzeCollarMat);
      collarMesh.position.y = 0.02;
      monolithGroup.add(collarMesh);

      // 4 carved golden studs around the monolith waist
      for (let s = 0; s < 4; s++) {
        const ang = (s / 4) * Math.PI * 2;
        const stud = new THREE.Mesh(this._runePipGeo, runePipMat);
        stud.position.set(Math.cos(ang) * 0.21, 0.02, Math.sin(ang) * 0.21);
        stud.scale.setScalar(0.85);
        monolithGroup.add(stud);
      }

      root.add(monolithGroup);

      // Primary tilted orbiting golden rune ring with 6 glowing rune pips
      const runeRingGroup = new THREE.Group();
      runeRingGroup.rotation.set(0.46, 0, 0.28);

      const ringMesh = new THREE.Mesh(this._ringGeo, runeRingMat);
      runeRingGroup.add(ringMesh);

      for (let p = 0; p < 6; p++) {
        const ang = (p / 6) * Math.PI * 2;
        const pip = new THREE.Mesh(this._runePipGeo, runePipMat);
        pip.position.set(Math.cos(ang) * 0.42, Math.sin(ang) * 0.42, 0);
        runeRingGroup.add(pip);
      }
      root.add(runeRingGroup);

      // Secondary delicate counter-orbiting halo ring
      const outerRingGroup = new THREE.Group();
      outerRingGroup.rotation.set(-0.62, 0.4, -0.35);
      const outerRingMesh = new THREE.Mesh(this._outerRingGeo, runeRingMat);
      outerRingGroup.add(outerRingMesh);
      root.add(outerRingGroup);

      // 3 floating orbiting crystal micro-motes
      const motes = [];
      for (let m = 0; m < 3; m++) {
        const mote = new THREE.Mesh(this._moteGeo, crystalMat);
        root.add(mote);
        motes.push({
          mesh: mote,
          angleOffset: (m / 3) * Math.PI * 2,
          radius: 0.48 + m * 0.07,
          heightAmp: 0.14 + m * 0.04,
          speed: 1.35 + m * 0.28,
        });
      }

      // Crossed additive volumetric shimmer planes
      const haloA = new THREE.Mesh(this._haloPlaneGeo, haloMat);
      const haloB = new THREE.Mesh(this._haloPlaneGeo, haloMat);
      haloB.rotation.y = Math.PI * 0.5;
      root.add(haloA, haloB);

      // Inviting moderate-distance PointLight (distance = 8.5)
      const baseLightIntensity = def.id === 'deep_lagoon' ? 3.8 : 2.65;
      const pointLight = new THREE.PointLight(
        def.lightColor,
        baseLightIntensity,
        RELIC_LIGHT_DISTANCE,
        1.55
      );
      pointLight.position.set(0, 0.06, 0);
      pointLight.castShadow = false;
      root.add(pointLight);
      this._lights.push(pointLight);

      this.group.add(root);

      this._relics.push({
        id: def.id,
        name: def.name,
        position: def.position.clone(),
        baseY: def.position.y,
        aquatic: def.aquatic,
        collected: false,
        collectAnim: 0, // 0 -> 1 fade-out progress after collection
        phase: i * 1.13,
        group: root,
        monolithGroup,
        runeRingGroup,
        outerRingGroup,
        motes,
        crystalMat,
        baseEmissiveIntensity: crystalMat.emissiveIntensity,
        haloMat,
        baseHaloOpacity: haloMat.opacity,
        light: pointLight,
        baseLightIntensity,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Celebratory Golden Particle Burst System (Relic & Character Swap)
  // ---------------------------------------------------------------------------

  _buildParticleBurstSystem() {
    this._pPos = new Float32Array(MAX_PARTICLES * 3);
    this._pVel = new Float32Array(MAX_PARTICLES * 3);
    this._pCol = new Float32Array(MAX_PARTICLES * 3);
    this._pSize = new Float32Array(MAX_PARTICLES);
    this._pAlpha = new Float32Array(MAX_PARTICLES);
    this._pAge = new Float32Array(MAX_PARTICLES);
    this._pLife = new Float32Array(MAX_PARTICLES);
    this._pSwirl = new Float32Array(MAX_PARTICLES); // tangential swirl strength (character swap)
    this._pGravity = new Float32Array(MAX_PARTICLES);
    this._pOriginX = new Float32Array(MAX_PARTICLES);
    this._pOriginZ = new Float32Array(MAX_PARTICLES);
    this._pSeed = new Float32Array(MAX_PARTICLES);

    this._pCursor = 0;
    this.activeParticleCount = 0;

    // Initialize dead offscreen
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this._pLife[i] = 0;
      this._pAge[i] = 0;
      this._pAlpha[i] = 0;
      this._pSize[i] = 0;
      this._pPos[i * 3 + 1] = -9999;
    }

    const geo = this._trackGeo(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(this._pPos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this._pCol, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this._pSize, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this._pAlpha, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this._pSeed, 1));

    const mat = this._trackMat(
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uPixelRatio: {
            value: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1,
          },
        },
        vertexShader: /* glsl */ `
          attribute vec3 aColor;
          attribute float aSize;
          attribute float aAlpha;
          attribute float aSeed;

          uniform float uTime;
          uniform float uPixelRatio;

          varying vec3 vColor;
          varying float vAlpha;

          void main() {
            vColor = aColor;
            float twinkle = 0.72 + 0.28 * sin(uTime * 14.0 + aSeed * 31.4);
            vAlpha = aAlpha * twinkle;

            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            float dist = max(-mvPosition.z, 0.6);
            gl_PointSize = clamp(aSize * uPixelRatio * (190.0 / dist), 0.0, 48.0);
            gl_Position = projectionMatrix * mvPosition;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vColor;
          varying float vAlpha;

          void main() {
            if (vAlpha <= 0.004) discard;
            vec2 uv = gl_PointCoord * 2.0 - 1.0;
            float r = length(uv);
            if (r > 1.0) discard;

            // Crisp radiant star-spark core + soft golden halo
            float core = pow(max(1.0 - r * 1.35, 0.0), 2.4);
            float halo = pow(max(1.0 - r, 0.0), 2.1) * 0.62;
            float crossFlare = exp(-abs(uv.x) * 7.5) * exp(-abs(uv.y) * 2.2)
                             + exp(-abs(uv.y) * 7.5) * exp(-abs(uv.x) * 2.2);
            float glow = core + halo + crossFlare * 0.35 * (1.0 - r);

            vec3 col = mix(vColor, vec3(1.0, 0.98, 0.9), clamp(core * 0.75, 0.0, 1.0));
            gl_FragColor = vec4(col * 1.45, clamp(glow * vAlpha, 0.0, 1.0));
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );

    this._particleGeo = geo;
    this._particleMat = mat;
    this._particlePoints = new THREE.Points(geo, mat);
    this._particlePoints.name = 'CelebrationGoldenParticles';
    this._particlePoints.frustumCulled = false;
    this.group.add(this._particlePoints);
  }

  _allocParticleIndex() {
    const idx = this._pCursor;
    this._pCursor = (this._pCursor + 1) % MAX_PARTICLES;
    return idx;
  }

  /**
   * Fires a celebratory golden spark burst at `worldPos`.
   * @param {THREE.Vector3|{x:number,y:number,z:number}} worldPos
   * @param {number} [count=70]
   */
  spawnGoldenBurst(worldPos, count = 70) {
    const origin = toVec3(worldPos, this._scratchBurstPos);
    if (!origin) return 0;

    const spawnCount = clamp(Math.round(count || 70), 1, MAX_PARTICLES);
    const palette = [
      [1.0, 0.86, 0.36], // bright sunlit gold
      [0.98, 0.68, 0.24], // warm amber
      [1.0, 0.96, 0.74], // starlight ivory
      [0.88, 0.72, 0.32], // antique rune gold
    ];

    for (let i = 0; i < spawnCount; i++) {
      const idx = this._allocParticleIndex();
      const i3 = idx * 3;

      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(lerp(-0.45, 1.0, Math.random()));
      const speed = lerp(1.35, 4.6, Math.pow(Math.random(), 0.72));

      const dirX = Math.sin(phi) * Math.cos(theta);
      const dirY = Math.cos(phi);
      const dirZ = Math.sin(phi) * Math.sin(theta);

      const jitterR = Math.random() * 0.24;
      this._pPos[i3] = origin.x + dirX * jitterR;
      this._pPos[i3 + 1] = origin.y + dirY * jitterR;
      this._pPos[i3 + 2] = origin.z + dirZ * jitterR;

      this._pVel[i3] = dirX * speed;
      this._pVel[i3 + 1] = dirY * speed + lerp(0.85, 2.1, Math.random());
      this._pVel[i3 + 2] = dirZ * speed;

      const col = palette[i % palette.length];
      this._pCol[i3] = col[0];
      this._pCol[i3 + 1] = col[1];
      this._pCol[i3 + 2] = col[2];

      this._pSize[idx] = lerp(0.16, 0.42, Math.random());
      this._pAlpha[idx] = 1.0;
      this._pAge[idx] = 0;
      this._pLife[idx] = lerp(1.05, 2.05, Math.random());
      this._pSwirl[idx] = lerp(-1.2, 1.2, Math.random());
      this._pGravity[idx] = lerp(1.8, 3.1, Math.random());
      this._pOriginX[idx] = origin.x;
      this._pOriginZ[idx] = origin.z;
      this._pSeed[idx] = Math.random();
    }

    this._markParticleBuffersDirty();
    this._recountActiveParticles();
    return spawnCount;
  }

  /**
   * Fires a warm golden burst + swirling helical sparks around the explorer
   * when switching playable characters.
   * @param {THREE.Vector3|{x:number,y:number,z:number}} worldPos
   */
  spawnSwapBurst(worldPos) {
    const origin = toVec3(worldPos, this._scratchBurstPos);
    if (!origin) return 0;

    const count = 60;
    const palette = [
      [1.0, 0.84, 0.38], // warm gold
      [0.95, 0.66, 0.26], // amber glow
      [0.64, 0.88, 0.56], // forest moss shimmer
      [1.0, 0.96, 0.78], // bright spark core
    ];

    for (let i = 0; i < count; i++) {
      const idx = this._allocParticleIndex();
      const i3 = idx * 3;

      const t = i / count;
      const angle = t * Math.PI * 6.0 + Math.random() * 0.45;
      const ringR = lerp(0.28, 0.72, Math.random());
      const startY = origin.y + lerp(0.12, 1.62, t);

      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      this._pPos[i3] = origin.x + cosA * ringR;
      this._pPos[i3 + 1] = startY;
      this._pPos[i3 + 2] = origin.z + sinA * ringR;

      // Swirling tangential + gentle radial bloom + upward drift
      const radialSpeed = lerp(0.45, 1.65, Math.random());
      const tangentSpeed = lerp(1.9, 3.3, Math.random());
      this._pVel[i3] = cosA * radialSpeed - sinA * tangentSpeed;
      this._pVel[i3 + 1] = lerp(0.75, 2.05, Math.random());
      this._pVel[i3 + 2] = sinA * radialSpeed + cosA * tangentSpeed;

      const col = palette[i % palette.length];
      this._pCol[i3] = col[0];
      this._pCol[i3 + 1] = col[1];
      this._pCol[i3 + 2] = col[2];

      this._pSize[idx] = lerp(0.15, 0.34, Math.random());
      this._pAlpha[idx] = 1.0;
      this._pAge[idx] = 0;
      this._pLife[idx] = lerp(0.8, 1.45, Math.random());
      this._pSwirl[idx] = 4.2; // crisp spiral vortex around character
      this._pGravity[idx] = lerp(0.25, 0.8, Math.random());
      this._pOriginX[idx] = origin.x;
      this._pOriginZ[idx] = origin.z;
      this._pSeed[idx] = Math.random();
    }

    this._markParticleBuffersDirty();
    this._recountActiveParticles();
    return count;
  }

  _markParticleBuffersDirty() {
    this._particleGeo.attributes.position.needsUpdate = true;
    this._particleGeo.attributes.aColor.needsUpdate = true;
    this._particleGeo.attributes.aSize.needsUpdate = true;
    this._particleGeo.attributes.aAlpha.needsUpdate = true;
    this._particleGeo.attributes.aSeed.needsUpdate = true;
  }

  _recountActiveParticles() {
    let active = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this._pLife[i] > 0 && this._pAge[i] < this._pLife[i]) {
        active++;
      }
    }
    this.activeParticleCount = active;
  }

  _updateParticles(dt, elapsed) {
    this._particleMat.uniforms.uTime.value = elapsed;
    if (this.activeParticleCount === 0) return;

    const drag = Math.exp(-dt * 1.45);
    let active = 0;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const life = this._pLife[i];
      if (life <= 0) continue;

      const age = this._pAge[i] + dt;
      this._pAge[i] = age;

      if (age >= life) {
        this._pLife[i] = 0;
        this._pAlpha[i] = 0;
        this._pSize[i] = 0;
        this._pPos[i * 3 + 1] = -9999;
        continue;
      }

      active++;
      const i3 = i * 3;

      // Apply optional orbital swirl around burst origin
      const swirl = this._pSwirl[i];
      if (Math.abs(swirl) > 0.01) {
        const dx = this._pPos[i3] - this._pOriginX[i];
        const dz = this._pPos[i3 + 2] - this._pOriginZ[i];
        const r = Math.hypot(dx, dz) + 0.08;
        this._pVel[i3] += (-dz / r) * swirl * dt;
        this._pVel[i3 + 2] += (dx / r) * swirl * dt;
      }

      this._pVel[i3] *= drag;
      this._pVel[i3 + 1] = this._pVel[i3 + 1] * drag - this._pGravity[i] * dt;
      this._pVel[i3 + 2] *= drag;

      this._pPos[i3] += this._pVel[i3] * dt;
      this._pPos[i3 + 1] += this._pVel[i3 + 1] * dt;
      this._pPos[i3 + 2] += this._pVel[i3 + 2] * dt;

      const progress = age / life;
      // Fast punch-in, graceful golden shimmer fade-out
      const fadeIn = clamp(progress / 0.08, 0, 1);
      const fadeOut = Math.pow(clamp(1.0 - progress, 0, 1), 1.45);
      this._pAlpha[i] = fadeIn * fadeOut;
    }

    this.activeParticleCount = active;
    this._particleGeo.attributes.position.needsUpdate = true;
    this._particleGeo.attributes.aAlpha.needsUpdate = true;
    this._particleGeo.attributes.aSize.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // 3. Top-Center RPG Compass Bar HUD & Discovery Toast
  // ---------------------------------------------------------------------------

  _injectStyles() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById?.(STYLE_ELEMENT_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = COMPASS_CSS;
    document.head.appendChild(style);
  }

  _buildCompassHud() {
    if (typeof document === 'undefined' || !document.body) return;

    // Remove any stale instance if reconstructed cleanly
    const existing = document.getElementById?.(COMPASS_ROOT_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    const existingToast = document.getElementById?.(TOAST_ROOT_ID);
    if (existingToast && existingToast.parentNode) existingToast.parentNode.removeChild(existingToast);

    const wrap = document.createElement('div');
    wrap.id = COMPASS_ROOT_ID;
    wrap.className = 'gs-compass-wrap';
    wrap.setAttribute('aria-label', 'Explorer compass and relic tracker');

    const bar = document.createElement('div');
    bar.className = 'gs-compass-bar';

    const caret = document.createElement('div');
    caret.className = 'gs-compass-caret';
    bar.appendChild(caret);

    const centerLine = document.createElement('div');
    centerLine.className = 'gs-compass-center-line';
    bar.appendChild(centerLine);

    const viewport = document.createElement('div');
    viewport.className = 'gs-compass-viewport';

    // Seamless 720-degree scrolling cardinal tape (-180° .. +540°)
    // Origin 0° sits at x = 180 * COMPASS_PX_PER_DEG so wrapping [0, 360) never seams!
    const tape = document.createElement('div');
    tape.className = 'gs-compass-tape';
    this._tapeOriginPx = 180 * COMPASS_PX_PER_DEG;
    tape.style.width = `${720 * COMPASS_PX_PER_DEG}px`;

    for (let deg = -180; deg <= 540; deg += 15) {
      const px = this._tapeOriginPx + deg * COMPASS_PX_PER_DEG;
      const normDeg = wrapDeg360(deg);

      const tick = document.createElement('span');
      const isCard = normDeg % 45 === 0;
      tick.className = isCard ? 'gs-compass-tick is-minor' : 'gs-compass-tick';
      tick.style.left = `${px.toFixed(1)}px`;
      tape.appendChild(tick);

      if (isCard) {
        const entry = CARDINAL_LABELS.find((c) => c.deg === normDeg);
        if (entry) {
          const lbl = document.createElement('span');
          lbl.className =
            'gs-compass-cardinal' +
            (entry.major ? ' is-major' : '') +
            (entry.text === 'N' ? ' is-north' : '');
          lbl.textContent = entry.text;
          lbl.style.left = `${px.toFixed(1)}px`;
          tape.appendChild(lbl);
        }
      }
    }

    viewport.appendChild(tape);

    // Dynamic golden diamond markers for uncollected relics
    const markersLayer = document.createElement('div');
    markersLayer.className = 'gs-compass-markers';
    for (let i = 0; i < this._relics.length; i++) {
      const relic = this._relics[i];
      const marker = document.createElement('span');
      marker.className = relic.aquatic ? 'gs-relic-marker is-aquatic' : 'gs-relic-marker';
      marker.dataset.relicId = relic.id;
      marker.setAttribute('aria-label', relic.name);
      markersLayer.appendChild(marker);
      this._relicMarkerEls.set(relic.id, marker);
    }
    viewport.appendChild(markersLayer);
    bar.appendChild(viewport);
    wrap.appendChild(bar);

    // Compact 0/7 Relics counter pill
    const pill = document.createElement('div');
    pill.className = 'gs-relic-pill';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');

    const gem = document.createElement('span');
    gem.className = 'gs-relic-pill-gem';
    pill.appendChild(gem);

    const countSpan = document.createElement('span');
    countSpan.className = 'gs-relic-count';
    countSpan.textContent = `0/${this._relics.length} Relics`;
    pill.appendChild(countSpan);

    wrap.appendChild(pill);

    // Celebratory toast banner
    const toast = document.createElement('div');
    toast.id = TOAST_ROOT_ID;
    toast.className = 'gs-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'assertive');

    const toastTitle = document.createElement('div');
    toastTitle.className = 'gs-toast-title';
    toast.appendChild(toastTitle);

    const toastSub = document.createElement('div');
    toastSub.className = 'gs-toast-sub';
    toast.appendChild(toastSub);

    document.body.appendChild(wrap);
    document.body.appendChild(toast);

    this._compassWrap = wrap;
    this._tapeViewport = viewport;
    this._tapeTrack = tape;
    this._markersLayer = markersLayer;
    this._relicPill = pill;
    this._relicCountEl = countSpan;
    this._toastEl = toast;
    this._toastTitleEl = toastTitle;
    this._toastSubEl = toastSub;

    this._applyCompassTapeTransform();
  }

  _applyCompassTapeTransform() {
    if (!this._tapeTrack) return;
    const viewW = this._tapeViewport?.clientWidth || COMPASS_DEFAULT_VIEW_WIDTH;
    const centerX = viewW * 0.5;
    const shiftX = centerX - (this._tapeOriginPx + this.cameraAzimuthDeg * COMPASS_PX_PER_DEG);
    this._tapeTrack.style.transform = `translate3d(${shiftX.toFixed(2)}px, 0px, 0px)`;
    if (this._compassWrap) {
      this._compassWrap.dataset.azimuth = String(Math.round(this.cameraAzimuthDeg));
    }
  }

  _updateCompassHud(playerPos, cameraForward) {
    if (cameraForward && Number.isFinite(cameraForward.x) && Number.isFinite(cameraForward.z)) {
      const horizLenSq = cameraForward.x * cameraForward.x + cameraForward.z * cameraForward.z;
      if (horizLenSq > 1e-6) {
        // 0 rad = North (-Z), +PI/2 = East (+X), PI = South (+Z), -PI/2 = West (-X)
        this.cameraAzimuthRad = Math.atan2(cameraForward.x, -cameraForward.z);
        this.cameraAzimuthDeg = wrapDeg360((this.cameraAzimuthRad * 180) / Math.PI);
      }
    }

    this._applyCompassTapeTransform();

    if (!playerPos || this._relicMarkerEls.size === 0) return;

    const viewW = this._tapeViewport?.clientWidth || COMPASS_DEFAULT_VIEW_WIDTH;
    const maxOffsetPx = viewW * 0.5 - 10;

    for (let i = 0; i < this._relics.length; i++) {
      const relic = this._relics[i];
      const marker = this._relicMarkerEls.get(relic.id);
      if (!marker) continue;

      if (relic.collected) {
        marker.style.opacity = '0';
        continue;
      }

      const dx = relic.position.x - playerPos.x;
      const dz = relic.position.z - playerPos.z;
      const horizDist = Math.hypot(dx, dz);
      const bearingRad = Math.atan2(dx, -dz);
      const relRad = wrapPi(bearingRad - this.cameraAzimuthRad);
      const relDeg = (relRad * 180) / Math.PI;
      const absDeg = Math.abs(relDeg);

      if (absDeg > COMPASS_HALF_FOV_DEG + 10) {
        marker.style.opacity = '0';
        continue;
      }

      const offsetPx = clamp(relDeg * COMPASS_PX_PER_DEG, -maxOffsetPx, maxOffsetPx);
      const edgeFade = 1.0 - clamp((absDeg - (COMPASS_HALF_FOV_DEG - 18)) / 24, 0, 1);
      const closeness = clamp(1.0 - horizDist / 52.0, 0, 1);

      const scale = lerp(0.76, 1.26, closeness);
      const opacity = lerp(0.48, 1.0, closeness) * edgeFade;

      marker.style.transform = `translate3d(${offsetPx.toFixed(1)}px, -50%, 0px) rotate(45deg) scale(${scale.toFixed(3)})`;
      marker.style.opacity = opacity.toFixed(3);
    }
  }

  _updateRelicCounterUI() {
    const total = this._relics.length;
    const allFound = this._collectedCount >= total;
    if (this._relicCountEl) {
      this._relicCountEl.textContent = allFound
        ? `${this._collectedCount}/${total} Relics ★`
        : `${this._collectedCount}/${total} Relics`;
    }
    if (this._relicPill) {
      this._relicPill.classList.add('is-pulse');
      this._relicPill.classList.toggle('is-complete', allFound);
      this._pillPulseTimer = 0.55;
    }
  }

  _showDiscoveryToast(relic) {
    const total = this._relics.length;
    const allFound = this._collectedCount >= total;
    const title = allFound
      ? `All ${total} Ancient Forest Relics Found!`
      : `Ancient Relic Discovered! (${this._collectedCount}/${total})`;
    const sub = allFound
      ? `${relic.name} — Forest Sanctuary Complete`
      : relic.name;

    this.lastToastMessage = title;
    this._toastTimer = allFound ? TOAST_DURATION_SEC + 1.5 : TOAST_DURATION_SEC;

    if (this._toastTitleEl) this._toastTitleEl.textContent = title;
    if (this._toastSubEl) this._toastSubEl.textContent = sub;
    if (this._toastEl) {
      this._toastEl.classList.toggle('is-complete', allFound);
      this._toastEl.classList.add('is-visible');
    }
  }

  _collectRelic(relic) {
    if (relic.collected) return;
    relic.collected = true;
    relic.collectAnim = 0.001;
    this._collectedCount++;

    this.audio?.playRelicFound?.();
    this.spawnGoldenBurst(relic.position, 75);
    this._updateRelicCounterUI();
    this._showDiscoveryToast(relic);
  }

  // ---------------------------------------------------------------------------
  // 4. Per-Frame Update & Public API
  // ---------------------------------------------------------------------------

  update(dt = 0.016, elapsed = 0, { playerPos = null, cameraForward = null } = {}) {
    if (this._disposed) return;

    const safeDt = clamp(Number.isFinite(dt) ? dt : 0.016, 0, 0.1);
    const t = Number.isFinite(elapsed) ? elapsed : 0;
    const resolvedPlayer = toVec3(playerPos, this._scratchPlayerPos);

    // 1. Animate relics & check 3D proximity auto-collection
    for (let i = 0; i < this._relics.length; i++) {
      const relic = this._relics[i];

      if (!relic.collected) {
        // Gentle floating bob + crystal spin + dual orbiting rune rings + glimmer pulse
        const bob = Math.sin(t * 2.05 + relic.phase) * 0.11;
        relic.group.position.set(relic.position.x, relic.baseY + bob, relic.position.z);

        relic.monolithGroup.rotation.y = t * 0.82 + relic.phase;
        relic.monolithGroup.rotation.z = Math.sin(t * 1.15 + relic.phase) * 0.06;

        relic.runeRingGroup.rotation.z = t * 1.28 + relic.phase;
        relic.runeRingGroup.rotation.y = t * 0.55;

        relic.outerRingGroup.rotation.z = -t * 0.92 + relic.phase;
        relic.outerRingGroup.rotation.x = -0.62 + Math.sin(t * 0.8 + relic.phase) * 0.18;

        for (let m = 0; m < relic.motes.length; m++) {
          const mote = relic.motes[m];
          const ma = t * mote.speed + mote.angleOffset + relic.phase;
          mote.mesh.position.set(
            Math.cos(ma) * mote.radius,
            Math.sin(ma * 1.4) * mote.heightAmp,
            Math.sin(ma) * mote.radius
          );
          mote.mesh.rotation.y = ma * 2.0;
        }

        const pulse = 0.86 + 0.22 * Math.sin(t * 2.6 + relic.phase);
        relic.crystalMat.emissiveIntensity = relic.baseEmissiveIntensity * pulse;
        relic.haloMat.opacity = relic.baseHaloOpacity * (0.85 + 0.25 * Math.sin(t * 3.1 + relic.phase));
        relic.light.intensity = relic.baseLightIntensity * pulse;

        // 3D distance check (< 1.95m) so submerged lagoon relic requires diving down!
        if (resolvedPlayer) {
          const distSq = resolvedPlayer.distanceToSquared(relic.position);
          if (distSq < PICKUP_RADIUS_SQ) {
            this._collectRelic(relic);
          }
        }
      } else if (relic.group.visible) {
        // Smooth celebratory flash-and-vanish hide animation
        relic.collectAnim = Math.min(1.0, relic.collectAnim + safeDt / RELIC_COLLECT_ANIM_DURATION);
        const p = relic.collectAnim;
        const swell = p < 0.25 ? lerp(1.0, 1.38, p / 0.25) : lerp(1.38, 0.001, (p - 0.25) / 0.75);
        relic.group.scale.setScalar(Math.max(0.001, swell));
        relic.group.position.y = relic.baseY + p * 0.65;
        relic.monolithGroup.rotation.y += safeDt * 7.5;
        relic.light.intensity = relic.baseLightIntensity * (1.0 - p) * (p < 0.25 ? 2.2 : 1.0);
        relic.haloMat.opacity = relic.baseHaloOpacity * (1.0 - p);

        if (p >= 1.0) {
          relic.group.visible = false;
          relic.light.visible = false;
          relic.light.intensity = 0;
        }
      }
    }

    // 2. Update golden celebration & character-swap particles
    this._updateParticles(safeDt, t);

    // 3. Update sleek top-center compass tape & golden relic markers
    this._updateCompassHud(resolvedPlayer, cameraForward);

    // 4. Decay toast banner & pill pulse
    if (this._toastTimer > 0) {
      this._toastTimer = Math.max(0, this._toastTimer - safeDt);
      if (this._toastTimer === 0 && this._toastEl) {
        this._toastEl.classList.remove('is-visible');
      }
    }

    if (this._pillPulseTimer > 0) {
      this._pillPulseTimer = Math.max(0, this._pillPulseTimer - safeDt);
      if (this._pillPulseTimer === 0 && this._relicPill) {
        this._relicPill.classList.remove('is-pulse');
      }
    }
  }

  getCollectedCount() {
    return this._collectedCount;
  }

  getTotalCount() {
    return this._relics.length;
  }

  getRelicsState() {
    return this._relics.map((r) => ({
      id: r.id,
      name: r.name,
      position: r.position.clone(),
      collected: r.collected,
    }));
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    // Remove DOM compass & toast elements
    if (this._compassWrap && this._compassWrap.parentNode) {
      this._compassWrap.parentNode.removeChild(this._compassWrap);
    }
    if (this._toastEl && this._toastEl.parentNode) {
      this._toastEl.parentNode.removeChild(this._toastEl);
    }
    this._relicMarkerEls.clear();
    this._compassWrap = null;
    this._tapeViewport = null;
    this._tapeTrack = null;
    this._markersLayer = null;
    this._relicPill = null;
    this._relicCountEl = null;
    this._toastEl = null;
    this._toastTitleEl = null;
    this._toastSubEl = null;

    // Remove from Three.js scene & dispose all GPU resources
    if (this.scene && this.group.parent === this.scene) {
      this.scene.remove(this.group);
    } else if (this.group.parent) {
      this.group.parent.remove(this.group);
    }

    for (let i = 0; i < this._lights.length; i++) {
      this._lights[i].dispose?.();
    }
    this._lights.length = 0;

    for (let i = 0; i < this._geometries.length; i++) {
      this._geometries[i].dispose?.();
    }
    this._geometries.length = 0;

    for (let i = 0; i < this._materials.length; i++) {
      this._materials[i].dispose?.();
    }
    this._materials.length = 0;

    for (let i = 0; i < this._textures.length; i++) {
      this._textures[i].dispose?.();
    }
    this._textures.length = 0;

    this.activeParticleCount = 0;
  }
}
