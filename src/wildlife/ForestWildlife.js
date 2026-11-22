import * as THREE from 'three';
import { createRng, clamp, lerp, smoothstep } from '../utils/random.js';
import { RatActor, createRatSharedAssets, playRatSqueak } from './RatActor.js';

const MAP_BOUND = 100;
const WATER_SAFE_Y = 0.30;

const MAX_RATS = 15;
const MAX_SQUIRRELS = 10;
const MAX_RABBITS = 10;

const DEFAULT_RATS = 14;
const DEFAULT_SQUIRRELS = 8;
const DEFAULT_RABBITS = 8;

const GLOBAL_SCARE_COOLDOWN = 16.0;

// Module-level scratch math objects (zero per-frame GC allocations)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _humanPos = new THREE.Vector3();
const _humanFwd = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _basisX = new THREE.Vector3();
const _basisY = new THREE.Vector3();
const _basisZ = new THREE.Vector3();
const _rotMat = new THREE.Matrix4();
const _targetQuat = new THREE.Quaternion();
const _spawnPos = new THREE.Vector3();
const _footL = new THREE.Vector3();
const _footR = new THREE.Vector3();

function wrapAngle(a) {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

function createSculptedSphere(radius, widthSegs, heightSegs, sculptFn) {
  const geo = new THREE.SphereGeometry(radius, widthSegs, heightSegs);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const out = sculptFn(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (out) {
      pos.setXYZ(i, out[0], out[1], out[2]);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Generates procedural fur canvas texture + bump map (with automatic DataTexture
 * fallback when running headless in Node without a DOM document).
 */
function createWoodlandFurTextures(palette, seed) {
  const rng = createRng(seed);

  if (typeof document !== 'undefined') {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const bumpCanvas = document.createElement('canvas');
    bumpCanvas.width = size;
    bumpCanvas.height = size;
    const bctx = bumpCanvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0.0, palette.dorsal);
    grad.addColorStop(0.38, palette.mid);
    grad.addColorStop(0.75, palette.flank);
    grad.addColorStop(1.0, palette.belly);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    bctx.fillStyle = '#7c7c7c';
    bctx.fillRect(0, 0, size, size);

    ctx.lineCap = 'round';
    bctx.lineCap = 'round';
    for (let i = 0; i < 2200; i++) {
      const hx = rng() * size;
      const hy = rng() * size;
      const len = 5 + rng() * 11;
      const ang = (rng() - 0.5) * 0.36;
      const dx = Math.cos(ang) * len;
      const dy = Math.sin(ang) * len;

      const roll = rng();
      ctx.strokeStyle =
        roll < 0.34 ? palette.hairDark : roll < 0.74 ? palette.hairMid : palette.hairLight;
      ctx.lineWidth = 0.8 + rng() * 1.1;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx + dx, hy + dy);
      ctx.stroke();

      const shade = Math.round(92 + rng() * 128);
      bctx.strokeStyle = `rgb(${shade},${shade},${shade})`;
      bctx.lineWidth = 0.85 + rng() * 0.85;
      bctx.beginPath();
      bctx.moveTo(hx, hy);
      bctx.lineTo(hx + dx, hy + dy);
      bctx.stroke();
    }

    const diffuseTex = new THREE.CanvasTexture(canvas);
    diffuseTex.colorSpace = THREE.SRGBColorSpace;
    diffuseTex.wrapS = THREE.RepeatWrapping;
    diffuseTex.wrapT = THREE.ClampToEdgeWrapping;
    diffuseTex.needsUpdate = true;

    const bumpTex = new THREE.CanvasTexture(bumpCanvas);
    bumpTex.wrapS = THREE.RepeatWrapping;
    bumpTex.wrapT = THREE.ClampToEdgeWrapping;
    bumpTex.needsUpdate = true;

    return { diffuseTex, bumpTex };
  }

  // Headless Node DataTexture fallback
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const bump = new Uint8Array(size * size * 4);
  const cTop = new THREE.Color(palette.dorsal);
  const cMid = new THREE.Color(palette.mid);
  const cBot = new THREE.Color(palette.belly);
  const tmp = new THREE.Color();

  for (let y = 0; y < size; y++) {
    const v = y / (size - 1);
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      if (v < 0.5) {
        tmp.lerpColors(cTop, cMid, v * 2);
      } else {
        tmp.lerpColors(cMid, cBot, (v - 0.5) * 2);
      }
      const strand = (rng() - 0.5) * 0.14;
      data[idx] = clamp(Math.round((tmp.r + strand) * 255), 0, 255);
      data[idx + 1] = clamp(Math.round((tmp.g + strand) * 255), 0, 255);
      data[idx + 2] = clamp(Math.round((tmp.b + strand) * 255), 0, 255);
      data[idx + 3] = 255;

      const bv = clamp(Math.round(128 + (rng() - 0.5) * 84), 0, 255);
      bump[idx] = bv;
      bump[idx + 1] = bv;
      bump[idx + 2] = bv;
      bump[idx + 3] = 255;
    }
  }

  const diffuseTex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  diffuseTex.colorSpace = THREE.SRGBColorSpace;
  diffuseTex.wrapS = THREE.RepeatWrapping;
  diffuseTex.wrapT = THREE.ClampToEdgeWrapping;
  diffuseTex.needsUpdate = true;

  const bumpTex = new THREE.DataTexture(bump, size, size, THREE.RGBAFormat);
  bumpTex.wrapS = THREE.RepeatWrapping;
  bumpTex.wrapT = THREE.ClampToEdgeWrapping;
  bumpTex.needsUpdate = true;

  return { diffuseTex, bumpTex };
}

/**
 * Optional soft procedural squirrel chatter sound when perched high on a branch.
 */
function playSquirrelChatter(audio) {
  if (!audio) return;
  try {
    if (typeof audio.triggerSquirrelChatter === 'function') {
      audio.triggerSquirrelChatter();
      return;
    }
    if (
      audio._ctx &&
      audio._mixBus &&
      typeof audio._canPlayOneShots === 'function' &&
      audio._canPlayOneShots()
    ) {
      const ctx = audio._ctx;
      const now = ctx.currentTime;
      const clicks = 3 + Math.floor(Math.random() * 2);
      for (let i = 0; i < clicks; i++) {
        const t = now + i * (0.075 + Math.random() * 0.025);
        const dur = 0.036;
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const f0 = 1550 + Math.random() * 450;
        osc.frequency.setValueAtTime(f0, t);
        osc.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + dur);

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(2100, t);
        bp.Q.setValueAtTime(3.2, t);

        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.linearRampToValueAtTime(0.018, t + 0.006);
        env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

        osc.connect(bp);
        bp.connect(env);
        env.connect(audio._mixBus);
        osc.start(t);
        osc.stop(t + dur + 0.01);
      }
    }
  } catch {
    // Non-fatal in headless or muted audio contexts
  }
}

// ============================================================================
// ARTICULATED TREE-CLIMBING WOODLAND SQUIRREL
// ============================================================================

function createSquirrelSharedAssets() {
  const geometries = [];
  const materials = [];
  const textures = [];

  const trackGeo = (g) => {
    geometries.push(g);
    return g;
  };
  const trackMat = (m) => {
    materials.push(m);
    return m;
  };

  const coatPalettes = [
    {
      dorsal: '#8e3d1c',
      mid: '#b05226',
      flank: '#c76d39',
      belly: '#efe3cf',
      hairDark: 'rgba(84, 30, 12, 0.55)',
      hairMid: 'rgba(182, 86, 38, 0.52)',
      hairLight: 'rgba(232, 162, 102, 0.45)',
    },
    {
      dorsal: '#7a351c',
      mid: '#9b4a27',
      flank: '#b8683e',
      belly: '#eadcc6',
      hairDark: 'rgba(68, 26, 14, 0.55)',
      hairMid: 'rgba(160, 78, 40, 0.50)',
      hairLight: 'rgba(220, 152, 98, 0.44)',
    },
  ];

  const furMaterials = coatPalettes.map((pal, idx) => {
    const pair = createWoodlandFurTextures(pal, 6100 + idx * 197);
    textures.push(pair.diffuseTex, pair.bumpTex);
    return trackMat(
      new THREE.MeshStandardMaterial({
        map: pair.diffuseTex,
        bumpMap: pair.bumpTex,
        bumpScale: 0.012,
        roughness: 0.86,
        metalness: 0.0,
      })
    );
  });

  const tailPlumeMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xb8592b,
      roughness: 0.92,
      metalness: 0.0,
    })
  );
  const tailTipMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd98f56,
      roughness: 0.94,
      metalness: 0.0,
    })
  );
  const bellyMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xefe3ce,
      roughness: 0.90,
      metalness: 0.0,
    })
  );
  const eyeMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x070606,
      roughness: 0.06,
      metalness: 0.06,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
    })
  );
  const eyeGlintMaterial = trackMat(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const noseMaterial = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x3b241d, roughness: 0.45 })
  );
  const earTuftMaterial = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x6f2d14, roughness: 0.88 })
  );

  // Sculpted woodland squirrel anatomy
  const pelvisGeo = trackGeo(
    createSculptedSphere(1.0, 12, 10, (x, y, z) => [x * 0.052, y * 0.048, z * 0.068])
  );
  const chestGeo = trackGeo(
    createSculptedSphere(1.0, 12, 10, (x, y, z) => {
      const taper = lerp(1.02, 0.78, (z + 1) * 0.5);
      return [x * 0.045 * taper, y * 0.044 * taper, z * 0.066];
    })
  );
  const bellyPatchGeo = trackGeo(
    createSculptedSphere(1.0, 10, 8, (x, y, z) => [x * 0.036, y * 0.024, z * 0.064])
  );
  const headGeo = trackGeo(
    createSculptedSphere(1.0, 12, 10, (x, y, z) => {
      const narrow = z > 0 ? 1.0 - z * 0.25 : 1.0;
      return [x * 0.038 * narrow, y * 0.034, z * 0.044];
    })
  );
  const muzzleGeo = trackGeo(
    createSculptedSphere(1.0, 8, 6, (x, y, z) => {
      const t = (z + 1) * 0.5;
      const r = lerp(1.0, 0.42, t);
      return [x * 0.022 * r, y * 0.019 * r, (z + 0.5) * 0.026];
    })
  );
  const noseGeo = trackGeo(new THREE.SphereGeometry(0.0075, 6, 5));
  const eyeGeo = trackGeo(new THREE.SphereGeometry(0.0095, 8, 6));
  const eyeGlintGeo = trackGeo(new THREE.SphereGeometry(0.0028, 5, 4));

  // Pointed tufted woodland squirrel ears
  const earGeo = trackGeo(new THREE.ConeGeometry(0.013, 0.034, 6));
  earGeo.translate(0, 0.017, 0);
  const earTuftGeo = trackGeo(new THREE.ConeGeometry(0.006, 0.018, 5));
  earTuftGeo.translate(0, 0.036, -0.002);

  // Fluffy arched S-curve bushy tail segments
  const tailSeg0Geo = trackGeo(
    createSculptedSphere(1.0, 10, 8, (x, y, z) => [x * 0.034, y * 0.042, (z - 0.6) * 0.065])
  );
  const tailSeg1Geo = trackGeo(
    createSculptedSphere(1.0, 12, 9, (x, y, z) => [x * 0.052, y * 0.058, (z - 0.55) * 0.095])
  );
  const tailSeg2Geo = trackGeo(
    createSculptedSphere(1.0, 12, 9, (x, y, z) => {
      const tip = clamp((-z + 1) * 0.5, 0, 1);
      const flare = lerp(1.0, 0.52, tip * tip);
      return [x * 0.050 * flare, y * 0.056 * flare, (z - 0.52) * 0.092];
    })
  );

  // Articulated limbs
  const hindLegGeo = trackGeo(
    createSculptedSphere(1.0, 8, 6, (x, y, z) => [x * 0.020, (y - 0.45) * 0.044, z * 0.024])
  );
  const frontLegGeo = trackGeo(
    createSculptedSphere(1.0, 8, 6, (x, y, z) => [x * 0.014, (y - 0.5) * 0.036, z * 0.016])
  );
  const pawGeo = trackGeo(
    createSculptedSphere(1.0, 6, 5, (x, y, z) => [x * 0.012, y * 0.006, (z + 0.5) * 0.016])
  );

  return {
    geometries,
    materials,
    textures,
    furMaterials,
    tailPlumeMaterial,
    tailTipMaterial,
    bellyMaterial,
    eyeMaterial,
    eyeGlintMaterial,
    noseMaterial,
    earTuftMaterial,
    geo: {
      pelvisGeo,
      chestGeo,
      bellyPatchGeo,
      headGeo,
      muzzleGeo,
      noseGeo,
      eyeGeo,
      eyeGlintGeo,
      earGeo,
      earTuftGeo,
      tailSeg0Geo,
      tailSeg1Geo,
      tailSeg2Geo,
      hindLegGeo,
      frontLegGeo,
      pawGeo,
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      geometries.length = 0;
      materials.length = 0;
      textures.length = 0;
    },
  };
}

class SquirrelActor {
  constructor(terrain, tree, assets, seed) {
    this.terrain = terrain;
    this.tree = tree;
    this._assets = assets;
    this._rng = createRng(seed);

    this.root = new THREE.Group();
    this.root.name = `ForestSquirrel_${seed}`;
    this.baseScale = 0.94 + this._rng() * 0.16;
    this.root.scale.setScalar(this.baseScale);

    this.furVariant = Math.floor(this._rng() * assets.furMaterials.length);
    this._buildRig();

    // Tree trunk climbing bounds tailored to species height/fork
    const species = tree.species || 'pine';
    const scale = tree.scale || 1.0;
    this._trunkBaseR = Math.max(0.22, tree.radius || 0.45);
    this._maxTrunkH =
      species === 'oak'
        ? clamp(4.75 * scale, 2.5, 6.2)
        : species === 'birch'
          ? clamp(8.2 * scale, 3.8, 9.5)
          : clamp(11.5 * scale, 5.2, 9.5);

    this.active = true;
    this.state = 'forageGround'; // 'forageGround' | 'scurryToTree' | 'climbUp' | 'perchChatter' | 'climbDown'
    this._stateTimer = 1.8 + this._rng() * 4.5;
    this._chatterTimer = 1.2 + this._rng() * 2.5;
    this._gaitPhase = this._rng() * Math.PI * 2;
    this._tailFlickPhase = this._rng() * 10;

    // Trunk spiral state
    this._trunkAngle = this._rng() * Math.PI * 2;
    this._spiralDir = this._rng() > 0.5 ? 1 : -1;
    this._climbY = 0.15;
    this._targetClimbY = 3.2;
    this._spooked = false;

    // Start foraging near home tree roots
    const startDist = this._trunkBaseR + 1.0 + this._rng() * 2.2;
    const sx = clamp(tree.x + Math.cos(this._trunkAngle) * startDist, -MAP_BOUND, MAP_BOUND);
    const sz = clamp(tree.z + Math.sin(this._trunkAngle) * startDist, -MAP_BOUND, MAP_BOUND);
    const sy = this._sampleHeight(sx, sz);

    this.position = this.root.position;
    this.position.set(sx, Math.max(sy, WATER_SAFE_Y), sz);
    this._yaw = this._rng() * Math.PI * 2;
    this._waypoint = this.position.clone();
    this._pickGroundForagePoint();
    this._alignToTerrain(1.0);
  }

  _buildRig() {
    const a = this._assets;
    const g = a.geo;
    const furMat = a.furMaterials[this.furVariant];

    const makeMesh = (geo, mat, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = cast;
      m.receiveShadow = true;
      return m;
    };

    this.bodyPivot = new THREE.Group();
    this.root.add(this.bodyPivot);

    // Pelvis
    this.pelvis = new THREE.Group();
    this.pelvis.position.set(0, 0.082, -0.048);
    this.bodyPivot.add(this.pelvis);
    this.pelvis.add(makeMesh(g.pelvisGeo, furMat));

    // Articulated Hind Legs
    const buildHind = (s) => {
      const leg = new THREE.Group();
      leg.position.set(s * 0.040, -0.012, -0.005);
      leg.add(makeMesh(g.hindLegGeo, furMat));
      const paw = makeMesh(g.pawGeo, furMat, false);
      paw.position.set(0, -0.064, 0.012);
      leg.add(paw);
      this.pelvis.add(leg);
      return leg;
    };
    this.legBL = buildHind(1);
    this.legBR = buildHind(-1);

    // 3-Segment Fluffy Arched S-Curve Bushy Tail
    this.tailBase = new THREE.Group();
    this.tailBase.position.set(0, 0.012, -0.056);
    this.pelvis.add(this.tailBase);
    this.tailBase.add(makeMesh(g.tailSeg0Geo, furMat));

    this.tailMid = new THREE.Group();
    this.tailMid.position.set(0, 0.014, -0.095);
    this.tailBase.add(this.tailMid);
    this.tailMid.add(makeMesh(g.tailSeg1Geo, a.tailPlumeMaterial));

    this.tailTip = new THREE.Group();
    this.tailTip.position.set(0, 0.012, -0.118);
    this.tailMid.add(this.tailTip);
    this.tailTip.add(makeMesh(g.tailSeg2Geo, a.tailTipMaterial));

    // Chest & Creamy-White Belly
    this.chest = new THREE.Group();
    this.chest.position.set(0, 0.006, 0.094);
    this.pelvis.add(this.chest);
    this.chest.add(makeMesh(g.chestGeo, furMat));

    const belly = makeMesh(g.bellyPatchGeo, a.bellyMaterial, false);
    belly.position.set(0, -0.028, -0.012);
    this.chest.add(belly);

    // Articulated Front Legs
    const buildFront = (s) => {
      const leg = new THREE.Group();
      leg.position.set(s * 0.034, -0.018, 0.020);
      leg.add(makeMesh(g.frontLegGeo, furMat));
      const paw = makeMesh(g.pawGeo, furMat, false);
      paw.position.set(0, -0.054, 0.008);
      leg.add(paw);
      this.chest.add(leg);
      return leg;
    };
    this.legFL = buildFront(1);
    this.legFR = buildFront(-1);

    // Head, Tufted Ears, Bright Dark Eyes
    this.head = new THREE.Group();
    this.head.position.set(0, 0.022, 0.056);
    this.chest.add(this.head);
    this.head.add(makeMesh(g.headGeo, furMat));

    const muzzle = makeMesh(g.muzzleGeo, furMat, false);
    muzzle.position.set(0, -0.006, 0.032);
    this.head.add(muzzle);

    const nose = makeMesh(g.noseGeo, a.noseMaterial, false);
    nose.position.set(0, -0.005, 0.062);
    this.head.add(nose);

    for (const s of [1, -1]) {
      const eye = makeMesh(g.eyeGeo, a.eyeMaterial, false);
      eye.position.set(s * 0.026, 0.011, 0.018);
      this.head.add(eye);
      const glint = makeMesh(g.eyeGlintGeo, a.eyeGlintMaterial, false);
      glint.position.set(s * 0.031, 0.015, 0.023);
      this.head.add(glint);
    }

    const buildEar = (s) => {
      const ear = new THREE.Group();
      ear.position.set(s * 0.022, 0.024, -0.010);
      ear.rotation.set(-0.10, s * 0.22, -s * 0.20);
      ear.add(makeMesh(g.earGeo, furMat, false));
      ear.add(makeMesh(g.earTuftGeo, a.earTuftMaterial, false));
      this.head.add(ear);
      return ear;
    };
    this.earL = buildEar(1);
    this.earR = buildEar(-1);
  }

  setActive(active) {
    this.active = Boolean(active);
    this.root.visible = this.active;
  }

  _sampleHeight(x, z) {
    if (!this.terrain || typeof this.terrain.getHeightAt !== 'function') return 0;
    const h = this.terrain.getHeightAt(x, z);
    return Number.isFinite(h) ? h : 0;
  }

  _sampleNormal(x, z, out) {
    if (!this.terrain || typeof this.terrain.getNormalAt !== 'function') {
      return out.set(0, 1, 0);
    }
    return this.terrain.getNormalAt(x, z, out);
  }

  _trunkRadiusAt(heightAboveBase) {
    const frac = clamp(heightAboveBase / Math.max(this._maxTrunkH, 1.0), 0, 1);
    return this._trunkBaseR * lerp(0.95, 0.56, frac) + 0.048;
  }

  _alignToTerrain(blend) {
    const n = this._sampleNormal(this.position.x, this.position.z, _normal);
    _fwd.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
    _fwd.addScaledVector(n, -_fwd.dot(n));
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    else _fwd.normalize();
    _right.crossVectors(n, _fwd).normalize();
    _fwd.crossVectors(_right, n).normalize();
    _rotMat.makeBasis(_right, n, _fwd);
    _targetQuat.setFromRotationMatrix(_rotMat);
    if (blend >= 0.999) this.root.quaternion.copy(_targetQuat);
    else this.root.quaternion.slerp(_targetQuat, clamp(blend, 0, 1));
  }

  _orientOnTrunk(angle, climbSign, spiralSlope) {
    // Outward bark normal = +Y_squirrel (belly pressed flat against tree bark!)
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    _basisY.set(cosA, 0, sinA).normalize();
    // Forward direction (+Z_squirrel) = vertically UP (climbSign=+1) or DOWN (climbSign=-1) + spiral tangent
    const tanX = -sinA * spiralSlope;
    const tanZ = cosA * spiralSlope;
    _basisZ.set(tanX, climbSign, tanZ).normalize();
    _basisX.crossVectors(_basisY, _basisZ).normalize();
    _basisZ.crossVectors(_basisX, _basisY).normalize();

    _rotMat.makeBasis(_basisX, _basisY, _basisZ);
    this.root.quaternion.setFromRotationMatrix(_rotMat);
  }

  _pickGroundForagePoint() {
    for (let k = 0; k < 10; k++) {
      const ang = this._rng() * Math.PI * 2;
      const dist = this._trunkBaseR + 0.8 + this._rng() * 3.1;
      const gx = clamp(this.tree.x + Math.cos(ang) * dist, -MAP_BOUND, MAP_BOUND);
      const gz = clamp(this.tree.z + Math.sin(ang) * dist, -MAP_BOUND, MAP_BOUND);
      const gy = this._sampleHeight(gx, gz);
      if (gy > WATER_SAFE_Y + 0.05) {
        this._waypoint.set(gx, gy, gz);
        return;
      }
    }
    const r = this._trunkBaseR + 0.9;
    this._waypoint.set(
      this.tree.x + Math.cos(this._trunkAngle) * r,
      Math.max(this.tree.y, WATER_SAFE_Y),
      this.tree.z + Math.sin(this._trunkAngle) * r
    );
  }

  update(dt, elapsed, humanPos, audio) {
    if (!this.active) return;

    const humanDist = humanPos
      ? Math.hypot(humanPos.x - this.position.x, humanPos.z - this.position.z)
      : 999;

    const treeBaseY = Number.isFinite(this.tree.y)
      ? this.tree.y
      : this._sampleHeight(this.tree.x, this.tree.z);

    let speedNorm = 0;

    if (this.state === 'forageGround') {
      this._stateTimer -= dt;
      const dx = this._waypoint.x - this.position.x;
      const dz = this._waypoint.z - this.position.z;
      const dist = Math.hypot(dx, dz);

      if (dist > 0.25) {
        const desiredYaw = Math.atan2(dx, dz);
        this._yaw = wrapAngle(this._yaw + clamp(wrapAngle(desiredYaw - this._yaw), -9 * dt, 9 * dt));
        const step = Math.min(dist, 2.35 * dt);
        const nx = clamp(this.position.x + Math.sin(this._yaw) * step, -MAP_BOUND, MAP_BOUND);
        const nz = clamp(this.position.z + Math.cos(this._yaw) * step, -MAP_BOUND, MAP_BOUND);
        const ny = this._sampleHeight(nx, nz);
        if (ny > WATER_SAFE_Y) {
          this.position.set(nx, ny, nz);
          speedNorm = 0.7;
        } else {
          this._pickGroundForagePoint();
        }
      }
      this._alignToTerrain(1.0 - Math.exp(-12 * dt));

      // Trigger vertical tree-trunk climb if human approaches within ~11 units OR forage timer ticks!
      if (humanDist < 11.2 || this._stateTimer <= 0) {
        this._spooked = humanDist < 11.2;
        this._trunkAngle = Math.atan2(
          this.position.z - this.tree.z,
          this.position.x - this.tree.x
        );
        this._spiralDir = this._rng() > 0.5 ? 1 : -1;
        this._targetClimbY = clamp(
          1.7 + this._rng() * Math.max(1.5, this._maxTrunkH - 1.8),
          1.5,
          Math.min(9.5, this._maxTrunkH)
        );
        this.state = 'scurryToTree';
        this._stateTimer = 3.5;
      }
    } else if (this.state === 'scurryToTree') {
      this._stateTimer -= dt;
      const targetR = this._trunkRadiusAt(0.15);
      const tx = this.tree.x + Math.cos(this._trunkAngle) * targetR;
      const tz = this.tree.z + Math.sin(this._trunkAngle) * targetR;
      const dx = tx - this.position.x;
      const dz = tz - this.position.z;
      const dist = Math.hypot(dx, dz);

      const sprintSpeed = this._spooked ? 6.2 : 4.5;
      if (dist > 0.05) {
        this._yaw = Math.atan2(dx, dz);
        const step = Math.min(dist, sprintSpeed * dt);
        this.position.x += (dx / dist) * step;
        this.position.z += (dz / dist) * step;
        this.position.y = Math.max(this._sampleHeight(this.position.x, this.position.z), WATER_SAFE_Y);
      }
      this._alignToTerrain(1.0 - Math.exp(-16 * dt));
      speedNorm = 1.15;

      if (dist < 0.24 || this._stateTimer <= 0) {
        this._climbY = 0.22;
        this.state = 'climbUp';
      }
    } else if (this.state === 'climbUp') {
      const climbSpeed = this._spooked ? 4.9 : 3.5;
      const spiralRate = (this._spooked ? 2.4 : 1.75) * this._spiralDir;
      this._climbY += climbSpeed * dt;
      this._trunkAngle += spiralRate * dt;

      const r = this._trunkRadiusAt(this._climbY);
      this.position.set(
        this.tree.x + Math.cos(this._trunkAngle) * r,
        treeBaseY + this._climbY,
        this.tree.z + Math.sin(this._trunkAngle) * r
      );
      this._orientOnTrunk(this._trunkAngle, 1.0, this._spiralDir * 0.34);
      speedNorm = 1.25;

      if (this._climbY >= this._targetClimbY) {
        this._climbY = this._targetClimbY;
        this.state = 'perchChatter';
        this._stateTimer = 3.2 + this._rng() * 4.5;
        this._chatterTimer = 0.35 + this._rng() * 1.1;
      }
    } else if (this.state === 'perchChatter') {
      this._stateTimer -= dt;
      this._chatterTimer -= dt;

      const r = this._trunkRadiusAt(this._climbY);
      this.position.set(
        this.tree.x + Math.cos(this._trunkAngle) * r,
        treeBaseY + this._climbY,
        this.tree.z + Math.sin(this._trunkAngle) * r
      );
      // Perched alertly gripping bark, slightly angled sideways to peer down at the forest
      this._orientOnTrunk(this._trunkAngle, 0.35, this._spiralDir * 0.85);
      speedNorm = 0;

      if (this._chatterTimer <= 0) {
        if (humanDist < 15.0) {
          playSquirrelChatter(audio);
        }
        this._chatterTimer = 2.2 + this._rng() * 3.0;
      }

      // Wait briefly if human is standing right beneath the trunk before scampering back down
      if (this._stateTimer <= 0 && humanDist > 5.0) {
        this._spooked = false;
        this._spiralDir = -this._spiralDir;
        this.state = 'climbDown';
      }
    } else if (this.state === 'climbDown') {
      const downSpeed = 3.6;
      const spiralRate = 1.65 * this._spiralDir;
      this._climbY -= downSpeed * dt;
      this._trunkAngle += spiralRate * dt;

      const r = this._trunkRadiusAt(Math.max(0.15, this._climbY));
      this.position.set(
        this.tree.x + Math.cos(this._trunkAngle) * r,
        treeBaseY + Math.max(0.12, this._climbY),
        this.tree.z + Math.sin(this._trunkAngle) * r
      );
      // Head-first downward spiral down the tree bark!
      this._orientOnTrunk(this._trunkAngle, -1.0, this._spiralDir * 0.32);
      speedNorm = 1.1;

      if (this._climbY <= 0.16) {
        const outR = this._trunkBaseR + 0.55;
        const gx = clamp(this.tree.x + Math.cos(this._trunkAngle) * outR, -MAP_BOUND, MAP_BOUND);
        const gz = clamp(this.tree.z + Math.sin(this._trunkAngle) * outR, -MAP_BOUND, MAP_BOUND);
        this.position.set(gx, Math.max(this._sampleHeight(gx, gz), WATER_SAFE_Y), gz);
        this._yaw = Math.atan2(Math.cos(this._trunkAngle), Math.sin(this._trunkAngle));
        this._pickGroundForagePoint();
        this._alignToTerrain(1.0);
        this.state = 'forageGround';
        this._stateTimer = 4.0 + this._rng() * 6.0;
      }
    }

    // Animate squirrel limbs, head curiosity & iconic bushy S-curve tail flick!
    const isClimbing = this.state === 'climbUp' || this.state === 'climbDown';
    const isPerching = this.state === 'perchChatter';
    this._gaitPhase += dt * (speedNorm > 0.05 ? 11.5 + speedNorm * 9.5 : 3.0);

    if (speedNorm > 0.05) {
      const bound = Math.sin(this._gaitPhase);
      this.bodyPivot.position.y = isClimbing ? -0.015 : Math.max(0, Math.cos(this._gaitPhase)) * 0.032;
      this.pelvis.rotation.x = bound * 0.22;
      this.chest.rotation.x = -bound * 0.18;
      this.head.rotation.set(-0.12, Math.sin(this._gaitPhase * 0.5) * 0.12, 0);

      const sF = Math.sin(this._gaitPhase);
      const sB = Math.sin(this._gaitPhase + Math.PI);
      this.legFL.rotation.x = -sF * 0.82;
      this.legFR.rotation.x = -Math.sin(this._gaitPhase + 0.35) * 0.82;
      this.legBL.rotation.x = -sB * 0.86;
      this.legBR.rotation.x = -Math.sin(this._gaitPhase + Math.PI + 0.35) * 0.86;

      // Tail streams/bobs dynamically in arched S-curve while scampering or climbing
      this.tailBase.rotation.set(0.68 + bound * 0.18, Math.sin(this._gaitPhase * 0.5) * 0.16, 0);
      this.tailMid.rotation.set(0.45 - bound * 0.12, 0, 0);
      this.tailTip.rotation.set(-0.62 + bound * 0.16, 0, 0);
    } else {
      // Sitting alertly or perched chattering: rhythmic double-flick on the big bushy S-curve tail!
      const flickWave = Math.pow(Math.max(0, Math.sin(elapsed * 3.4 + this._tailFlickPhase)), 4);
      const doubleFlick = flickWave * Math.sin(elapsed * 22.0 + this._tailFlickPhase) * 0.42;

      this.bodyPivot.position.y = isPerching ? -0.01 : 0.014;
      this.pelvis.rotation.x = isPerching ? -0.15 : -0.34;
      this.chest.rotation.x = isPerching ? 0.14 : 0.24;
      this.head.rotation.set(
        isPerching ? 0.18 : 0.08 + Math.sin(elapsed * 5.0) * 0.06,
        Math.sin(elapsed * 1.9 + this._tailFlickPhase) * 0.48,
        Math.sin(elapsed * 1.2) * 0.10
      );

      this.legFL.rotation.x = -0.35;
      this.legFR.rotation.x = -0.35;
      this.legBL.rotation.x = 0.28;
      this.legBR.rotation.x = 0.28;

      // Classic arched question-mark S-curve bushy squirrel tail held over back
      this.tailBase.rotation.set(1.08 + doubleFlick * 0.65, doubleFlick * 0.25, 0);
      this.tailMid.rotation.set(0.58 - doubleFlick * 0.45, 0, 0);
      this.tailTip.rotation.set(-0.92 + doubleFlick * 0.72, 0, 0);
    }

    // Subtle ear twitches
    const eTwitch = Math.pow(Math.max(0, Math.sin(elapsed * 4.2 + this._tailFlickPhase)), 12) * 0.28;
    this.earL.rotation.z = -0.20 - eTwitch;
    this.earR.rotation.z = 0.20 + eTwitch * 0.8;
  }

  dispose() {
    if (this.root.parent) {
      this.root.parent.remove(this.root);
    }
  }
}

// ============================================================================
// ARTICULATED FERN-HOPPING WOODLAND COTTONTAIL RABBIT
// ============================================================================

function createRabbitSharedAssets() {
  const geometries = [];
  const materials = [];
  const textures = [];

  const trackGeo = (g) => {
    geometries.push(g);
    return g;
  };
  const trackMat = (m) => {
    materials.push(m);
    return m;
  };

  const coatPalettes = [
    {
      dorsal: '#7a6957',
      mid: '#978570',
      flank: '#b09e88',
      belly: '#e7dfd2',
      hairDark: 'rgba(72, 58, 45, 0.50)',
      hairMid: 'rgba(154, 136, 114, 0.48)',
      hairLight: 'rgba(222, 208, 188, 0.46)',
    },
    {
      dorsal: '#6a5d50',
      mid: '#87796a',
      flank: '#a29484',
      belly: '#ece6db',
      hairDark: 'rgba(62, 52, 44, 0.50)',
      hairMid: 'rgba(138, 124, 110, 0.48)',
      hairLight: 'rgba(216, 204, 190, 0.44)',
    },
  ];

  const furMaterials = coatPalettes.map((pal, idx) => {
    const pair = createWoodlandFurTextures(pal, 7300 + idx * 211);
    textures.push(pair.diffuseTex, pair.bumpTex);
    return trackMat(
      new THREE.MeshStandardMaterial({
        map: pair.diffuseTex,
        bumpMap: pair.bumpTex,
        bumpScale: 0.011,
        roughness: 0.89,
        metalness: 0.0,
      })
    );
  });

  const cottonTailMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xf7f4ee,
      roughness: 0.96,
      metalness: 0.0,
    })
  );
  const chestCreamMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xe9e1d4,
      roughness: 0.92,
      metalness: 0.0,
    })
  );
  const earInnerMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xdda19a,
      roughness: 0.72,
      metalness: 0.0,
    })
  );
  const noseMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd9928f,
      roughness: 0.58,
      metalness: 0.0,
    })
  );
  const eyeMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x0b0807,
      roughness: 0.06,
      metalness: 0.06,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
    })
  );
  const eyeGlintMaterial = trackMat(new THREE.MeshBasicMaterial({ color: 0xffffff }));

  // Sculpted cottontail rabbit body parts (length ~0.36, tall swiveling ears ~0.17)
  const haunchesGeo = trackGeo(
    createSculptedSphere(1.0, 14, 12, (x, y, z) => {
      const plump = z < 0 ? 1.08 : 0.94;
      return [x * 0.088 * plump, (y < 0 ? y * 0.068 : y * 0.084), z * 0.112];
    })
  );
  const chestGeo = trackGeo(
    createSculptedSphere(1.0, 12, 10, (x, y, z) => [x * 0.064, y * 0.064, z * 0.078])
  );
  const chestFluffGeo = trackGeo(
    createSculptedSphere(1.0, 10, 8, (x, y, z) => [x * 0.048, y * 0.046, z * 0.052])
  );
  const headGeo = trackGeo(
    createSculptedSphere(1.0, 12, 10, (x, y, z) => {
      const cheek = z > 0 ? 0.90 : 1.04;
      return [x * 0.050 * cheek, y * 0.046, z * 0.064];
    })
  );
  const noseGeo = trackGeo(
    createSculptedSphere(1.0, 8, 6, (x, y, z) => [x * 0.011, y * 0.008, z * 0.008])
  );
  const eyeGeo = trackGeo(new THREE.SphereGeometry(0.011, 8, 6));
  const eyeGlintGeo = trackGeo(new THREE.SphereGeometry(0.0032, 5, 4));

  // Long swiveling rabbit ears (~0.17 tall) with inner pink concavity
  const earOuterGeo = trackGeo(
    createSculptedSphere(1.0, 10, 10, (x, y, z) => {
      const h = (y + 1) * 0.5; // 0=base, 1=tip
      const widthEnv = Math.sin(clamp(h * 0.92 + 0.08, 0, 1) * Math.PI);
      return [x * 0.022 * (0.45 + 0.65 * widthEnv), (y + 0.92) * 0.086, z * 0.0095];
    })
  );
  const earInnerGeo = trackGeo(
    createSculptedSphere(1.0, 8, 8, (x, y, z) => {
      const h = (y + 1) * 0.5;
      const widthEnv = Math.sin(clamp(h * 0.92 + 0.08, 0, 1) * Math.PI);
      return [x * 0.013 * (0.45 + 0.65 * widthEnv), (y + 0.90) * 0.072, z * 0.004 + 0.0065];
    })
  );

  // Fluffy white cotton puff tail
  const tailPuffGeo = trackGeo(
    createSculptedSphere(1.0, 10, 8, (x, y, z) => [x * 0.036, y * 0.038, z * 0.038])
  );

  // Powerful hind haunch thighs + elongated rabbit feet
  const hindThighGeo = trackGeo(
    createSculptedSphere(1.0, 10, 8, (x, y, z) => [x * 0.034, (y - 0.25) * 0.058, z * 0.054])
  );
  const hindFootGeo = trackGeo(
    createSculptedSphere(1.0, 8, 6, (x, y, z) => [x * 0.020, y * 0.012, (z + 0.55) * 0.062])
  );
  const frontLegGeo = trackGeo(
    createSculptedSphere(1.0, 8, 6, (x, y, z) => [x * 0.017, (y - 0.55) * 0.056, z * 0.019])
  );
  const frontPawGeo = trackGeo(
    createSculptedSphere(1.0, 6, 5, (x, y, z) => [x * 0.016, y * 0.009, (z + 0.45) * 0.020])
  );

  return {
    geometries,
    materials,
    textures,
    furMaterials,
    cottonTailMaterial,
    chestCreamMaterial,
    earInnerMaterial,
    noseMaterial,
    eyeMaterial,
    eyeGlintMaterial,
    geo: {
      haunchesGeo,
      chestGeo,
      chestFluffGeo,
      headGeo,
      noseGeo,
      eyeGeo,
      eyeGlintGeo,
      earOuterGeo,
      earInnerGeo,
      tailPuffGeo,
      hindThighGeo,
      hindFootGeo,
      frontLegGeo,
      frontPawGeo,
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      geometries.length = 0;
      materials.length = 0;
      textures.length = 0;
    },
  };
}

class RabbitActor {
  constructor(terrain, homePos, assets, seed) {
    this.terrain = terrain;
    this.homePos = homePos.clone();
    this._assets = assets;
    this._rng = createRng(seed);

    this.root = new THREE.Group();
    this.root.name = `ForestRabbit_${seed}`;
    this.baseScale = 0.92 + this._rng() * 0.16;
    this.root.scale.setScalar(this.baseScale);

    this.furVariant = Math.floor(this._rng() * assets.furMaterials.length);
    this._buildRig();

    this.active = true;
    this.state = 'nibble'; // 'nibble' | 'alert' | 'hop' | 'fleeHop'
    this._stateTimer = 1.4 + this._rng() * 3.2;

    this.position = this.root.position;
    this.position.copy(homePos);
    this._yaw = this._rng() * Math.PI * 2;
    this._earPhaseL = this._rng() * 10;
    this._earPhaseR = this._rng() * 10;
    this._nibblePhase = this._rng() * 10;

    // Parabolic hop arc state
    this._hopStart = new THREE.Vector3();
    this._hopEnd = new THREE.Vector3();
    this._hopTime = 0;
    this._hopDuration = 0.46;
    this._hopArcHeight = 0.45;
    this._hopsRemaining = 0;
    this._hopPause = 0;
    this._fleeDir = new THREE.Vector2(1, 0);

    this._alignToTerrain(1.0);
  }

  _buildRig() {
    const a = this._assets;
    const g = a.geo;
    const furMat = a.furMaterials[this.furVariant];

    const makeMesh = (geo, mat, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = cast;
      m.receiveShadow = true;
      return m;
    };

    this.bodyPivot = new THREE.Group();
    this.root.add(this.bodyPivot);

    // Rounded plump haunches
    this.haunches = new THREE.Group();
    this.haunches.position.set(0, 0.118, -0.055);
    this.bodyPivot.add(this.haunches);
    this.haunches.add(makeMesh(g.haunchesGeo, furMat));

    // White cotton puff tail!
    this.tailPuff = makeMesh(g.tailPuffGeo, a.cottonTailMaterial);
    this.tailPuff.position.set(0, 0.015, -0.112);
    this.haunches.add(this.tailPuff);

    // Powerful articulated hind legs + long rabbit feet
    const buildHind = (s) => {
      const hip = new THREE.Group();
      hip.position.set(s * 0.072, -0.025, -0.008);
      hip.add(makeMesh(g.hindThighGeo, furMat));

      const foot = new THREE.Group();
      foot.position.set(0, -0.078, 0.002);
      foot.add(makeMesh(g.hindFootGeo, furMat));
      hip.add(foot);

      this.haunches.add(hip);
      return { hip, foot };
    };
    const bl = buildHind(1);
    const br = buildHind(-1);
    this.legBL = bl.hip;
    this.footBL = bl.foot;
    this.legBR = br.hip;
    this.footBR = br.foot;

    // Compact chest & soft cream ruff
    this.chest = new THREE.Group();
    this.chest.position.set(0, 0.020, 0.112);
    this.haunches.add(this.chest);
    this.chest.add(makeMesh(g.chestGeo, furMat));

    const ruff = makeMesh(g.chestFluffGeo, a.chestCreamMaterial, false);
    ruff.position.set(0, -0.022, 0.036);
    this.chest.add(ruff);

    // Nimble front legs
    const buildFront = (s) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 0.044, -0.034, 0.028);
      shoulder.add(makeMesh(g.frontLegGeo, furMat));
      const paw = makeMesh(g.frontPawGeo, a.chestCreamMaterial, false);
      paw.position.set(0, -0.088, 0.010);
      shoulder.add(paw);
      this.chest.add(shoulder);
      return shoulder;
    };
    this.legFL = buildFront(1);
    this.legFR = buildFront(-1);

    // Head, twitching nose, glossy eyes, 2 long swiveling ears!
    this.head = new THREE.Group();
    this.head.position.set(0, 0.048, 0.056);
    this.chest.add(this.head);
    this.head.add(makeMesh(g.headGeo, furMat));

    this.nose = makeMesh(g.noseGeo, a.noseMaterial, false);
    this.nose.position.set(0, -0.008, 0.064);
    this.head.add(this.nose);

    for (const s of [1, -1]) {
      const eye = makeMesh(g.eyeGeo, a.eyeMaterial, false);
      eye.position.set(s * 0.038, 0.014, 0.020);
      this.head.add(eye);
      const glint = makeMesh(g.eyeGlintGeo, a.eyeGlintMaterial, false);
      glint.position.set(s * 0.044, 0.018, 0.025);
      this.head.add(glint);
    }

    const buildEar = (s) => {
      const ear = new THREE.Group();
      ear.position.set(s * 0.022, 0.034, -0.018);
      ear.rotation.set(-0.22, s * 0.25, -s * 0.16);
      ear.add(makeMesh(g.earOuterGeo, furMat));
      ear.add(makeMesh(g.earInnerGeo, a.earInnerMaterial, false));
      this.head.add(ear);
      return ear;
    };
    this.earL = buildEar(1);
    this.earR = buildEar(-1);
  }

  setActive(active) {
    this.active = Boolean(active);
    this.root.visible = this.active;
  }

  _sampleHeight(x, z) {
    if (!this.terrain || typeof this.terrain.getHeightAt !== 'function') return 0;
    const h = this.terrain.getHeightAt(x, z);
    return Number.isFinite(h) ? h : 0;
  }

  _sampleNormal(x, z, out) {
    if (!this.terrain || typeof this.terrain.getNormalAt !== 'function') {
      return out.set(0, 1, 0);
    }
    return this.terrain.getNormalAt(x, z, out);
  }

  _alignToTerrain(blend) {
    const n = this._sampleNormal(this.position.x, this.position.z, _normal);
    _fwd.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
    _fwd.addScaledVector(n, -_fwd.dot(n));
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    else _fwd.normalize();
    _right.crossVectors(n, _fwd).normalize();
    _fwd.crossVectors(_right, n).normalize();
    _rotMat.makeBasis(_right, n, _fwd);
    _targetQuat.setFromRotationMatrix(_rotMat);
    if (blend >= 0.999) this.root.quaternion.copy(_targetQuat);
    else this.root.quaternion.slerp(_targetQuat, clamp(blend, 0, 1));
  }

  _planNextHop(isFlee) {
    const clearing = this.terrain?.clearingCenter ?? { x: 10.5, y: 6.0 };
    const hopLen = isFlee ? 1.85 + this._rng() * 0.95 : 0.95 + this._rng() * 0.70;
    const baseAngle = isFlee
      ? Math.atan2(this._fleeDir.x, this._fleeDir.y) + (this._rng() - 0.5) * 0.45
      : Math.atan2(this.homePos.x - this.position.x, this.homePos.z - this.position.z) * 0.35 +
        (this._yaw + (this._rng() - 0.5) * 1.9);

    let chosenX = this.position.x;
    let chosenZ = this.position.z;
    let chosenY = this.position.y;
    let found = false;

    for (let k = 0; k < 10; k++) {
      const ang = baseAngle + (k === 0 ? 0 : (k % 2 === 0 ? 1 : -1) * k * 0.34);
      const tx = clamp(this.position.x + Math.sin(ang) * hopLen, -MAP_BOUND, MAP_BOUND);
      const tz = clamp(this.position.z + Math.cos(ang) * hopLen, -MAP_BOUND, MAP_BOUND);
      const ty = this._sampleHeight(tx, tz);
      if (ty <= WATER_SAFE_Y + 0.12) continue;
      const midY = this._sampleHeight((this.position.x + tx) * 0.5, (this.position.z + tz) * 0.5);
      if (midY <= WATER_SAFE_Y + 0.08) continue;
      if (
        this.terrain &&
        typeof this.terrain.getStreamDistance === 'function' &&
        typeof this.terrain.getStreamHalfWidth === 'function'
      ) {
        if (this.terrain.getStreamDistance(tx, tz) < this.terrain.getStreamHalfWidth(tz) + 1.1) continue;
      }

      // Stay clear of campfire center
      if (Math.hypot(tx - clearing.x, tz - clearing.y) < 3.0) continue;

      const slope =
        this.terrain && typeof this.terrain.getSlopeAt === 'function'
          ? this.terrain.getSlopeAt(tx, tz)
          : 0;
      if (slope > 0.44) continue;

      chosenX = tx;
      chosenZ = tz;
      chosenY = ty;
      this._yaw = Math.atan2(tx - this.position.x, tz - this.position.z);
      found = true;
      break;
    }

    if (!found) {
      // Gently hop back toward home meadow
      const dx = this.homePos.x - this.position.x;
      const dz = this.homePos.z - this.position.z;
      const d = Math.hypot(dx, dz) || 1;
      const step = Math.min(d, hopLen);
      chosenX = clamp(this.position.x + (dx / d) * step, -MAP_BOUND, MAP_BOUND);
      chosenZ = clamp(this.position.z + (dz / d) * step, -MAP_BOUND, MAP_BOUND);
      chosenY = Math.max(this._sampleHeight(chosenX, chosenZ), WATER_SAFE_Y);
      this._yaw = Math.atan2(dx, dz);
    }

    this._hopStart.copy(this.position);
    this._hopEnd.set(chosenX, chosenY, chosenZ);
    this._hopTime = 0;
    this._hopDuration = isFlee ? 0.34 + this._rng() * 0.08 : 0.44 + this._rng() * 0.10;
    this._hopArcHeight = isFlee ? 0.56 + this._rng() * 0.28 : 0.36 + this._rng() * 0.20;
    this._hopPause = 0;
  }

  _triggerFlee(humanPos) {
    const dx = this.position.x - humanPos.x;
    const dz = this.position.z - humanPos.z;
    const len = Math.hypot(dx, dz) || 1;
    this._fleeDir.set(dx / len, dz / len);
    this.state = 'fleeHop';
    this._hopsRemaining = 3 + Math.floor(this._rng() * 3);
    this._planNextHop(true);
  }

  update(dt, elapsed, humanPos) {
    if (!this.active) return;

    const humanDist = humanPos
      ? Math.hypot(humanPos.x - this.position.x, humanPos.z - this.position.z)
      : 999;

    let hopPhaseU = -1; // -1 when grounded, [0..1] mid-parabolic hop

    if (this.state === 'nibble') {
      this._stateTimer -= dt;
      const gy = this._sampleHeight(this.position.x, this.position.z);
      this.position.y = Math.max(gy, WATER_SAFE_Y);
      this._alignToTerrain(1.0 - Math.exp(-10 * dt));

      if (humanPos && humanDist < 9.5) {
        if (humanDist < 5.2) {
          this._triggerFlee(humanPos);
        } else {
          this.state = 'alert';
          this._stateTimer = 0.26;
          this._yaw = Math.atan2(humanPos.x - this.position.x, humanPos.z - this.position.z);
        }
      } else if (this._stateTimer <= 0) {
        this.state = 'hop';
        this._hopsRemaining = 2 + Math.floor(this._rng() * 3);
        this._planNextHop(false);
      }
    } else if (this.state === 'alert') {
      this._stateTimer -= dt;
      this._alignToTerrain(1.0 - Math.exp(-14 * dt));
      if (this._stateTimer <= 0) {
        if (humanPos && humanDist < 10.5) {
          this._triggerFlee(humanPos);
        } else {
          this.state = 'nibble';
          this._stateTimer = 2.0 + this._rng() * 2.5;
        }
      }
    } else if (this.state === 'hop' || this.state === 'fleeHop') {
      const isFlee = this.state === 'fleeHop';

      if (this._hopPause > 0) {
        this._hopPause -= dt;
        this._alignToTerrain(1.0 - Math.exp(-14 * dt));
        if (this._hopPause <= 0) {
          if (this._hopsRemaining > 0) {
            if (!isFlee && humanPos && humanDist < 9.5) {
              this._triggerFlee(humanPos);
            } else {
              this._planNextHop(isFlee);
            }
          } else {
            this.state = 'nibble';
            this._stateTimer = 2.0 + this._rng() * 3.4;
          }
        }
      } else {
        this._hopTime += dt;
        const u = clamp(this._hopTime / this._hopDuration, 0, 1);
        hopPhaseU = u;

        // Realistic parabolic hop arc over grass and ferns!
        const px = lerp(this._hopStart.x, this._hopEnd.x, u);
        const pz = lerp(this._hopStart.z, this._hopEnd.z, u);
        const baseY = lerp(this._hopStart.y, this._hopEnd.y, u);
        const arcLift = 4.0 * this._hopArcHeight * u * (1.0 - u);
        this.position.set(px, baseY + arcLift, pz);
        this._alignToTerrain(1.0 - Math.exp(-14 * dt));

        if (u >= 1.0) {
          const groundY = this._sampleHeight(this._hopEnd.x, this._hopEnd.z);
          this.position.set(this._hopEnd.x, Math.max(groundY, WATER_SAFE_Y), this._hopEnd.z);
          this._hopsRemaining--;
          this._hopPause = isFlee ? 0.08 + this._rng() * 0.05 : 0.14 + this._rng() * 0.12;
        }
      }
    }

    // --- Procedural Rabbit Articulation ---
    // Nose wiggle is nearly constant on real woodland rabbits!
    const noseTwitch = Math.sin(elapsed * 18.0 + this._nibblePhase) * 0.0025;
    this.nose.position.y = -0.008 + noseTwitch;

    if (hopPhaseU >= 0) {
      // Realistic mid-hop pose: explosive hind leg kick-out -> sleek mid-air stretch -> front paw landing!
      const u = hopPhaseU;
      const pitchArc = lerp(-0.42, 0.24, smoothstep(0.05, 0.95, u));
      const stretch = Math.sin(u * Math.PI);

      this.bodyPivot.position.y = 0;
      this.bodyPivot.rotation.x = pitchArc;

      this.haunches.rotation.x = -0.10 + stretch * 0.20;
      this.chest.rotation.x = 0.06 - stretch * 0.18;
      this.head.rotation.set(-pitchArc * 0.55, 0, 0);

      // Powerful hind legs extend strongly backward mid-hop (positive rot.x kicks backward!)
      const hindExtend = smoothstep(0.0, 0.35, u) * (1.0 - smoothstep(0.68, 1.0, u));
      this.legBL.rotation.x = 0.15 + hindExtend * 1.15;
      this.legBR.rotation.x = 0.15 + hindExtend * 1.15;
      this.footBL.rotation.x = hindExtend * 0.65;
      this.footBR.rotation.x = hindExtend * 0.65;

      // Front legs tuck cleanly at apex, then reach forward to cushion touchdown
      const frontReach = smoothstep(0.55, 0.95, u);
      const frontTuck = Math.sin(u * Math.PI) * (1.0 - frontReach);
      this.legFL.rotation.x = frontTuck * 0.72 - frontReach * 0.68;
      this.legFR.rotation.x = frontTuck * 0.72 - frontReach * 0.68;

      // Long ears flatten sleekly backward mid-hop!
      const earSweepBack = -0.25 - stretch * 0.78;
      this.earL.rotation.set(earSweepBack, 0.18, -0.12);
      this.earR.rotation.set(earSweepBack, -0.18, 0.12);

      // Cotton puff tail bounces cheerfully
      this.tailPuff.position.y = 0.015 + stretch * 0.014;
    } else if (this.state === 'alert') {
      // Frozen tall alert posture with ears perked straight up scanning the threat!
      this.bodyPivot.position.y = 0.015;
      this.bodyPivot.rotation.x = -0.16;
      this.haunches.rotation.x = -0.12;
      this.chest.rotation.x = -0.10;
      this.head.rotation.set(0.05, 0, 0);

      this.legBL.rotation.x = 0.0;
      this.legBR.rotation.x = 0.0;
      this.footBL.rotation.x = 0.0;
      this.footBR.rotation.x = 0.0;
      this.legFL.rotation.x = -0.10;
      this.legFR.rotation.x = -0.10;

      // Tall perked radar ears
      this.earL.rotation.set(0.12, 0.22, -0.08);
      this.earR.rotation.set(0.12, -0.22, 0.08);
      this.tailPuff.position.y = 0.016;
    } else {
      // Relaxed nibbling / crouch pause between bounds
      const isPause = this.state === 'hop' || this.state === 'fleeHop';
      const chew = isPause ? 0 : Math.sin(elapsed * 8.5 + this._nibblePhase) * 0.07;
      const dip = isPause ? 0.08 : (Math.sin(elapsed * 1.4 + this._nibblePhase) * 0.5 + 0.5) * 0.34;
      const lookY = isPause ? 0 : Math.sin(elapsed * 0.9 + this._nibblePhase) * 0.28;

      this.bodyPivot.position.y = isPause ? -0.018 : -0.004;
      this.bodyPivot.rotation.x = isPause ? 0.08 : 0;
      this.haunches.rotation.x = 0.06;
      this.chest.rotation.x = 0.08 + dip * 0.45;
      this.head.rotation.set(0.16 + dip + chew, lookY, 0);

      this.legBL.rotation.x = -0.12;
      this.legBR.rotation.x = -0.12;
      this.footBL.rotation.x = 0.08;
      this.footBR.rotation.x = 0.08;
      this.legFL.rotation.x = -0.12;
      this.legFR.rotation.x = -0.12;

      // Long ears swivel independently listening to the forest
      const swL = Math.sin(elapsed * 1.7 + this._earPhaseL) * 0.38;
      const swR = Math.sin(elapsed * 2.1 + this._earPhaseR) * 0.38;
      this.earL.rotation.set(-0.22 + swL * 0.35, 0.28 + swL, -0.16 - Math.abs(swL) * 0.14);
      this.earR.rotation.set(-0.22 + swR * 0.35, -0.28 - swR, 0.16 + Math.abs(swR) * 0.14);
      this.tailPuff.position.y = 0.015;
    }
  }

  dispose() {
    if (this.root.parent) {
      this.root.parent.remove(this.root);
    }
  }
}

// ============================================================================
// FOREST WILDLIFE ECOSYSTEM MANAGER
// ============================================================================

/**
 * Orchestrates 3 articulated procedural woodland species:
 *  - 14 default (15 pre-allocated) forest rats (`RatActor`) with proximity & manual leg-climb scare AI
 *  - 8 default (10 pre-allocated) tree-climbing red squirrels paired to real trees from `treePositions`
 *  - 8 default (10 pre-allocated) fern-hopping woodland cottontail rabbits
 * Supports hitch-free population scaling via `setPopulation(scale)` in [0.25, 1.5].
 */
export class ForestWildlife {
  constructor(scene, terrain, treePositions = [], audio = null) {
    this.scene = scene;
    this.terrain = terrain;
    this.treePositions = Array.isArray(treePositions) ? treePositions : [];
    this.audio = audio;

    this._rng = createRng(8842);
    this.group = new THREE.Group();
    this.group.name = 'ForestWildlife';
    if (scene && typeof scene.add === 'function') {
      scene.add(this.group);
    }

    // Shared procedural geometry/texture/material pools (zero duplicate textures!)
    this._ratAssets = createRatSharedAssets();
    this._squirrelAssets = createSquirrelSharedAssets();
    this._rabbitAssets = createRabbitSharedAssets();

    // Global proximity scare cooldown (~16s so organic scares stay exciting without spamming)
    this._globalScareCooldown = 0;
    this._nextManualSide = 'right';
    this.populationScale = 1.0;

    // 1. Pre-allocate 15 Articulated Forest Rats
    const ratHomes = this._computeRatHomePositions(MAX_RATS);
    this.rats = [];
    for (let i = 0; i < MAX_RATS; i++) {
      const isClearingHero = i < 3;
      const rat = new RatActor(terrain, {
        seed: 4100 + i * 37,
        homePos: ratHomes[i],
        boldness: isClearingHero ? 0.78 + this._rng() * 0.20 : 0.44 + this._rng() * 0.46,
        territoryRadius: isClearingHero ? 5.2 + this._rng() * 2.4 : 6.0 + this._rng() * 4.5,
        furVariant: i % 3,
        scale: 0.96 + this._rng() * 0.14,
        sharedAssets: this._ratAssets,
        name: `ForestRat_${i}`,
      });
      this.group.add(rat.root);
      this.rats.push(rat);
    }

    // 2. Pre-allocate 10 Articulated Tree-Climbing Squirrels paired to real trees
    const squirrelTrees = this._selectSquirrelTrees(MAX_SQUIRRELS);
    this.squirrels = [];
    for (let i = 0; i < MAX_SQUIRRELS; i++) {
      const sq = new SquirrelActor(terrain, squirrelTrees[i], this._squirrelAssets, 5100 + i * 53);
      this.group.add(sq.root);
      this.squirrels.push(sq);
    }

    // 3. Pre-allocate 10 Articulated Fern-Hopping Woodland Rabbits
    const rabbitHomes = this._computeRabbitHomePositions(MAX_RABBITS);
    this.rabbits = [];
    for (let i = 0; i < MAX_RABBITS; i++) {
      const rb = new RabbitActor(terrain, rabbitHomes[i], this._rabbitAssets, 6200 + i * 71);
      this.group.add(rb.root);
      this.rabbits.push(rb);
    }

    // Reusable humanInfo descriptor passed into each RatActor.update()
    this._ratHumanInfo = {
      position: new THREE.Vector3(),
      canProximityTrigger: true,
      getFootWorldPos: null,
      getShinBone: null,
      triggerRatPanic: null,
      onScareTriggered: () => {
        this._globalScareCooldown = GLOBAL_SCARE_COOLDOWN;
      },
    };

    // Apply default population scale (14 rats, 8 squirrels, 8 rabbits)
    this.setPopulation(1.0);
  }

  _sampleHeight(x, z) {
    if (!this.terrain || typeof this.terrain.getHeightAt !== 'function') return 1.0;
    const h = this.terrain.getHeightAt(x, z);
    return Number.isFinite(h) ? h : 1.0;
  }

  _sampleSlope(x, z) {
    if (!this.terrain || typeof this.terrain.getSlopeAt !== 'function') return 0;
    return this.terrain.getSlopeAt(x, z);
  }

  _isGoodDrySite(x, z, minY = 0.42, maxSlope = 0.42, minCampfireDist = 3.2) {
    if (Math.abs(x) > MAP_BOUND || Math.abs(z) > MAP_BOUND) return null;
    const y = this._sampleHeight(x, z);
    if (y <= minY) return null;
    if (this._sampleSlope(x, z) > maxSlope) return null;

    if (
      this.terrain &&
      typeof this.terrain.getStreamDistance === 'function' &&
      typeof this.terrain.getStreamHalfWidth === 'function'
    ) {
      if (this.terrain.getStreamDistance(x, z) < this.terrain.getStreamHalfWidth(z) + 2.2) {
        return null;
      }
    }

    const clearing = this.terrain?.clearingCenter ?? { x: 10.5, y: 6.0 };
    if (Math.hypot(x - clearing.x, z - clearing.y) < minCampfireDist) return null;

    return y;
  }

  _computeRatHomePositions(count) {
    const homes = [];
    const clearing = this.terrain?.clearingCenter ?? { x: 10.5, y: 6.0 };

    // First 3 rats: bold clearing-perimeter territories so exploring naturally encounters them!
    for (let i = 0; i < 3 && homes.length < count; i++) {
      let placed = false;
      for (let t = 0; t < 20; t++) {
        const ang = (i / 3) * Math.PI * 2 + 0.55 + (this._rng() - 0.5) * 0.7;
        const dist = 8.4 + this._rng() * 4.8;
        const x = clearing.x + Math.cos(ang) * dist;
        const z = clearing.y + Math.sin(ang) * dist;
        const y = this._isGoodDrySite(x, z, 0.40, 0.42, 4.5);
        if (y !== null) {
          homes.push(new THREE.Vector3(x, y, z));
          placed = true;
          break;
        }
      }
      if (!placed) {
        const x = clearing.x + Math.cos(i * 2.1) * 9.5;
        const z = clearing.y + Math.sin(i * 2.1) * 9.5;
        homes.push(new THREE.Vector3(x, Math.max(this._sampleHeight(x, z), 0.5), z));
      }
    }

    // Next 4 rats: mossy stream banks just above water level
    for (let i = 0; i < 4 && homes.length < count; i++) {
      let placed = false;
      for (let t = 0; t < 24; t++) {
        const z = (this._rng() * 2 - 1) * 28.0;
        const scx =
          this.terrain && typeof this.terrain.getStreamCenterX === 'function'
            ? this.terrain.getStreamCenterX(z)
            : -14.0;
        const hw =
          this.terrain && typeof this.terrain.getStreamHalfWidth === 'function'
            ? this.terrain.getStreamHalfWidth(z)
            : 4.3;
        const side = i % 2 === 0 ? 1 : -1;
        const x = scx + side * (hw + 1.8 + this._rng() * 4.2);
        const y = this._isGoodDrySite(x, z, 0.36, 0.46, 4.0);
        if (y !== null) {
          homes.push(new THREE.Vector3(x, y, z));
          placed = true;
          break;
        }
      }
      if (!placed) {
        const ang = this._rng() * Math.PI * 2;
        const x = clearing.x + Math.cos(ang) * 16.0;
        const z = clearing.y + Math.sin(ang) * 16.0;
        homes.push(new THREE.Vector3(x, Math.max(this._sampleHeight(x, z), 0.5), z));
      }
    }

    // Remaining rats: around woodland tree roots, boulders, logs & trails (14 - 46 units)
    let tries = 0;
    while (homes.length < count && tries < 300) {
      tries++;
      let x, z;
      if (this.treePositions.length > 0 && this._rng() < 0.65) {
        const tree = this.treePositions[Math.floor(this._rng() * this.treePositions.length)];
        const dClear = Math.hypot(tree.x - clearing.x, tree.z - clearing.y);
        if (dClear > 52 && tries < 180) continue;
        const ang = this._rng() * Math.PI * 2;
        const d = (tree.radius || 0.5) + 1.2 + this._rng() * 2.5;
        x = tree.x + Math.cos(ang) * d;
        z = tree.z + Math.sin(ang) * d;
      } else {
        const ang = this._rng() * Math.PI * 2;
        const dist = 13.0 + this._rng() * 34.0;
        x = clearing.x + Math.cos(ang) * dist;
        z = clearing.y + Math.sin(ang) * dist;
      }
      const y = this._isGoodDrySite(x, z, 0.38, 0.44, 5.0);
      if (y !== null) {
        homes.push(new THREE.Vector3(x, y, z));
      }
    }

    while (homes.length < count) {
      const ang = (homes.length / count) * Math.PI * 2;
      const x = clearing.x + Math.cos(ang) * 15.0;
      const z = clearing.y + Math.sin(ang) * 15.0;
      homes.push(new THREE.Vector3(x, Math.max(this._sampleHeight(x, z), 0.5), z));
    }

    return homes;
  }

  _selectSquirrelTrees(count) {
    const clearing = this.terrain?.clearingCenter ?? { x: 10.5, y: 6.0 };
    const selected = [];

    if (this.treePositions.length > 0) {
      // Score trees: strongly prioritize clearing-framing & stream-adjacent trees so player spots squirrels immediately!
      const scored = this.treePositions
        .filter((t) => t && Number.isFinite(t.x) && Number.isFinite(t.z))
        .map((t) => {
          const distClear = Math.hypot(t.x - clearing.x, t.z - clearing.y);
          const distStream =
            this.terrain && typeof this.terrain.getStreamDistance === 'function'
              ? this.terrain.getStreamDistance(t.x, t.z)
              : 20;
          let score = 0;
          // Sweet spot: framing the clearing (12 - 30 units)
          if (distClear >= 11.0 && distClear <= 32.0) {
            score += 40.0 - Math.abs(distClear - 18.0);
          } else {
            score += Math.max(0, 22.0 - Math.abs(distClear - 34.0) * 0.5);
          }
          // Bonus for scenic trees near stream banks
          if (distStream < 16.0) score += 12.0;
          // Slight preference for climbable pines & stout oaks
          if (t.species === 'pine') score += 7.0;
          else if (t.species === 'oak') score += 5.0;
          score += this._rng() * 5.0;
          return { tree: t, score };
        });

      scored.sort((a, b) => b.score - a.score);

      for (const entry of scored) {
        if (selected.length >= count) break;
        const t = entry.tree;
        let tooClose = false;
        for (const s of selected) {
          if (Math.hypot(t.x - s.x, t.z - s.z) < 5.5) {
            tooClose = true;
            break;
          }
        }
        if (!tooClose) {
          selected.push({
            x: t.x,
            y: Number.isFinite(t.y) ? t.y : this._sampleHeight(t.x, t.z),
            z: t.z,
            species: t.species || 'pine',
            scale: t.scale || 1.0,
            radius: t.radius || 0.48,
          });
        }
      }

      // Top up with remaining trees if spacing was tight
      for (const entry of scored) {
        if (selected.length >= count) break;
        const t = entry.tree;
        if (!selected.some((s) => s.x === t.x && s.z === t.z)) {
          selected.push({
            x: t.x,
            y: Number.isFinite(t.y) ? t.y : this._sampleHeight(t.x, t.z),
            z: t.z,
            species: t.species || 'pine',
            scale: t.scale || 1.0,
            radius: t.radius || 0.48,
          });
        }
      }
    }

    // Fallback virtual anchor trees if treePositions was empty (e.g. standalone unit test)
    while (selected.length < count) {
      const ang = (selected.length / count) * Math.PI * 2 + 0.3;
      const dist = 14.0 + (selected.length % 3) * 4.5;
      const x = clearing.x + Math.cos(ang) * dist;
      const z = clearing.y + Math.sin(ang) * dist;
      selected.push({
        x,
        y: Math.max(this._sampleHeight(x, z), 0.6),
        z,
        species: selected.length % 2 === 0 ? 'pine' : 'oak',
        scale: 1.0,
        radius: 0.52,
      });
    }

    return selected;
  }

  _computeRabbitHomePositions(count) {
    const homes = [];
    const clearing = this.terrain?.clearingCenter ?? { x: 10.5, y: 6.0 };

    // First 3 rabbits: sunlit clearing edges & fern glades immediately visible to the explorer!
    for (let i = 0; i < 3 && homes.length < count; i++) {
      let placed = false;
      for (let t = 0; t < 24; t++) {
        const ang = (i / 3) * Math.PI * 2 + 1.15 + (this._rng() - 0.5) * 0.6;
        const dist = 9.5 + this._rng() * 7.5;
        const x = clearing.x + Math.cos(ang) * dist;
        const z = clearing.y + Math.sin(ang) * dist;
        const y = this._isGoodDrySite(x, z, 0.38, 0.30, 5.5);
        if (y !== null) {
          homes.push(new THREE.Vector3(x, y, z));
          placed = true;
          break;
        }
      }
      if (!placed) {
        const x = clearing.x + Math.cos(i * 2.1 + 1.0) * 11.5;
        const z = clearing.y + Math.sin(i * 2.1 + 1.0) * 11.5;
        homes.push(new THREE.Vector3(x, Math.max(this._sampleHeight(x, z), 0.5), z));
      }
    }

    // Remaining 7 rabbits: sunlit meadows & fern patches around the woodland
    let tries = 0;
    while (homes.length < count && tries < 320) {
      tries++;
      const ang = this._rng() * Math.PI * 2;
      const dist = 15.0 + this._rng() * 32.0;
      const x = clearing.x + Math.cos(ang) * dist;
      const z = clearing.y + Math.sin(ang) * dist;
      const y = this._isGoodDrySite(x, z, 0.38, 0.30, 6.0);
      if (y === null) continue;

      let wellSpaced = true;
      for (const h of homes) {
        if (Math.hypot(x - h.x, z - h.z) < 5.5) {
          wellSpaced = false;
          break;
        }
      }
      if (wellSpaced) {
        homes.push(new THREE.Vector3(x, y, z));
      }
    }

    while (homes.length < count) {
      const ang = (homes.length / count) * Math.PI * 2 + 0.7;
      const x = clearing.x + Math.cos(ang) * 18.0;
      const z = clearing.y + Math.sin(ang) * 18.0;
      homes.push(new THREE.Vector3(x, Math.max(this._sampleHeight(x, z), 0.5), z));
    }

    return homes;
  }

  /**
   * Scales active wildlife population cleanly with zero allocations or frame hitch.
   * `scale` is clamped to [0.25, 1.5] (default 1.0 => 14 rats, 8 squirrels, 8 rabbits).
   */
  setPopulation(scale = 1.0) {
    this.populationScale = clamp(Number.isFinite(scale) ? scale : 1.0, 0.25, 1.5);

    const activeRats = clamp(Math.round(DEFAULT_RATS * this.populationScale), 1, MAX_RATS);
    const activeSquirrels = clamp(
      Math.round(DEFAULT_SQUIRRELS * this.populationScale),
      1,
      MAX_SQUIRRELS
    );
    const activeRabbits = clamp(Math.round(DEFAULT_RABBITS * this.populationScale), 1, MAX_RABBITS);

    for (let i = 0; i < this.rats.length; i++) {
      this.rats[i].setActive(i < activeRats);
    }
    for (let i = 0; i < this.squirrels.length; i++) {
      this.squirrels[i].setActive(i < activeSquirrels);
    }
    for (let i = 0; i < this.rabbits.length; i++) {
      this.rabbits[i].setActive(i < activeRabbits);
    }
  }

  _extractHumanPosition(humanController, out) {
    if (!humanController) return null;
    if (typeof humanController.getPosition === 'function') {
      const r = humanController.getPosition(out);
      if (r && Number.isFinite(r.x)) {
        out.copy(r);
        return out;
      }
      if (Number.isFinite(out.x)) return out;
    }
    if (humanController.position && Number.isFinite(humanController.position.x)) {
      return out.copy(humanController.position);
    }
    if (humanController.root?.position && Number.isFinite(humanController.root.position.x)) {
      return out.copy(humanController.root.position);
    }
    return null;
  }

  _extractHumanForward(humanController, out) {
    if (humanController) {
      if (typeof humanController.getForward === 'function') {
        const r = humanController.getForward(out);
        if (r && Number.isFinite(r.x)) {
          out.copy(r);
          out.y = 0;
          if (out.lengthSq() > 1e-4) return out.normalize();
        }
      }
      if (typeof humanController.getYaw === 'function') {
        const yaw = humanController.getYaw();
        if (Number.isFinite(yaw)) {
          return out.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
        }
      }
      if (humanController.root?.quaternion) {
        out.set(0, 0, 1).applyQuaternion(humanController.root.quaternion);
        out.y = 0;
        if (out.lengthSq() > 1e-4) return out.normalize();
      }
    }
    return out.set(0, 0, 1);
  }

  /**
   * Manually dispatches an immediate dramatic rat scare (bypassing global cooldown).
   * Picks the nearest idle/foraging rat — and if it's > 7 units away, smoothly repositions
   * it into grass ~4.2 units ahead/beside the human so a visible grass sprint and leg-climb
   * occurs within ~0.7-1.1s!
   */
  setSurfaceSolver(surfaceSolver) {
    this.surfaceSolver = surfaceSolver || null;
    for (let i = 0; i < this.rats.length; i++) {
      this.rats[i].setSurfaceSolver?.(this.surfaceSolver);
    }
  }

  triggerRatScare(humanController) {
    const hPos = this._extractHumanPosition(humanController, _humanPos);
    if (!hPos) return false;

    // Avoid stacking a second rat onto the leg while one is already climbing
    for (let i = 0; i < this.rats.length; i++) {
      if (this.rats[i].active && this.rats[i].isClimbing()) {
        return false;
      }
    }

    // Pick nearest active idle/foraging rat (falling back to any non-climbing active rat)
    let bestRat = null;
    let bestDistSq = Infinity;

    for (let pass = 0; pass < 2 && !bestRat; pass++) {
      for (let i = 0; i < this.rats.length; i++) {
        const rat = this.rats[i];
        if (!rat.active || rat.isClimbing()) continue;
        if (pass === 0 && rat.state !== 'forage' && rat.state !== 'scurry') continue;

        const dSq = rat.position.distanceToSquared(hPos);
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestRat = rat;
        }
      }
    }

    if (!bestRat) return false;

    // Choose target boot side (closest foot if close, else alternate left/right)
    let side = this._nextManualSide;
    if (typeof humanController.getFootWorldPos === 'function') {
      const fL = humanController.getFootWorldPos('left', _footL) || _footL;
      const fR = humanController.getFootWorldPos('right', _footR) || _footR;
      if (bestDistSq <= 49.0 && Number.isFinite(fL.x) && Number.isFinite(fR.x)) {
        side =
          bestRat.position.distanceToSquared(fL) < bestRat.position.distanceToSquared(fR)
            ? 'left'
            : 'right';
      }
    }
    this._nextManualSide = side === 'right' ? 'left' : 'right';

    const shelter = this.surfaceSolver?.getShelterState?.(hPos);
    const isIndoors = Boolean(shelter?.sheltered);

    let teleportNearPos = null;
    if (bestDistSq > 49.0 || (isIndoors && bestDistSq > 9.0)) {
      // Reposition onto same walkable floor (cabin floorboards / hollow tree / grass)
      const fwd = this._extractHumanForward(humanController, _humanFwd);
      const baseYaw = Math.atan2(fwd.x, fwd.z);
      const sideSign = side === 'left' ? 1 : -1;
      const candidateOffsets = [
        sideSign * 0.58,
        -sideSign * 0.58,
        sideSign * 0.95,
        -sideSign * 0.95,
        0.18,
        -0.18,
        sideSign * 1.55,
        Math.PI,
      ];

      const launchDist = isIndoors ? 1.85 : 4.2;
      let chosen = false;
      for (const offset of candidateOffsets) {
        const ang = baseYaw + offset;
        const sx = clamp(hPos.x + Math.sin(ang) * launchDist, -MAP_BOUND, MAP_BOUND);
        const sz = clamp(hPos.z + Math.cos(ang) * launchDist, -MAP_BOUND, MAP_BOUND);
        const sy = this.surfaceSolver
          ? this.surfaceSolver.getHeightAt(sx, sz, hPos.y + 0.5)
          : this._sampleHeight(sx, sz);
        if (sy > WATER_SAFE_Y && (!isIndoors || Math.abs(sy - hPos.y) < 0.45)) {
          _spawnPos.set(sx, sy, sz);
          chosen = true;
          break;
        }
      }
      if (!chosen) {
        const sx = clamp(hPos.x + fwd.x * launchDist, -MAP_BOUND, MAP_BOUND);
        const sz = clamp(hPos.z + fwd.z * launchDist, -MAP_BOUND, MAP_BOUND);
        const sy = this.surfaceSolver
          ? this.surfaceSolver.getHeightAt(sx, sz, hPos.y + 0.5)
          : Math.max(this._sampleHeight(sx, sz), WATER_SAFE_Y);
        _spawnPos.set(sx, sy, sz);
      }
      teleportNearPos = _spawnPos;
    }

    bestRat.startScareChase(side, teleportNearPos);
    this._globalScareCooldown = GLOBAL_SCARE_COOLDOWN;
    playRatSqueak(this.audio, 0.92);
    return true;
  }

  getStats() {
    let activeRats = 0;
    let climbingRat = false;
    for (let i = 0; i < this.rats.length; i++) {
      if (this.rats[i].active) {
        activeRats++;
        if (this.rats[i].isClimbing()) climbingRat = true;
      }
    }

    let activeSquirrels = 0;
    for (let i = 0; i < this.squirrels.length; i++) {
      if (this.squirrels[i].active) activeSquirrels++;
    }

    let activeRabbits = 0;
    for (let i = 0; i < this.rabbits.length; i++) {
      if (this.rabbits[i].active) activeRabbits++;
    }

    return { activeRats, activeSquirrels, activeRabbits, climbingRat };
  }

  update(dt, elapsed, humanController = null) {
    const safeDt = clamp(Number.isFinite(dt) ? dt : 0.016, 0.0001, 0.05);
    const safeElapsed = Number.isFinite(elapsed) ? elapsed : 0;

    if (this._globalScareCooldown > 0) {
      this._globalScareCooldown = Math.max(0, this._globalScareCooldown - safeDt);
    }

    const hPos = this._extractHumanPosition(humanController, _humanPos);

    // Check if any active rat is currently chasing, climbing, or leaping off
    let anyRatScaring = false;
    for (let i = 0; i < this.rats.length; i++) {
      if (this.rats[i].active && this.rats[i].isScaring()) {
        anyRatScaring = true;
        break;
      }
    }

    // Build reusable humanInfo view for rats (zero allocations per frame!)
    let ratHumanInfo = null;
    if (hPos && humanController) {
      this._ratHumanInfo.position.copy(hPos);
      this._ratHumanInfo.canProximityTrigger =
        !anyRatScaring && this._globalScareCooldown <= 0;
      this._ratHumanInfo.getFootWorldPos =
        typeof humanController.getFootWorldPos === 'function'
          ? (side, out) => humanController.getFootWorldPos(side, out)
          : null;
      this._ratHumanInfo.getShinBone =
        typeof humanController.getShinBone === 'function'
          ? (side) => humanController.getShinBone(side)
          : null;
      this._ratHumanInfo.triggerRatPanic =
        typeof humanController.triggerRatPanic === 'function'
          ? (side) => humanController.triggerRatPanic(side)
          : null;
      ratHumanInfo = this._ratHumanInfo;
    }

    // 1. Update Rats
    for (let i = 0; i < this.rats.length; i++) {
      const rat = this.rats[i];
      if (!rat.active) continue;
      // Ensure at most one rat can proximity-trigger during this exact tick
      if (ratHumanInfo && anyRatScaring) {
        ratHumanInfo.canProximityTrigger = false;
      }
      rat.update(safeDt, safeElapsed, ratHumanInfo, this.audio);
      if (rat.isScaring()) {
        anyRatScaring = true;
      }
    }

    // 2. Update Tree-Climbing Squirrels
    for (let i = 0; i < this.squirrels.length; i++) {
      const sq = this.squirrels[i];
      if (sq.active) {
        sq.update(safeDt, safeElapsed, hPos, this.audio);
      }
    }

    // 3. Update Fern-Hopping Rabbits
    for (let i = 0; i < this.rabbits.length; i++) {
      const rb = this.rabbits[i];
      if (rb.active) {
        rb.update(safeDt, safeElapsed, hPos);
      }
    }
  }

  dispose() {
    for (const r of this.rats) r.dispose();
    for (const s of this.squirrels) s.dispose();
    for (const b of this.rabbits) b.dispose();

    this.rats.length = 0;
    this.squirrels.length = 0;
    this.rabbits.length = 0;

    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }

    this._ratAssets?.dispose();
    this._squirrelAssets?.dispose();
    this._rabbitAssets?.dispose();
    this._ratAssets = null;
    this._squirrelAssets = null;
    this._rabbitAssets = null;
  }
}
