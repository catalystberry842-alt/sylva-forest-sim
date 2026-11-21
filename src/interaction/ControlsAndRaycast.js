import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { WATER_LEVEL } from '../world/Terrain.js';
import { createRng, clamp, lerp } from '../utils/random.js';

const MAP_BOUND = 105;
const ORBIT_TARGET_BOUND = 95;
const FP_EYE_HEIGHT = 1.74;
const FP_WALK_SPEED = 5.6;
const FP_SPRINT_SPEED = 9.8;
const FP_PLAYER_RADIUS = 0.55;

const BIRD_COUNT = 18;
const BIRD_FLIGHT_DURATION = 24.0;
const BIRD_MIN_SPEED = 7.0;
const BIRD_MAX_SPEED = 13.0;
const BIRD_TERRAIN_CLEARANCE = 5.5;

const EMBER_COUNT = 90;
const SMOKE_COUNT = 45;

// Scratch math objects to avoid per-frame GC allocations
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _sep = new THREE.Vector3();
const _ali = new THREE.Vector3();
const _coh = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _bankUp = new THREE.Vector3();
const _right = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _centerNdc = new THREE.Vector2(0, 0);

/**
 * Fast 2D spatial hash grid (cell size 4.0) for smooth circle-vs-circle
 * collision sliding around tree trunks, boulders, stumps, and the campfire ring.
 */
export class SpatialHash2D {
  constructor(cellSize = 4.0) {
    this.cellSize = cellSize;
    this._invCellSize = 1.0 / cellSize;
    this._cells = new Map();
    this._visitStamp = 0;
  }

  _key(cx, cz) {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  setColliders(colliders = []) {
    this._cells.clear();
    const inv = this._invCellSize;

    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z) || !Number.isFinite(c.radius) || c.radius <= 0) {
        continue;
      }

      const entry = {
        x: c.x,
        z: c.z,
        radius: c.radius,
        _stamp: 0,
      };

      const minCx = Math.floor((entry.x - entry.radius) * inv);
      const maxCx = Math.floor((entry.x + entry.radius) * inv);
      const minCz = Math.floor((entry.z - entry.radius) * inv);
      const maxCz = Math.floor((entry.z + entry.radius) * inv);

      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const k = this._key(cx, cz);
          let bucket = this._cells.get(k);
          if (!bucket) {
            bucket = [];
            this._cells.set(k, bucket);
          }
          bucket.push(entry);
        }
      }
    }
  }

  /**
   * Iteratively resolves 2D circle-vs-circle overlaps on `pos` ({ x, z })
   * so the player slides smoothly around trunks & boulders without jitter.
   */
  resolveCircle(pos, playerRadius = FP_PLAYER_RADIUS) {
    const inv = this._invCellSize;
    let anyCollision = false;

    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      const stamp = ++this._visitStamp;

      const minCx = Math.floor((pos.x - playerRadius) * inv);
      const maxCx = Math.floor((pos.x + playerRadius) * inv);
      const minCz = Math.floor((pos.z - playerRadius) * inv);
      const maxCz = Math.floor((pos.z + playerRadius) * inv);

      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const bucket = this._cells.get(this._key(cx, cz));
          if (!bucket) continue;

          for (let i = 0; i < bucket.length; i++) {
            const c = bucket[i];
            if (c._stamp === stamp) continue;
            c._stamp = stamp;

            const dx = pos.x - c.x;
            const dz = pos.z - c.z;
            const minDist = playerRadius + c.radius;
            const distSq = dx * dx + dz * dz;

            if (distSq < minDist * minDist) {
              if (distSq < 1e-8) {
                pos.x += minDist;
              } else {
                const dist = Math.sqrt(distSq);
                const overlap = minDist - dist;
                pos.x += (dx / dist) * overlap;
                pos.z += (dz / dist) * overlap;
              }
              moved = true;
              anyCollision = true;
            }
          }
        }
      }

      if (!moved) break;
    }

    return anyCollision;
  }
}

/**
 * Helper: appends a triangle to arrays with flat or interpolated vertex colors.
 */
function pushTri(positions, colors, a, b, c, ca, cb, cc) {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  colors.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
}

/**
 * Builds stylized low-poly woodland bird geometries (body+head+beak+tail, plus
 * separate left & right wing geometries pivoted cleanly at the shoulders).
 * Forward axis is +Z, Up is +Y.
 */
function createBirdGeometries(palette) {
  // 1. Body + head + beak + fanned wedge tail
  const bPos = [];
  const bCol = [];

  const back = palette.back;
  const breast = palette.breast;
  const crown = palette.crown;
  const tailCol = palette.tail;
  const beakCol = palette.beak;

  // Profile rings along +Z (tail root -> torso -> chest -> neck -> head -> nose)
  const rings = [
    { z: -0.17, y: 0.005, rx: 0.032, ry: 0.026, top: back, bot: breast },
    { z: -0.09, y: 0.008, rx: 0.068, ry: 0.056, top: back, bot: breast },
    { z: 0.0, y: 0.004, rx: 0.082, ry: 0.068, top: back, bot: breast },
    { z: 0.085, y: 0.012, rx: 0.066, ry: 0.058, top: back, bot: breast },
    { z: 0.135, y: 0.038, rx: 0.048, ry: 0.044, top: crown, bot: breast },
    { z: 0.185, y: 0.052, rx: 0.042, ry: 0.04, top: crown, bot: crown },
    { z: 0.218, y: 0.046, rx: 0.022, ry: 0.02, top: crown, bot: crown },
  ];

  const segs = 8;
  const ringVerts = [];
  const ringCols = [];

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const verts = [];
    const cols = [];
    for (let s = 0; s < segs; s++) {
      const ang = (s / segs) * Math.PI * 2;
      const vx = Math.cos(ang) * ring.rx;
      const vy = ring.y + Math.sin(ang) * ring.ry;
      verts.push([vx, vy, ring.z]);
      const topMix = clamp(Math.sin(ang) * 0.5 + 0.5, 0, 1);
      cols.push([
        lerp(ring.bot[0], ring.top[0], topMix),
        lerp(ring.bot[1], ring.top[1], topMix),
        lerp(ring.bot[2], ring.top[2], topMix),
      ]);
    }
    ringVerts.push(verts);
    ringCols.push(cols);
  }

  for (let r = 0; r < rings.length - 1; r++) {
    for (let s = 0; s < segs; s++) {
      const sn = (s + 1) % segs;
      const a = ringVerts[r][s];
      const b = ringVerts[r][sn];
      const c = ringVerts[r + 1][sn];
      const d = ringVerts[r + 1][s];
      const ca = ringCols[r][s];
      const cb = ringCols[r][sn];
      const cc = ringCols[r + 1][sn];
      const cd = ringCols[r + 1][s];
      pushTri(bPos, bCol, a, b, c, ca, cb, cc);
      pushTri(bPos, bCol, a, c, d, ca, cc, cd);
    }
  }

  // Close rear cap (normal pointing -Z)
  const rearCenter = [0, 0.005, -0.185];
  for (let s = 0; s < segs; s++) {
    const sn = (s + 1) % segs;
    pushTri(bPos, bCol, rearCenter, ringVerts[0][sn], ringVerts[0][s], tailCol, ringCols[0][sn], ringCols[0][s]);
  }

  // Pointed beak at front (+Z)
  const beakTip = [0, 0.042, 0.285];
  const lastRing = rings.length - 1;
  for (let s = 0; s < segs; s++) {
    const sn = (s + 1) % segs;
    pushTri(bPos, bCol, ringVerts[lastRing][s], ringVerts[lastRing][sn], beakTip, beakCol, beakCol, beakCol);
  }

  // Fanned wedge tail feathers extending toward -Z (double-sided thin wedge)
  const tRootL = [-0.028, 0.008, -0.155];
  const tRootR = [0.028, 0.008, -0.155];
  const tRootTop = [0, 0.022, -0.155];
  const tTipL = [-0.078, 0.022, -0.34];
  const tTipC = [0, 0.025, -0.36];
  const tTipR = [0.078, 0.022, -0.34];

  // Top & underside of tail
  pushTri(bPos, bCol, tRootL, tTipC, tTipL, tailCol, tailCol, tailCol);
  pushTri(bPos, bCol, tRootL, tRootR, tTipC, tailCol, tailCol, tailCol);
  pushTri(bPos, bCol, tRootR, tTipR, tTipC, tailCol, tailCol, tailCol);

  pushTri(bPos, bCol, tRootTop, tTipL, tTipC, back, tailCol, tailCol);
  pushTri(bPos, bCol, tRootTop, tTipC, tTipR, back, tailCol, tailCol);
  pushTri(bPos, bCol, tRootL, tTipL, tTipC, tailCol, tailCol, tailCol);
  pushTri(bPos, bCol, tRootR, tTipC, tTipR, tailCol, tailCol, tailCol);

  const bodyGeometry = new THREE.BufferGeometry();
  bodyGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
  bodyGeometry.setAttribute('color', new THREE.Float32BufferAttribute(bCol, 3));
  bodyGeometry.computeVertexNormals();

  // 2. Separately hinged Left (-X) & Right (+X) Wing Geometries (pivoted at x=0)
  const buildWing = (sideSign) => {
    const wPos = [];
    const wCol = [];
    const s = sideSign; // +1 right wing (+X), -1 left wing (-X)

    const rootLead = [0.0, 0.014, 0.085];
    const rootTrail = [0.0, 0.004, -0.09];
    const rootMid = [0.0, 0.024, 0.0];

    const midLead = [s * 0.165, 0.024, 0.068];
    const midTrail = [s * 0.145, 0.008, -0.105];

    const tipLead = [s * 0.34, 0.005, -0.028];
    const tipTrail = [s * 0.30, -0.002, -0.118];

    const cRoot = palette.wingRoot;
    const cTip = palette.wingTip;
    const cUnder = palette.wingUnder;

    const emitDouble = (p0, p1, p2, colTop0, colTop1, colTop2) => {
      if (s > 0) {
        pushTri(wPos, wCol, p0, p1, p2, colTop0, colTop1, colTop2);
        pushTri(wPos, wCol, p0, p2, p1, cUnder, cUnder, cUnder);
      } else {
        pushTri(wPos, wCol, p0, p2, p1, colTop0, colTop2, colTop1);
        pushTri(wPos, wCol, p0, p1, p2, cUnder, cUnder, cUnder);
      }
    };

    emitDouble(rootLead, midLead, rootMid, cRoot, cRoot, cRoot);
    emitDouble(rootMid, midLead, midTrail, cRoot, cRoot, cTip);
    emitDouble(rootMid, midTrail, rootTrail, cRoot, cTip, cRoot);
    emitDouble(midLead, tipLead, midTrail, cRoot, cTip, cTip);
    emitDouble(midTrail, tipLead, tipTrail, cTip, cTip, cTip);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(wCol, 3));
    geo.computeVertexNormals();
    return geo;
  };

  return {
    bodyGeometry,
    leftWingGeometry: buildWing(-1),
    rightWingGeometry: buildWing(1),
  };
}

/**
 * Unified Dual-Camera Controller (Orbit & First-Person with 2D Spatial Hash
 * collision), Interactive Stone Campfire (flames, light, HDR sparks & smoke),
 * Interactive 18-Bird 3D Boid Flock, and Terrain/Object Raycasting.
 */
export class ControlsAndRaycast {
  constructor(engine, terrain, windSystem, audio, callbacks = {}) {
    this.engine = engine;
    this.terrain = terrain;
    this.windSystem = windSystem;
    this.audio = audio;
    this.callbacks = callbacks;

    this.camera = engine.camera;
    this.scene = engine.scene;
    this.domElement = engine.renderer.domElement;

    this.campfirePos = this.terrain.getClearingCenter3D(new THREE.Vector3());
    this.spatialHash = new SpatialHash2D(4.0);
    this._externalColliders = [];

    // Camera mode state
    this._cameraMode = 'Orbit';
    this._isPointerLocked = false;
    this._fpPos = new THREE.Vector3();
    this._fpFootPos = new THREE.Vector3();
    this._fpVelocity = new THREE.Vector3();
    this._fpGroundY = this.campfirePos.y;
    this._bobPhase = 0;
    this._bobAmp = 0;

    // Input state
    this._keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      sprint: false,
    };
    this._pointerNdc = new THREE.Vector2(0, 0);
    this._pointerInside = false;
    this._pointerDownPos = { x: 0, y: 0 };
    this._isPointerDown = false;

    // Raycasting & hover prompts
    this._raycaster = new THREE.Raycaster();
    this._interactiveTargets = [];
    this._hoveredTarget = null;
    this._lastPromptText = '';
    this._lastPromptInteractive = null;
    this._terrainHitPoint = new THREE.Vector3();
    this._terrainBounds = null;
    this._lastTerrainRayTime = -1;

    // Disposables tracker
    this._geometries = [];
    this._materials = [];

    // 1. Setup Dual Camera Controls
    this._initControls();

    // 2. Build Interactive Stone Campfire at clearing center
    this._campfireLit = true;
    this._campfireHeat = 1.0;
    this._initCampfire();

    // 3. Build 18-Bird Interactive 3D Boid Flock
    this._flockState = 'perched'; // 'perched' | 'flying' | 'landing'
    this._flightTimer = 0;
    this._landingTimer = 0;
    this._birds = [];
    this._initBirds();

    // Index campfire collider immediately even before trees/rocks are added
    this.setColliders([]);

    // Ensure terrain bounding box exists for fast ray intersection bounds check
    if (this.terrain.mesh && this.terrain.mesh.geometry) {
      if (!this.terrain.mesh.geometry.boundingBox) {
        this.terrain.mesh.geometry.computeBoundingBox();
      }
      this._terrainBounds = this.terrain.mesh.geometry.boundingBox.clone();
    }

    // 4. Bind DOM & Keyboard Events
    this._bindEvents();

    // Position initial Orbit camera overlooking campfire clearing & winding stream
    this.resetCamera();
    this._updatePrompt();
  }

  _initControls() {
    this.orbitControls = new OrbitControls(this.camera, this.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.06;
    this.orbitControls.minDistance = 4;
    this.orbitControls.maxDistance = 95;
    this.orbitControls.maxPolarAngle = Math.PI * 0.495;
    this.orbitControls.rotateSpeed = 0.78;
    this.orbitControls.zoomSpeed = 0.92;
    this.orbitControls.panSpeed = 0.85;

    this.pointerLockControls = new PointerLockControls(this.camera, this.domElement);
    this.pointerLockControls.minPolarAngle = 0.14;
    this.pointerLockControls.maxPolarAngle = Math.PI - 0.14;
    this.pointerLockControls.enabled = false;

    this._onLock = () => {
      this._isPointerLocked = true;
      this.callbacks.onPointerLockChange?.(true);
      this._updatePrompt();
    };
    this._onUnlock = () => {
      this._isPointerLocked = false;
      this.callbacks.onPointerLockChange?.(false);
      this._updatePrompt();
    };
    this.pointerLockControls.addEventListener('lock', this._onLock);
    this.pointerLockControls.addEventListener('unlock', this._onUnlock);
  }

  /**
   * Indexes all tree, boulder, stump/log colliders plus the central campfire stone ring.
   */
  setColliders(colliders = []) {
    this._externalColliders = Array.isArray(colliders) ? colliders : [];
    const combined = this._externalColliders.slice();
    // Always include central campfire stone ring collider
    combined.push({
      x: this.campfirePos.x,
      z: this.campfirePos.z,
      radius: 1.72,
    });
    this.spatialHash.setColliders(combined);
  }

  // ---------------------------------------------------------------------------
  // Interactive Stone Campfire
  // ---------------------------------------------------------------------------

  _initCampfire() {
    const rng = createRng(7711);
    const group = new THREE.Group();
    group.name = 'InteractiveCampfire';
    group.position.copy(this.campfirePos);
    this.campfireGroup = group;

    // 1. Stone ring: 14 varied mossy river stones in a 1.35-radius circle resting snugly on terrain
    const stoneMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.87,
      metalness: 0.03,
    });
    this._materials.push(stoneMat);

    const stoneCount = 14;
    const ringRadius = 1.35;
    for (let i = 0; i < stoneCount; i++) {
      const ang = (i / stoneCount) * Math.PI * 2 + (rng() - 0.5) * 0.16;
      const radJitter = ringRadius + (rng() - 0.5) * 0.14;
      const lx = Math.cos(ang) * radJitter;
      const lz = Math.sin(ang) * radJitter;

      const geo = new THREE.DodecahedronGeometry(1.0, 1);
      const pos = geo.attributes.position;
      const col = new Float32Array(pos.count * 3);

      const sx = 0.25 + rng() * 0.15;
      const sy = 0.16 + rng() * 0.1;
      const sz = 0.23 + rng() * 0.14;
      const tone = 0.72 + rng() * 0.4;
      const mossAmount = 0.35 + rng() * 0.45;
      const pPhase = rng() * Math.PI * 2;

      for (let v = 0; v < pos.count; v++) {
        let vx = pos.getX(v);
        let vy = pos.getY(v);
        let vz = pos.getZ(v);
        const lump =
          1.0 +
          Math.sin(vx * 3.1 + pPhase) * 0.12 +
          Math.cos(vz * 3.5 - pPhase) * 0.12 +
          Math.sin(vy * 4.2 + vx * 2.0) * 0.08;
        vx *= sx * lump;
        vy *= sy * (vy < 0 ? 0.72 : 1.0) * lump;
        vz *= sz * lump;
        pos.setXYZ(v, vx, vy, vz);

        // Granite side with damp bottom and velvety moss cap
        const upFactor = clamp((vy / sy + 0.2) * 0.75, 0, 1);
        const mossMask = clamp((upFactor - 0.35) * 1.9, 0, 1) * mossAmount;
        const sootMask = clamp(1.0 - upFactor * 1.3, 0, 1) * 0.25;
        const r = lerp(0.36 * tone, 0.21, mossMask) * (1.0 - sootMask);
        const g = lerp(0.35 * tone, 0.36, mossMask) * (1.0 - sootMask);
        const b = lerp(0.33 * tone, 0.16, mossMask) * (1.0 - sootMask);
        col[v * 3] = r;
        col[v * 3 + 1] = g;
        col[v * 3 + 2] = b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.computeVertexNormals();
      this._geometries.push(geo);

      const worldX = this.campfirePos.x + lx;
      const worldZ = this.campfirePos.z + lz;
      const localGroundY = this.terrain.getHeightAt(worldX, worldZ) - this.campfirePos.y;

      const stone = new THREE.Mesh(geo, stoneMat);
      stone.position.set(lx, localGroundY + sy * 0.48, lz);
      stone.rotation.set((rng() - 0.5) * 0.24, rng() * Math.PI * 2, (rng() - 0.5) * 0.24);
      stone.castShadow = true;
      stone.receiveShadow = true;
      stone.userData.interactive = 'campfire';
      group.add(stone);
    }

    // 2. Glowing charcoal ember mound
    const emberGeo = new THREE.SphereGeometry(0.86, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52);
    const ePos = emberGeo.attributes.position;
    const eCol = new Float32Array(ePos.count * 3);
    for (let i = 0; i < ePos.count; i++) {
      let x = ePos.getX(i);
      let y = ePos.getY(i) * 0.34;
      let z = ePos.getZ(i);
      const bump = Math.sin(x * 8.5 + z * 6.3) * 0.032 + Math.cos(z * 10.2 - x * 7.1) * 0.025;
      y = Math.max(0.01, y + bump);
      ePos.setXYZ(i, x, y, z);

      const rDist = Math.sqrt(x * x + z * z) / 0.86;
      const hotCenter = clamp(1.0 - rDist * 0.88 + bump * 6.0, 0.08, 1.0);
      eCol[i * 3] = lerp(0.1, 0.45, hotCenter);
      eCol[i * 3 + 1] = lerp(0.08, 0.16, hotCenter);
      eCol[i * 3 + 2] = lerp(0.07, 0.05, hotCenter);
    }
    emberGeo.setAttribute('color', new THREE.BufferAttribute(eCol, 3));
    emberGeo.computeVertexNormals();
    this._geometries.push(emberGeo);

    this._emberMoundMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0.04,
      emissive: new THREE.Color(0xff3c08),
      emissiveIntensity: 2.1,
    });
    this._materials.push(this._emberMoundMat);

    const emberMound = new THREE.Mesh(emberGeo, this._emberMoundMat);
    emberMound.position.y = -0.02;
    emberMound.receiveShadow = true;
    emberMound.userData.interactive = 'campfire';
    group.add(emberMound);

    // 3. Crossed charred firewood logs
    this._logMat = new THREE.MeshStandardMaterial({
      color: 0x261d17,
      roughness: 0.93,
      metalness: 0.02,
      emissive: new THREE.Color(0x9a2104),
      emissiveIntensity: 0.38,
    });
    this._materials.push(this._logMat);

    const logGeo = new THREE.CylinderGeometry(0.075, 0.105, 1.48, 8, 4);
    const lPos = logGeo.attributes.position;
    for (let i = 0; i < lPos.count; i++) {
      const lx = lPos.getX(i);
      const ly = lPos.getY(i);
      const lz = lPos.getZ(i);
      const bark = 1.0 + Math.sin(ly * 7.0 + lx * 14.0) * 0.08;
      lPos.setXYZ(i, lx * bark, ly, lz * bark);
    }
    logGeo.computeVertexNormals();
    this._geometries.push(logGeo);

    const logCount = 6;
    for (let i = 0; i < logCount; i++) {
      const ang = (i / logCount) * Math.PI * 2 + 0.25 + (rng() - 0.5) * 0.24;
      const log = new THREE.Mesh(logGeo, this._logMat);
      const radialOffset = 0.24 + rng() * 0.14;
      log.position.set(
        Math.cos(ang) * radialOffset,
        0.24 + (i % 2) * 0.06,
        Math.sin(ang) * radialOffset
      );
      log.rotation.order = 'YXZ';
      log.rotation.y = ang + Math.PI * 0.5;
      log.rotation.z = 0.94 + (rng() - 0.5) * 0.18;
      log.castShadow = true;
      log.receiveShadow = true;
      log.userData.interactive = 'campfire';
      group.add(log);
    }

    // 4. Flickering warm PointLight
    this._campfireLight = new THREE.PointLight(0xff7b28, 15.0, 28, 1.75);
    this._campfireLight.position.set(0, 1.38, 0);
    group.add(this._campfireLight);

    // 5. Animated stylized flickering flame planes (3 crossed procedural shader planes)
    const flameGeo = new THREE.PlaneGeometry(1.22, 1.68, 6, 12);
    flameGeo.translate(0, 0.82, 0);
    this._geometries.push(flameGeo);

    this._flameUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 1.0 },
      uWindLean: { value: new THREE.Vector2(0, 0) },
    };

    const flameMat = new THREE.ShaderMaterial({
      uniforms: this._flameUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uIntensity;
        uniform vec2 uWindLean;
        varying vec2 vUv;
        varying float vHeight;

        void main() {
          vUv = uv;
          vHeight = uv.y;
          vec3 pos = position;

          float h = clamp(uv.y, 0.0, 1.0);
          pos.y *= mix(0.18, 1.0, uIntensity);

          // Organic upward dancing flutter + gentle wind lean
          float sway = sin(uTime * 7.2 - h * 5.4 + pos.x * 3.1) * 0.095 * h * h;
          float sway2 = cos(uTime * 11.4 - h * 7.8) * 0.045 * h;
          pos.x += sway + sway2;

          vec4 worldPos = modelMatrix * vec4(pos, 1.0);
          worldPos.x += uWindLean.x * h * h * 0.36;
          worldPos.z += uWindLean.y * h * h * 0.36;

          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uIntensity;
        varying vec2 vUv;
        varying float vHeight;

        float fHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float fNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(fHash(i), fHash(i + vec2(1.0, 0.0)), u.x),
            mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }

        float fFbm(vec2 p) {
          float v = 0.0;
          float a = 0.55;
          for (int i = 0; i < 3; i++) {
            v += a * fNoise(p);
            p = p * 2.1 + vec2(3.7, -5.2);
            a *= 0.48;
          }
          return v;
        }

        void main() {
          if (uIntensity <= 0.005) discard;

          vec2 uv = vUv;
          float y = uv.y;
          float x = (uv.x - 0.5) * 2.0;

          // Upward-scrolling turbulent fire noise
          float n1 = fFbm(vec2(uv.x * 3.8, y * 2.9 - uTime * 3.1));
          float n2 = fNoise(vec2(uv.x * 7.5 + n1 * 1.4, y * 5.2 - uTime * 5.4));
          float turb = n1 * 0.68 + n2 * 0.32;

          // Tapered flickering teardrop silhouette
          float width = mix(0.88, 0.06, pow(y, 0.82)) + (turb - 0.5) * 0.42 * y;
          float radial = abs(x + (turb - 0.5) * 0.32 * y) / max(width, 0.04);
          float shape = (1.0 - smoothstep(0.32, 1.0, radial))
                      * smoothstep(0.0, 0.14, y)
                      * (1.0 - smoothstep(0.58, 1.0, y + (0.5 - turb) * 0.38));

          float flameMask = clamp(shape * (0.72 + turb * 0.65), 0.0, 1.0);
          if (flameMask < 0.02) discard;

          // HDR orange-gold core so UnrealBloomPass blooms softly
          float core = clamp((1.0 - radial * 1.15) * (1.0 - y * 1.15), 0.0, 1.0);
          vec3 outerCol = vec3(1.15, 0.22, 0.02);
          vec3 midCol = vec3(2.15, 0.85, 0.12);
          vec3 coreCol = vec3(3.1, 2.25, 0.95);

          vec3 col = mix(outerCol, midCol, smoothstep(0.15, 0.65, flameMask));
          col = mix(col, coreCol, smoothstep(0.28, 0.88, core));

          float alpha = flameMask * 0.86 * uIntensity;
          gl_FragColor = vec4(col * uIntensity, alpha);
        }
      `,
    });
    this._materials.push(flameMat);

    for (let i = 0; i < 3; i++) {
      const plane = new THREE.Mesh(flameGeo, flameMat);
      plane.rotation.y = (i * Math.PI) / 3;
      plane.position.y = 0.08;
      plane.renderOrder = 2;
      group.add(plane);
    }

    // 6. Rising glowing HDR sparks / embers (90 particles)
    this._initCampfireEmbers(group, rng);

    // 7. Rising translucent smoke wisps (45 particles)
    this._initCampfireSmoke(group, rng);

    // 8. Generous invisible hit sphere (r = 2.0) for effortless clicking
    const hitGeo = new THREE.SphereGeometry(2.0, 12, 10);
    const hitMat = new THREE.MeshBasicMaterial({
      visible: false,
      side: THREE.DoubleSide,
    });
    this._geometries.push(hitGeo);
    this._materials.push(hitMat);

    this._campfireHitSphere = new THREE.Mesh(hitGeo, hitMat);
    this._campfireHitSphere.position.set(0, 0.85, 0);
    this._campfireHitSphere.userData.interactive = 'campfire';
    group.add(this._campfireHitSphere);
    this._interactiveTargets.push(this._campfireHitSphere);

    this.scene.add(group);
  }

  _initCampfireEmbers(group, rng) {
    const positions = new Float32Array(EMBER_COUNT * 3);
    const sizes = new Float32Array(EMBER_COUNT);
    const lives = new Float32Array(EMBER_COUNT);
    const seeds = new Float32Array(EMBER_COUNT);

    this._emberState = [];
    for (let i = 0; i < EMBER_COUNT; i++) {
      const life = rng();
      const maxLife = 1.6 + rng() * 2.1;
      const angle = rng() * Math.PI * 2;
      const rad = rng() * 0.45;
      const st = {
        x: Math.cos(angle) * rad,
        y: 0.2 + life * 4.2,
        z: Math.sin(angle) * rad,
        vx: (rng() - 0.5) * 0.35,
        vy: 1.15 + rng() * 1.45,
        vz: (rng() - 0.5) * 0.35,
        life,
        maxLife,
        seed: rng() * 100.0,
        size: 16 + rng() * 22,
      };
      this._emberState.push(st);
      positions[i * 3] = st.x;
      positions[i * 3 + 1] = st.y;
      positions[i * 3 + 2] = st.z;
      sizes[i] = st.size;
      lives[i] = st.life;
      seeds[i] = st.seed;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aLife', new THREE.BufferAttribute(lives, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this._geometries.push(geo);

    this._emberUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 1.0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this._emberUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aLife;
        attribute float aSeed;
        uniform float uPixelRatio;
        varying float vLife;
        varying float vSeed;

        void main() {
          vLife = aLife;
          vSeed = aSeed;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          float lifeScale = sin(clamp(aLife, 0.0, 1.0) * 3.14159);
          gl_PointSize = clamp((aSize * lifeScale * uPixelRatio) / max(-mvPos.z, 0.8), 1.5, 22.0);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uIntensity;
        varying float vLife;
        varying float vSeed;

        void main() {
          if (uIntensity <= 0.005) discard;
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d) * 2.0;
          if (r > 1.0) discard;

          float glow = pow(1.0 - r, 2.2);
          float flicker = 0.72 + 0.28 * sin(uTime * 14.0 + vSeed);
          float fade = smoothstep(0.0, 0.12, vLife) * (1.0 - smoothstep(0.68, 1.0, vLife));

          // Hot HDR gold-orange spark cooling toward deep ember red
          vec3 hotCol = vec3(3.4, 1.85, 0.45);
          vec3 coolCol = vec3(1.9, 0.38, 0.06);
          vec3 col = mix(hotCol, coolCol, vLife);

          float alpha = glow * fade * flicker * uIntensity;
          gl_FragColor = vec4(col * alpha, alpha);
        }
      `,
    });
    this._materials.push(mat);

    this._emberPoints = new THREE.Points(geo, mat);
    this._emberPoints.frustumCulled = false;
    this._emberPoints.renderOrder = 3;
    group.add(this._emberPoints);
  }

  _initCampfireSmoke(group, rng) {
    const positions = new Float32Array(SMOKE_COUNT * 3);
    const sizes = new Float32Array(SMOKE_COUNT);
    const lives = new Float32Array(SMOKE_COUNT);
    const seeds = new Float32Array(SMOKE_COUNT);

    this._smokeState = [];
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const life = rng();
      const maxLife = 4.2 + rng() * 3.2;
      const angle = rng() * Math.PI * 2;
      const rad = rng() * 0.35;
      const st = {
        x: Math.cos(angle) * rad,
        y: 1.0 + life * 7.5,
        z: Math.sin(angle) * rad,
        vy: 0.95 + rng() * 0.55,
        life,
        maxLife,
        seed: rng() * 100.0,
        baseSize: 135 + rng() * 115,
      };
      this._smokeState.push(st);
      positions[i * 3] = st.x;
      positions[i * 3 + 1] = st.y;
      positions[i * 3 + 2] = st.z;
      sizes[i] = st.baseSize;
      lives[i] = st.life;
      seeds[i] = st.seed;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aLife', new THREE.BufferAttribute(lives, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this._geometries.push(geo);

    this._smokeUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 1.0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this._smokeUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aLife;
        attribute float aSeed;
        uniform float uPixelRatio;
        varying float vLife;
        varying float vSeed;

        void main() {
          vLife = aLife;
          vSeed = aSeed;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          float expand = mix(0.55, 1.95, aLife);
          gl_PointSize = clamp((aSize * expand * uPixelRatio) / max(-mvPos.z, 1.0), 6.0, 145.0);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uIntensity;
        varying float vLife;
        varying float vSeed;

        void main() {
          if (uIntensity <= 0.005) discard;
          vec2 uv = gl_PointCoord - vec2(0.5);
          float ang = vSeed + uTime * 0.25;
          float c = cos(ang);
          float s = sin(ang);
          vec2 ruv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);

          float dist = length(ruv) * 2.0;
          if (dist > 1.0) discard;

          float billow = 0.82 + 0.18 * sin(ruv.x * 11.0 + vSeed) * cos(ruv.y * 11.0 - vSeed);
          float soft = pow(max(0.0, 1.0 - dist), 2.15) * billow;
          float fade = smoothstep(0.0, 0.18, vLife) * (1.0 - smoothstep(0.52, 1.0, vLife));

          // Warm ember under-glow near base fading to soft woodland smoke gray
          vec3 warmSmoke = vec3(0.42, 0.30, 0.23);
          vec3 coolSmoke = vec3(0.32, 0.34, 0.36);
          vec3 col = mix(warmSmoke, coolSmoke, smoothstep(0.05, 0.55, vLife));

          float alpha = soft * fade * 0.24 * uIntensity;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    this._materials.push(mat);

    this._smokePoints = new THREE.Points(geo, mat);
    this._smokePoints.frustumCulled = false;
    this._smokePoints.renderOrder = 1;
    group.add(this._smokePoints);
  }

  _updateCampfire(dt, elapsed) {
    // Smoothly transition heat between 0 (extinguished) and 1 (lit)
    const targetHeat = this._campfireLit ? 1.0 : 0.0;
    const rate = this._campfireLit ? 3.8 : 2.6;
    this._campfireHeat = lerp(this._campfireHeat, targetHeat, 1.0 - Math.exp(-dt * rate));
    if (Math.abs(this._campfireHeat - targetHeat) < 0.002) {
      this._campfireHeat = targetHeat;
    }

    const heat = this._campfireHeat;
    const windSample = this.windSystem
      ? this.windSystem.sampleGustAt(this.campfirePos.x, this.campfirePos.z)
      : { intensity: 0.4, dirX: 1, dirZ: 0 };

    // Organic multi-sine fire flicker
    const flicker =
      1.0 +
      Math.sin(elapsed * 11.7) * 0.12 +
      Math.sin(elapsed * 19.3 + 1.4) * 0.07 +
      Math.cos(elapsed * 29.1 + 0.7) * 0.04;

    // Update PointLight intensity, warmth, and tiny dancing offset
    this._campfireLight.intensity = heat > 0.002 ? 15.5 * heat * flicker : 0;
    this._campfireLight.position.set(
      Math.sin(elapsed * 9.3) * 0.065 + windSample.dirX * windSample.intensity * 0.06,
      1.36 + Math.sin(elapsed * 14.1) * 0.045,
      Math.cos(elapsed * 8.7) * 0.065 + windSample.dirZ * windSample.intensity * 0.06
    );
    const colorShift = clamp((flicker - 0.82) * 1.4, 0, 1);
    this._campfireLight.color.setRGB(
      1.0,
      lerp(0.38, 0.56, colorShift),
      lerp(0.09, 0.21, colorShift)
    );

    // Update glowing charcoal mound & charred logs emissive
    this._emberMoundMat.emissiveIntensity = heat * (2.15 * flicker);
    this._logMat.emissiveIntensity = heat * (0.36 * flicker);

    // Update flame shader uniforms
    this._flameUniforms.uTime.value = elapsed;
    this._flameUniforms.uIntensity.value = heat;
    this._flameUniforms.uWindLean.value.set(
      windSample.dirX * clamp(windSample.intensity * 0.55, 0, 1.4),
      windSample.dirZ * clamp(windSample.intensity * 0.55, 0, 1.4)
    );

    // Update rising HDR sparks/embers
    const pixelRatio = this.engine.renderer.getPixelRatio();
    this._emberUniforms.uTime.value = elapsed;
    this._emberUniforms.uIntensity.value = heat;
    this._emberUniforms.uPixelRatio.value = pixelRatio;

    const ePosAttr = this._emberPoints.geometry.attributes.position;
    const eLifeAttr = this._emberPoints.geometry.attributes.aLife;
    const windPushX = windSample.dirX * (0.42 + windSample.intensity * 0.95);
    const windPushZ = windSample.dirZ * (0.42 + windSample.intensity * 0.95);

    if (heat > 0.004) {
      for (let i = 0; i < EMBER_COUNT; i++) {
        const st = this._emberState[i];
        st.life += dt / st.maxLife;
        if (st.life >= 1.0) {
          st.life -= Math.floor(st.life);
          const ang = (st.seed * 13.7 + elapsed * 3.1) % (Math.PI * 2);
          const rad = 0.08 + ((st.seed * 7.3) % 1.0) * 0.44;
          st.x = Math.cos(ang) * rad;
          st.y = 0.22 + ((st.seed * 3.1) % 0.28);
          st.z = Math.sin(ang) * rad;
        } else {
          const curlX = Math.sin(elapsed * 3.2 + st.seed + st.y * 1.4) * 0.42;
          const curlZ = Math.cos(elapsed * 2.9 + st.seed * 1.3 + st.y * 1.3) * 0.42;
          st.x += (st.vx + curlX + windPushX * (0.35 + st.life * 0.95)) * dt;
          st.y += st.vy * (1.0 - st.life * 0.22) * dt;
          st.z += (st.vz + curlZ + windPushZ * (0.35 + st.life * 0.95)) * dt;
        }
        ePosAttr.setXYZ(i, st.x, st.y, st.z);
        eLifeAttr.setX(i, st.life);
      }
      ePosAttr.needsUpdate = true;
      eLifeAttr.needsUpdate = true;
    }

    // Update rising translucent smoke wisps
    const smokeHeat = clamp(heat * 1.15, 0, 1);
    this._smokeUniforms.uTime.value = elapsed;
    this._smokeUniforms.uIntensity.value = smokeHeat;
    this._smokeUniforms.uPixelRatio.value = pixelRatio;

    const sPosAttr = this._smokePoints.geometry.attributes.position;
    const sLifeAttr = this._smokePoints.geometry.attributes.aLife;

    if (smokeHeat > 0.004) {
      for (let i = 0; i < SMOKE_COUNT; i++) {
        const st = this._smokeState[i];
        st.life += dt / st.maxLife;
        if (st.life >= 1.0) {
          st.life -= Math.floor(st.life);
          const ang = (st.seed * 11.3 + elapsed * 1.7) % (Math.PI * 2);
          const rad = ((st.seed * 5.1) % 1.0) * 0.34;
          st.x = Math.cos(ang) * rad;
          st.y = 0.95;
          st.z = Math.sin(ang) * rad;
        } else {
          const driftX = Math.sin(elapsed * 0.9 + st.seed) * 0.28 + windPushX * (0.55 + st.life * 1.25);
          const driftZ = Math.cos(elapsed * 0.82 + st.seed * 1.1) * 0.28 + windPushZ * (0.55 + st.life * 1.25);
          st.x += driftX * dt;
          st.y += st.vy * dt;
          st.z += driftZ * dt;
        }
        sPosAttr.setXYZ(i, st.x, st.y, st.z);
        sLifeAttr.setX(i, st.life);
      }
      sPosAttr.needsUpdate = true;
      sLifeAttr.needsUpdate = true;
    }
  }

  toggleCampfire(forceState) {
    const next = typeof forceState === 'boolean' ? forceState : !this._campfireLit;
    this._campfireLit = next;
    this.callbacks.onCampfireToggle?.(this._campfireLit);
    this._updatePrompt();
    return this._campfireLit;
  }

  isCampfireLit() {
    return this._campfireLit;
  }

  // ---------------------------------------------------------------------------
  // Interactive Startled Bird Flock (18 Stylized Birds + 3D Boid Steering)
  // ---------------------------------------------------------------------------

  _initBirds() {
    const rng = createRng(5521);

    // Resting perch center near clearingCenter + (-5.2, 0, -5.0)
    const perchX = this.campfirePos.x - 5.2;
    const perchZ = this.campfirePos.z - 5.0;
    const perchY = this.terrain.getHeightAt(perchX, perchZ);
    this._birdPerchCenter = new THREE.Vector3(perchX, perchY, perchZ);

    // 3 rich woodland plumage palettes (robin-russet, slate-blue, warm cinnamon-brown)
    const palettes = [
      {
        // Woodland Robin: russet-orange breast, warm slate-charcoal back
        back: [0.24, 0.23, 0.22],
        crown: [0.19, 0.18, 0.19],
        breast: [0.76, 0.34, 0.16],
        tail: [0.17, 0.16, 0.16],
        beak: [0.85, 0.66, 0.22],
        wingRoot: [0.26, 0.24, 0.22],
        wingTip: [0.14, 0.13, 0.13],
        wingUnder: [0.56, 0.44, 0.34],
      },
      {
        // Bluebird / Woodland Jay: slate-blue back & crown, soft chestnut breast
        back: [0.21, 0.34, 0.49],
        crown: [0.18, 0.31, 0.47],
        breast: [0.68, 0.39, 0.23],
        tail: [0.16, 0.25, 0.37],
        beak: [0.22, 0.21, 0.2],
        wingRoot: [0.23, 0.36, 0.52],
        wingTip: [0.13, 0.18, 0.27],
        wingUnder: [0.62, 0.64, 0.68],
      },
      {
        // Forest Thrush / Finch: warm cinnamon-brown back, creamy ochre breast
        back: [0.43, 0.29, 0.18],
        crown: [0.36, 0.23, 0.14],
        breast: [0.78, 0.64, 0.45],
        tail: [0.28, 0.19, 0.12],
        beak: [0.74, 0.56, 0.26],
        wingRoot: [0.42, 0.28, 0.17],
        wingTip: [0.21, 0.15, 0.1],
        wingUnder: [0.68, 0.58, 0.46],
      },
    ];

    const birdMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.74,
      metalness: 0.03,
    });
    this._materials.push(birdMat);

    const variantGeos = palettes.map((pal) => {
      const g = createBirdGeometries(pal);
      this._geometries.push(g.bodyGeometry, g.leftWingGeometry, g.rightWingGeometry);
      return g;
    });

    this.birdFlockGroup = new THREE.Group();
    this.birdFlockGroup.name = 'ForestBirdFlock';

    for (let i = 0; i < BIRD_COUNT; i++) {
      const variant = variantGeos[i % variantGeos.length];
      const root = new THREE.Group();

      const body = new THREE.Mesh(variant.bodyGeometry, birdMat);
      body.castShadow = true;
      body.receiveShadow = true;
      body.userData.interactive = 'birds';

      const leftWing = new THREE.Mesh(variant.leftWingGeometry, birdMat);
      leftWing.position.set(-0.056, 0.014, 0.01);
      leftWing.castShadow = true;
      leftWing.userData.interactive = 'birds';

      const rightWing = new THREE.Mesh(variant.rightWingGeometry, birdMat);
      rightWing.position.set(0.056, 0.014, 0.01);
      rightWing.castShadow = true;
      rightWing.userData.interactive = 'birds';

      root.add(body);
      root.add(leftWing);
      root.add(rightWing);

      const birdScale = 1.05 + rng() * 0.24;
      root.scale.setScalar(birdScale);

      // Natural scattered ground/rock perch around perchCenter (kept safely above stream water)
      let px = perchX;
      let pz = perchZ;
      for (let attempt = 0; attempt < 8; attempt++) {
        const ang = (i / BIRD_COUNT) * Math.PI * 2 + (rng() - 0.5) * 0.9;
        const rad = 0.55 + Math.sqrt(rng()) * 3.15;
        const cx = perchX + Math.cos(ang) * rad;
        const cz = perchZ + Math.sin(ang) * rad;
        const cy = this.terrain.getHeightAt(cx, cz);
        if (cy >= WATER_LEVEL + 0.25) {
          px = cx;
          pz = cz;
          break;
        }
      }
      const py = this.terrain.getHeightAt(px, pz) + 0.095 * birdScale;
      const idleYaw = rng() * Math.PI * 2;

      root.position.set(px, py, pz);
      root.rotation.set(0, idleYaw, 0);
      leftWing.rotation.z = 0.42;
      rightWing.rotation.z = -0.42;

      this.birdFlockGroup.add(root);
      this._interactiveTargets.push(body);

      this._birds.push({
        root,
        leftWing,
        rightWing,
        scale: birdScale,
        perchPos: new THREE.Vector3(px, py, pz),
        pos: new THREE.Vector3(px, py, pz),
        vel: new THREE.Vector3(0, 0, 1),
        acc: new THREE.Vector3(),
        bankAngle: 0,
        flapPhase: rng() * Math.PI * 2,
        flapRate: 11.5 + rng() * 3.2,
        glideCycle: rng() * Math.PI * 2,
        wingAngle: -0.42,
        idleYaw,
        targetIdleYaw: idleYaw,
        lookTimer: 0.6 + rng() * 2.5,
        hopTimer: 1.5 + rng() * 4.5,
        hopProgress: -1,
        landed: true,
        speedPref: 8.6 + rng() * 3.2,
      });
    }

    // Invisible interactive hit sphere (r = 4.2) centered on resting flock
    const birdHitGeo = new THREE.SphereGeometry(4.2, 14, 10);
    const birdHitMat = new THREE.MeshBasicMaterial({
      visible: false,
      side: THREE.DoubleSide,
    });
    this._geometries.push(birdHitGeo);
    this._materials.push(birdHitMat);

    this._birdHitSphere = new THREE.Mesh(birdHitGeo, birdHitMat);
    this._birdHitSphere.position.set(perchX, perchY + 0.85, perchZ);
    this._birdHitSphere.userData.interactive = 'birds';
    this.birdFlockGroup.add(this._birdHitSphere);
    this._interactiveTargets.push(this._birdHitSphere);

    this.scene.add(this.birdFlockGroup);
  }

  startleBirds() {
    this.audio?.triggerBirdStartle?.();
    this.callbacks.onBirdsStartled?.();

    const wasPerched = this._flockState === 'perched';
    this._flockState = 'flying';
    this._flightTimer = 0;
    this._landingTimer = 0;

    // Launch all 18 birds upward & outward with energetic takeoff burst
    for (let i = 0; i < this._birds.length; i++) {
      const b = this._birds[i];
      b.landed = false;
      b.hopProgress = -1;

      if (wasPerched || b.vel.lengthSq() < 16) {
        const outX = b.pos.x - this._birdPerchCenter.x;
        const outZ = b.pos.z - this._birdPerchCenter.z;
        const len = Math.hypot(outX, outZ) || 1;
        const spreadAng = (Math.random() - 0.5) * 0.9;
        const cosA = Math.cos(spreadAng);
        const sinA = Math.sin(spreadAng);
        const dx = (outX / len) * cosA - (outZ / len) * sinA;
        const dz = (outX / len) * sinA + (outZ / len) * cosA;

        const horizSpeed = 5.5 + Math.random() * 3.5;
        b.vel.set(dx * horizSpeed, 5.2 + Math.random() * 2.8, dz * horizSpeed);
      } else {
        // Already flying — give a quick startled climb & scatter burst
        b.vel.y = Math.max(b.vel.y, 3.8 + Math.random() * 2.2);
        b.vel.x += (Math.random() - 0.5) * 3.0;
        b.vel.z += (Math.random() - 0.5) * 3.0;
      }
      b.flapPhase = Math.random() * Math.PI * 2;
    }

    this._updatePrompt();
  }

  areBirdsFlying() {
    return this._flockState !== 'perched';
  }

  /**
   * Fixed-timestep 3D Boid steering solver (Separation, Alignment, Cohesion,
   * valley/canopy orbit attraction, terrain clearance, speed clamping, landing).
   */
  updateFixed(fixedDt, elapsed) {
    const birds = this._birds;
    const count = birds.length;

    if (this._flockState === 'perched') {
      // Cute idle head turns & occasional tiny hops on the ground
      for (let i = 0; i < count; i++) {
        const b = birds[i];
        b.lookTimer -= fixedDt;
        if (b.lookTimer <= 0) {
          b.targetIdleYaw = b.idleYaw + (Math.random() - 0.5) * 2.1;
          b.lookTimer = 1.1 + Math.random() * 2.8;
        }
        b.idleYaw = lerp(b.idleYaw, b.targetIdleYaw, 1.0 - Math.exp(-fixedDt * 7.5));

        b.hopTimer -= fixedDt;
        if (b.hopProgress < 0 && b.hopTimer <= 0) {
          b.hopProgress = 0;
          b.hopTimer = 2.6 + Math.random() * 5.2;
        }

        let hopY = 0;
        if (b.hopProgress >= 0) {
          b.hopProgress += fixedDt * 3.6;
          if (b.hopProgress >= 1.0) {
            b.hopProgress = -1;
          } else {
            hopY = Math.sin(b.hopProgress * Math.PI) * 0.22;
          }
        }

        b.pos.set(b.perchPos.x, b.perchPos.y + hopY, b.perchPos.z);
        b.wingAngle = lerp(b.wingAngle, -0.42 + (hopY > 0.02 ? 0.32 : 0), 1.0 - Math.exp(-fixedDt * 12));
      }
      return;
    }

    if (this._flockState === 'flying') {
      this._flightTimer += fixedDt;
      if (this._flightTimer >= BIRD_FLIGHT_DURATION) {
        this._flockState = 'landing';
        this._landingTimer = 0;
      }

      // Scenic moving attraction point circling over valley, stream & canopy
      const orbitAngle = elapsed * 0.24;
      const orbitX = this.campfirePos.x - 10.5 + Math.cos(orbitAngle) * 25.0;
      const orbitZ = this.campfirePos.z + Math.sin(orbitAngle * 0.85) * 27.0;
      const orbitGroundY = this.terrain.getHeightAt(orbitX, orbitZ);
      const orbitY = orbitGroundY + 13.0 + Math.sin(elapsed * 0.42) * 3.8;

      const sepRadiusSq = 2.6 * 2.6;
      const aliRadiusSq = 7.8 * 7.8;
      const cohRadiusSq = 10.0 * 10.0;

      for (let i = 0; i < count; i++) {
        const b = birds[i];
        _sep.set(0, 0, 0);
        _ali.set(0, 0, 0);
        _coh.set(0, 0, 0);
        let sepCount = 0;
        let aliCount = 0;
        let cohCount = 0;

        for (let j = 0; j < count; j++) {
          if (i === j) continue;
          const o = birds[j];
          const dx = b.pos.x - o.pos.x;
          const dy = b.pos.y - o.pos.y;
          const dz = b.pos.z - o.pos.z;
          const dSq = dx * dx + dy * dy + dz * dz;
          if (dSq < 1e-6) continue;

          if (dSq < sepRadiusSq) {
            const invD = 1.0 / dSq;
            _sep.x += dx * invD;
            _sep.y += dy * invD;
            _sep.z += dz * invD;
            sepCount++;
          }
          if (dSq < aliRadiusSq) {
            _ali.add(o.vel);
            aliCount++;
          }
          if (dSq < cohRadiusSq) {
            _coh.add(o.pos);
            cohCount++;
          }
        }

        b.acc.set(0, 0, 0);

        if (sepCount > 0) {
          _sep.divideScalar(sepCount);
          if (_sep.lengthSq() > 1e-5) {
            _sep.normalize().multiplyScalar(14.5);
            b.acc.add(_sep);
          }
        }

        if (aliCount > 0) {
          _ali.divideScalar(aliCount).sub(b.vel).multiplyScalar(1.35);
          b.acc.add(_ali);
        }

        if (cohCount > 0) {
          _coh.divideScalar(cohCount).sub(b.pos);
          if (_coh.lengthSq() > 1e-4) {
            _coh.multiplyScalar(0.82);
            b.acc.add(_coh);
          }
        }

        // Gentle orbit attraction over the valley & tree canopy
        _v1.set(orbitX - b.pos.x, orbitY - b.pos.y, orbitZ - b.pos.z);
        const distToOrbit = _v1.length();
        if (distToOrbit > 0.1) {
          const pull = clamp(distToOrbit * 0.22, 1.5, 9.5);
          b.acc.addScaledVector(_v1, pull / distToOrbit);
        }

        // Soft boundary return if straying far from the clearing valley
        const dxHome = b.pos.x - (this.campfirePos.x - 8.0);
        const dzHome = b.pos.z - this.campfirePos.z;
        const homeDist = Math.hypot(dxHome, dzHome);
        if (homeDist > 54.0) {
          const backPull = (homeDist - 54.0) * 0.55;
          b.acc.x -= (dxHome / homeDist) * backPull;
          b.acc.z -= (dzHome / homeDist) * backPull;
        }

        // Terrain height clearance (terrain.getHeightAt(x, z) + 5.5) & canopy ceiling
        const groundY = Math.max(this.terrain.getHeightAt(b.pos.x, b.pos.z), WATER_LEVEL);
        const minAlt = groundY + BIRD_TERRAIN_CLEARANCE;
        const maxAlt = groundY + 27.0;
        if (b.pos.y < minAlt) {
          b.acc.y += (minAlt - b.pos.y) * 8.5 + 4.0;
        } else if (b.pos.y > maxAlt) {
          b.acc.y -= (b.pos.y - maxAlt) * 3.5;
        }

        // Initial takeoff boost during first 1.8 seconds
        if (this._flightTimer < 1.8) {
          b.acc.y += (1.8 - this._flightTimer) * 3.5;
        }

        // Integrate velocity & clamp strictly to 7..13 u/s
        b.vel.addScaledVector(b.acc, fixedDt);
        const speed = b.vel.length();
        const targetMax = Math.min(BIRD_MAX_SPEED, b.speedPref + 1.8);
        if (speed < BIRD_MIN_SPEED) {
          b.vel.multiplyScalar(BIRD_MIN_SPEED / Math.max(speed, 0.001));
        } else if (speed > targetMax) {
          b.vel.multiplyScalar(targetMax / speed);
        }

        // Keep vertical pitch reasonable
        const maxVy = b.vel.length() * 0.62;
        b.vel.y = clamp(b.vel.y, -maxVy, maxVy);

        b.pos.addScaledVector(b.vel, fixedDt);

        // Hard safety floor above terrain while soaring
        const safeFloor = Math.max(this.terrain.getHeightAt(b.pos.x, b.pos.z), WATER_LEVEL) + 3.0;
        if (b.pos.y < safeFloor) {
          b.pos.y = safeFloor;
          if (b.vel.y < 1.5) b.vel.y = 1.5;
        }

        // Compute realistic bank-into-turn roll from lateral acceleration
        _v2.copy(b.vel).normalize();
        _right.crossVectors(_up, _v2);
        if (_right.lengthSq() > 1e-4) {
          _right.normalize();
          const latAcc = b.acc.dot(_right);
          const targetBank = clamp(latAcc * 0.095, -0.82, 0.82);
          b.bankAngle = lerp(b.bankAngle, targetBank, 1.0 - Math.exp(-fixedDt * 6.0));
        }

        // Wing flap vs glide cycle (rapid on takeoff/climb, alternating flap & glide cruising)
        const climbing = b.vel.y > 0.7 || this._flightTimer < 2.2;
        b.glideCycle += fixedDt * 1.15;
        const glideBlend = climbing ? 0.0 : clamp(Math.sin(b.glideCycle) * 1.35 - 0.35, 0, 1);
        b.flapPhase += fixedDt * b.flapRate * (climbing ? 1.25 : 1.0);
        const flapAmp = lerp(0.76, 0.06, glideBlend);
        const flapCenter = lerp(0.05, 0.14, glideBlend);
        b.wingAngle = flapCenter + Math.sin(b.flapPhase) * flapAmp;
      }
      return;
    }

    // 'landing' state: gracefully descend & re-perch near the clearing
    this._landingTimer += fixedDt;
    let allLanded = true;

    for (let i = 0; i < count; i++) {
      const b = birds[i];
      if (b.landed) continue;

      _v1.subVectors(b.perchPos, b.pos);
      const dist = _v1.length();

      if (dist < 0.28 || this._landingTimer > 11.5) {
        b.pos.copy(b.perchPos);
        b.vel.set(0, 0, 0);
        b.bankAngle = 0;
        b.wingAngle = -0.42;
        b.landed = true;
        continue;
      }

      allLanded = false;

      // Steer along a smooth descending arc toward perch spot
      const desiredSpeed = clamp(dist * 1.15, 1.8, 10.5);
      _v2.copy(_v1).normalize().multiplyScalar(desiredSpeed);
      // Keep slightly above approach path until close so birds swoop gracefully over bushes
      if (dist > 3.0) {
        const approachGround = Math.max(this.terrain.getHeightAt(b.pos.x, b.pos.z), WATER_LEVEL);
        const desiredClearY = Math.max(b.perchPos.y + dist * 0.22, approachGround + 1.4);
        _v2.y = clamp((desiredClearY - b.pos.y) * 1.8, -5.5, 4.5);
      }

      // Light separation while landing
      _sep.set(0, 0, 0);
      for (let j = 0; j < count; j++) {
        if (i === j || birds[j].landed) continue;
        const dx = b.pos.x - birds[j].pos.x;
        const dy = b.pos.y - birds[j].pos.y;
        const dz = b.pos.z - birds[j].pos.z;
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq > 1e-5 && dSq < 2.25) {
          _sep.x += dx / dSq;
          _sep.y += dy / dSq;
          _sep.z += dz / dSq;
        }
      }

      b.acc.subVectors(_v2, b.vel).multiplyScalar(3.2).addScaledVector(_sep, 2.2);
      b.vel.addScaledVector(b.acc, fixedDt);
      const spd = b.vel.length();
      if (spd > desiredSpeed + 1.5) {
        b.vel.multiplyScalar((desiredSpeed + 1.5) / spd);
      }

      b.pos.addScaledVector(b.vel, fixedDt);
      const minY = this.terrain.getHeightAt(b.pos.x, b.pos.z) + 0.095 * b.scale;
      if (b.pos.y < minY) b.pos.y = minY;

      // Rapid braking flutter right before touchdown
      b.bankAngle = lerp(b.bankAngle, 0, 1.0 - Math.exp(-fixedDt * 5.0));
      b.flapPhase += fixedDt * b.flapRate * (dist < 4.0 ? 1.45 : 1.05);
      b.wingAngle = 0.12 + Math.sin(b.flapPhase) * (dist < 4.0 ? 0.82 : 0.65);
    }

    if (allLanded) {
      this._flockState = 'perched';
      this._updatePrompt();
    }
  }

  /**
   * Syncs bird meshes & hinged wings from simulation state each render frame.
   */
  _syncBirdMeshes(dt) {
    const birds = this._birds;
    for (let i = 0; i < birds.length; i++) {
      const b = birds[i];
      b.root.position.copy(b.pos);

      if (this._flockState === 'perched' || b.landed) {
        _euler.set(0, b.idleYaw, 0, 'YXZ');
        _quat.setFromEuler(_euler);
        b.root.quaternion.slerp(_quat, 1.0 - Math.exp(-dt * 12.0));
      } else if (b.vel.lengthSq() > 0.04) {
        // Align +Z forward with velocity and tilt up-vector by bankAngle
        _v3.copy(b.vel).normalize();
        _right.crossVectors(_up, _v3);
        if (_right.lengthSq() < 1e-4) {
          _right.set(1, 0, 0);
        } else {
          _right.normalize();
        }
        _v4.crossVectors(_v3, _right).normalize(); // natural up

        // Rotate up vector around forward axis by bankAngle
        const cosB = Math.cos(b.bankAngle);
        const sinB = Math.sin(b.bankAngle);
        _bankUp.copy(_v4).multiplyScalar(cosB).addScaledVector(_right, sinB).normalize();
        _v5.crossVectors(_bankUp, _v3).normalize(); // banked right

        _mat4.makeBasis(_v5, _bankUp, _v3);
        _quat.setFromRotationMatrix(_mat4);
        b.root.quaternion.slerp(_quat, 1.0 - Math.exp(-dt * 14.0));
      }

      // Mirror flap angle across left & right hinged wings
      b.leftWing.rotation.z = -b.wingAngle;
      b.rightWing.rotation.z = b.wingAngle;
    }
  }

  // ---------------------------------------------------------------------------
  // Camera Modes, Movement & Raycasting
  // ---------------------------------------------------------------------------

  getCameraMode() {
    return this._cameraMode;
  }

  setCameraMode(mode) {
    const targetMode = mode === 'First-Person' ? 'First-Person' : 'Orbit';
    if (targetMode === this._cameraMode) return;

    this._cameraMode = targetMode;

    if (targetMode === 'First-Person') {
      this.orbitControls.enabled = false;
      this.pointerLockControls.enabled = true;

      // Spawn First-Person explorer at camera XZ (clamped inside bounds & off deep riverbed)
      let x = clamp(this.camera.position.x, -MAP_BOUND + 5, MAP_BOUND - 5);
      let z = clamp(this.camera.position.z, -MAP_BOUND + 5, MAP_BOUND - 5);

      if (this.terrain.getHeightAt(x, z) < WATER_LEVEL - 0.35) {
        // Gently nudge onto dry bank beside campfire clearing
        x = this.campfirePos.x + 6.5;
        z = this.campfirePos.z + 6.5;
      }

      this._fpPos.set(x, 0, z);
      this.spatialHash.resolveCircle(this._fpPos, FP_PLAYER_RADIUS);

      const groundY = Math.max(this.terrain.getHeightAt(this._fpPos.x, this._fpPos.z), WATER_LEVEL - 0.52);
      this._fpGroundY = groundY;
      this._fpVelocity.set(0, 0, 0);
      this._bobAmp = 0;

      this.camera.position.set(this._fpPos.x, groundY + FP_EYE_HEIGHT, this._fpPos.z);

      // Look cleanly toward previous Orbit target without roll or extreme pitch
      _v1.subVectors(this.orbitControls.target, this.camera.position);
      const yaw = Math.atan2(-_v1.x, -_v1.z);
      const horiz = Math.max(Math.hypot(_v1.x, _v1.z), 0.001);
      const pitch = clamp(Math.atan2(_v1.y, horiz), -0.4, 0.35);
      _euler.set(pitch, yaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(_euler);

      this.engine.container.classList.add('fp-mode');
      this.engine.container.classList.remove('interactive-hover');
    } else {
      if (this.pointerLockControls.isLocked || this._isPointerLocked) {
        try {
          this.pointerLockControls.unlock();
        } catch {
          // Ignore if already unlocked
        }
      }
      this.pointerLockControls.enabled = false;
      this.orbitControls.enabled = true;

      // Transition smoothly into Orbit view looking ahead from explorer's vantage
      this.camera.getWorldDirection(_v1);
      _v1.y = 0;
      if (_v1.lengthSq() < 1e-4) _v1.set(0, 0, -1);
      _v1.normalize();

      const tx = clamp(this.camera.position.x + _v1.x * 9.0, -ORBIT_TARGET_BOUND, ORBIT_TARGET_BOUND);
      const tz = clamp(this.camera.position.z + _v1.z * 9.0, -ORBIT_TARGET_BOUND, ORBIT_TARGET_BOUND);
      const ty = Math.max(this.terrain.getHeightAt(tx, tz) + 1.2, WATER_LEVEL + 0.6);
      this.orbitControls.target.set(tx, ty, tz);

      const cx = clamp(this.camera.position.x - _v1.x * 8.0, -MAP_BOUND, MAP_BOUND);
      const cz = clamp(this.camera.position.z - _v1.z * 8.0, -MAP_BOUND, MAP_BOUND);
      const cy = Math.max(this.terrain.getHeightAt(cx, cz) + 4.8, this.camera.position.y + 3.2);
      this.camera.position.set(cx, cy, cz);
      this.orbitControls.update();

      this.engine.container.classList.remove('fp-mode');
    }

    this._hoveredTarget = null;
    this.callbacks.onCameraModeChange?.(this._cameraMode);
    this._updatePrompt();
  }

  resetCamera() {
    if (this._cameraMode !== 'Orbit') {
      this.setCameraMode('Orbit');
    }
    const camX = this.campfirePos.x + 7.4;
    const camZ = this.campfirePos.z + 6.4;
    const camGroundY = this.terrain.getHeightAt(camX, camZ);
    this.camera.position.set(
      camX,
      Math.max(camGroundY + 4.4, this.campfirePos.y + 4.6),
      camZ
    );
    this.orbitControls.target.set(
      this.campfirePos.x - 3.6,
      this.campfirePos.y + 0.85,
      this.campfirePos.z - 2.2
    );
    this.orbitControls.update();
    this._updatePrompt();
  }

  getPlayerPosition(target = new THREE.Vector3()) {
    return target.copy(this.camera.position);
  }

  /**
   * Fast heightfield raymarch bounded by terrain.mesh's bounding box so moving the
   * cursor in Orbit mode smoothly parts grass & ferns at 60+ FPS with zero stutter.
   */
  _raycastTerrainHeightfield(ray, outPoint) {
    if (!this._terrainBounds) return false;
    if (!ray.intersectBox(this._terrainBounds, _v1)) return false;

    const half = this.terrain.size * 0.5 - 0.5;
    let t = Math.max(0.2, _v1.distanceTo(ray.origin) - 1.0);
    const maxT = 135.0;
    const step = 1.25;

    let prevT = t;
    let prevDiff = 1.0;
    let hit = false;

    for (let i = 0; i < 95 && t <= maxT; i++) {
      const px = ray.origin.x + ray.direction.x * t;
      const py = ray.origin.y + ray.direction.y * t;
      const pz = ray.origin.z + ray.direction.z * t;

      if (Math.abs(px) <= half && Math.abs(pz) <= half) {
        const groundY = this.terrain.getHeightAt(px, pz);
        const diff = py - groundY;
        if (diff <= 0) {
          // Binary search refinement for exact terrain surface contact
          let lo = prevT;
          let hi = t;
          for (let b = 0; b < 6; b++) {
            const mid = (lo + hi) * 0.5;
            const mx = ray.origin.x + ray.direction.x * mid;
            const my = ray.origin.y + ray.direction.y * mid;
            const mz = ray.origin.z + ray.direction.z * mid;
            if (my - this.terrain.getHeightAt(mx, mz) <= 0) {
              hi = mid;
            } else {
              lo = mid;
            }
          }
          const finalT = (lo + hi) * 0.5;
          const fx = ray.origin.x + ray.direction.x * finalT;
          const fz = ray.origin.z + ray.direction.z * finalT;
          outPoint.set(fx, this.terrain.getHeightAt(fx, fz), fz);
          hit = true;
          break;
        }
        prevDiff = diff;
      }

      prevT = t;
      t += prevDiff > 6.0 ? step * 1.8 : step;
    }

    return hit;
  }

  /**
   * Raycasts interactive targets ('campfire' or 'birds') from NDC coords.
   */
  _pickInteractive(ndc) {
    this._raycaster.setFromCamera(ndc, this.camera);
    const hits = this._raycaster.intersectObjects(this._interactiveTargets, false);

    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const tag = hit.object.userData?.interactive;
      if (!tag) continue;

      // In First-Person mode keep interaction distance grounded & tactile
      if (this._cameraMode === 'First-Person' && hit.distance > 18.0) {
        continue;
      }
      if (tag === 'birds' && this._flockState !== 'perched') {
        continue;
      }
      return tag;
    }
    return null;
  }

  _triggerInteraction(tag) {
    if (tag === 'campfire') {
      this.toggleCampfire();
      return true;
    }
    if (tag === 'birds' && this._flockState === 'perched') {
      this.startleBirds();
      return true;
    }
    return false;
  }

  _updatePrompt() {
    let text = '';
    let isInteractive = false;

    if (this._hoveredTarget === 'campfire') {
      text = this._campfireLit ? 'Click to extinguish campfire' : 'Click to light campfire';
      isInteractive = true;
    } else if (this._hoveredTarget === 'birds' && this._flockState === 'perched') {
      text = 'Click to startle forest birds';
      isInteractive = true;
    } else if (this._cameraMode === 'Orbit') {
      text = 'Drag to orbit • Scroll to zoom • Click campfire or birds • Press C for First-Person';
    } else if (this._isPointerLocked || this.pointerLockControls.isLocked) {
      text = 'WASD to walk • Shift to sprint • Click campfire or birds • ESC to unlock • C for Orbit';
    } else {
      text = 'Click scene to look around • WASD to walk • Shift to sprint • Press C for Orbit';
    }

    if (this._cameraMode === 'Orbit') {
      this.engine.container.classList.toggle('interactive-hover', isInteractive);
    } else {
      this.engine.container.classList.remove('interactive-hover');
    }

    if (text !== this._lastPromptText || isInteractive !== this._lastPromptInteractive) {
      this._lastPromptText = text;
      this._lastPromptInteractive = isInteractive;
      this.callbacks.onPromptChange?.(text, isInteractive);
    }
  }

  _requestPointerLockSafe() {
    try {
      const res = this.domElement.requestPointerLock?.();
      if (res && typeof res.catch === 'function') {
        res.catch(() => {});
      }
    } catch {
      // Ignore browser pointer lock cooldown or unsupported headless environment
    }
  }

  // ---------------------------------------------------------------------------
  // DOM & Keyboard Listeners
  // ---------------------------------------------------------------------------

  _bindEvents() {
    this._onPointerMove = (e) => {
      const rect = this.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      this._pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this._pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this._pointerInside = true;
    };

    this._onPointerLeave = () => {
      this._pointerInside = false;
      this._isPointerDown = false;
      if (this._cameraMode === 'Orbit') {
        this.windSystem?.setInteractorTarget?.(null, false);
        this._hoveredTarget = null;
        this._updatePrompt();
      }
    };

    this._onPointerDown = (e) => {
      if (e.button !== 0) return;
      this.audio?.unlock?.();
      this._isPointerDown = true;
      this._pointerDownPos.x = e.clientX;
      this._pointerDownPos.y = e.clientY;

      // In First-Person mode: if already locked, interact directly via center-screen raycast;
      // otherwise lock the pointer on canvas click.
      if (this._cameraMode === 'First-Person') {
        if (this.pointerLockControls.isLocked || this._isPointerLocked) {
          const hitTag = this._pickInteractive(_centerNdc);
          if (hitTag) {
            this._triggerInteraction(hitTag);
          }
        } else {
          this._requestPointerLockSafe();
        }
      }
    };

    this._onPointerUp = (e) => {
      if (e.button !== 0 || !this._isPointerDown) return;
      this._isPointerDown = false;

      if (this._cameraMode === 'Orbit') {
        const dx = e.clientX - this._pointerDownPos.x;
        const dy = e.clientY - this._pointerDownPos.y;
        if (dx * dx + dy * dy <= 36) {
          const rect = this.domElement.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            this._pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            this._pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            const hitTag = this._pickInteractive(this._pointerNdc);
            if (hitTag) {
              this._triggerInteraction(hitTag);
            }
          }
        }
      }
    };

    this._onKeyDown = (e) => {
      const active = document.activeElement;
      const target = e.target;
      const isTextField = (el) =>
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);

      if (isTextField(active) || isTextField(target)) return;

      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this._keys.forward = true;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this._keys.backward = true;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this._keys.left = true;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this._keys.right = true;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this._keys.sprint = true;
          break;
        case 'KeyC':
          if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
            this.setCameraMode(this._cameraMode === 'Orbit' ? 'First-Person' : 'Orbit');
          }
          break;
        default:
          break;
      }
    };

    this._onKeyUp = (e) => {
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this._keys.forward = false;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this._keys.backward = false;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this._keys.left = false;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this._keys.right = false;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this._keys.sprint = false;
          break;
        default:
          break;
      }
    };

    this._onBlur = () => {
      this._keys.forward = false;
      this._keys.backward = false;
      this._keys.left = false;
      this._keys.right = false;
      this._keys.sprint = false;
      this._isPointerDown = false;
    };

    this.domElement.addEventListener('pointermove', this._onPointerMove);
    this.domElement.addEventListener('pointerleave', this._onPointerLeave);
    this.domElement.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  // ---------------------------------------------------------------------------
  // Per-Frame Update
  // ---------------------------------------------------------------------------

  update(dt, elapsed) {
    const safeDt = clamp(dt || 0.016, 0.0005, 0.05);

    if (this._cameraMode === 'Orbit') {
      this.orbitControls.update();

      // Clamp orbit target inside [-95, 95] and keep camera safely above terrain
      const tgt = this.orbitControls.target;
      tgt.x = clamp(tgt.x, -ORBIT_TARGET_BOUND, ORBIT_TARGET_BOUND);
      tgt.z = clamp(tgt.z, -ORBIT_TARGET_BOUND, ORBIT_TARGET_BOUND);
      const tgtGround = this.terrain.getHeightAt(tgt.x, tgt.z);
      tgt.y = clamp(tgt.y, Math.max(tgtGround + 0.2, WATER_LEVEL + 0.2), 38);

      const camPos = this.camera.position;
      camPos.x = clamp(camPos.x, -MAP_BOUND - 6, MAP_BOUND + 6);
      camPos.z = clamp(camPos.z, -MAP_BOUND - 6, MAP_BOUND + 6);
      const camGround = this.terrain.getHeightAt(camPos.x, camPos.z);
      camPos.y = Math.max(camPos.y, camGround + 1.15);

      // Raycast pointer onto terrain & interactive targets in Orbit mode
      if (this._pointerInside) {
        this._hoveredTarget = this._pickInteractive(this._pointerNdc);
        this._updatePrompt();

        // Update foliage parting interactor on terrain surface (throttled ~45 Hz for efficiency)
        if (elapsed - this._lastTerrainRayTime > 0.022) {
          this._lastTerrainRayTime = elapsed;
          this._raycaster.setFromCamera(this._pointerNdc, this.camera);
          if (this._raycastTerrainHeightfield(this._raycaster.ray, this._terrainHitPoint)) {
            this.windSystem?.setInteractorTarget?.(this._terrainHitPoint, true);
          } else {
            this.windSystem?.setInteractorTarget?.(null, false);
          }
        }
      }
    } else {
      // First-Person Explorer smooth horizontal WASD/Arrows movement + SpatialHash2D collision
      this.camera.getWorldDirection(_v1);
      _v1.y = 0;
      if (_v1.lengthSq() < 1e-5) {
        _v1.set(0, 0, -1);
      } else {
        _v1.normalize();
      }
      _v2.crossVectors(_v1, _up).normalize(); // right

      const moveF = (this._keys.forward ? 1 : 0) - (this._keys.backward ? 1 : 0);
      const moveR = (this._keys.right ? 1 : 0) - (this._keys.left ? 1 : 0);

      _v3.set(0, 0, 0);
      if (moveF !== 0) _v3.addScaledVector(_v1, moveF);
      if (moveR !== 0) _v3.addScaledVector(_v2, moveR);
      const hasInput = _v3.lengthSq() > 0.001;
      if (hasInput) _v3.normalize();

      const maxSpeed = this._keys.sprint ? FP_SPRINT_SPEED : FP_WALK_SPEED;
      const targetVx = hasInput ? _v3.x * maxSpeed : 0;
      const targetVz = hasInput ? _v3.z * maxSpeed : 0;
      const response = hasInput ? 13.0 : 10.5;
      const blend = 1.0 - Math.exp(-safeDt * response);

      this._fpVelocity.x = lerp(this._fpVelocity.x, targetVx, blend);
      this._fpVelocity.z = lerp(this._fpVelocity.z, targetVz, blend);

      const prevX = this._fpPos.x;
      const prevZ = this._fpPos.z;
      this._fpPos.x = clamp(this._fpPos.x + this._fpVelocity.x * safeDt, -MAP_BOUND, MAP_BOUND);
      this._fpPos.z = clamp(this._fpPos.z + this._fpVelocity.z * safeDt, -MAP_BOUND, MAP_BOUND);

      // Smooth circle-vs-circle sliding around trunks, boulders, stumps & campfire ring
      this.spatialHash.resolveCircle(this._fpPos, FP_PLAYER_RADIUS);
      this._fpPos.x = clamp(this._fpPos.x, -MAP_BOUND, MAP_BOUND);
      this._fpPos.z = clamp(this._fpPos.z, -MAP_BOUND, MAP_BOUND);

      // Actual achieved ground speed (stops head-bob if blocked against a tree)
      const actualSpeed = Math.hypot(this._fpPos.x - prevX, this._fpPos.z - prevZ) / safeDt;

      // Smooth terrain height following with subtle footstep head-bob scaled by actual speed
      const targetGroundY = Math.max(
        this.terrain.getHeightAt(this._fpPos.x, this._fpPos.z),
        WATER_LEVEL - 0.52
      );
      this._fpGroundY = lerp(this._fpGroundY, targetGroundY, 1.0 - Math.exp(-safeDt * 13.5));

      const speedNorm = clamp(actualSpeed / FP_WALK_SPEED, 0, 1.55);
      if (actualSpeed > 0.25) {
        this._bobPhase += safeDt * (this._keys.sprint ? 12.8 : 9.4);
      }
      this._bobAmp = lerp(this._bobAmp, speedNorm, 1.0 - Math.exp(-safeDt * 10.0));
      const headBobY = Math.sin(this._bobPhase) * 0.052 * this._bobAmp;

      this.camera.position.set(
        this._fpPos.x,
        this._fpGroundY + FP_EYE_HEIGHT + headBobY,
        this._fpPos.z
      );

      // Part grass & ferns around the explorer's footsteps
      this._fpFootPos.set(this._fpPos.x, this._fpGroundY, this._fpPos.z);
      this.windSystem?.setInteractorTarget?.(this._fpFootPos, true);

      // Center-screen hover raycast in First-Person mode
      this._hoveredTarget = this._pickInteractive(_centerNdc);
      this._updatePrompt();
    }

    // Update campfire fire/light/sparks/smoke & sync bird visuals
    this._updateCampfire(safeDt, elapsed);
    this._syncBirdMeshes(safeDt);
  }

  dispose() {
    this.domElement.removeEventListener('pointermove', this._onPointerMove);
    this.domElement.removeEventListener('pointerleave', this._onPointerLeave);
    this.domElement.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);

    this.pointerLockControls.removeEventListener('lock', this._onLock);
    this.pointerLockControls.removeEventListener('unlock', this._onUnlock);
    this.pointerLockControls.dispose();
    this.orbitControls.dispose();

    if (this.campfireGroup && this.campfireGroup.parent) {
      this.campfireGroup.parent.remove(this.campfireGroup);
    }
    if (this.birdFlockGroup && this.birdFlockGroup.parent) {
      this.birdFlockGroup.parent.remove(this.birdFlockGroup);
    }

    for (let i = 0; i < this._geometries.length; i++) {
      this._geometries[i].dispose();
    }
    for (let i = 0; i < this._materials.length; i++) {
      this._materials[i].dispose();
    }
    this._geometries.length = 0;
    this._materials.length = 0;
  }
}
