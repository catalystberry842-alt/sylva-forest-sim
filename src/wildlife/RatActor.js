import * as THREE from 'three';
import { createRng, clamp, lerp, smoothstep } from '../utils/random.js';

const MAP_BOUND = 102;
const WATER_SAFE_Y = 0.25;
const TAIL_SEG_LENGTHS = [0.068, 0.068, 0.066, 0.064, 0.060, 0.056]; // Total ~0.382
const TAIL_SEG_RADII = [0.0155, 0.0130, 0.0108, 0.0086, 0.0064, 0.0042, 0.0018];

// Scratch math objects (zero per-frame GC allocations)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _humanPos = new THREE.Vector3();
const _footPos = new THREE.Vector3();
const _footAlt = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _climbN = new THREE.Vector3();
const _climbZ = new THREE.Vector3();
const _climbX = new THREE.Vector3();
const _localPos = new THREE.Vector3();
const _worldPos = new THREE.Vector3();
const _shinQuat = new THREE.Quaternion();
const _localQuat = new THREE.Quaternion();
const _targetQuat = new THREE.Quaternion();
const _rotMat = new THREE.Matrix4();
const _invRootQuat = new THREE.Quaternion();
const _rootVel = new THREE.Vector3();
const _rootAccel = new THREE.Vector3();
const _localAccel = new THREE.Vector3();

function wrapAngle(a) {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/**
 * Safely plays a procedural high-pitched rodent squeak through the audio system.
 * Uses a dedicated audio method if present, or synthesizes a lightweight Web Audio
 * double-pip squeak directly into ProceduralAudio's mix bus when unmuted.
 */
export function playRatSqueak(audio, urgency = 0.7) {
  if (!audio) return;
  try {
    if (typeof audio.triggerRatSqueak === 'function') {
      audio.triggerRatSqueak(urgency);
      return;
    }
    if (typeof audio.playRatSqueak === 'function') {
      audio.playRatSqueak(urgency);
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
      const pips = urgency > 0.75 ? 2 : 1;
      for (let i = 0; i < pips; i++) {
        const t = now + i * (0.068 + Math.random() * 0.025);
        const dur = 0.055 + Math.random() * 0.032;
        const f0 = 3650 + Math.random() * 1150 + urgency * 650;
        const fPeak = f0 * (1.16 + Math.random() * 0.16);
        const fEnd = f0 * (0.76 + Math.random() * 0.12);

        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f0, t);
        osc.frequency.exponentialRampToValueAtTime(fPeak, t + dur * 0.36);
        osc.frequency.exponentialRampToValueAtTime(fEnd, t + dur);

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(fPeak * 0.95, t);
        bp.Q.setValueAtTime(2.6, t);

        const env = ctx.createGain();
        const peakGain = (0.032 + urgency * 0.026) * (i === 0 ? 1.0 : 0.8);
        env.gain.setValueAtTime(0.0001, t);
        env.gain.linearRampToValueAtTime(peakGain, t + 0.008);
        env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

        osc.connect(bp);
        bp.connect(env);
        env.connect(audio._mixBus);

        osc.start(t);
        osc.stop(t + dur + 0.015);
      }
    }
  } catch {
    // Non-fatal in headless or suspended audio contexts
  }
}

/**
 * Helper to deform a SphereGeometry with an anatomical sculpting callback.
 */
function createSculptedSphere(radius, widthSegs, heightSegs, sculptFn) {
  const geo = new THREE.SphereGeometry(radius, widthSegs, heightSegs);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const out = sculptFn(x, y, z);
    if (out) {
      pos.setXYZ(i, out[0], out[1], out[2]);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds procedural fur diffuse + bump canvas textures (with automatic DataTexture
 * fallback in headless Node environments without a DOM document).
 */
function createFurTexturePair(palette, seed) {
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

    // Base coat gradient: rich dorsal stripe -> agouti flanks -> soft lighter undercoat
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0.0, palette.dorsal);
    grad.addColorStop(0.32, palette.mid);
    grad.addColorStop(0.68, palette.flank);
    grad.addColorStop(1.0, palette.belly);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Subtle organic mottled coat variation
    for (let i = 0; i < 95; i++) {
      const px = rng() * size;
      const py = rng() * size;
      const rad = 10 + rng() * 26;
      const darker = rng() > 0.45;
      ctx.fillStyle = darker ? 'rgba(22, 14, 10, 0.08)' : 'rgba(225, 205, 180, 0.07)';
      ctx.beginPath();
      ctx.arc(px, py, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    // Neutral gray bump background
    bctx.fillStyle = '#787878';
    bctx.fillRect(0, 0, size, size);

    // 2,600 fine directional fur hairs (layered dark underfur + ticked agouti guard hairs)
    ctx.lineCap = 'round';
    bctx.lineCap = 'round';
    for (let i = 0; i < 2600; i++) {
      const hx = rng() * size;
      const hy = rng() * size;
      const len = 5 + rng() * 11;
      const ang = (rng() - 0.5) * 0.34; // Mostly aligned along coat flow
      const dx = Math.cos(ang) * len;
      const dy = Math.sin(ang) * len;

      const dorsalFactor = 1.0 - smoothstep(0.0, 0.85, hy / size);
      const roll = rng();
      if (roll < 0.34) {
        ctx.strokeStyle = dorsalFactor > 0.4 ? palette.hairDark : palette.hairMid;
      } else if (roll < 0.78) {
        ctx.strokeStyle = palette.hairMid;
      } else {
        ctx.strokeStyle = palette.hairLight;
      }
      ctx.lineWidth = 0.75 + rng() * 1.15;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx + dx, hy + dy);
      ctx.stroke();

      // Matching fine hair ridge in bump map
      const shade = Math.round(95 + rng() * 125);
      bctx.strokeStyle = `rgb(${shade},${shade},${shade})`;
      bctx.lineWidth = 0.9 + rng() * 0.9;
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

  // Headless Node fallback: procedural DataTexture pair
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
      const strand = (rng() - 0.5) * 0.16;
      data[idx] = clamp(Math.round((tmp.r + strand) * 255), 0, 255);
      data[idx + 1] = clamp(Math.round((tmp.g + strand) * 255), 0, 255);
      data[idx + 2] = clamp(Math.round((tmp.b + strand) * 255), 0, 255);
      data[idx + 3] = 255;

      const bv = clamp(Math.round(128 + (rng() - 0.5) * 90), 0, 255);
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
 * Builds procedural annulated (ringed-scale) rosy-brown rat tail textures.
 */
function createTailTexturePair(seed = 808) {
  const rng = createRng(seed);

  if (typeof document !== 'undefined') {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const bumpCanvas = document.createElement('canvas');
    bumpCanvas.width = size;
    bumpCanvas.height = size;
    const bctx = bumpCanvas.getContext('2d');

    ctx.fillStyle = '#a8766e';
    ctx.fillRect(0, 0, size, size);
    bctx.fillStyle = '#808080';
    bctx.fillRect(0, 0, size, size);

    // Fine ringed rodent tail scales
    const rings = 26;
    const ringH = size / rings;
    for (let r = 0; r < rings; r++) {
      const y = r * ringH;
      const shade = 0.88 + rng() * 0.22;
      ctx.fillStyle = `rgb(${Math.round(166 * shade)}, ${Math.round(112 * shade)}, ${Math.round(105 * shade)})`;
      ctx.fillRect(0, y, size, ringH * 0.72);
      ctx.fillStyle = 'rgba(72, 42, 38, 0.36)';
      ctx.fillRect(0, y + ringH * 0.72, size, ringH * 0.28);

      bctx.fillStyle = '#b4b4b4';
      bctx.fillRect(0, y, size, ringH * 0.68);
      bctx.fillStyle = '#484848';
      bctx.fillRect(0, y + ringH * 0.68, size, ringH * 0.32);
    }

    const diffuseTex = new THREE.CanvasTexture(canvas);
    diffuseTex.colorSpace = THREE.SRGBColorSpace;
    diffuseTex.wrapS = THREE.RepeatWrapping;
    diffuseTex.wrapT = THREE.RepeatWrapping;
    diffuseTex.needsUpdate = true;

    const bumpTex = new THREE.CanvasTexture(bumpCanvas);
    bumpTex.wrapS = THREE.RepeatWrapping;
    bumpTex.wrapT = THREE.RepeatWrapping;
    bumpTex.needsUpdate = true;

    return { diffuseTex, bumpTex };
  }

  const size = 32;
  const data = new Uint8Array(size * size * 4);
  const bump = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ring = (y % 4) < 3 ? 1.0 : 0.74;
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      data[idx] = Math.round(168 * ring);
      data[idx + 1] = Math.round(115 * ring);
      data[idx + 2] = Math.round(108 * ring);
      data[idx + 3] = 255;
      const bVal = (y % 4) < 3 ? 175 : 75;
      bump[idx] = bVal;
      bump[idx + 1] = bVal;
      bump[idx + 2] = bVal;
      bump[idx + 3] = 255;
    }
  }

  const diffuseTex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  diffuseTex.colorSpace = THREE.SRGBColorSpace;
  diffuseTex.wrapS = THREE.RepeatWrapping;
  diffuseTex.wrapT = THREE.RepeatWrapping;
  diffuseTex.needsUpdate = true;

  const bumpTex = new THREE.DataTexture(bump, size, size, THREE.RGBAFormat);
  bumpTex.wrapS = THREE.RepeatWrapping;
  bumpTex.wrapT = THREE.RepeatWrapping;
  bumpTex.needsUpdate = true;

  return { diffuseTex, bumpTex };
}

/**
 * Creates a reusable pool of sculpted geometries, procedural fur textures,
 * and PBR materials shared cleanly across all RatActor instances.
 */
export function createRatSharedAssets() {
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

  // 3 organic woodland rat fur palettes
  const furPalettes = [
    {
      dorsal: '#4f3c2e',
      mid: '#6e5744',
      flank: '#856c57',
      belly: '#bca995',
      hairDark: 'rgba(42, 30, 22, 0.58)',
      hairMid: 'rgba(118, 94, 73, 0.52)',
      hairLight: 'rgba(182, 158, 132, 0.45)',
    },
    {
      dorsal: '#3d3027',
      mid: '#5a473a',
      flank: '#735e4e',
      belly: '#a69685',
      hairDark: 'rgba(30, 22, 18, 0.60)',
      hairMid: 'rgba(98, 79, 64, 0.50)',
      hairLight: 'rgba(164, 142, 122, 0.42)',
    },
    {
      dorsal: '#604f3f',
      mid: '#7e6a56',
      flank: '#96816b',
      belly: '#cabaa7',
      hairDark: 'rgba(54, 42, 32, 0.55)',
      hairMid: 'rgba(134, 114, 92, 0.50)',
      hairLight: 'rgba(202, 184, 158, 0.45)',
    },
  ];

  const furMaterials = furPalettes.map((pal, idx) => {
    const pair = createFurTexturePair(pal, 3100 + idx * 173);
    textures.push(pair.diffuseTex, pair.bumpTex);
    return trackMat(
      new THREE.MeshStandardMaterial({
        map: pair.diffuseTex,
        bumpMap: pair.bumpTex,
        bumpScale: 0.012,
        roughness: 0.87,
        metalness: 0.0,
      })
    );
  });

  const tailPair = createTailTexturePair(911);
  textures.push(tailPair.diffuseTex, tailPair.bumpTex);

  const tailMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      map: tailPair.diffuseTex,
      bumpMap: tailPair.bumpTex,
      bumpScale: 0.008,
      roughness: 0.64,
      metalness: 0.02,
    })
  );

  const pinkSkinMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xe89d98,
      roughness: 0.52,
      metalness: 0.02,
    })
  );

  const earInnerMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xeba19b,
      emissive: 0x451210,
      emissiveIntensity: 0.16,
      roughness: 0.55,
      metalness: 0.0,
      side: THREE.DoubleSide,
    })
  );

  const earRimMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x8a695c,
      roughness: 0.84,
      metalness: 0.0,
    })
  );

  const eyeMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x050507,
      roughness: 0.05,
      metalness: 0.08,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
    })
  );

  const eyeGlintMaterial = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
    })
  );

  const whiskerMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x2d2623,
      roughness: 0.42,
      metalness: 0.05,
    })
  );

  // --- Sculpted Anatomical Body Geometries (body length ~0.34-0.35, tail ~0.38) ---

  // 1. Plump pear-shaped pelvis / hindquarters
  const pelvisGeo = trackGeo(
    createSculptedSphere(1.0, 14, 12, (x, y, z) => {
      // Wider lower haunches tapering slightly forward (+Z) and smoothly arched on top
      const backBulge = z < 0 ? 1.0 + (-z) * 0.14 : 1.0 - z * 0.18;
      const sx = x * 0.060 * backBulge;
      const sy = (y < 0 ? y * 0.044 : y * 0.055) * (1.0 - Math.max(0, z) * 0.12);
      const sz = z * 0.076;
      return [sx, sy, sz];
    })
  );

  // 2. Bridging muscular mid-spine torso
  const midSpineGeo = trackGeo(
    createSculptedSphere(1.0, 14, 10, (x, y, z) => {
      const taper = lerp(1.04, 0.86, (z + 1) * 0.5);
      const sx = x * 0.052 * taper;
      const sy = (y < 0 ? y * 0.040 : y * 0.050) * taper;
      const sz = z * 0.062;
      return [sx, sy, sz];
    })
  );

  // 3. Agile chest & shoulders tapering toward neck
  const chestGeo = trackGeo(
    createSculptedSphere(1.0, 14, 10, (x, y, z) => {
      const neckTaper = lerp(1.06, 0.72, (z + 1) * 0.5);
      const sx = x * 0.046 * neckTaper;
      const sy = (y < 0 ? y * 0.036 : y * 0.045) * neckTaper;
      const sz = z * 0.058;
      return [sx, sy, sz];
    })
  );

  // 4. Sculpted rodent cranium + pointed muzzle
  const craniumGeo = trackGeo(
    createSculptedSphere(1.0, 12, 10, (x, y, z) => {
      const frontNarrow = z > 0 ? 1.0 - z * 0.28 : 1.0 + z * 0.06;
      const sx = x * 0.034 * frontNarrow;
      const sy = (y < 0 ? y * 0.025 : y * 0.030) * (1.0 - Math.max(0, z) * 0.2);
      const sz = z * 0.040;
      return [sx, sy, sz];
    })
  );

  // Pointed rodent snout extending forward along +Z
  const snoutGeo = trackGeo(
    createSculptedSphere(1.0, 12, 10, (x, y, z) => {
      const t = clamp((z + 1) * 0.5, 0, 1); // 0=base, 1=tip
      const rad = lerp(1.0, 0.24, Math.pow(t, 0.82));
      const sx = x * 0.025 * rad;
      const sy = y * 0.020 * rad - t * 0.007; // slight downward slope toward nose tip
      const sz = (z + 0.65) * 0.036;
      return [sx, sy, sz];
    })
  );

  // Soft glossy pink nose tip
  const noseGeo = trackGeo(
    createSculptedSphere(1.0, 8, 6, (x, y, z) => [x * 0.0095, y * 0.0080, z * 0.0078])
  );

  // Glossy jet-black eye + crisp specular highlight speck
  const eyeGeo = trackGeo(new THREE.SphereGeometry(0.0092, 10, 8));
  const eyeGlintGeo = trackGeo(new THREE.SphereGeometry(0.0028, 6, 5));

  // Rounded translucent-pink cupped rodent ear (concavity facing +Z/+X)
  const earDishGeo = trackGeo(
    createSculptedSphere(1.0, 10, 8, (x, y, z) => {
      // Flatten along Z into an oval cupped shell
      const dish = (x * x + y * y) * 0.0055;
      return [x * 0.020, (y + 0.72) * 0.024, z * 0.0042 + dish];
    })
  );
  const earBackGeo = trackGeo(
    createSculptedSphere(1.0, 8, 6, (x, y, z) => [x * 0.017, (y + 0.68) * 0.020, z * 0.0040 - 0.0022])
  );

  // Fine tapering whisker filament extending along +X (scaled/mirrored per side)
  const whiskerGeo = trackGeo(new THREE.CylinderGeometry(0.00045, 0.00125, 0.062, 4, 1));
  whiskerGeo.rotateZ(-Math.PI * 0.5);
  whiskerGeo.translate(0.031, 0, 0);

  // Articulated limb geometries
  const hindThighGeo = trackGeo(
    createSculptedSphere(1.0, 8, 7, (x, y, z) => [x * 0.021, (y - 0.35) * 0.036, z * 0.028])
  );
  const hindShinGeo = trackGeo(new THREE.CylinderGeometry(0.0075, 0.0105, 0.036, 6, 1));
  hindShinGeo.translate(0, -0.018, 0);

  const frontArmGeo = trackGeo(
    createSculptedSphere(1.0, 8, 6, (x, y, z) => [x * 0.014, (y - 0.45) * 0.026, z * 0.015])
  );
  const frontForearmGeo = trackGeo(new THREE.CylinderGeometry(0.0058, 0.0078, 0.028, 6, 1));
  frontForearmGeo.translate(0, -0.014, 0);

  // Tiny pink splayed rodent paws (hind foot slightly longer than agile front paw)
  const hindPawGeo = trackGeo(
    createSculptedSphere(1.0, 8, 6, (x, y, z) => [x * 0.013, y * 0.0055, (z + 0.55) * 0.022])
  );
  const frontPawGeo = trackGeo(
    createSculptedSphere(1.0, 8, 6, (x, y, z) => [x * 0.011, y * 0.0050, (z + 0.45) * 0.014])
  );
  const toeGeo = trackGeo(
    createSculptedSphere(1.0, 5, 4, (x, y, z) => [x * 0.0032, y * 0.0028, (z + 0.5) * 0.0085])
  );

  // 6 tapering scaly tail segments pointing along -Z (with slight overlap for seamless bends)
  const tailSegGeos = [];
  for (let i = 0; i < 6; i++) {
    const len = TAIL_SEG_LENGTHS[i];
    const r0 = TAIL_SEG_RADII[i];
    const r1 = TAIL_SEG_RADII[i + 1];
    // Cylinder extends along Y from -len/2 to +len/2; rotateX(-PI/2) puts +Y onto -Z
    const seg = new THREE.CylinderGeometry(r1, r0, len * 1.15, 7, 1);
    seg.rotateX(-Math.PI * 0.5);
    seg.translate(0, 0, -len * 0.48);
    tailSegGeos.push(trackGeo(seg));
  }

  return {
    geometries,
    materials,
    textures,
    furMaterials,
    tailMaterial,
    pinkSkinMaterial,
    earInnerMaterial,
    earRimMaterial,
    eyeMaterial,
    eyeGlintMaterial,
    whiskerMaterial,
    geo: {
      pelvisGeo,
      midSpineGeo,
      chestGeo,
      craniumGeo,
      snoutGeo,
      noseGeo,
      eyeGeo,
      eyeGlintGeo,
      earDishGeo,
      earBackGeo,
      whiskerGeo,
      hindThighGeo,
      hindShinGeo,
      frontArmGeo,
      frontForearmGeo,
      hindPawGeo,
      frontPawGeo,
      toeGeo,
      tailSegGeos,
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

/**
 * Detailed, articulated procedural forest rat with:
 * - Sculpted multi-bone spine (`pelvis` -> `midSpine` -> `chest` -> `head`)
 * - 6 twitching whiskers, 2 translucent-pink twitching ears, glossy jet-black eyes w/ glint
 * - 4 articulated scampering legs with pink paws
 * - 6-bone dynamic spring/whip tail (`tail0` .. `tail5`)
 * - Full 6-state AI ('forage', 'scurry', 'chaseHuman', 'climbLeg', 'leapOff', 'flee')
 *   including direct `shinBone.matrixWorld` clinging during a 14 Hz panicked leg shake!
 */
export class RatActor {
  constructor(terrain, options = {}) {
    this.terrain = terrain;
    this.seed = options.seed ?? 1001;
    this._rng = createRng(this.seed);

    this.boldness = clamp(options.boldness ?? (0.52 + this._rng() * 0.46), 0.1, 1.0);
    this.baseScale = options.scale ?? (0.95 + this._rng() * 0.14);
    this.territoryRadius = options.territoryRadius ?? (5.5 + this._rng() * 4.5);
    this.furVariant = options.furVariant ?? Math.floor(this._rng() * 3);

    this._ownsSharedAssets = !options.sharedAssets;
    this._assets = options.sharedAssets || createRatSharedAssets();

    // Scene graph root
    this.root = new THREE.Group();
    this.root.name = options.name || `ForestRat_${this.seed}`;
    this.root.scale.setScalar(this.baseScale);

    // Build full articulated skeleton & meshes
    this._buildRig();

    // Territory & spatial state
    const clearing = terrain?.clearingCenter ?? { x: 10.5, y: 6.0 };
    const defaultAng = this._rng() * Math.PI * 2;
    const defaultDist = 9.5 + this._rng() * 4.0;
    const hx = options.homePos?.x ?? (clearing.x + Math.cos(defaultAng) * defaultDist);
    const hz = options.homePos?.z ?? (clearing.y + Math.sin(defaultAng) * defaultDist);
    const hy = this._sampleHeight(hx, hz);

    this.homePos = new THREE.Vector3(hx, hy, hz);
    this.position = this.root.position;
    this.position.set(hx, Math.max(hy, WATER_SAFE_Y), hz);

    this._yaw = this._rng() * Math.PI * 2;
    this._prevYaw = this._yaw;
    this._yawRate = 0;
    this._speed = 0;
    this._vel = new THREE.Vector3();
    this._prevRootPos = this.position.clone();
    this._prevRootVel = new THREE.Vector3();
    this._hasPrevPos = false;

    // AI state machine
    this.state = 'forage';
    this.active = true;
    this.targetSide = this._rng() > 0.5 ? 'right' : 'left';
    this._explicitTargetBone = null;

    this._waypoint = this.homePos.clone();
    this._stateTimer = 0.8 + this._rng() * 2.4;
    this._scareCooldown = 0;
    this._squeakTimer = 0.4 + this._rng() * 0.6;

    // Climb & leap state
    this._climbDuration = 1.55;
    this._climbStartPos = new THREE.Vector3();
    this._climbStartQuat = new THREE.Quaternion();
    this._leapSpin = new THREE.Vector3();
    this._leapEuler = new THREE.Euler(0, 0, 0, 'YXZ');

    // Animation phase accumulators
    this._gaitPhase = this._rng() * Math.PI * 2;
    this._earPhaseL = this._rng() * 10;
    this._earPhaseR = this._rng() * 10;
    this._whiskerPhase = this._rng() * 10;
    this._sniffOffset = this._rng() * 6.28;

    // 6-bone dynamic spring/lag tail state
    this._tailYaw = new Float32Array(6);
    this._tailYawVel = new Float32Array(6);
    this._tailPitch = new Float32Array(6);
    this._tailPitchVel = new Float32Array(6);

    // Align cleanly onto starting terrain slope
    this._alignToTerrain(1.0);
  }

  _sampleHeight(x, z) {
    if (!this.terrain || typeof this.terrain.getHeightAt !== 'function') return 0;
    const h = this.terrain.getHeightAt(x, z);
    return Number.isFinite(h) ? h : 0;
  }

  _sampleNormal(x, z, target) {
    if (!this.terrain || typeof this.terrain.getNormalAt !== 'function') {
      return target.set(0, 1, 0);
    }
    const n = this.terrain.getNormalAt(x, z, target);
    if (!n || !Number.isFinite(n.y) || n.lengthSq() < 1e-6) {
      return target.set(0, 1, 0);
    }
    return n;
  }

  _buildRig() {
    const a = this._assets;
    const furMat = a.furMaterials[this.furVariant % a.furMaterials.length];
    const g = a.geo;

    const makeMesh = (geo, mat, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = cast;
      m.receiveShadow = true;
      return m;
    };

    // Body pivot handles gallop bobbing and climb body crouch
    this.bodyPivot = new THREE.Group();
    this.root.add(this.bodyPivot);

    // 1. Pelvis / hindquarters
    this.pelvis = new THREE.Group();
    this.pelvis.position.set(0, 0.088, -0.065);
    this.bodyPivot.add(this.pelvis);

    const pelvisMesh = makeMesh(g.pelvisGeo, furMat);
    this.pelvis.add(pelvisMesh);

    // 2. Articulated Hind Legs (legBL, legBR)
    const buildHindLeg = (sideSign) => {
      const hip = new THREE.Group();
      hip.position.set(sideSign * 0.044, -0.015, -0.008);

      const thigh = makeMesh(g.hindThighGeo, furMat);
      thigh.rotation.x = 0.24;
      hip.add(thigh);

      const footJoint = new THREE.Group();
      footJoint.position.set(sideSign * 0.002, -0.036, -0.010);
      hip.add(footJoint);

      const shin = makeMesh(g.hindShinGeo, furMat, false);
      shin.rotation.x = -0.25;
      footJoint.add(shin);

      const paw = makeMesh(g.hindPawGeo, a.pinkSkinMaterial, false);
      paw.position.set(0, -0.034, 0.006);
      footJoint.add(paw);

      // 3 tiny pink splayed toes
      for (let t = -1; t <= 1; t++) {
        const toe = makeMesh(g.toeGeo, a.pinkSkinMaterial, false);
        toe.position.set(t * 0.0055, -0.035, 0.026);
        toe.rotation.y = t * 0.24;
        footJoint.add(toe);
      }

      this.pelvis.add(hip);
      return { hip, footJoint };
    };

    const bl = buildHindLeg(1);
    const br = buildHindLeg(-1);
    this.legBL = bl.hip;
    this.footBL = bl.footJoint;
    this.legBR = br.hip;
    this.footBR = br.footJoint;

    // 3. 6-Bone Dynamic Articulated Tail (tail0 .. tail5)
    this.tailBones = [];
    let tailParent = this.pelvis;
    for (let i = 0; i < 6; i++) {
      const bone = new THREE.Group();
      bone.name = `tail${i}`;
      if (i === 0) {
        bone.position.set(0, -0.008, -0.072);
      } else {
        bone.position.set(0, 0, -TAIL_SEG_LENGTHS[i - 1]);
      }
      const segMesh = makeMesh(g.tailSegGeos[i], a.tailMaterial, i < 3);
      bone.add(segMesh);
      tailParent.add(bone);
      tailParent = bone;

      this[`tail${i}`] = bone;
      this.tailBones.push(bone);
    }

    // 4. Mid-Spine (flexes left/right during turns & arches/extends during gallop/climb)
    this.midSpine = new THREE.Group();
    this.midSpine.position.set(0, 0.008, 0.068);
    this.pelvis.add(this.midSpine);

    const midMesh = makeMesh(g.midSpineGeo, furMat);
    this.midSpine.add(midMesh);

    // 5. Chest / Shoulders
    this.chest = new THREE.Group();
    this.chest.position.set(0, -0.006, 0.074);
    this.midSpine.add(this.chest);

    const chestMesh = makeMesh(g.chestGeo, furMat);
    this.chest.add(chestMesh);

    // 6. Articulated Forelegs (legFL, legFR)
    const buildFrontLeg = (sideSign) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(sideSign * 0.036, -0.020, 0.012);

      const arm = makeMesh(g.frontArmGeo, furMat);
      arm.rotation.x = -0.18;
      shoulder.add(arm);

      const pawJoint = new THREE.Group();
      pawJoint.position.set(0, -0.032, 0.005);
      shoulder.add(pawJoint);

      const forearm = makeMesh(g.frontForearmGeo, furMat, false);
      forearm.rotation.x = 0.16;
      pawJoint.add(forearm);

      const paw = makeMesh(g.frontPawGeo, a.pinkSkinMaterial, false);
      paw.position.set(0, -0.026, 0.003);
      pawJoint.add(paw);

      for (let t = -1; t <= 1; t++) {
        const toe = makeMesh(g.toeGeo, a.pinkSkinMaterial, false);
        toe.position.set(t * 0.0044, -0.027, 0.015);
        toe.rotation.y = t * 0.28;
        toe.scale.setScalar(0.82);
        pawJoint.add(toe);
      }

      this.chest.add(shoulder);
      return { shoulder, pawJoint };
    };

    const fl = buildFrontLeg(1);
    const fr = buildFrontLeg(-1);
    this.legFL = fl.shoulder;
    this.footFL = fl.pawJoint;
    this.legFR = fr.shoulder;
    this.footFR = fr.pawJoint;

    // 7. Articulated Head (snout, pink nose, 6 whiskers, 2 pink ears, 2 glossy eyes w/ glint)
    this.head = new THREE.Group();
    this.head.position.set(0, 0.012, 0.056);
    this.chest.add(this.head);

    const cranium = makeMesh(g.craniumGeo, furMat);
    this.head.add(cranium);

    const snout = makeMesh(g.snoutGeo, furMat);
    snout.position.set(0, -0.004, 0.024);
    this.head.add(snout);

    // Soft pink nose tip
    this.noseTip = makeMesh(g.noseGeo, a.pinkSkinMaterial, false);
    this.noseTip.position.set(0, -0.011, 0.080);
    this.head.add(this.noseTip);

    // 2 Glossy Jet-Black Eyes with tiny specular glint
    const buildEye = (sideSign) => {
      const eyeGroup = new THREE.Group();
      eyeGroup.position.set(sideSign * 0.021, 0.009, 0.022);
      const ball = makeMesh(g.eyeGeo, a.eyeMaterial, false);
      eyeGroup.add(ball);
      const glint = makeMesh(g.eyeGlintGeo, a.eyeGlintMaterial, false);
      glint.position.set(sideSign * 0.0045, 0.0042, 0.0062);
      eyeGroup.add(glint);
      this.head.add(eyeGroup);
      return eyeGroup;
    };
    this.eyeL = buildEye(1);
    this.eyeR = buildEye(-1);

    // 2 Rounded Translucent-Pink Ears that twitch independently
    const buildEar = (sideSign) => {
      const ear = new THREE.Group();
      ear.position.set(sideSign * 0.023, 0.020, -0.012);
      ear.rotation.set(-0.18, sideSign * 0.42, -sideSign * 0.36);

      const inner = makeMesh(g.earDishGeo, a.earInnerMaterial, false);
      ear.add(inner);
      const back = makeMesh(g.earBackGeo, a.earRimMaterial, false);
      ear.add(back);

      this.head.add(ear);
      return ear;
    };
    this.earL = buildEar(1);
    this.earR = buildEar(-1);

    // 6 Fine Twitching Whiskers (3 per side)
    this.whiskersL = [];
    this.whiskersR = [];
    const whiskerAngles = [
      { yaw: 0.24, pitch: 0.16, yOff: 0.003, zOff: 0.062, scale: 1.05 },
      { yaw: 0.12, pitch: -0.02, yOff: -0.001, zOff: 0.066, scale: 1.15 },
      { yaw: -0.04, pitch: -0.18, yOff: -0.005, zOff: 0.063, scale: 0.92 },
    ];
    for (const sideSign of [1, -1]) {
      const list = sideSign > 0 ? this.whiskersL : this.whiskersR;
      for (let w = 0; w < 3; w++) {
        const cfg = whiskerAngles[w];
        const wg = new THREE.Group();
        wg.position.set(sideSign * 0.012, -0.008 + cfg.yOff, cfg.zOff);
        wg.rotation.set(0, sideSign > 0 ? -cfg.yaw : Math.PI + cfg.yaw, cfg.pitch);
        const wm = makeMesh(g.whiskerGeo, a.whiskerMaterial, false);
        wm.scale.setScalar(cfg.scale);
        wg.add(wm);
        this.head.add(wg);
        list.push({
          group: wg,
          baseRotY: wg.rotation.y,
          baseRotZ: wg.rotation.z,
          phase: w * 2.1 + (sideSign > 0 ? 0 : 1.3),
        });
      }
    }
  }

  /**
   * Explicitly starts a dramatic scare chase targeting a human boot/shin.
   * Supports both `startScareChase(side, teleportNearPos)` and `startScareChase(side, targetBone)`.
   */
  startScareChase(side = 'right', teleportNearPos = null, targetBone = null) {
    this.targetSide = side === 'left' ? 'left' : 'right';
    this._explicitTargetBone = null;

    if (teleportNearPos && (teleportNearPos.isObject3D || teleportNearPos.matrixWorld)) {
      this._explicitTargetBone = teleportNearPos;
    } else if (
      teleportNearPos &&
      Number.isFinite(teleportNearPos.x) &&
      Number.isFinite(teleportNearPos.z)
    ) {
      const ty = Number.isFinite(teleportNearPos.y)
        ? teleportNearPos.y
        : this._sampleHeight(teleportNearPos.x, teleportNearPos.z);
      this.position.set(teleportNearPos.x, Math.max(ty, WATER_SAFE_Y), teleportNearPos.z);
      this._prevRootPos.copy(this.position);
      this._prevRootVel.set(0, 0, 0);
      this._tailYaw.fill(0);
      this._tailYawVel.fill(0);
      this._tailPitch.fill(0);
      this._tailPitchVel.fill(0);
      this._alignToTerrain(1.0);
    }

    if (targetBone && (targetBone.isObject3D || targetBone.matrixWorld)) {
      this._explicitTargetBone = targetBone;
    }

    this.state = 'chaseHuman';
    this._stateTimer = 0;
    this._scareCooldown = 0;
    this._squeakTimer = 0.12;
    this.active = true;
    this.root.visible = true;
  }

  isClimbing() {
    return this.state === 'climbLeg';
  }

  isScaring() {
    return this.state === 'chaseHuman' || this.state === 'climbLeg' || this.state === 'leapOff';
  }

  setActive(active) {
    const next = Boolean(active);
    if (!next && this.active && this.isScaring()) {
      this.resetToForage();
    }
    this.active = next;
    this.root.visible = next;
  }

  resetToForage() {
    this.state = 'forage';
    this._explicitTargetBone = null;
    this._stateTimer = 1.2 + this._rng() * 1.8;
    this._speed = 0;
    this._vel.set(0, 0, 0);
    const y = this._sampleHeight(this.position.x, this.position.z);
    this.position.y = Math.max(y, WATER_SAFE_Y);
    this._alignToTerrain(1.0);
  }

  _pickDryWaypoint(originX, originZ, minR, maxR) {
    const clearing = this.terrain?.clearingCenter ?? { x: 10.5, y: 6.0 };
    for (let attempt = 0; attempt < 14; attempt++) {
      const ang = this._rng() * Math.PI * 2;
      const dist = minR + this._rng() * (maxR - minR);
      const wx = clamp(originX + Math.cos(ang) * dist, -MAP_BOUND, MAP_BOUND);
      const wz = clamp(originZ + Math.sin(ang) * dist, -MAP_BOUND, MAP_BOUND);
      const wy = this._sampleHeight(wx, wz);
      if (wy <= WATER_SAFE_Y + 0.08) continue;

      // Avoid campfire center
      const dFire = Math.hypot(wx - clearing.x, wz - clearing.y);
      if (dFire < 2.2) continue;

      const slope =
        this.terrain && typeof this.terrain.getSlopeAt === 'function'
          ? this.terrain.getSlopeAt(wx, wz)
          : 0;
      if (slope > 0.56) continue;

      this._waypoint.set(wx, wy, wz);
      return true;
    }

    const hy = Math.max(this._sampleHeight(this.homePos.x, this.homePos.z), WATER_SAFE_Y + 0.1);
    this._waypoint.set(this.homePos.x, hy, this.homePos.z);
    return false;
  }

  _extractHumanData(humanInfo) {
    if (!humanInfo) return null;

    let pos = null;
    if (typeof humanInfo.getPosition === 'function') {
      const r = humanInfo.getPosition(_humanPos);
      pos = r && Number.isFinite(r.x) ? r : _humanPos;
    } else if (humanInfo.position && Number.isFinite(humanInfo.position.x)) {
      pos = _humanPos.copy(humanInfo.position);
    }
    if (!pos) return null;

    const getFootWorldPos = (side, out) => {
      if (typeof humanInfo.getFootWorldPos === 'function') {
        const res = humanInfo.getFootWorldPos(side, out);
        if (res && Number.isFinite(res.x)) {
          out.copy(res);
          return out;
        }
        if (Number.isFinite(out.x)) return out;
      }
      if (humanInfo.footPos && Number.isFinite(humanInfo.footPos.x)) {
        return out.copy(humanInfo.footPos);
      }
      const bone = getShinBone(side);
      if (bone) {
        bone.updateWorldMatrix(true, false);
        return out.set(0, -0.36, 0.08).applyMatrix4(bone.matrixWorld);
      }
      return out.copy(pos);
    };

    const getShinBone = (side) => {
      if (this._explicitTargetBone) return this._explicitTargetBone;
      if (typeof humanInfo.getShinBone === 'function') {
        return humanInfo.getShinBone(side) || null;
      }
      if (humanInfo.shinBone) return humanInfo.shinBone;
      return null;
    };

    const triggerRatPanic = (side) => {
      if (typeof humanInfo.triggerRatPanic === 'function') {
        humanInfo.triggerRatPanic(side);
      }
    };

    const canProximityTrigger =
      humanInfo.canProximityTrigger !== undefined ? Boolean(humanInfo.canProximityTrigger) : true;

    return {
      pos,
      canProximityTrigger,
      getFootWorldPos,
      getShinBone,
      triggerRatPanic,
      onScareTriggered: humanInfo.onScareTriggered,
    };
  }

  _alignToTerrain(blend) {
    const n = this._sampleNormal(this.position.x, this.position.z, _normal);
    _fwd.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
    _fwd.addScaledVector(n, -_fwd.dot(n));
    if (_fwd.lengthSq() < 1e-6) {
      _fwd.set(0, 0, 1);
    } else {
      _fwd.normalize();
    }
    _right.crossVectors(n, _fwd);
    if (_right.lengthSq() < 1e-6) {
      _right.set(1, 0, 0);
    } else {
      _right.normalize();
    }
    _fwd.crossVectors(_right, n).normalize();

    _rotMat.makeBasis(_right, n, _fwd);
    _targetQuat.setFromRotationMatrix(_rotMat);

    if (blend >= 0.999) {
      this.root.quaternion.copy(_targetQuat);
    } else {
      this.root.quaternion.slerp(_targetQuat, clamp(blend, 0, 1));
    }
  }

  _stepGroundMove(dt, targetX, targetZ, moveSpeed, turnSpeed, allowWater = false) {
    const dx = targetX - this.position.x;
    const dz = targetZ - this.position.z;
    const dist = Math.hypot(dx, dz);

    if (dist > 0.001) {
      const desiredYaw = Math.atan2(dx, dz);
      const diff = wrapAngle(desiredYaw - this._yaw);
      const maxTurn = turnSpeed * dt;
      this._yaw = wrapAngle(this._yaw + clamp(diff, -maxTurn, maxTurn));
    }

    const stepDist = Math.min(moveSpeed * dt, dist > 0.02 ? dist + 0.05 : moveSpeed * dt);
    const fx = Math.sin(this._yaw);
    const fz = Math.cos(this._yaw);
    let nx = clamp(this.position.x + fx * stepDist, -MAP_BOUND, MAP_BOUND);
    let nz = clamp(this.position.z + fz * stepDist, -MAP_BOUND, MAP_BOUND);
    let ny = this._sampleHeight(nx, nz);

    if (!allowWater && ny <= WATER_SAFE_Y) {
      // Steer gently along dry bank instead of plunging into stream
      const tryLeftYaw = this._yaw + 1.1;
      const tryRightYaw = this._yaw - 1.1;
      const lx = clamp(this.position.x + Math.sin(tryLeftYaw) * stepDist, -MAP_BOUND, MAP_BOUND);
      const lz = clamp(this.position.z + Math.cos(tryLeftYaw) * stepDist, -MAP_BOUND, MAP_BOUND);
      const ly = this._sampleHeight(lx, lz);
      const rx = clamp(this.position.x + Math.sin(tryRightYaw) * stepDist, -MAP_BOUND, MAP_BOUND);
      const rz = clamp(this.position.z + Math.cos(tryRightYaw) * stepDist, -MAP_BOUND, MAP_BOUND);
      const ry = this._sampleHeight(rx, rz);

      if (ly > ry && ly > WATER_SAFE_Y) {
        this._yaw = wrapAngle(tryLeftYaw);
        nx = lx;
        nz = lz;
        ny = ly;
      } else if (ry > WATER_SAFE_Y) {
        this._yaw = wrapAngle(tryRightYaw);
        nx = rx;
        nz = rz;
        ny = ry;
      } else {
        // Turn back toward homePos dry ground
        this._yaw = Math.atan2(this.homePos.x - this.position.x, this.homePos.z - this.position.z);
        return { dist, blockedByWater: true };
      }
    }

    this.position.set(nx, Math.max(ny, allowWater ? ny : WATER_SAFE_Y), nz);
    this._speed = moveSpeed;
    this._alignToTerrain(1.0 - Math.exp(-15.0 * dt));
    return { dist: Math.hypot(targetX - nx, targetZ - nz), blockedByWater: false };
  }

  _tryProximityTrigger(human, audio) {
    if (!human || !human.canProximityTrigger || this._scareCooldown > 0) return false;
    if (this.boldness < 0.42) return false;

    const dx = human.pos.x - this.position.x;
    const dz = human.pos.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 4.2) return false;

    // Pick closest boot side for natural sprint angle
    const leftFoot = human.getFootWorldPos('left', _footPos);
    const rightFoot = human.getFootWorldPos('right', _footAlt);
    const dL = this.position.distanceToSquared(leftFoot);
    const dR = this.position.distanceToSquared(rightFoot);
    this.targetSide = dL < dR ? 'left' : 'right';

    this.state = 'chaseHuman';
    this._stateTimer = 0;
    this._squeakTimer = 0.08;
    human.onScareTriggered?.(this);
    playRatSqueak(audio, 0.78);
    return true;
  }

  update(dt, elapsed, humanInfo = null, audio = null) {
    if (!this.active) return;

    const safeDt = clamp(Number.isFinite(dt) ? dt : 0.016, 0.0001, 0.05);
    const safeElapsed = Number.isFinite(elapsed) ? elapsed : 0;

    if (this._scareCooldown > 0) {
      this._scareCooldown = Math.max(0, this._scareCooldown - safeDt);
    }

    const human = this._extractHumanData(humanInfo);
    this._prevYaw = this._yaw;

    // --- AI STATE MACHINE ---
    if (this.state === 'forage') {
      this._speed = lerp(this._speed, 0, clamp(safeDt * 12, 0, 1));
      this._stateTimer -= safeDt;

      // Ground stay & gentle alignment
      const gy = this._sampleHeight(this.position.x, this.position.z);
      this.position.y = Math.max(gy, WATER_SAFE_Y);
      this._alignToTerrain(1.0 - Math.exp(-8 * safeDt));

      if (!this._tryProximityTrigger(human, audio) && this._stateTimer <= 0) {
        this._pickDryWaypoint(this.homePos.x, this.homePos.z, 1.4, this.territoryRadius);
        this.state = 'scurry';
        this._stateTimer = 4.5;
      }
    } else if (this.state === 'scurry') {
      this._stateTimer -= safeDt;
      const scurrySpeed = 2.5 + this.boldness * 1.1;
      const { dist, blockedByWater } = this._stepGroundMove(
        safeDt,
        this._waypoint.x,
        this._waypoint.z,
        scurrySpeed,
        8.5,
        false
      );

      if (!this._tryProximityTrigger(human, audio)) {
        if (dist < 0.36 || blockedByWater || this._stateTimer <= 0) {
          this.state = 'forage';
          this._stateTimer = 1.2 + this._rng() * 2.6;
          this._speed = 0;
        }
      }
    } else if (this.state === 'chaseHuman') {
      this._stateTimer += safeDt;
      this._squeakTimer -= safeDt;

      if (!human) {
        this.state = 'forage';
        this._stateTimer = 1.5;
      } else {
        const footTarget = human.getFootWorldPos(this.targetSide, _footPos);
        const horizDist = Math.hypot(
          footTarget.x - this.position.x,
          footTarget.z - this.position.z
        );

        // Sprint eagerly at 5.8 - 7.6 u/s (always fast enough to overtake walking/jogging human!)
        const urgencyBoost = clamp((horizDist - 1.5) * 0.28, 0, 1.1);
        const chaseSpeed = clamp(5.85 + this.boldness * 0.85 + urgencyBoost, 5.8, 7.6);

        this._stepGroundMove(safeDt, footTarget.x, footTarget.z, chaseSpeed, 14.5, true);

        if (this._squeakTimer <= 0) {
          playRatSqueak(audio, 0.85);
          this._squeakTimer = 0.48 + this._rng() * 0.36;
        }

        const postDist = Math.hypot(
          footTarget.x - this.position.x,
          footTarget.z - this.position.z
        );
        const vertDelta = Math.abs(footTarget.y - this.position.y);

        if (postDist < 0.45 && vertDelta < 1.35) {
          // Latch onto the human's boot/shin and trigger rat panic!
          human.triggerRatPanic(this.targetSide);
          playRatSqueak(audio, 1.0);

          this._climbStartPos.copy(this.position);
          this._climbStartQuat.copy(this.root.quaternion);
          this._climbDuration = 1.50 + this._rng() * 0.12; // ~1.55s
          this._stateTimer = 0;
          this._squeakTimer = 0.55;
          this.state = 'climbLeg';
        } else if (this._stateTimer > 6.5 || postDist > 26.0) {
          // Safety abort if human somehow teleported far away
          this.state = 'flee';
          this._stateTimer = 3.5;
          this._scareCooldown = 14.0;
        }
      }
    } else if (this.state === 'climbLeg') {
      this._stateTimer += safeDt;
      this._squeakTimer -= safeDt;

      if (this._squeakTimer <= 0) {
        playRatSqueak(audio, 0.95);
        this._squeakTimer = 0.52 + this._rng() * 0.30;
      }

      const progress = clamp(this._stateTimer / this._climbDuration, 0, 1);
      const shinBone = human ? human.getShinBone(this.targetSide) : this._explicitTargetBone;

      // Scramble smoothly from top of boot (localY = -0.36, localZ = +0.08) up to below knee (localY = -0.08)
      const sideSign = this.targetSide === 'left' ? 1 : -1;
      const climbFrac = clamp(
        smoothstep(0.0, 0.82, progress) * 0.96 + Math.sin(this._stateTimer * 18.0) * 0.03,
        0,
        1
      );
      const localY = lerp(-0.36, -0.08, climbFrac);

      // Wrap slightly around the calf while frantically scrambling
      const wrapTheta =
        sideSign * (0.08 + smoothstep(0.0, 0.95, progress) * 0.72) +
        Math.sin(this._stateTimer * 21.0) * 0.11;
      const shinRadius = lerp(0.078, 0.086, climbFrac);

      const lx = Math.sin(wrapTheta) * shinRadius;
      const lz = Math.cos(wrapTheta) * shinRadius;

      // Construct exact local clinging basis:
      // +Y_rat (dorsal back) = radial outward normal away from shin
      // +Z_rat (head/snout)  = upward along shin (+Y) tilted slightly along calf wrap spiral
      // +X_rat (left)        = cross(Y_rat, Z_rat)
      const cosT = Math.cos(wrapTheta);
      const sinT = Math.sin(wrapTheta);
      _climbN.set(sinT, 0, cosT).normalize();
      const spiralSlope = sideSign * 0.24 + Math.cos(this._stateTimer * 21.0) * 0.12;
      _climbZ.set(cosT * spiralSlope, 1.0, -sinT * spiralSlope).normalize();
      _climbX.crossVectors(_climbN, _climbZ).normalize();
      _climbZ.crossVectors(_climbX, _climbN).normalize();

      _rotMat.makeBasis(_climbX, _climbN, _climbZ);
      _localQuat.setFromRotationMatrix(_rotMat);

      if (shinBone && shinBone.matrixWorld) {
        if (typeof shinBone.updateWorldMatrix === 'function') {
          shinBone.updateWorldMatrix(true, false);
        }
        _worldPos.set(lx, localY, lz).applyMatrix4(shinBone.matrixWorld);
        if (typeof shinBone.getWorldQuaternion === 'function') {
          shinBone.getWorldQuaternion(_shinQuat);
        } else {
          _shinQuat.setFromRotationMatrix(shinBone.matrixWorld);
        }
        _targetQuat.copy(_shinQuat).multiply(_localQuat);
      } else if (human) {
        const foot = human.getFootWorldPos(this.targetSide, _footPos);
        _worldPos.set(foot.x + lx, foot.y + (localY + 0.40), foot.z + lz);
        _targetQuat.copy(_localQuat);
      } else {
        _worldPos.copy(this.position);
        _targetQuat.copy(this.root.quaternion);
      }

      // Ultra-snappy 0.08s latch blend, then 100% locked rigidly to shinBone.matrixWorld!
      const latchBlend = smoothstep(0.0, 0.08, this._stateTimer);
      if (latchBlend < 0.999) {
        this.position.lerpVectors(this._climbStartPos, _worldPos, latchBlend);
        this.root.quaternion.slerpQuaternions(this._climbStartQuat, _targetQuat, latchBlend);
      } else {
        this.position.copy(_worldPos);
        this.root.quaternion.copy(_targetQuat);
      }
      this.root.scale.setScalar(this.baseScale);
      this._speed = 5.5;

      // After ~1.55s (mid-Stage 2 violent 14 Hz leg shake), launch outward in a parabolic arc!
      if (this._stateTimer >= this._climbDuration) {
        // Outward vector away from the shin (+Y_rat in world space)
        _v1.set(0, 1, 0).applyQuaternion(this.root.quaternion);
        _v1.y = 0;
        if (_v1.lengthSq() < 0.001) {
          _v1.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
        }
        _v1.normalize();

        const velOut = 3.1 + this._rng() * 0.7;
        const upVel = 3.35 + this._rng() * 0.35; // ~3.4 u/s upward arc
        this._vel.set(_v1.x * velOut, upVel, _v1.z * velOut);

        this._yaw = Math.atan2(_v1.x, _v1.z);
        this._leapEuler.set(-0.55, this._yaw, 0, 'YXZ');
        this._leapSpin.set(
          4.2 + this._rng() * 2.2,
          (this._rng() - 0.5) * 6.5,
          (this._rng() > 0.5 ? 1 : -1) * (5.0 + this._rng() * 3.0)
        );

        this._explicitTargetBone = null;
        this._stateTimer = 0;
        this.state = 'leapOff';
        playRatSqueak(audio, 1.0);
      }
    } else if (this.state === 'leapOff') {
      this._stateTimer += safeDt;

      // Parabolic gravity arc
      this._vel.y -= 14.5 * safeDt;
      this.position.x = clamp(this.position.x + this._vel.x * safeDt, -MAP_BOUND, MAP_BOUND);
      this.position.y += this._vel.y * safeDt;
      this.position.z = clamp(this.position.z + this._vel.z * safeDt, -MAP_BOUND, MAP_BOUND);

      // Dramatic airborne pitch/spin tumble following trajectory
      const horizSpeed = Math.hypot(this._vel.x, this._vel.z);
      const arcPitch = clamp(-Math.atan2(this._vel.y, Math.max(horizSpeed, 0.5)), -1.1, 1.1);
      this._leapEuler.x = lerp(this._leapEuler.x, arcPitch, clamp(safeDt * 5.0, 0, 1));
      this._leapEuler.y = wrapAngle(this._leapEuler.y + this._leapSpin.y * safeDt * 0.45);
      this._leapEuler.z += this._leapSpin.z * safeDt;
      this._leapSpin.multiplyScalar(Math.exp(-1.8 * safeDt));
      this.root.quaternion.setFromEuler(this._leapEuler);
      this._speed = this._vel.length();

      const groundY = this._sampleHeight(this.position.x, this.position.z);
      if ((this._stateTimer > 0.08 && this.position.y <= groundY + 0.01) || this._stateTimer > 2.4) {
        this.position.y = Math.max(groundY, WATER_SAFE_Y);

        // Pick a frantic flee escape point away from the human into cover/ferns
        let awayX = this._vel.x;
        let awayZ = this._vel.z;
        if (human) {
          awayX = this.position.x - human.pos.x;
          awayZ = this.position.z - human.pos.z;
        }
        const len = Math.hypot(awayX, awayZ) || 1;
        const baseAng = Math.atan2(awayX / len, awayZ / len);
        let foundDry = false;
        for (let k = 0; k < 8; k++) {
          const testAng = baseAng + (k === 0 ? 0 : (k % 2 === 0 ? 1 : -1) * k * 0.35);
          const fx = clamp(this.position.x + Math.sin(testAng) * 14.0, -MAP_BOUND, MAP_BOUND);
          const fz = clamp(this.position.z + Math.cos(testAng) * 14.0, -MAP_BOUND, MAP_BOUND);
          const fy = this._sampleHeight(fx, fz);
          if (fy > WATER_SAFE_Y + 0.15) {
            this._waypoint.set(fx, fy, fz);
            foundDry = true;
            break;
          }
        }
        if (!foundDry) {
          this._waypoint.copy(this.homePos);
        }

        this._yaw = Math.atan2(
          this._waypoint.x - this.position.x,
          this._waypoint.z - this.position.z
        );
        this._alignToTerrain(0.85);
        this.state = 'flee';
        this._stateTimer = 4.2 + this._rng() * 0.7; // ~4.5s flee into ferns/trees
        this._scareCooldown = 22.0;
      }
    } else if (this.state === 'flee') {
      this._stateTimer -= safeDt;
      const fleeSpeed = 5.2 + this.boldness * 1.0;
      const { dist, blockedByWater } = this._stepGroundMove(
        safeDt,
        this._waypoint.x,
        this._waypoint.z,
        fleeSpeed,
        12.0,
        false
      );

      if (dist < 1.2 || blockedByWater) {
        this._pickDryWaypoint(this.homePos.x, this.homePos.z, 2.0, this.territoryRadius + 2.5);
      }

      if (this._stateTimer <= 0) {
        this.state = 'forage';
        this._stateTimer = 2.0 + this._rng() * 2.5;
        this._speed = 0;
      }
    }

    // Measure angular yaw rate & world-space root acceleration (powers 6-bone tail physics!)
    const rawYawRate = wrapAngle(this._yaw - this._prevYaw) / safeDt;
    this._yawRate = lerp(this._yawRate, clamp(rawYawRate, -14, 14), clamp(safeDt * 18, 0, 1));

    if (this._hasPrevPos) {
      _rootVel.subVectors(this.position, this._prevRootPos).divideScalar(safeDt);
      _rootAccel.subVectors(_rootVel, this._prevRootVel).divideScalar(safeDt);
      // Clamp acceleration to prevent impulse spikes on teleport/latch
      if (_rootAccel.lengthSq() > 45 * 45) {
        _rootAccel.setLength(45);
      }
      _invRootQuat.copy(this.root.quaternion).invert();
      _localAccel.copy(_rootAccel).applyQuaternion(_invRootQuat);
      this._prevRootVel.copy(_rootVel);
    } else {
      _localAccel.set(0, 0, 0);
      this._hasPrevPos = true;
    }
    this._prevRootPos.copy(this.position);

    // Update procedural spine, legs, ears, whiskers & 6-bone tail physics
    this._animateBody(safeDt, safeElapsed);
    this._updateTailPhysics(safeDt, safeElapsed, _localAccel);
  }

  _animateBody(dt, elapsed) {
    const isClimbing = this.state === 'climbLeg';
    const isLeaping = this.state === 'leapOff';
    const isMoving = this.state === 'scurry' || this.state === 'chaseHuman' || this.state === 'flee';

    // Advance gallop / scramble cycle
    let cycleFreq = 0;
    if (isClimbing) {
      cycleFreq = 25.0; // Frantic pant-leg scramble!
    } else if (isLeaping) {
      cycleFreq = 22.0; // Mid-air frantic paddle!
    } else if (isMoving) {
      cycleFreq = 7.5 + this._speed * 2.2;
    }
    this._gaitPhase += dt * cycleFreq;

    const turnFlex = isClimbing
      ? Math.sin(this._gaitPhase * 0.45) * 0.28
      : clamp(this._yawRate * 0.085, -0.34, 0.34);

    if (isMoving) {
      const gallop = Math.sin(this._gaitPhase);
      const gallopCos = Math.cos(this._gaitPhase);
      const intensity = clamp(this._speed / 5.5, 0.45, 1.25);

      // Rodent bounding gallop: spine arches as hind legs gather, extends as front legs reach
      this.bodyPivot.position.y = Math.max(0, gallopCos) * 0.018 * intensity;
      this.bodyPivot.rotation.x = -gallop * 0.14 * intensity;
      this.bodyPivot.rotation.z = -turnFlex * 0.25;

      this.pelvis.rotation.x = -gallop * 0.16 * intensity;
      this.midSpine.rotation.x = gallop * 0.24 * intensity;
      this.midSpine.rotation.y = turnFlex * 0.55;

      this.chest.rotation.x = -gallop * 0.12 * intensity;
      this.chest.rotation.y = turnFlex * 0.45;

      this.head.rotation.x = -gallop * 0.08 + 0.05;
      this.head.rotation.y = turnFlex * 0.42;
      this.head.rotation.z = 0;

      // Half-bound legs: front pair + hind pair out of phase (negative rot.x swings paw forward!)
      const flSwing = Math.sin(this._gaitPhase + 0.22);
      const frSwing = Math.sin(this._gaitPhase - 0.22);
      const blSwing = Math.sin(this._gaitPhase + Math.PI + 0.18);
      const brSwing = Math.sin(this._gaitPhase + Math.PI - 0.18);

      this.legFL.rotation.x = -flSwing * 0.78 * intensity;
      this.legFR.rotation.x = -frSwing * 0.78 * intensity;
      this.footFL.rotation.x = Math.max(0, flSwing) * 0.52;
      this.footFR.rotation.x = Math.max(0, frSwing) * 0.52;

      this.legBL.rotation.x = -blSwing * 0.88 * intensity;
      this.legBR.rotation.x = -brSwing * 0.88 * intensity;
      this.footBL.rotation.x = -Math.max(0, -blSwing) * 0.55;
      this.footBR.rotation.x = -Math.max(0, -brSwing) * 0.55;
    } else if (isClimbing) {
      // Flat hunched clinging posture with frantic gripping paw cycles & squirming spine
      const scramble = Math.sin(this._gaitPhase);
      this.bodyPivot.position.y = -0.028 + Math.abs(scramble) * 0.008;
      this.bodyPivot.rotation.x = 0.05;
      this.bodyPivot.rotation.z = Math.sin(this._gaitPhase * 0.5) * 0.14;

      this.pelvis.rotation.x = 0.12 + scramble * 0.14;
      this.midSpine.rotation.x = -0.20 - scramble * 0.22;
      this.midSpine.rotation.y = turnFlex * 0.85;

      this.chest.rotation.x = 0.12 + scramble * 0.10;
      this.chest.rotation.y = -turnFlex * 0.55;

      this.head.rotation.x = -0.18; // Nose angled slightly up the pant leg!
      this.head.rotation.y = Math.sin(this._gaitPhase * 0.4) * 0.24;
      this.head.rotation.z = 0;

      // Rapid alternating grip scramble clutching the shin
      const sL = Math.sin(this._gaitPhase);
      const sR = Math.sin(this._gaitPhase + Math.PI);
      this.legFL.rotation.x = -0.45 - sL * 0.65;
      this.legFR.rotation.x = -0.45 - sR * 0.65;
      this.legFL.rotation.z = -0.28; // Hug shin tightly
      this.legFR.rotation.z = 0.28;
      this.footFL.rotation.x = 0.35 + sL * 0.3;
      this.footFR.rotation.x = 0.35 + sR * 0.3;

      this.legBL.rotation.x = 0.25 - sR * 0.68;
      this.legBR.rotation.x = 0.25 - sL * 0.68;
      this.legBL.rotation.z = -0.26;
      this.legBR.rotation.z = 0.26;
      this.footBL.rotation.x = -0.25;
      this.footBR.rotation.x = -0.25;
    } else if (isLeaping) {
      // Mid-air stretched panicked flail
      this.bodyPivot.position.y = 0;
      this.bodyPivot.rotation.set(0, 0, 0);
      this.pelvis.rotation.x = 0.22;
      this.midSpine.rotation.x = -0.18 + Math.sin(this._gaitPhase) * 0.15;
      this.midSpine.rotation.y = Math.sin(this._gaitPhase * 0.5) * 0.22;
      this.chest.rotation.x = -0.12;
      this.chest.rotation.y = -this.midSpine.rotation.y * 0.5;
      this.head.rotation.set(-0.22, 0, 0);

      const p1 = Math.sin(this._gaitPhase);
      const p2 = Math.cos(this._gaitPhase);
      this.legFL.rotation.set(-0.55 + p1 * 0.55, 0, -0.35);
      this.legFR.rotation.set(-0.55 - p1 * 0.55, 0, 0.35);
      this.legBL.rotation.set(0.65 + p2 * 0.55, 0, -0.30);
      this.legBR.rotation.set(0.65 - p2 * 0.55, 0, 0.30);
      this.footFL.rotation.x = 0.2;
      this.footFR.rotation.x = 0.2;
      this.footBL.rotation.x = -0.3;
      this.footBR.rotation.x = -0.3;
    } else {
      // Idle / Forage: crouched sniffing, breathing, curious head looks
      const breathe = Math.sin(elapsed * 5.2 + this._sniffOffset);
      const sniff = Math.sin(elapsed * 13.5 + this._sniffOffset) * 0.06;
      const lookYaw = Math.sin(elapsed * 1.15 + this._sniffOffset) * 0.34;
      const dip = (Math.sin(elapsed * 1.7 + this._sniffOffset * 1.4) * 0.5 + 0.5) * 0.22;

      this.bodyPivot.position.y = -0.004 + breathe * 0.0025;
      this.bodyPivot.rotation.set(0, 0, 0);

      this.pelvis.rotation.set(0.08, 0, 0);
      this.midSpine.rotation.set(0.10 + breathe * 0.025, lookYaw * 0.25, 0);
      this.chest.rotation.set(-0.06, lookYaw * 0.25, 0);
      this.head.rotation.set(0.10 + dip + sniff, lookYaw * 0.55, Math.sin(elapsed * 0.9) * 0.08);

      // Relaxed tucked ground stance
      this.legFL.rotation.set(-0.08, 0, 0);
      this.legFR.rotation.set(-0.08, 0, 0);
      this.footFL.rotation.x = 0.08;
      this.footFR.rotation.x = 0.08;
      this.legBL.rotation.set(0.12, 0, 0);
      this.legBR.rotation.set(0.12, 0, 0);
      this.footBL.rotation.x = -0.10;
      this.footBR.rotation.x = -0.10;
    }

    // Reset leg Z splay when on ground
    if (!isClimbing && !isLeaping) {
      this.legFL.rotation.z = 0;
      this.legFR.rotation.z = 0;
      this.legBL.rotation.z = 0;
      this.legBR.rotation.z = 0;
    }

    // Independent ear twitches (flattened back slightly when chasing/climbing/fleeing)
    const earAlertPin =
      this.state === 'chaseHuman' || isClimbing || this.state === 'flee' ? -0.34 : 0.0;
    const twitchL = Math.pow(Math.max(0, Math.sin(elapsed * 4.7 + this._earPhaseL)), 10) * 0.32;
    const twitchR = Math.pow(Math.max(0, Math.sin(elapsed * 5.3 + this._earPhaseR)), 10) * 0.32;
    this.earL.rotation.set(-0.18 + earAlertPin - twitchL * 0.6, 0.42 + twitchL, -0.36 - twitchL * 0.4);
    this.earR.rotation.set(-0.18 + earAlertPin - twitchR * 0.6, -0.42 - twitchR, 0.36 + twitchR * 0.4);

    // Rapid excited whisker twitching (6 whiskers, 3 per side)
    const whiskerRate = this.isScaring() ? 34.0 : 19.0;
    const whiskerAmp = this.isScaring() ? 0.16 : 0.11;
    for (let i = 0; i < 3; i++) {
      const wL = this.whiskersL[i];
      const wR = this.whiskersR[i];
      const jL = Math.sin(elapsed * whiskerRate + this._whiskerPhase + wL.phase) * whiskerAmp;
      const jR = Math.sin(elapsed * (whiskerRate + 1.8) + this._whiskerPhase + wR.phase) * whiskerAmp;
      wL.group.rotation.y = wL.baseRotY + jL;
      wL.group.rotation.z = wL.baseRotZ + jL * 0.45;
      wR.group.rotation.y = wR.baseRotY - jR;
      wR.group.rotation.z = wR.baseRotZ - jR * 0.45;
    }
  }

  /**
   * Sub-stepped angular spring-damper physics across all 6 tail bones (`tail0` .. `tail5`),
   * driven by turn yaw rate, scamper gallop waves, and world-space lateral/vertical shake acceleration!
   */
  _updateTailPhysics(dt, elapsed, localAccel) {
    const isClimbing = this.state === 'climbLeg';
    const isLeaping = this.state === 'leapOff';
    const isForaging = this.state === 'forage';

    // Drive tail whip from turn angular rate + lateral bone shake acceleration (14 Hz shin shake!)
    const lateralShakeDrive = clamp(-localAccel.x * 0.055, -1.75, 1.75);
    const verticalShakeDrive = clamp(-localAccel.y * 0.032, -1.25, 1.25);
    const shakeEnergy = clamp(Math.hypot(localAccel.x, localAccel.y) * 0.06, 0, 1.4);
    const turnDrive = clamp(-this._yawRate * 0.095, -0.85, 0.85);

    const substeps = isClimbing ? 3 : 2;
    const h = dt / substeps;

    for (let s = 0; s < substeps; s++) {
      for (let i = 0; i < 6; i++) {
        const frac = i / 5;

        // Target yaw propagates with lag down the 6-bone chain
        let targetYaw = 0;
        if (i === 0) {
          targetYaw = turnDrive * 0.72 + lateralShakeDrive * 0.62;
          if (isForaging) {
            targetYaw += Math.sin(elapsed * 2.1 + this._sniffOffset) * 0.16;
          } else if (isClimbing) {
            targetYaw += Math.sin(elapsed * 22.0 + this._sniffOffset) * (0.36 + shakeEnergy * 0.24);
          } else if (isLeaping) {
            targetYaw += Math.sin(elapsed * 19.0 + this._sniffOffset) * 0.46;
          } else {
            targetYaw += Math.sin(this._gaitPhase * 0.5) * 0.12;
          }
        } else {
          // Lagged whip propagation + amplified tip flick on 14 Hz leg shake & leap
          const whipBoost = isClimbing || isLeaping ? 1.15 : 0.88;
          targetYaw =
            this._tailYaw[i - 1] * whipBoost +
            lateralShakeDrive * (0.30 + frac * 0.42) * (isClimbing ? 1.45 : 0.65);
          if (isForaging) {
            targetYaw += Math.sin(elapsed * 2.1 - i * 0.65 + this._sniffOffset) * 0.11;
          } else if (isClimbing) {
            targetYaw +=
              Math.sin(elapsed * 22.0 - i * 0.72 + this._sniffOffset) *
              (0.18 + frac * 0.22) *
              (0.6 + shakeEnergy * 0.6);
          }
        }

        // Target pitch: positive rot.x lifts -Z tail UP; negative droops it DOWN
        let targetPitch = 0;
        if (isClimbing) {
          // Droop outward/back slightly off the vertical shin and whip vertically
          targetPitch =
            (i === 0 ? 0.24 : -0.05) +
            verticalShakeDrive * (0.38 + frac * 0.44) +
            Math.cos(elapsed * 19.0 - i * 0.62) * (0.24 + shakeEnergy * 0.14);
        } else if (isLeaping) {
          targetPitch =
            (i === 0 ? 0.16 : 0.08) +
            Math.sin(elapsed * 18.0 - i * 0.6) * 0.30 +
            verticalShakeDrive * 0.25;
        } else if (isForaging) {
          // Tail rests gently curved slightly above soil, curving softly up at tip
          targetPitch = i === 0 ? -0.18 : i === 1 ? 0.12 : 0.06;
        } else {
          // Streaming cleanly behind during scamper gallop with slight vertical wave
          const baseLift = i === 0 ? 0.12 : -0.02;
          targetPitch = baseLift + Math.sin(this._gaitPhase - i * 0.62) * (0.06 + frac * 0.05);
        }

        targetYaw = clamp(targetYaw, -0.76, 0.76);
        targetPitch = clamp(targetPitch, -0.72, 0.72);

        const baseStiff = isClimbing ? 168.0 : 108.0;
        const stiffness = baseStiff - i * 11.5;
        const damping = (isClimbing ? 15.2 : 13.8) - i * 1.05;

        const yawAcc = (targetYaw - this._tailYaw[i]) * stiffness - this._tailYawVel[i] * damping;
        this._tailYawVel[i] = clamp(this._tailYawVel[i] + yawAcc * h, -22, 22);
        this._tailYaw[i] = clamp(this._tailYaw[i] + this._tailYawVel[i] * h, -0.78, 0.78);

        const pitchAcc =
          (targetPitch - this._tailPitch[i]) * stiffness - this._tailPitchVel[i] * damping;
        this._tailPitchVel[i] = clamp(this._tailPitchVel[i] + pitchAcc * h, -22, 22);
        this._tailPitch[i] = clamp(this._tailPitch[i] + this._tailPitchVel[i] * h, -0.74, 0.74);
      }
    }

    for (let i = 0; i < 6; i++) {
      const bone = this.tailBones[i];
      bone.rotation.y = this._tailYaw[i];
      bone.rotation.x = this._tailPitch[i];
    }
  }

  dispose() {
    if (this.root.parent) {
      this.root.parent.remove(this.root);
    }
    if (this._ownsSharedAssets && this._assets) {
      this._assets.dispose();
    }
    this._assets = null;
    this._explicitTargetBone = null;
  }
}
