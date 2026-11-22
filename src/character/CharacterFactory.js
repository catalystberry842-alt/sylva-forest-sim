import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { createRng, clamp, lerp, smoothstep } from '../utils/random.js';

/**
 * Supported playable character preset IDs.
 */
export const CHARACTER_PRESETS = ['liam', 'lyra', 'kael', 'kenji'];

/**
 * Human-readable character display labels keyed by preset ID.
 */
export const CHARACTER_LABELS = {
  liam: 'Forest Ranger (Liam)',
  lyra: 'Woodland Archer (Lyra)',
  kael: 'Cyber Scout (Kael)',
  kenji: 'Wandering Ronin (Kenji)',
};

const PRESET_CONFIGS = {
  liam: {
    id: 'liam',
    name: CHARACTER_LABELS.liam,
    seed: 7319,
    clavX: 0.06,
    shoulderX: 0.195,
    waistScale: 1.0,
    chestScale: 1.0,
    hipScale: 1.0,
    armScale: 1.0,
    legScale: 1.0,
    headScale: [1.0, 1.02, 1.0],
    jawWidth: 1.0,
    skinTone: { r0: 196, r1: 228, g0: 146, g1: 178, b0: 118, b1: 146 },
    lipColor: 0xbd7164,
    hairTone: { r0: 54, r1: 112, g0: 34, g1: 72, b0: 22, b1: 46 },
    eyeStyle: 'hazel-blue',
    canteenOnHip: false,
  },
  lyra: {
    id: 'lyra',
    name: CHARACTER_LABELS.lyra,
    seed: 9127,
    clavX: 0.054,
    shoulderX: 0.178,
    waistScale: 0.84,
    chestScale: 0.91,
    hipScale: 0.97,
    armScale: 0.86,
    legScale: 0.92,
    headScale: [0.95, 1.01, 0.97],
    jawWidth: 0.88,
    skinTone: { r0: 212, r1: 240, g0: 164, g1: 196, b0: 138, b1: 168 },
    lipColor: 0xc46b68,
    hairTone: { r0: 118, r1: 186, g0: 44, g1: 86, b0: 22, b1: 46 },
    eyeStyle: 'emerald-amber',
    canteenOnHip: false,
  },
  kael: {
    id: 'kael',
    name: CHARACTER_LABELS.kael,
    seed: 5483,
    clavX: 0.06,
    shoulderX: 0.194,
    waistScale: 0.95,
    chestScale: 1.02,
    hipScale: 0.96,
    armScale: 0.98,
    legScale: 0.96,
    headScale: [0.98, 1.02, 1.0],
    jawWidth: 0.98,
    skinTone: { r0: 182, r1: 214, g0: 138, g1: 170, b0: 112, b1: 140 },
    lipColor: 0xb06c64,
    hairTone: { r0: 22, r1: 48, g0: 26, g1: 54, b0: 34, b1: 68 },
    eyeStyle: 'ice-cyan',
    canteenOnHip: false,
  },
  kenji: {
    id: 'kenji',
    name: CHARACTER_LABELS.kenji,
    seed: 3821,
    clavX: 0.06,
    shoulderX: 0.196,
    waistScale: 0.99,
    chestScale: 1.02,
    hipScale: 1.04,
    armScale: 0.98,
    legScale: 1.0,
    headScale: [0.99, 1.02, 1.0],
    jawWidth: 1.02,
    skinTone: { r0: 194, r1: 226, g0: 150, g1: 182, b0: 116, b1: 144 },
    lipColor: 0xb46d62,
    hairTone: { r0: 16, r1: 36, g0: 17, g1: 38, b0: 22, b1: 44 },
    eyeStyle: 'obsidian-amber',
    canteenOnHip: true,
  },
};

function cosBlend(t) {
  const c = clamp(t, 0, 1);
  return 0.5 - 0.5 * Math.cos(Math.PI * c);
}

/**
 * Normalizes up to 4 skinning influences strictly so sum === 1.0 in float32.
 */
function packSkinWeights(influences, fallbackBoneIdx = 0) {
  const merged = [];
  for (let i = 0; i < influences.length; i++) {
    const inf = influences[i];
    if (!inf || !Number.isFinite(inf.weight) || inf.weight <= 1e-6 || inf.boneIdx < 0) continue;
    let found = false;
    for (let j = 0; j < merged.length; j++) {
      if (merged[j].boneIdx === inf.boneIdx) {
        merged[j].weight += inf.weight;
        found = true;
        break;
      }
    }
    if (!found) {
      merged.push({ boneIdx: inf.boneIdx, weight: inf.weight });
    }
  }

  if (merged.length === 0) {
    return {
      indices: [fallbackBoneIdx, 0, 0, 0],
      weights: [1.0, 0.0, 0.0, 0.0],
    };
  }

  merged.sort((a, b) => b.weight - a.weight);
  const top = merged.slice(0, 4);
  let sum = 0;
  for (let i = 0; i < top.length; i++) sum += top[i].weight;
  if (!(sum > 1e-8)) {
    return {
      indices: [fallbackBoneIdx, 0, 0, 0],
      weights: [1.0, 0.0, 0.0, 0.0],
    };
  }

  const indices = [0, 0, 0, 0];
  const weights = [0.0, 0.0, 0.0, 0.0];
  let acc = 0.0;
  for (let i = 0; i < top.length; i++) {
    indices[i] = top[i].boneIdx;
    if (i === top.length - 1) {
      weights[i] = Math.max(0.0, 1.0 - acc);
    } else {
      const w = Math.fround(top[i].weight / sum);
      weights[i] = w;
      acc += w;
    }
  }

  // Re-normalize tiny rounding residue cleanly onto the primary influence
  const total = weights[0] + weights[1] + weights[2] + weights[3];
  if (Math.abs(total - 1.0) > 1e-6) {
    weights[0] = Math.max(0.0, weights[0] + (1.0 - total));
  }
  return { indices, weights };
}

/**
 * Welds vertex normals across coincident seam/material-transition vertices so
 * continuous skinned meshes shade smoothly without UV-seam creases.
 */
function weldBoundaryNormals(geo) {
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  if (!pos || !norm) return geo;

  const buckets = new Map();
  const invQuant = 2000; // 0.5mm spatial quantization bucket
  for (let i = 0; i < pos.count; i++) {
    const qx = Math.round(pos.getX(i) * invQuant);
    const qy = Math.round(pos.getY(i) * invQuant);
    const qz = Math.round(pos.getZ(i) * invQuant);
    const key = `${qx},${qy},${qz}`;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(i);
  }

  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let k = 0; k < list.length; k++) {
      const idx = list[k];
      nx += norm.getX(idx);
      ny += norm.getY(idx);
      nz += norm.getZ(idx);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-5) {
      nx /= len;
      ny /= len;
      nz /= len;
      for (let k = 0; k < list.length; k++) {
        norm.setXYZ(list[k], nx, ny, nz);
      }
    }
  }
  norm.needsUpdate = true;
  return geo;
}

/**
 * Procedural vertex-weighted SkinnedMesh character rig supporting all 4 presets:
 *   'liam'  — Forest Ranger (Liam)
 *   'lyra'  — Woodland Archer (Lyra)
 *   'kael'  — Cyber Scout (Kael)
 *   'kenji' — Wandering Ronin (Kenji)
 *
 * Local coordinate conventions:
 *   +Z = forward, +Y = up, +X = character's LEFT
 *   Bind pose: boot soles strictly at y = 0.0, hips at y = 0.94, head crown at ~1.80.
 */
export class CharacterRig {
  constructor(presetId = 'liam', options = {}) {
    const resolvedId = PRESET_CONFIGS[presetId] ? presetId : 'liam';
    this._cfg = PRESET_CONFIGS[resolvedId];
    this.id = this._cfg.id;
    this.name = this._cfg.name;
    this._seed = options.seed ?? this._cfg.seed;

    this._geometries = [];
    this._materials = [];
    this._textures = [];
    this._disposed = false;

    this.root = new THREE.Group();
    this.root.name = `CharacterRig_${this.id}`;

    this.metrics = {
      hipBindY: 0.94,
      thighLen: 0.44,
      shinLen: 0.42,
      ankleHeight: 0.08,
      hipOffsetX: 0.105,
      upperArmLen: 0.28,
      forearmLen: 0.25,
    };

    // Exact vertical distance from ankle joint (y = 0.06 in straight bind pose) to boot sole (y = 0.0)
    this._soleOffsetBelowAnkle = 0.06;

    // Shared reactive shader uniforms across skin, clothing, cloth-wave shaders, boots, and gear
    this.shaderUniforms = {
      uSweatLevel: { value: 0.0 },
      uLegWetness: { value: 0.0 },
      uRainWetness: { value: 0.0 },
      uFaceFlush: { value: 0.0 },
      uClothTime: { value: 0.0 },
      uClothWind: { value: 0.25 },
      uClothSpeed: { value: 0.0 },
    };

    this.headMeshes = [];
    this.skinnedMeshes = [];
    this.bones = {};
    this._boneList = [];
    this._boneIndex = {};

    this._buildMaterials();
    this._buildSkeletonHierarchy();

    // Freeze exact bind-pose world matrices & skeleton before binding SkinnedMeshes
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this._boneList);
    this.skeleton.calculateInverses();

    // Build continuous vertex-weighted body, limbs, boots, garments, head, hands & gear
    this._buildCharacterGeometry();
    this._buildContactShadows();

    // Final world matrix sync in bind pose
    this.root.updateMatrixWorld(true);
    this.skeleton.update();

    // Reusable scratch vectors/matrices for zero-allocation queries & contact shadows
    this._tmpFootLocal = new THREE.Vector3();
    this._shadowInvRootMat = new THREE.Matrix4();
    this._shadowRootPos = new THREE.Vector3();
    this._shadowRootQuat = new THREE.Quaternion();
    this._shadowInvRootQuat = new THREE.Quaternion();
    this._shadowRootScale = new THREE.Vector3();
    this._shadowLocalPos = new THREE.Vector3();
    this._shadowLocalNorm = new THREE.Vector3();
    this._shadowUp = new THREE.Vector3(0, 1, 0);
    this._shadowFwd = new THREE.Vector3(0, 0, 1);
    this._shadowLeft = new THREE.Vector3(1, 0, 0);
    this._shadowBasis = new THREE.Matrix4();
  }

  // ---------------------------------------------------------------------------
  // Resource Tracking & Attribute Tagging Helpers
  // ---------------------------------------------------------------------------

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

  _tagCharHeight(geo, baseHeightY = 0.0, scaleY = 1.0) {
    const pos = geo.attributes.position;
    const heights = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      heights[i] = Math.max(0.0, baseHeightY + pos.getY(i) * scaleY);
    }
    geo.setAttribute('aLegHeight', new THREE.BufferAttribute(heights, 1));
    return geo;
  }

  _tagSweatMask(geo, maskFn) {
    const pos = geo.attributes.position;
    const mask = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      mask[i] = clamp(maskFn(pos.getX(i), pos.getY(i), pos.getZ(i)), 0.0, 1.0);
    }
    geo.setAttribute('aSweatMask', new THREE.BufferAttribute(mask, 1));
    return geo;
  }

  _tagClothPin(geo, pinFn) {
    const pos = geo.attributes.position;
    const pins = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      pins[i] = clamp(pinFn(pos.getX(i), pos.getY(i), pos.getZ(i)), 0.0, 1.0);
    }
    geo.setAttribute('aClothPin', new THREE.BufferAttribute(pins, 1));
    return geo;
  }

  _ensureShaderAttributes(geo, defaultHeight = 1.2) {
    if (!geo.attributes.aLegHeight) {
      this._tagCharHeight(geo, defaultHeight, 1.0);
    }
    if (!geo.attributes.aSweatMask) {
      this._tagSweatMask(geo, () => 0.35);
    }
    if (!geo.attributes.aClothPin) {
      this._tagClothPin(geo, () => 0.0);
    }
    return geo;
  }

  _makeMesh(geo, mat, { name = '', castShadow = true, receiveShadow = true, isHead = false } = {}) {
    this._ensureShaderAttributes(geo, 1.2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    if (isHead) {
      this.headMeshes.push(mesh);
    }
    return mesh;
  }

  _createSkinnedMesh(geo, materials, { name = '', castShadow = true, receiveShadow = true } = {}) {
    this._ensureShaderAttributes(geo, 0.0);
    if (!geo.boundingSphere) {
      geo.computeBoundingSphere();
    }
    const skinned = new THREE.SkinnedMesh(geo, materials);
    skinned.name = name;
    skinned.castShadow = castShadow;
    skinned.receiveShadow = receiveShadow;
    // Prevent unexpected view-frustum culling when skeletal animation offsets limbs far from bind bounds
    skinned.frustumCulled = false;
    this.root.add(skinned);
    skinned.bind(this.skeleton);
    this.skinnedMeshes.push(skinned);
    return skinned;
  }

  // ---------------------------------------------------------------------------
  // Procedural Sculpted Organic Geometry Builders
  // ---------------------------------------------------------------------------

  /**
   * Builds a closed or open organic lofted tube from anatomically profiled cross-section rings.
   * Each ring: { y, rx, rz, ox = 0, oz = 0, frontScale = 1, backScale = 1, squareness = 0, pleatAmp = 0, pleatFreq = 6 }
   */
  _createSculptedLoft(rings, radialSegments = 18, options = {}) {
    const { capBottom = true, capTop = true, uvRepeatU = 1, uvRepeatV = 1 } = options;
    const ringCount = rings.length;
    const cols = radialSegments + 1;

    const positions = [];
    const uvs = [];
    const indices = [];

    const vCoords = new Float32Array(ringCount);
    let totalLen = 0;
    for (let r = 1; r < ringCount; r++) {
      const dy = rings[r].y - rings[r - 1].y;
      const dr = (rings[r].rx - rings[r - 1].rx + (rings[r].rz - rings[r - 1].rz)) * 0.5;
      totalLen += Math.hypot(dy, dr);
      vCoords[r] = totalLen;
    }
    const invTotal = totalLen > 1e-5 ? 1 / totalLen : 1;

    for (let r = 0; r < ringCount; r++) {
      const ring = rings[r];
      const v = vCoords[r] * invTotal * uvRepeatV;
      const ox = ring.ox ?? 0;
      const oz = ring.oz ?? 0;
      const frontScale = ring.frontScale ?? 1.0;
      const backScale = ring.backScale ?? 1.0;
      const sq = ring.squareness ?? 0.0;
      const pleatAmp = ring.pleatAmp ?? 0.0;
      const pleatFreq = ring.pleatFreq ?? 6.0;

      for (let c = 0; c <= radialSegments; c++) {
        const uFrac = c / radialSegments;
        const theta = uFrac * Math.PI * 2;
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);

        let sx = sinT;
        let sz = cosT;
        if (sq > 0) {
          const p = 1.0 - sq * 0.35;
          sx = Math.sign(sinT) * Math.pow(Math.abs(sinT), p);
          sz = Math.sign(cosT) * Math.pow(Math.abs(cosT), p);
        }

        const pleat = pleatAmp > 0 ? 1.0 + pleatAmp * Math.cos(theta * pleatFreq) : 1.0;
        const zMult = sz >= 0 ? frontScale : backScale;
        const x = ox + sx * ring.rx * pleat;
        const z = oz + sz * ring.rz * zMult * pleat;

        positions.push(x, ring.y, z);
        uvs.push(uFrac * uvRepeatU, v);
      }
    }

    const ascending = rings[ringCount - 1].y >= rings[0].y;
    for (let r = 0; r < ringCount - 1; r++) {
      const rowA = r * cols;
      const rowB = (r + 1) * cols;
      for (let c = 0; c < radialSegments; c++) {
        const a = rowA + c;
        const b = rowA + c + 1;
        const d = rowB + c;
        const e = rowB + c + 1;
        if (ascending) {
          indices.push(a, b, e, a, e, d);
        } else {
          indices.push(a, e, b, a, d, e);
        }
      }
    }

    if (capBottom && (rings[0].rx > 1e-4 || rings[0].rz > 1e-4)) {
      const centerIdx = positions.length / 3;
      positions.push(rings[0].ox ?? 0, rings[0].y, rings[0].oz ?? 0);
      uvs.push(0.5, 0.0);
      for (let c = 0; c < radialSegments; c++) {
        if (ascending) {
          indices.push(centerIdx, c + 1, c);
        } else {
          indices.push(centerIdx, c, c + 1);
        }
      }
    }

    if (capTop && (rings[ringCount - 1].rx > 1e-4 || rings[ringCount - 1].rz > 1e-4)) {
      const lastRow = (ringCount - 1) * cols;
      const centerIdx = positions.length / 3;
      const top = rings[ringCount - 1];
      positions.push(top.ox ?? 0, top.y, top.oz ?? 0);
      uvs.push(0.5, uvRepeatV);
      for (let c = 0; c < radialSegments; c++) {
        if (ascending) {
          indices.push(centerIdx, lastRow + c, lastRow + c + 1);
        } else {
          indices.push(centerIdx, lastRow + c + 1, lastRow + c);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return this._trackGeo(geo);
  }

  /**
   * Builds a thickened open-front C-shell (for open field jackets, haori coats,
   * split archer tunics, and exo-jackets) sweeping cleanly around left, back, and right.
   */
  _createOpenSculptedShell(rings, radialSegments = 22, options = {}) {
    const {
      gapHalfAngle = 0.44,
      thickness = 0.012,
      uvRepeatU = 1,
      uvRepeatV = 1,
    } = options;

    const ringCount = rings.length;
    const cols = radialSegments + 1;
    const positions = [];
    const uvs = [];
    const indices = [];

    const vCoords = new Float32Array(ringCount);
    let totalLen = 0;
    for (let r = 1; r < ringCount; r++) {
      const dy = rings[r].y - rings[r - 1].y;
      const dr = (rings[r].rx - rings[r - 1].rx + (rings[r].rz - rings[r - 1].rz)) * 0.5;
      totalLen += Math.hypot(dy, dr);
      vCoords[r] = totalLen;
    }
    const invTotal = totalLen > 1e-5 ? 1 / totalLen : 1;

    const evalPoint = (ring, theta, inset) => {
      const ox = ring.ox ?? 0;
      const oz = ring.oz ?? 0;
      const frontScale = ring.frontScale ?? 1.0;
      const backScale = ring.backScale ?? 1.0;
      const sq = ring.squareness ?? 0.0;

      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      let sx = sinT;
      let sz = cosT;
      if (sq > 0) {
        const p = 1.0 - sq * 0.35;
        sx = Math.sign(sinT) * Math.pow(Math.abs(sinT), p);
        sz = Math.sign(cosT) * Math.pow(Math.abs(cosT), p);
      }

      const zMult = sz >= 0 ? frontScale : backScale;
      const rx = Math.max(0.01, ring.rx - inset);
      const rz = Math.max(0.01, ring.rz - inset);
      return [ox + sx * rx, ring.y, oz + sz * rz * zMult];
    };

    const ascending = rings[ringCount - 1].y >= rings[0].y;

    for (let r = 0; r < ringCount; r++) {
      const ring = rings[r];
      const gapR = ring.gapHalfAngle ?? gapHalfAngle;
      const tStart = gapR;
      const tSpan = Math.PI * 2 - gapR * 2;
      const v = vCoords[r] * invTotal * uvRepeatV;
      for (let c = 0; c <= radialSegments; c++) {
        const uFrac = c / radialSegments;
        const theta = tStart + uFrac * tSpan;
        const pt = evalPoint(ring, theta, 0);
        positions.push(pt[0], pt[1], pt[2]);
        uvs.push(uFrac * uvRepeatU, v);
      }
    }

    const innerBase = ringCount * cols;
    for (let r = 0; r < ringCount; r++) {
      const ring = rings[r];
      const gapR = ring.gapHalfAngle ?? gapHalfAngle;
      const tStart = gapR;
      const tSpan = Math.PI * 2 - gapR * 2;
      const v = vCoords[r] * invTotal * uvRepeatV;
      for (let c = 0; c <= radialSegments; c++) {
        const uFrac = c / radialSegments;
        const theta = tStart + uFrac * tSpan;
        const pt = evalPoint(ring, theta, thickness);
        positions.push(pt[0], pt[1], pt[2]);
        uvs.push(uFrac * uvRepeatU, v);
      }
    }

    for (let r = 0; r < ringCount - 1; r++) {
      const rowA = r * cols;
      const rowB = (r + 1) * cols;
      const iRowA = innerBase + rowA;
      const iRowB = innerBase + rowB;
      for (let c = 0; c < radialSegments; c++) {
        const a = rowA + c;
        const b = rowA + c + 1;
        const d = rowB + c;
        const e = rowB + c + 1;
        if (ascending) {
          indices.push(a, b, e, a, e, d);
        } else {
          indices.push(a, e, b, a, d, e);
        }
        const ia = iRowA + c;
        const ib = iRowA + c + 1;
        const id = iRowB + c;
        const ie = iRowB + c + 1;
        if (ascending) {
          indices.push(ia, ie, ib, ia, id, ie);
        } else {
          indices.push(ia, ib, ie, ia, ie, id);
        }
      }
    }

    const addEdgeStrip = (colIdx, flipWinding) => {
      const edgeBase = positions.length / 3;
      for (let r = 0; r < ringCount; r++) {
        const v = vCoords[r] * invTotal * uvRepeatV;
        const outIdx = (r * cols + colIdx) * 3;
        const inIdx = (innerBase + r * cols + colIdx) * 3;
        positions.push(positions[outIdx], positions[outIdx + 1], positions[outIdx + 2]);
        uvs.push(0.0, v);
        positions.push(positions[inIdx], positions[inIdx + 1], positions[inIdx + 2]);
        uvs.push(0.08, v);
      }
      for (let r = 0; r < ringCount - 1; r++) {
        const o0 = edgeBase + r * 2;
        const i0 = o0 + 1;
        const o1 = edgeBase + (r + 1) * 2;
        const i1 = o1 + 1;
        if (ascending !== flipWinding) {
          indices.push(o0, i1, i0, o0, o1, i1);
        } else {
          indices.push(o0, i0, i1, o0, i1, o1);
        }
      }
    };

    addEdgeStrip(0, true);
    addEdgeStrip(radialSegments, false);

    const addRimStrip = (rIdx, flipWinding) => {
      const rimBase = positions.length / 3;
      for (let c = 0; c <= radialSegments; c++) {
        const uFrac = c / radialSegments;
        const outIdx = (rIdx * cols + c) * 3;
        const inIdx = (innerBase + rIdx * cols + c) * 3;
        positions.push(positions[outIdx], positions[outIdx + 1], positions[outIdx + 2]);
        uvs.push(uFrac * uvRepeatU, 0.0);
        positions.push(positions[inIdx], positions[inIdx + 1], positions[inIdx + 2]);
        uvs.push(uFrac * uvRepeatU, 0.08);
      }
      for (let c = 0; c < radialSegments; c++) {
        const o0 = rimBase + c * 2;
        const i0 = o0 + 1;
        const o1 = rimBase + (c + 1) * 2;
        const i1 = o1 + 1;
        if (ascending !== flipWinding) {
          indices.push(o0, i0, i1, o0, i1, o1);
        } else {
          indices.push(o0, i1, i0, o0, o1, i1);
        }
      }
    };

    addRimStrip(0, false);
    addRimStrip(ringCount - 1, true);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return this._trackGeo(geo);
  }

  /**
   * Merges an array of { geo, matIndex, pinFn, sweatFn, transform } parts (already in
   * bind-pose root space or transformed via optional matrix) into ONE multi-material
   * vertex-weighted BufferGeometry ready for THREE.SkinnedMesh.
   */
  _mergeToSkinnedGeometry(parts, weightFn) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const skinIndices = [];
    const skinWeights = [];
    const legHeights = [];
    const sweatMasks = [];
    const clothPins = [];
    const groupBuckets = new Map();

    const tmpPos = new THREE.Vector3();
    const tmpNorm = new THREE.Vector3();
    const normalMat = new THREE.Matrix3();
    let vertOffset = 0;

    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      const geo = part.geo;
      if (!geo.attributes.normal) {
        geo.computeVertexNormals();
      }
      const posAttr = geo.attributes.position;
      const normAttr = geo.attributes.normal;
      const uvAttr = geo.attributes.uv;
      const matIdx = part.matIndex ?? 0;

      if (part.matrix) {
        normalMat.getNormalMatrix(part.matrix);
      }

      for (let i = 0; i < posAttr.count; i++) {
        tmpPos.fromBufferAttribute(posAttr, i);
        tmpNorm.fromBufferAttribute(normAttr, i);
        if (part.matrix) {
          tmpPos.applyMatrix4(part.matrix);
          tmpNorm.applyMatrix3(normalMat).normalize();
        }
        positions.push(tmpPos.x, tmpPos.y, tmpPos.z);
        normals.push(tmpNorm.x, tmpNorm.y, tmpNorm.z);
        if (uvAttr) {
          uvs.push(uvAttr.getX(i), uvAttr.getY(i));
        } else {
          uvs.push(0.5, 0.5);
        }

        const packed = packSkinWeights(weightFn(tmpPos.x, tmpPos.y, tmpPos.z, part), this._boneIndex.hips);
        skinIndices.push(packed.indices[0], packed.indices[1], packed.indices[2], packed.indices[3]);
        skinWeights.push(packed.weights[0], packed.weights[1], packed.weights[2], packed.weights[3]);

        legHeights.push(Math.max(0.0, tmpPos.y));
        sweatMasks.push(part.sweatFn ? clamp(part.sweatFn(tmpPos.x, tmpPos.y, tmpPos.z), 0, 1) : 0.35);
        clothPins.push(part.pinFn ? clamp(part.pinFn(tmpPos.x, tmpPos.y, tmpPos.z), 0, 1) : 0.0);
      }

      let bucket = groupBuckets.get(matIdx);
      if (!bucket) {
        bucket = [];
        groupBuckets.set(matIdx, bucket);
      }

      const idxAttr = geo.index;
      if (idxAttr) {
        for (let i = 0; i < idxAttr.count; i++) {
          bucket.push(vertOffset + idxAttr.getX(i));
        }
      } else {
        for (let i = 0; i < posAttr.count; i++) {
          bucket.push(vertOffset + i);
        }
      }

      vertOffset += posAttr.count;
    }

    const finalIndices = [];
    const mergedGeo = new THREE.BufferGeometry();
    const sortedMats = Array.from(groupBuckets.keys()).sort((a, b) => a - b);
    for (const matIdx of sortedMats) {
      const bucket = groupBuckets.get(matIdx);
      if (bucket.length === 0) continue;
      const start = finalIndices.length;
      for (let i = 0; i < bucket.length; i++) {
        finalIndices.push(bucket[i]);
      }
      mergedGeo.addGroup(start, bucket.length, matIdx);
    }

    mergedGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    mergedGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    mergedGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    mergedGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    mergedGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    mergedGeo.setAttribute('aLegHeight', new THREE.Float32BufferAttribute(legHeights, 1));
    mergedGeo.setAttribute('aSweatMask', new THREE.Float32BufferAttribute(sweatMasks, 1));
    mergedGeo.setAttribute('aClothPin', new THREE.Float32BufferAttribute(clothPins, 1));
    mergedGeo.setIndex(finalIndices);
    mergedGeo.computeBoundingBox();
    mergedGeo.computeBoundingSphere();

    return this._trackGeo(mergedGeo);
  }

  _partTransform(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
    return m;
  }

  // ---------------------------------------------------------------------------
  // Procedural Canvas PBR Texture + Sobel Normal Map Generator (Node-Safe!)
  // ---------------------------------------------------------------------------

  _bufferToTexture(data, size, { isSRGB = false, repeatX = 1, repeatY = 1, clampEdge = false } = {}) {
    let tex;
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext ? canvas.getContext('2d') : null;
      if (ctx && typeof ctx.createImageData === 'function' && typeof ctx.putImageData === 'function') {
        const img = ctx.createImageData(size, size);
        img.data.set(data);
        ctx.putImageData(img, 0, 0);
        tex = new THREE.CanvasTexture(canvas);
      }
    }

    if (!tex) {
      tex = new THREE.DataTexture(new Uint8Array(data), size, size, THREE.RGBAFormat);
    }

    const wrap = clampEdge ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapS = wrap;
    tex.wrapT = wrap;
    tex.repeat.set(repeatX, repeatY);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = isSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.needsUpdate = true;
    return this._trackTex(tex);
  }

  _buildSobelNormalBuffer(heightBuf, size, strength = 1.4) {
    const out = new Uint8Array(size * size * 4);
    const hAt = (ix, iy) => heightBuf[((iy + size) % size) * size + ((ix + size) % size)];

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const tl = hAt(x - 1, y - 1);
        const t = hAt(x, y - 1);
        const tr = hAt(x + 1, y - 1);
        const l = hAt(x - 1, y);
        const r = hAt(x + 1, y);
        const bl = hAt(x - 1, y + 1);
        const b = hAt(x, y + 1);
        const br = hAt(x + 1, y + 1);

        const dX = (tr + 2 * r + br - (tl + 2 * l + bl)) * strength;
        const dY = (bl + 2 * b + br - (tl + 2 * t + tr)) * strength;
        let nx = -dX;
        let ny = -dY;
        let nz = 1.0;
        const inv = 1.0 / (Math.hypot(nx, ny, nz) || 1.0);
        nx *= inv;
        ny *= inv;
        nz *= inv;

        const idx = (y * size + x) * 4;
        out[idx] = Math.round((nx * 0.5 + 0.5) * 255);
        out[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        out[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        out[idx + 3] = 255;
      }
    }
    return out;
  }

  _generatePBRTextureSet(type, size = 128, seedOffset = 0, repeatX = 2, repeatY = 2) {
    const rng = createRng(this._seed + seedOffset);
    const n1 = createNoise2D(rng);
    const n2 = createNoise2D(createRng(this._seed + seedOffset + 97));

    const tileNoise = (u, v, freq, fn) => {
      const a = fn(u * freq, v * freq);
      const b = fn((u - 1) * freq, v * freq);
      const c = fn(u * freq, (v - 1) * freq);
      const d = fn((u - 1) * freq, (v - 1) * freq);
      const wx = smoothstep(0, 1, u);
      const wy = smoothstep(0, 1, v);
      return lerp(lerp(a, b, wx), lerp(c, d, wx), wy);
    };

    const diffBuf = new Uint8Array(size * size * 4);
    const roughBuf = new Uint8Array(size * size * 4);
    const heightBuf = new Float32Array(size * size);
    const skinTone = this._cfg.skinTone;
    const hairTone = this._cfg.hairTone;

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const idx = y * size + x;
        const pIdx = idx * 4;

        const fbm = tileNoise(u, v, 4.0, n1) * 0.6 + tileNoise(u, v, 9.0, n2) * 0.4;
        const nf = fbm * 0.5 + 0.5;
        const fine = tileNoise(u, v, 22.0, n2) * 0.5 + 0.5;

        let r = 128;
        let g = 128;
        let b = 128;
        let rough = 0.8;
        let h = nf;

        if (type === 'jacket') {
          const warp = Math.sin(u * size * Math.PI * 0.65) * 0.5 + 0.5;
          const weft = Math.sin(v * size * Math.PI * 0.65) * 0.5 + 0.5;
          const weave = (x + y) & 1 ? warp * 0.65 + weft * 0.35 : weft * 0.65 + warp * 0.35;
          const crease = Math.sin((u * 3.0 + v * 2.0 + nf * 1.1) * Math.PI * 2) * 0.5 + 0.5;
          const wax = clamp(nf * 0.55 + crease * 0.25 + weave * 0.2, 0, 1);

          r = lerp(52, 82, wax) + (fine - 0.5) * 8;
          g = lerp(66, 98, wax) + (fine - 0.5) * 8;
          b = lerp(52, 76, wax) + (fine - 0.5) * 6;
          rough = lerp(0.86, 0.58, wax);
          h = weave * 0.45 + crease * 0.35 + nf * 0.2;
        } else if (type === 'pants') {
          const diag = Math.sin(((x + y * 2) / size) * Math.PI * 44) * 0.5 + 0.5;
          const cross = Math.sin((x / size) * Math.PI * 56) * 0.5 + 0.5;
          const twill = diag * 0.68 + cross * 0.32;
          const tone = clamp(nf * 0.58 + twill * 0.27 + fine * 0.15, 0, 1);

          r = lerp(74, 112, tone);
          g = lerp(69, 102, tone);
          b = lerp(58, 84, tone);
          rough = lerp(0.92, 0.74, tone);
          h = twill * 0.52 + nf * 0.33 + fine * 0.15;
        } else if (type === 'leather') {
          const pebble = tileNoise(u, v, 28.0, n1) * 0.5 + 0.5;
          const crease = 1.0 - Math.abs(tileNoise(u, v, 7.0, n2));
          const grain = clamp(pebble * 0.5 + nf * 0.3 + crease * 0.2, 0, 1);

          r = lerp(68, 128, grain);
          g = lerp(40, 78, grain);
          b = lerp(24, 48, grain);
          rough = lerp(0.68, 0.36, grain);
          h = pebble * 0.48 + crease * 0.32 + nf * 0.2;
        } else if (type === 'embossedLeather') {
          const pebble = tileNoise(u, v, 26.0, n1) * 0.5 + 0.5;
          const vine = Math.sin((u * 6 + Math.sin(v * Math.PI * 4) * 0.45) * Math.PI * 2);
          const scroll = smoothstep(0.55, 0.92, Math.abs(vine)) * smoothstep(0.2, 0.8, Math.sin(v * Math.PI * 8) * 0.5 + 0.5);
          const grain = clamp(pebble * 0.42 + nf * 0.28 + scroll * 0.3, 0, 1);

          r = lerp(76, 134, grain) + scroll * 14;
          g = lerp(44, 84, grain) + scroll * 9;
          b = lerp(22, 46, grain);
          rough = lerp(0.66, 0.34, grain);
          h = pebble * 0.35 + scroll * 0.55 + nf * 0.1;
        } else if (type === 'pack') {
          const gridX = Math.sin(u * size * Math.PI * 0.8) * 0.5 + 0.5;
          const gridY = Math.sin(v * size * Math.PI * 0.8) * 0.5 + 0.5;
          const duck = gridX * 0.5 + gridY * 0.5;
          const patina = clamp(nf * 0.6 + duck * 0.25 + fine * 0.15, 0, 1);

          r = lerp(94, 146, patina);
          g = lerp(80, 124, patina);
          b = lerp(56, 90, patina);
          rough = lerp(0.94, 0.76, patina);
          h = duck * 0.5 + nf * 0.35 + fine * 0.15;
        } else if (type === 'skin') {
          const pore = tileNoise(u, v, 34.0, n2) * 0.5 + 0.5;
          const warmth = clamp(nf * 0.65 + fine * 0.2 + pore * 0.15, 0, 1);

          r = lerp(skinTone.r0, skinTone.r1, warmth);
          g = lerp(skinTone.g0, skinTone.g1, warmth);
          b = lerp(skinTone.b0, skinTone.b1, warmth);
          rough = lerp(0.62, 0.44, warmth);
          h = pore * 0.55 + fine * 0.25 + nf * 0.2;
        } else if (type === 'blanket') {
          const stripeA = Math.abs(Math.sin(v * Math.PI * 6));
          const stripeB = smoothstep(0.75, 0.92, Math.sin(v * Math.PI * 3) * 0.5 + 0.5);
          const fuzz = fine * 0.6 + nf * 0.4;
          r = lerp(128, 172, stripeA) * (1 - stripeB * 0.25) + (fuzz - 0.5) * 18;
          g = lerp(64, 118, stripeA) * (1 - stripeB * 0.42) + (fuzz - 0.5) * 14;
          b = lerp(42, 62, stripeA) * (1 - stripeB * 0.2) + (fuzz - 0.5) * 10;
          rough = lerp(0.96, 0.85, fuzz);
          h = fuzz * 0.7 + stripeA * 0.3;
        } else if (type === 'hair') {
          const strand = Math.sin((u * 48 + nf * 2.4) * Math.PI) * 0.5 + 0.5;
          const sheen = clamp(strand * 0.62 + nf * 0.28 + fine * 0.1, 0, 1);
          r = lerp(hairTone.r0, hairTone.r1, sheen);
          g = lerp(hairTone.g0, hairTone.g1, sheen);
          b = lerp(hairTone.b0, hairTone.b1, sheen);
          rough = lerp(0.74, 0.40, strand);
          h = strand * 0.75 + nf * 0.25;
        } else if (type === 'flannel') {
          const pu = (u * 3.0) % 1.0;
          const pv = (v * 3.0) % 1.0;
          const weave = ((x + y) & 1 ? 0.58 : 0.42) + (fine - 0.5) * 0.16;

          const inNavyU = pu < 0.24 || pu > 0.88;
          const inNavyV = pv < 0.24 || pv > 0.88;
          const inForestU = pu >= 0.46 && pu <= 0.66;
          const inForestV = pv >= 0.46 && pv <= 0.66;
          const inCreamU = Math.abs(pu - 0.35) < 0.022 || Math.abs(pu - 0.77) < 0.018;
          const inCreamV = Math.abs(pv - 0.35) < 0.022 || Math.abs(pv - 0.77) < 0.018;

          let cr = 136;
          let cg = 30;
          let cb = 34;

          if (inNavyU && inNavyV) {
            cr = 18;
            cg = 28;
            cb = 48;
          } else if (inNavyU || inNavyV) {
            cr = lerp(cr, 24, 0.62);
            cg = lerp(cg, 38, 0.62);
            cb = lerp(cb, 62, 0.62);
          }

          if (inForestU && inForestV) {
            cr = 22;
            cg = 52;
            cb = 34;
          } else if (inForestU || inForestV) {
            cr = lerp(cr, 28, 0.56);
            cg = lerp(cg, 64, 0.56);
            cb = lerp(cb, 42, 0.56);
          }

          if (inCreamU || inCreamV) {
            const pin = inCreamU && inCreamV ? 0.92 : 0.74;
            cr = lerp(cr, 212, pin);
            cg = lerp(cg, 188, pin);
            cb = lerp(cb, 146, pin);
          }

          const fuzz = 0.88 + nf * 0.16 + (weave - 0.5) * 0.18;
          r = cr * fuzz;
          g = cg * fuzz;
          b = cb * fuzz;
          rough = lerp(0.95, 0.82, weave);
          h = weave * 0.55 + fine * 0.25 + nf * 0.2;
        } else if (type === 'emeraldCloth') {
          // Deep emerald woodland wool-linen herringbone weave
          const herring = Math.sin((u * 42 + ((y & 4) ? v * 30 : -v * 30)) * Math.PI) * 0.5 + 0.5;
          const tone = clamp(nf * 0.52 + herring * 0.32 + fine * 0.16, 0, 1);
          r = lerp(16, 36, tone);
          g = lerp(68, 118, tone);
          b = lerp(48, 80, tone);
          rough = lerp(0.92, 0.74, tone);
          h = herring * 0.5 + nf * 0.3 + fine * 0.2;
        } else if (type === 'archerPants') {
          const twill = Math.sin(((x * 2 + y) / size) * Math.PI * 36) * 0.5 + 0.5;
          const tone = clamp(nf * 0.55 + twill * 0.3 + fine * 0.15, 0, 1);
          r = lerp(38, 62, tone);
          g = lerp(46, 68, tone);
          b = lerp(38, 54, tone);
          rough = lerp(0.88, 0.72, tone);
          h = twill * 0.45 + nf * 0.35 + fine * 0.2;
        } else if (type === 'hexCarbon') {
          // True hexagonal matte carbon-fiber micro-weave
          const scaleX = 12.0;
          const scaleY = 12.0 * 0.8660254;
          const gx = u * scaleX;
          const gy = v * scaleY;
          const row = Math.floor(gy);
          const fx = (gx + (row & 1 ? 0.5 : 0.0)) % 1.0;
          const fy = gy - row;
          const dx = Math.abs(fx - 0.5);
          const dy = Math.abs(fy - 0.5);
          const hexDist = Math.max(dx * 1.1547, dx * 0.57735 + dy);
          const cellGroove = smoothstep(0.41, 0.5, hexDist);
          const fiber = Math.sin((u * 80 + v * 80) * Math.PI) * 0.5 + 0.5;
          const shade = (1.0 - cellGroove * 0.55) * (0.85 + fiber * 0.15 + nf * 0.12);
          r = lerp(22, 48, shade);
          g = lerp(28, 56, shade);
          b = lerp(34, 66, shade);
          rough = lerp(0.38, 0.72, cellGroove * 0.65 + (1 - fiber) * 0.35);
          h = (1.0 - cellGroove) * 0.75 + fiber * 0.15 + nf * 0.1;
        } else if (type === 'techSlate') {
          // Ripstop micro-grid technical slate fabric
          const grid = ((x % 8 === 0) || (y % 8 === 0)) ? 0.85 : 0.35;
          const tone = clamp(nf * 0.5 + grid * 0.3 + fine * 0.2, 0, 1);
          r = lerp(38, 66, tone);
          g = lerp(44, 74, tone);
          b = lerp(54, 88, tone);
          rough = lerp(0.84, 0.62, tone);
          h = grid * 0.55 + nf * 0.3 + fine * 0.15;
        } else if (type === 'indigoCloth') {
          // Deep Japanese indigo sashiko woven cotton/linen with subtle vertical slub threads
          const warp = Math.sin(u * size * Math.PI * 0.85) * 0.5 + 0.5;
          const weft = Math.sin(v * size * Math.PI * 0.85) * 0.5 + 0.5;
          const slub = Math.sin((v * 26 + nf * 1.8) * Math.PI) * 0.5 + 0.5;
          const weave = warp * 0.45 + weft * 0.4 + slub * 0.15;
          const tone = clamp(nf * 0.52 + weave * 0.33 + fine * 0.15, 0, 1);
          r = lerp(20, 44, tone);
          g = lerp(34, 64, tone);
          b = lerp(64, 114, tone);
          rough = lerp(0.94, 0.76, tone);
          h = weave * 0.55 + nf * 0.3 + fine * 0.15;
        } else if (type === 'hakama') {
          // Dark charcoal-indigo heavy pleated hakama cloth with crisp vertical grain
          const vGrain = Math.sin(u * size * Math.PI * 1.1) * 0.5 + 0.5;
          const hGrain = Math.sin(v * size * Math.PI * 0.7) * 0.5 + 0.5;
          const tone = clamp(nf * 0.48 + vGrain * 0.34 + hGrain * 0.18, 0, 1);
          r = lerp(22, 42, tone);
          g = lerp(26, 48, tone);
          b = lerp(38, 68, tone);
          rough = lerp(0.90, 0.72, tone);
          h = vGrain * 0.52 + hGrain * 0.28 + nf * 0.2;
        } else if (type === 'obiBrocade') {
          // Woven crimson-gold diamond geometric brocade sash
          const du = Math.abs(((u * 6.0) % 1.0) - 0.5);
          const dv = Math.abs(((v * 6.0) % 1.0) - 0.5);
          const diamond = smoothstep(0.28, 0.36, du + dv) - smoothstep(0.42, 0.48, du + dv);
          const silk = ((x + y) & 1) ? 0.65 : 0.45;
          const baseTone = 0.8 + nf * 0.2;
          r = lerp(112 * baseTone, 206, diamond * 0.85);
          g = lerp(28 * baseTone, 166, diamond * 0.85);
          b = lerp(30 * baseTone, 76, diamond * 0.85);
          rough = lerp(0.76, 0.42, diamond * 0.7 + silk * 0.3);
          h = diamond * 0.6 + silk * 0.25 + nf * 0.15;
        } else if (type === 'bambooWeave') {
          // Interlocking woven golden-tan bamboo straw strips (for kasa hat & waraji)
          const stripU = Math.sin(u * Math.PI * 28.0);
          const stripV = Math.sin(v * Math.PI * 22.0);
          const over = (((Math.floor(u * 14) + Math.floor(v * 11)) & 1) === 0);
          const basket = over ? (stripU * 0.5 + 0.5) * 0.8 + 0.2 : (stripV * 0.5 + 0.5) * 0.7 + 0.15;
          const patina = clamp(basket * 0.58 + nf * 0.28 + fine * 0.14, 0, 1);
          r = lerp(138, 212, patina);
          g = lerp(112, 180, patina);
          b = lerp(66, 118, patina);
          rough = lerp(0.92, 0.72, patina);
          h = basket * 0.72 + fine * 0.18 + nf * 0.1;
        } else if (type === 'woodOak') {
          const ring = Math.sin((u * 14.0 + nf * 2.5) * Math.PI) * 0.5 + 0.5;
          const tone = clamp(ring * 0.55 + nf * 0.3 + fine * 0.15, 0, 1);
          r = lerp(132, 188, tone);
          g = lerp(94, 146, tone);
          b = lerp(56, 94, tone);
          rough = lerp(0.72, 0.46, tone);
          h = ring * 0.55 + fine * 0.25 + nf * 0.2;
        }

        diffBuf[pIdx] = clamp(Math.round(r), 0, 255);
        diffBuf[pIdx + 1] = clamp(Math.round(g), 0, 255);
        diffBuf[pIdx + 2] = clamp(Math.round(b), 0, 255);
        diffBuf[pIdx + 3] = 255;

        const rv = clamp(Math.round(rough * 255), 0, 255);
        roughBuf[pIdx] = rv;
        roughBuf[pIdx + 1] = rv;
        roughBuf[pIdx + 2] = rv;
        roughBuf[pIdx + 3] = 255;

        heightBuf[idx] = h;
      }
    }

    const normStrength =
      type === 'leather' || type === 'embossedLeather'
        ? 1.85
        : type === 'hexCarbon' || type === 'bambooWeave'
          ? 2.0
          : type === 'skin'
            ? 0.42
            : type === 'hair'
              ? 1.65
              : 1.3;
    const normBuf = this._buildSobelNormalBuffer(heightBuf, size, normStrength);

    return {
      map: this._bufferToTexture(diffBuf, size, { isSRGB: true, repeatX, repeatY }),
      normalMap: this._bufferToTexture(normBuf, size, { isSRGB: false, repeatX, repeatY }),
      roughnessMap: this._bufferToTexture(roughBuf, size, { isSRGB: false, repeatX, repeatY }),
    };
  }

  /**
   * High-detail procedural eyeball texture customized per character iris palette.
   */
  _generateEyeTexture(size = 128, style = 'hazel-blue') {
    const rng = createRng(this._seed + 888);
    const noise = createNoise2D(rng);
    const buf = new Uint8Array(size * size * 4);

    const palettes = {
      'hazel-blue': { inR: 144, inG: 118, inB: 64, outR: 52, outG: 114, outB: 144 },
      'emerald-amber': { inR: 168, inG: 132, inB: 52, outR: 38, outG: 138, outB: 82 },
      'ice-cyan': { inR: 130, inG: 215, inB: 235, outR: 36, outG: 148, outB: 192 },
      'obsidian-amber': { inR: 126, inG: 78, inB: 42, outR: 42, outG: 30, outB: 24 },
    };
    const pal = palettes[style] || palettes['hazel-blue'];

    for (let y = 0; y < size; y++) {
      const v = 1.0 - y / (size - 1);
      const polarAngle = (1.0 - v) * Math.PI;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const ang = u * Math.PI * 2;
        const idx = (y * size + x) * 4;

        let r = 238;
        let g = 234;
        let b = 228;

        const backTint = smoothstep(0.45, 1.35, polarAngle);
        r = lerp(r, 206, backTint);
        g = lerp(g, 184, backTint);
        b = lerp(b, 178, backTint);

        if (polarAngle < 0.47) {
          const irisT = clamp(polarAngle / 0.43, 0, 1);
          const fiber = noise(Math.cos(ang) * 9.5, Math.sin(ang) * 9.5) * 0.5 + 0.5;
          const radialStreak = Math.sin(ang * 24.0 + fiber * 3.5) * 0.5 + 0.5;
          const ring = noise(Math.cos(ang) * 3.2 + irisT * 4.2, Math.sin(ang) * 3.2) * 0.5 + 0.5;

          const ir = lerp(pal.inR, pal.outR, smoothstep(0.24, 0.78, irisT)) + (fiber - 0.5) * 34 + (radialStreak - 0.5) * 14;
          const ig = lerp(pal.inG, pal.outG, smoothstep(0.24, 0.82, irisT)) + (ring - 0.5) * 28 + (radialStreak - 0.5) * 12;
          const ib = lerp(pal.inB, pal.outB, smoothstep(0.20, 0.76, irisT)) + (fiber - 0.5) * 32;

          const limbal = smoothstep(0.74, 0.98, irisT);
          const irisEdge = 1.0 - smoothstep(0.92, 1.04, polarAngle / 0.44);

          const fr = lerp(ir, 18, limbal * 0.84);
          const fg = lerp(ig, 28, limbal * 0.84);
          const fb = lerp(ib, 38, limbal * 0.84);

          r = lerp(r, fr, irisEdge);
          g = lerp(g, fg, irisEdge);
          b = lerp(b, fb, irisEdge);

          const pupil = 1.0 - smoothstep(0.15, 0.188, polarAngle);
          r = lerp(r, 8, pupil);
          g = lerp(g, 9, pupil);
          b = lerp(b, 12, pupil);

          const px = Math.sin(polarAngle) * Math.cos(ang);
          const py = Math.sin(polarAngle) * Math.sin(ang);
          const mainGlint = Math.exp(-(((px - 0.12) ** 2 + (py - 0.14) ** 2) / 0.0022));
          const subGlint = Math.exp(-(((px + 0.14) ** 2 + (py + 0.12) ** 2) / 0.0009)) * 0.65;
          const glint = clamp(mainGlint + subGlint, 0, 1);
          r = lerp(r, 255, glint * 0.9);
          g = lerp(g, 255, glint * 0.92);
          b = lerp(b, 255, glint * 0.95);
        }

        buf[idx] = clamp(Math.round(r), 0, 255);
        buf[idx + 1] = clamp(Math.round(g), 0, 255);
        buf[idx + 2] = clamp(Math.round(b), 0, 255);
        buf[idx + 3] = 255;
      }
    }

    return this._bufferToTexture(buf, size, { isSRGB: true, repeatX: 1, repeatY: 1 });
  }

  /**
   * Procedural crisp white Japanese circular family crest (mon) texture for Kenji's haori coat.
   */
  _generateMonCrestTexture(size = 128) {
    const buf = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const ny = (y / (size - 1)) * 2 - 1;
      for (let x = 0; x < size; x++) {
        const nx = (x / (size - 1)) * 2 - 1;
        const r = Math.hypot(nx, ny);
        const outerRing = smoothstep(0.72, 0.76, r) * (1.0 - smoothstep(0.86, 0.90, r));
        // Inner triple-diamond / pine-wave crest emblem
        const dTop = Math.abs(nx) * 1.15 + Math.abs(ny + 0.24) * 1.45;
        const dBL = Math.abs(nx + 0.24) * 1.2 + Math.abs(ny - 0.18) * 1.45;
        const dBR = Math.abs(nx - 0.24) * 1.2 + Math.abs(ny - 0.18) * 1.45;
        const tri =
          (1.0 - smoothstep(0.24, 0.28, dTop)) +
          (1.0 - smoothstep(0.22, 0.26, dBL)) +
          (1.0 - smoothstep(0.22, 0.26, dBR));
        const alpha = clamp(Math.max(outerRing, tri), 0.0, 1.0);
        const idx = (y * size + x) * 4;
        buf[idx] = 242;
        buf[idx + 1] = 240;
        buf[idx + 2] = 232;
        buf[idx + 3] = Math.round(alpha * 255);
      }
    }
    return this._bufferToTexture(buf, size, { isSRGB: true, repeatX: 1, repeatY: 1, clampEdge: true });
  }

  // ---------------------------------------------------------------------------
  // Custom Three.js r187 onBeforeCompile Shaders (Skin SSS, Wetness, Cloth Wave)
  // ---------------------------------------------------------------------------

  _applySkinShader(material) {
    const uniforms = this.shaderUniforms;
    material.customProgramCacheKey = () => `charSkinSSS_Sweat_v3_${this.id}`;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        attribute float aSweatMask;
        varying float vSweatMask;
        varying vec3 vSkinWorldNormal;
        varying vec3 vSkinLocalPos;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSweatMask = aSweatMask;
        vSkinWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
        vSkinLocalPos = position;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uSweatLevel;
        uniform float uRainWetness;
        uniform float uFaceFlush;
        varying float vSweatMask;
        varying vec3 vSkinWorldNormal;
        varying vec3 vSkinLocalPos;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float flushWeight = clamp( uFaceFlush * vSweatMask * 0.58, 0.0, 0.65 );
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.22, 0.78, 0.74 ), flushWeight );
        float skinDamp = clamp( max( uSweatLevel * vSweatMask, uRainWetness * 0.65 ), 0.0, 1.0 );
        diffuseColor.rgb *= mix( 1.0, 0.90, skinDamp * 0.6 );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float sweatSheen = clamp( max( uSweatLevel * vSweatMask, uRainWetness * ( 0.4 + 0.6 * saturate( vSkinWorldNormal.y ) ) ), 0.0, 1.0 );
        roughnessFactor = mix( roughnessFactor, 0.13, sweatSheen * 0.86 );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          float ndotv = saturate( dot( geometryNormal, geometryViewDir ) );
          float rimSSS = pow( 1.0 - ndotv, 2.35 );
          vec3 lightEnergy = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
          float lum = clamp( dot( lightEnergy, vec3( 0.299, 0.587, 0.114 ) ), 0.0, 1.6 );
          vec3 sssTint = vec3( 0.52, 0.17, 0.085 );
          reflectedLight.indirectDiffuse += sssTint * rimSSS * ( 0.18 + lum * 0.45 );

          float sheenAmt = clamp( max( uSweatLevel * vSweatMask, uRainWetness * 0.55 ), 0.0, 1.0 );
          float bead = 0.75 + 0.25 * sin( vSkinLocalPos.x * 420.0 + vSkinLocalPos.z * 310.0 ) * cos( vSkinLocalPos.y * 420.0 );
          float fresnel = pow( 1.0 - ndotv, 3.2 );
          reflectedLight.indirectSpecular += vec3( 0.14, 0.135, 0.13 ) * fresnel * sheenAmt * bead * ( 0.25 + lum * 0.75 );
        }`
      );
    };
  }

  _applyWetnessShader(material, { useLegHeight = true, rainWeight = 1.0, darken = 0.52, wetRoughness = 0.16, keyTag = 'cloth' } = {}) {
    const uniforms = this.shaderUniforms;
    const rwStr = rainWeight.toFixed(3);
    const dkStr = darken.toFixed(3);
    const wrStr = wetRoughness.toFixed(3);

    material.customProgramCacheKey = () => `charWetness_v3_${keyTag}_${useLegHeight ? 1 : 0}_${rwStr}`;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        attribute float aLegHeight;
        varying float vLegHeight;
        varying vec3 vWetWorldNormal;
        varying vec3 vWetLocalPos;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vLegHeight = aLegHeight;
        vWetWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
        vWetLocalPos = position;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uLegWetness;
        uniform float uRainWetness;
        varying float vLegHeight;
        varying vec3 vWetWorldNormal;
        varying vec3 vWetLocalPos;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float organicWave = sin( vWetLocalPos.x * 42.0 + vWetLocalPos.z * 36.0 ) * 0.025 + cos( vWetLocalPos.z * 68.0 - vWetLocalPos.x * 29.0 ) * 0.015;
        float legWetMask = 0.0;
        ${
          useLegHeight
            ? `if ( uLegWetness > 0.001 ) {
                 float wetReach = mix( 0.06, 0.72, uLegWetness );
                 legWetMask = ( 1.0 - smoothstep( wetReach - 0.16, wetReach + 0.06, vLegHeight + organicWave ) ) * smoothstep( 0.0, 0.08, uLegWetness );
               }`
            : ''
        }
        float topExposure = 0.34 + 0.66 * smoothstep( -0.25, 0.68, vWetWorldNormal.y );
        float rainWetMask = clamp( uRainWetness * ${rwStr} * topExposure, 0.0, 1.0 );
        float combinedWet = clamp( max( legWetMask, rainWetMask ), 0.0, 1.0 );
        diffuseColor.rgb *= mix( 1.0, ${dkStr}, combinedWet );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, ${wrStr}, combinedWet * 0.86 );`
      );
    };
  }

  /**
   * Real GPU vertex cloth-wave shader (anchored strictly where aClothPin == 0.0 at shoulders/waist,
   * billowing & rippling smoothly with uClothTime, uClothWind, and uClothSpeed) combined with wetness.
   */
  _applyClothWaveShader(
    material,
    {
      useLegHeight = false,
      rainWeight = 1.0,
      darken = 0.54,
      wetRoughness = 0.22,
      ampZ = 0.048,
      ampX = 0.022,
      billowScale = 1.0,
      keyTag = 'cloakWave',
    } = {}
  ) {
    const uniforms = this.shaderUniforms;
    const rwStr = rainWeight.toFixed(3);
    const dkStr = darken.toFixed(3);
    const wrStr = wetRoughness.toFixed(3);
    const azStr = ampZ.toFixed(4);
    const axStr = ampX.toFixed(4);
    const bsStr = billowScale.toFixed(3);

    material.customProgramCacheKey = () =>
      `charClothWave_v3_${keyTag}_${useLegHeight ? 1 : 0}_${azStr}_${bsStr}`;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        attribute float aLegHeight;
        attribute float aClothPin;
        uniform float uClothTime;
        uniform float uClothWind;
        uniform float uClothSpeed;
        varying float vLegHeight;
        varying vec3 vWetWorldNormal;
        varying vec3 vWetLocalPos;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float pin = clamp( aClothPin, 0.0, 1.0 );
          if ( pin > 0.001 ) {
            float t = uClothTime;
            float spd = clamp( uClothSpeed, 0.0, 12.0 );
            float wnd = clamp( uClothWind, 0.0, 3.5 );
            float energy = 0.35 + wnd * 0.78 + spd * 0.30;
            float phaseA = t * ( 3.4 + wnd * 1.65 + spd * 0.88 ) - position.y * 7.2 + position.x * 5.8;
            float phaseB = t * ( 6.1 + wnd * 2.45 + spd * 1.25 ) - position.y * 12.5 - position.x * 9.2;
            float waveZ = ( sin( phaseA ) * 0.68 + sin( phaseB ) * 0.32 ) * ${azStr} * energy;
            float waveX = cos( phaseA * 0.85 + 0.9 ) * ${axStr} * energy;
            float billowBack = -clamp( spd * 0.022 + wnd * 0.020, 0.0, 0.25 ) * ${bsStr};
            float billowLift = clamp( spd * 0.011 + wnd * 0.009, 0.0, 0.14 ) * ${bsStr};
            transformed.z += ( waveZ + billowBack ) * pin;
            transformed.x += waveX * pin;
            transformed.y += ( abs( waveZ ) * 0.24 + billowLift ) * pin;
          }
        }
        vLegHeight = aLegHeight;
        vWetWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
        vWetLocalPos = position;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uLegWetness;
        uniform float uRainWetness;
        varying float vLegHeight;
        varying vec3 vWetWorldNormal;
        varying vec3 vWetLocalPos;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float organicWave = sin( vWetLocalPos.x * 42.0 + vWetLocalPos.z * 36.0 ) * 0.025 + cos( vWetLocalPos.z * 68.0 - vWetLocalPos.x * 29.0 ) * 0.015;
        float legWetMask = 0.0;
        ${
          useLegHeight
            ? `if ( uLegWetness > 0.001 ) {
                 float wetReach = mix( 0.06, 0.72, uLegWetness );
                 legWetMask = ( 1.0 - smoothstep( wetReach - 0.16, wetReach + 0.06, vLegHeight + organicWave ) ) * smoothstep( 0.0, 0.08, uLegWetness );
               }`
            : ''
        }
        float topExposure = 0.34 + 0.66 * smoothstep( -0.25, 0.68, vWetWorldNormal.y );
        float rainWetMask = clamp( uRainWetness * ${rwStr} * topExposure, 0.0, 1.0 );
        float combinedWet = clamp( max( legWetMask, rainWetMask ), 0.0, 1.0 );
        diffuseColor.rgb *= mix( 1.0, ${dkStr}, combinedWet );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, ${wrStr}, combinedWet * 0.86 );`
      );
    };
  }

  // ---------------------------------------------------------------------------
  // Character-Specific PBR Material Assembly
  // ---------------------------------------------------------------------------

  _buildMaterials() {
    this.mats = {};

    // 1. Common anatomical skin, eyes, hair, metals & base leather
    const skinTex = this._generatePBRTextureSet('skin', 128, 55, 1.6, 1.6);
    const hairTex = this._generatePBRTextureSet('hair', 128, 77, 2.0, 1.6);
    const eyeMap = this._generateEyeTexture(128, this._cfg.eyeStyle);

    this.mats.skin = this._trackMat(
      new THREE.MeshStandardMaterial({
        map: skinTex.map,
        normalMap: skinTex.normalMap,
        normalScale: new THREE.Vector2(0.35, 0.35),
        roughnessMap: skinTex.roughnessMap,
        roughness: 0.92,
        metalness: 0.0,
      })
    );
    this._applySkinShader(this.mats.skin);

    this.mats.lips = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: this._cfg.lipColor,
        roughness: 0.38,
        metalness: 0.0,
      })
    );
    this._applySkinShader(this.mats.lips);

    // Subtle warm lip shadow tone (blends softly with lips so no harsh dark mustache line appears!)
    this.mats.mouthCrease = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x8e4c44,
        roughness: 0.68,
        metalness: 0.0,
      })
    );

    this.mats.mouthCavity = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x260d0e,
        roughness: 0.85,
        metalness: 0.0,
      })
    );

    this.mats.eye = this._trackMat(
      new THREE.MeshStandardMaterial({
        map: eyeMap,
        roughness: 0.04,
        metalness: 0.05,
      })
    );

    this.mats.eyeCatchlight = this._trackMat(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.94,
        depthWrite: false,
      })
    );

    this.mats.hair = this._trackMat(
      new THREE.MeshStandardMaterial({
        map: hairTex.map,
        normalMap: hairTex.normalMap,
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughnessMap: hairTex.roughnessMap,
        roughness: 0.80,
        metalness: 0.04,
      })
    );
    this._applyWetnessShader(this.mats.hair, {
      useLegHeight: false,
      rainWeight: 0.95,
      darken: 0.62,
      wetRoughness: 0.22,
      keyTag: 'hair',
    });

    this.mats.lash = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x1e140e,
        roughness: 0.72,
        metalness: 0.0,
      })
    );

    this.mats.brass = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xd8b15c,
        roughness: 0.22,
        metalness: 0.9,
      })
    );

    this.mats.rubber = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x1b1a19,
        roughness: 0.84,
        metalness: 0.02,
      })
    );
    this._applyWetnessShader(this.mats.rubber, {
      useLegHeight: true,
      rainWeight: 0.8,
      darken: 0.65,
      wetRoughness: 0.14,
      keyTag: 'rubber',
    });

    // 2. Preset-specific PBR textures & materials
    if (this.id === 'liam') {
      const jacketTex = this._generatePBRTextureSet('jacket', 128, 11, 2.2, 2.2);
      const pantsTex = this._generatePBRTextureSet('pants', 128, 22, 2.4, 2.8);
      const leatherTex = this._generatePBRTextureSet('leather', 128, 33, 1.8, 1.8);
      const packTex = this._generatePBRTextureSet('pack', 128, 44, 2.0, 2.0);
      const blanketTex = this._generatePBRTextureSet('blanket', 128, 66, 2.0, 1.4);
      const flannelTex = this._generatePBRTextureSet('flannel', 128, 88, 1.8, 1.8);

      this.mats.jacket = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: jacketTex.map,
          normalMap: jacketTex.normalMap,
          normalScale: new THREE.Vector2(0.85, 0.85),
          roughnessMap: jacketTex.roughnessMap,
          roughness: 0.95,
          metalness: 0.02,
        })
      );
      this._applyWetnessShader(this.mats.jacket, {
        useLegHeight: false,
        rainWeight: 1.05,
        darken: 0.54,
        wetRoughness: 0.2,
        keyTag: 'jacket',
      });

      this.mats.jacketTrim = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x2e392d,
          normalMap: jacketTex.normalMap,
          normalScale: new THREE.Vector2(0.65, 0.65),
          roughness: 0.78,
          metalness: 0.02,
        })
      );
      this._applyWetnessShader(this.mats.jacketTrim, {
        useLegHeight: false,
        rainWeight: 1.0,
        darken: 0.56,
        wetRoughness: 0.22,
        keyTag: 'jacketTrim',
      });

      this.mats.stitching = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x9b865c,
          roughness: 0.85,
          metalness: 0.0,
        })
      );

      this.mats.flannel = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: flannelTex.map,
          normalMap: flannelTex.normalMap,
          normalScale: new THREE.Vector2(0.75, 0.75),
          roughnessMap: flannelTex.roughnessMap,
          roughness: 0.95,
          metalness: 0.0,
        })
      );
      this._applyWetnessShader(this.mats.flannel, {
        useLegHeight: false,
        rainWeight: 0.78,
        darken: 0.56,
        wetRoughness: 0.3,
        keyTag: 'flannel',
      });
      this.mats.shirt = this.mats.flannel;

      this.mats.pants = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: pantsTex.map,
          normalMap: pantsTex.normalMap,
          normalScale: new THREE.Vector2(0.75, 0.75),
          roughnessMap: pantsTex.roughnessMap,
          roughness: 0.96,
          metalness: 0.0,
        })
      );
      this._applyWetnessShader(this.mats.pants, {
        useLegHeight: true,
        rainWeight: 0.9,
        darken: 0.48,
        wetRoughness: 0.18,
        keyTag: 'pants',
      });

      this.mats.pantsReinforced = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x433f36,
          normalMap: pantsTex.normalMap,
          normalScale: new THREE.Vector2(0.8, 0.8),
          roughness: 0.88,
          metalness: 0.0,
        })
      );
      this._applyWetnessShader(this.mats.pantsReinforced, {
        useLegHeight: true,
        rainWeight: 0.9,
        darken: 0.48,
        wetRoughness: 0.18,
        keyTag: 'pantsReinf',
      });

      this.mats.leather = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: leatherTex.map,
          normalMap: leatherTex.normalMap,
          normalScale: new THREE.Vector2(0.95, 0.95),
          roughnessMap: leatherTex.roughnessMap,
          roughness: 0.88,
          metalness: 0.04,
        })
      );
      this._applyWetnessShader(this.mats.leather, {
        useLegHeight: true,
        rainWeight: 0.95,
        darken: 0.52,
        wetRoughness: 0.12,
        keyTag: 'leather',
      });

      this.mats.darkLeather = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x3b2416,
          normalMap: leatherTex.normalMap,
          normalScale: new THREE.Vector2(0.75, 0.75),
          roughness: 0.56,
          metalness: 0.05,
        })
      );
      this._applyWetnessShader(this.mats.darkLeather, {
        useLegHeight: true,
        rainWeight: 0.9,
        darken: 0.55,
        wetRoughness: 0.14,
        keyTag: 'darkLeather',
      });

      this.mats.laces = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xb89662,
          roughness: 0.86,
          metalness: 0.0,
        })
      );

      this.mats.pack = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: packTex.map,
          normalMap: packTex.normalMap,
          normalScale: new THREE.Vector2(0.9, 0.9),
          roughnessMap: packTex.roughnessMap,
          roughness: 0.96,
          metalness: 0.0,
        })
      );
      this._applyWetnessShader(this.mats.pack, {
        useLegHeight: false,
        rainWeight: 1.05,
        darken: 0.54,
        wetRoughness: 0.24,
        keyTag: 'pack',
      });

      this.mats.blanket = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: blanketTex.map,
          normalMap: blanketTex.normalMap,
          normalScale: new THREE.Vector2(0.85, 0.85),
          roughnessMap: blanketTex.roughnessMap,
          roughness: 0.98,
          metalness: 0.0,
        })
      );
      this._applyWetnessShader(this.mats.blanket, {
        useLegHeight: false,
        rainWeight: 1.05,
        darken: 0.58,
        wetRoughness: 0.34,
        keyTag: 'blanket',
      });

      this.mats.aluminum = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xcbd2d8,
          roughness: 0.28,
          metalness: 0.88,
        })
      );
    } else if (this.id === 'lyra') {
      const emeraldTex = this._generatePBRTextureSet('emeraldCloth', 128, 13, 2.2, 2.2);
      const pantsTex = this._generatePBRTextureSet('archerPants', 128, 29, 2.2, 2.6);
      const embLeatherTex = this._generatePBRTextureSet('embossedLeather', 128, 41, 2.0, 2.0);
      const woodTex = this._generatePBRTextureSet('woodOak', 64, 61, 1.5, 2.0);

      this.mats.tunic = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: emeraldTex.map,
          normalMap: emeraldTex.normalMap,
          normalScale: new THREE.Vector2(0.85, 0.85),
          roughnessMap: emeraldTex.roughnessMap,
          roughness: 0.94,
          metalness: 0.03,
        })
      );
      this._applyWetnessShader(this.mats.tunic, {
        useLegHeight: true,
        rainWeight: 1.0,
        darken: 0.52,
        wetRoughness: 0.22,
        keyTag: 'lyraTunic',
      });

      // Billowing emerald cloak with custom GPU vertex cloth-wave shader!
      this.mats.cloak = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: emeraldTex.map,
          normalMap: emeraldTex.normalMap,
          normalScale: new THREE.Vector2(0.9, 0.9),
          roughnessMap: emeraldTex.roughnessMap,
          color: 0xdff6e8,
          roughness: 0.92,
          metalness: 0.02,
          side: THREE.DoubleSide,
        })
      );
      this._applyClothWaveShader(this.mats.cloak, {
        useLegHeight: false,
        rainWeight: 1.08,
        darken: 0.5,
        wetRoughness: 0.2,
        ampZ: 0.056,
        ampX: 0.028,
        billowScale: 1.15,
        keyTag: 'lyraCloak',
      });

      // Gold embroidered border on cloak (same GPU cloth-wave displacement so border stays locked!)
      this.mats.cloakGoldTrim = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xdcb44e,
          roughness: 0.34,
          metalness: 0.72,
          side: THREE.DoubleSide,
        })
      );
      this._applyClothWaveShader(this.mats.cloakGoldTrim, {
        useLegHeight: false,
        rainWeight: 0.9,
        darken: 0.62,
        wetRoughness: 0.18,
        ampZ: 0.056,
        ampX: 0.028,
        billowScale: 1.15,
        keyTag: 'lyraCloakGold',
      });

      // Hood cowl & tunic gold embroidery trim (non-wave)
      this.mats.hood = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: emeraldTex.map,
          normalMap: emeraldTex.normalMap,
          normalScale: new THREE.Vector2(0.85, 0.85),
          color: 0xd2eedd,
          roughness: 0.9,
          metalness: 0.02,
          side: THREE.DoubleSide,
        })
      );
      this._applyWetnessShader(this.mats.hood, {
        useLegHeight: false,
        rainWeight: 1.05,
        darken: 0.52,
        wetRoughness: 0.22,
        keyTag: 'lyraHood',
      });

      this.mats.goldTrim = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xe0b954,
          roughness: 0.3,
          metalness: 0.78,
        })
      );

      this.mats.pants = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: pantsTex.map,
          normalMap: pantsTex.normalMap,
          normalScale: new THREE.Vector2(0.7, 0.7),
          roughnessMap: pantsTex.roughnessMap,
          roughness: 0.92,
          metalness: 0.0,
        })
      );
      this._applyWetnessShader(this.mats.pants, {
        useLegHeight: true,
        rainWeight: 0.9,
        darken: 0.48,
        wetRoughness: 0.18,
        keyTag: 'lyraPants',
      });

      this.mats.leather = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: embLeatherTex.map,
          normalMap: embLeatherTex.normalMap,
          normalScale: new THREE.Vector2(1.05, 1.05),
          roughnessMap: embLeatherTex.roughnessMap,
          roughness: 0.86,
          metalness: 0.05,
        })
      );
      this._applyWetnessShader(this.mats.leather, {
        useLegHeight: true,
        rainWeight: 0.95,
        darken: 0.52,
        wetRoughness: 0.14,
        keyTag: 'lyraLeather',
      });

      this.mats.darkLeather = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x3b2414,
          normalMap: embLeatherTex.normalMap,
          normalScale: new THREE.Vector2(0.8, 0.8),
          roughness: 0.55,
          metalness: 0.05,
        })
      );
      this._applyWetnessShader(this.mats.darkLeather, {
        useLegHeight: true,
        rainWeight: 0.9,
        darken: 0.55,
        wetRoughness: 0.14,
        keyTag: 'lyraDarkLeather',
      });

      this.mats.laces = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xcba666,
          roughness: 0.82,
          metalness: 0.0,
        })
      );

      this.mats.arrowShaft = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: woodTex.map,
          normalMap: woodTex.normalMap,
          roughness: 0.65,
          metalness: 0.0,
        })
      );

      this.mats.fletchCream = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xe8e0cc,
          roughness: 0.84,
          side: THREE.DoubleSide,
        })
      );

      this.mats.fletchEmerald = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x22845a,
          roughness: 0.8,
          side: THREE.DoubleSide,
        })
      );

      this.mats.fletchCrimson = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xa83232,
          roughness: 0.8,
          side: THREE.DoubleSide,
        })
      );
    } else if (this.id === 'kael') {
      const hexTex = this._generatePBRTextureSet('hexCarbon', 128, 17, 3.0, 3.0);
      const slateTex = this._generatePBRTextureSet('techSlate', 128, 31, 2.4, 2.8);

      this.mats.carbon = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: hexTex.map,
          normalMap: hexTex.normalMap,
          normalScale: new THREE.Vector2(1.1, 1.1),
          roughnessMap: hexTex.roughnessMap,
          roughness: 0.72,
          metalness: 0.28,
        })
      );
      this._applyWetnessShader(this.mats.carbon, {
        useLegHeight: true,
        rainWeight: 1.0,
        darken: 0.62,
        wetRoughness: 0.12,
        keyTag: 'kaelCarbon',
      });

      this.mats.carbonMatte = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x1d232b,
          normalMap: hexTex.normalMap,
          normalScale: new THREE.Vector2(0.75, 0.75),
          roughness: 0.64,
          metalness: 0.24,
        })
      );
      this._applyWetnessShader(this.mats.carbonMatte, {
        useLegHeight: true,
        rainWeight: 0.95,
        darken: 0.65,
        wetRoughness: 0.14,
        keyTag: 'kaelMatte',
      });

      this.mats.techPants = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: slateTex.map,
          normalMap: slateTex.normalMap,
          normalScale: new THREE.Vector2(0.85, 0.85),
          roughnessMap: slateTex.roughnessMap,
          roughness: 0.88,
          metalness: 0.08,
        })
      );
      this._applyWetnessShader(this.mats.techPants, {
        useLegHeight: true,
        rainWeight: 0.95,
        darken: 0.54,
        wetRoughness: 0.16,
        keyTag: 'kaelPants',
      });

      this.mats.titanium = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x8998a8,
          roughness: 0.28,
          metalness: 0.86,
        })
      );

      // Glowing HDR cyan luminous exo-trim strips & kinetic shoe sole lightbars (triggers subtle bloom!)
      this.mats.cyanGlow = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x14505e,
          emissive: new THREE.Color(0x00e8ff),
          emissiveIntensity: 2.25,
          roughness: 0.18,
          metalness: 0.1,
        })
      );

      // Translucent cyan-tinted forehead visor lens
      this.mats.visorGlass = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x18e0ff,
          emissive: new THREE.Color(0x00c8f0),
          emissiveIntensity: 0.72,
          roughness: 0.06,
          metalness: 0.22,
          transparent: true,
          opacity: 0.56,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );

      this.mats.shoeMesh = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x26303d,
          normalMap: slateTex.normalMap,
          normalScale: new THREE.Vector2(0.7, 0.7),
          roughness: 0.62,
          metalness: 0.12,
        })
      );
      this._applyWetnessShader(this.mats.shoeMesh, {
        useLegHeight: true,
        rainWeight: 0.9,
        darken: 0.58,
        wetRoughness: 0.14,
        keyTag: 'kaelShoe',
      });
    } else if (this.id === 'kenji') {
      const indigoTex = this._generatePBRTextureSet('indigoCloth', 128, 19, 2.2, 2.2);
      const hakamaTex = this._generatePBRTextureSet('hakama', 128, 37, 2.6, 2.6);
      const obiTex = this._generatePBRTextureSet('obiBrocade', 128, 53, 2.4, 1.0);
      const bambooTex = this._generatePBRTextureSet('bambooWeave', 128, 71, 2.6, 2.6);
      const oakTex = this._generatePBRTextureSet('woodOak', 128, 83, 1.8, 1.8);
      const crestTex = this._generateMonCrestTexture(128);

      this.mats.kosode = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x1a2234,
          normalMap: indigoTex.normalMap,
          normalScale: new THREE.Vector2(0.7, 0.7),
          roughness: 0.88,
          metalness: 0.0,
        })
      );
      this._applyWetnessShader(this.mats.kosode, {
        useLegHeight: false,
        rainWeight: 0.9,
        darken: 0.52,
        wetRoughness: 0.22,
        keyTag: 'kenjiKosode',
      });

      this.mats.juban = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xe6e0d2,
          normalMap: indigoTex.normalMap,
          normalScale: new THREE.Vector2(0.45, 0.45),
          roughness: 0.86,
          metalness: 0.0,
        })
      );

      // Deep-indigo haori coat with subtle cloth-flutter GPU shader
      this.mats.haori = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: indigoTex.map,
          normalMap: indigoTex.normalMap,
          normalScale: new THREE.Vector2(0.88, 0.88),
          roughnessMap: indigoTex.roughnessMap,
          roughness: 0.94,
          metalness: 0.02,
          side: THREE.DoubleSide,
        })
      );
      this._applyClothWaveShader(this.mats.haori, {
        useLegHeight: false,
        rainWeight: 1.05,
        darken: 0.52,
        wetRoughness: 0.2,
        ampZ: 0.024,
        ampX: 0.014,
        billowScale: 0.45,
        keyTag: 'kenjiHaori',
      });

      // Crisp white circular mon family crest decal material
      this.mats.monCrest = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: crestTex,
          color: 0xffffff,
          transparent: true,
          alphaTest: 0.35,
          roughness: 0.72,
          metalness: 0.0,
          side: THREE.DoubleSide,
        })
      );

      // Flowing dark pleated hakama trousers (with leg wetness + subtle hem cloth flutter!)
      this.mats.hakama = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: hakamaTex.map,
          normalMap: hakamaTex.normalMap,
          normalScale: new THREE.Vector2(0.85, 0.85),
          roughnessMap: hakamaTex.roughnessMap,
          roughness: 0.94,
          metalness: 0.02,
        })
      );
      this._applyClothWaveShader(this.mats.hakama, {
        useLegHeight: true,
        rainWeight: 0.95,
        darken: 0.48,
        wetRoughness: 0.18,
        ampZ: 0.016,
        ampX: 0.012,
        billowScale: 0.25,
        keyTag: 'kenjiHakama',
      });

      this.mats.obi = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: obiTex.map,
          normalMap: obiTex.normalMap,
          normalScale: new THREE.Vector2(0.85, 0.85),
          roughnessMap: obiTex.roughnessMap,
          roughness: 0.78,
          metalness: 0.12,
        })
      );
      this._applyWetnessShader(this.mats.obi, {
        useLegHeight: false,
        rainWeight: 0.85,
        darken: 0.56,
        wetRoughness: 0.22,
        keyTag: 'kenjiObi',
      });

      this.mats.bamboo = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: bambooTex.map,
          normalMap: bambooTex.normalMap,
          normalScale: new THREE.Vector2(1.15, 1.15),
          roughnessMap: bambooTex.roughnessMap,
          roughness: 0.92,
          metalness: 0.0,
          side: THREE.DoubleSide,
        })
      );
      this._applyWetnessShader(this.mats.bamboo, {
        useLegHeight: true,
        rainWeight: 1.0,
        darken: 0.58,
        wetRoughness: 0.24,
        keyTag: 'kenjiBamboo',
      });

      this.mats.cord = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x8e2428,
          roughness: 0.78,
          metalness: 0.0,
        })
      );

      this.mats.kyahan = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xd9d2c4,
          normalMap: indigoTex.normalMap,
          normalScale: new THREE.Vector2(0.6, 0.6),
          roughness: 0.9,
          metalness: 0.0,
        })
      );
      this._applyWetnessShader(this.mats.kyahan, {
        useLegHeight: true,
        rainWeight: 0.95,
        darken: 0.52,
        wetRoughness: 0.22,
        keyTag: 'kenjiKyahan',
      });

      this.mats.tabi = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x262932,
          roughness: 0.88,
          metalness: 0.0,
        })
      );
      this._applyWetnessShader(this.mats.tabi, {
        useLegHeight: true,
        rainWeight: 0.9,
        darken: 0.5,
        wetRoughness: 0.2,
        keyTag: 'kenjiTabi',
      });

      this.mats.bokkenWood = this._trackMat(
        new THREE.MeshStandardMaterial({
          map: oakTex.map,
          normalMap: oakTex.normalMap,
          normalScale: new THREE.Vector2(0.8, 0.8),
          roughnessMap: oakTex.roughnessMap,
          roughness: 0.58,
          metalness: 0.02,
        })
      );

      this.mats.lacquer = this._trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x1a0b0e,
          roughness: 0.16,
          metalness: 0.18,
        })
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Complete Articulated THREE.Bone + THREE.Skeleton Hierarchy
  // ---------------------------------------------------------------------------

  _addBone(name, parent, x, y, z) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    parent.add(bone);
    this.bones[name] = bone;
    this._boneIndex[name] = this._boneList.length;
    this._boneList.push(bone);
    return bone;
  }

  _buildSkeletonHierarchy() {
    const clavX = this._cfg.clavX;
    const upperArmOffsetX = this._cfg.shoulderX - clavX;

    // 1. Core torso chain
    const hips = this._addBone('hips', this.root, 0, 0.94, 0);
    const spine1 = this._addBone('spine1', hips, 0, 0.11, 0);
    const spine2 = this._addBone('spine2', spine1, 0, 0.14, 0);
    const chest = this._addBone('chest', spine2, 0, 0.16, 0);

    // 2. Secondary physics spring bones
    const backpack = this._addBone('backpack', chest, 0, 0.04, -0.17);
    if (this._cfg.canteenOnHip) {
      // Mounted at LEFT hip (+X) for Kenji's swinging bokken & lacquered scabbard
      this._addBone('canteen', hips, 0.168, 0.015, -0.015);
    } else {
      this._addBone('canteen', backpack, -0.17, -0.14, -0.02);
    }
    this._addBone('jacketHem', spine1, 0, -0.26, 0);
    // Cloak upper-back pivot on chest (drives Lyra's emerald cloak & available on all rigs)
    this._addBone('cloak', chest, 0, 0.135, -0.125);

    // 3. Neck & expressive head hierarchy
    const neck = this._addBone('neck', chest, 0, 0.17, 0.01);
    const head = this._addBone('head', neck, 0, 0.09, 0.015);

    // First-Person Body-Cam anchor (Object3D at eye bridge)
    const eyeTarget = new THREE.Object3D();
    eyeTarget.name = 'eyeTarget';
    eyeTarget.position.set(0, 0.055, 0.10);
    head.add(eyeTarget);
    this.bones.eyeTarget = eyeTarget;
    this.eyeTarget = eyeTarget;

    // Facial articulation bones
    this._addBone('jaw', head, 0, -0.042, 0.035);
    this._addBone('eyeL', head, 0.034, 0.048, 0.095);
    this._addBone('eyeR', head, -0.034, 0.048, 0.095);
    this._addBone('upperLidL', head, 0.034, 0.048, 0.095);
    this._addBone('upperLidR', head, -0.034, 0.048, 0.095);
    this._addBone('lowerLidL', head, 0.034, 0.048, 0.095);
    this._addBone('lowerLidR', head, -0.034, 0.048, 0.095);
    this._addBone('browL', head, 0.035, 0.072, 0.103);
    this._addBone('browR', head, -0.035, 0.072, 0.103);

    // Swaying front/crown hair locks spring bone (registered in headMeshes for FP Body-Cam)
    const hairLocks = this._addBone('hairLocks', head, 0, 0.135, 0.038);
    this.headMeshes.push(hairLocks);

    // 4. Left & Right arm chains (+X = Left, -X = Right) with 5-finger articulated hands
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const clav = this._addBone(`clavicle${side}`, chest, s * clavX, 0.13, 0);
      const upperArm = this._addBone(`upperArm${side}`, clav, s * upperArmOffsetX, -0.01, 0);
      const forearm = this._addBone(`forearm${side}`, upperArm, 0, -0.28, 0);
      const wrist = this._addBone(`wrist${side}`, forearm, 0, -0.25, 0);
      const hand = this._addBone(`hand${side}`, wrist, 0, -0.01, 0);

      const thumb = this._addBone(`thumb${side}`, hand, -s * 0.008, -0.028, 0.032);
      this._addBone(`thumbTip${side}`, thumb, 0, -0.033, 0.002);

      const fingers = this._addBone(`fingers${side}`, hand, 0, -0.076, 0.004);
      const fingerSpecs = [
        { name: 'index', y: 0.001, z: 0.029, proxLen: 0.036 },
        { name: 'middle', y: -0.001, z: 0.010, proxLen: 0.041 },
        { name: 'ring', y: 0.0, z: -0.009, proxLen: 0.038 },
        { name: 'pinky', y: 0.004, z: -0.026, proxLen: 0.030 },
      ];
      for (const f of fingerSpecs) {
        const prox = this._addBone(`${f.name}${side}`, fingers, 0, f.y, f.z);
        this._addBone(`${f.name}Tip${side}`, prox, 0, -f.proxLen, 0);
      }
    }

    // 5. Left & Right leg chains (+X = Left, -X = Right) — exact IK metrics across all 4 rigs
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const thigh = this._addBone(`thigh${side}`, hips, s * 0.105, -0.02, 0);
      thigh.rotation.order = 'ZXY';
      const shin = this._addBone(`shin${side}`, thigh, 0, -0.44, 0);
      const ankle = this._addBone(`ankle${side}`, shin, 0, -0.42, 0);
      this._addBone(`toe${side}`, ankle, 0, -0.045, 0.115);
    }
  }

  // ---------------------------------------------------------------------------
  // Anatomical Skinning Weight Functions (Cosine / Smoothstep Blended, Sum = 1.0)
  // ---------------------------------------------------------------------------

  _computeSpineWeights(x, y, _z, { includeClavicles = true, includeJacketHem = false } = {}) {
    const bi = this._boneIndex;
    const inf = [];

    if (includeJacketHem && y < 0.99) {
      const wHem = cosBlend((0.99 - y) / 0.21);
      if (wHem > 0.001) {
        inf.push({ boneIdx: bi.jacketHem, weight: wHem });
      }
      const wBase = 1.0 - wHem;
      if (wBase > 0.001) {
        const tS1 = cosBlend((y - 0.92) / 0.13);
        inf.push({ boneIdx: bi.hips, weight: wBase * (1.0 - tS1) });
        inf.push({ boneIdx: bi.spine1, weight: wBase * tS1 });
      }
      return inf;
    }

    if (y <= 0.94) {
      inf.push({ boneIdx: bi.hips, weight: 1.0 });
    } else if (y <= 1.05) {
      const t = cosBlend((y - 0.94) / 0.11);
      inf.push({ boneIdx: bi.hips, weight: 1.0 - t });
      inf.push({ boneIdx: bi.spine1, weight: t });
    } else if (y <= 1.19) {
      const t = cosBlend((y - 1.05) / 0.14);
      inf.push({ boneIdx: bi.spine1, weight: 1.0 - t });
      inf.push({ boneIdx: bi.spine2, weight: t });
    } else if (y <= 1.35) {
      const t = cosBlend((y - 1.19) / 0.16);
      inf.push({ boneIdx: bi.spine2, weight: 1.0 - t });
      inf.push({ boneIdx: bi.chest, weight: t });
    } else if (y <= 1.505) {
      let wChest = 1.0;
      if (includeClavicles && Math.abs(x) > 0.075 && y > 1.37) {
        const lat = cosBlend((Math.abs(x) - 0.075) / 0.105);
        const vert = cosBlend((y - 1.37) / 0.10);
        const wClav = lat * vert * 0.55;
        wChest -= wClav;
        inf.push({ boneIdx: x >= 0 ? bi.clavicleL : bi.clavicleR, weight: wClav });
      }
      inf.push({ boneIdx: bi.chest, weight: wChest });
    } else if (y <= 1.565) {
      if (Math.abs(x) < 0.085) {
        const t = cosBlend((y - 1.505) / 0.06);
        inf.push({ boneIdx: bi.chest, weight: 1.0 - t });
        inf.push({ boneIdx: bi.neck, weight: t });
      } else {
        const wClav = includeClavicles ? 0.45 : 0.0;
        inf.push({ boneIdx: bi.chest, weight: 1.0 - wClav });
        if (wClav > 0) inf.push({ boneIdx: x >= 0 ? bi.clavicleL : bi.clavicleR, weight: wClav });
      }
    } else {
      const t = cosBlend((y - 1.565) / 0.055);
      inf.push({ boneIdx: bi.neck, weight: 1.0 - t });
      inf.push({ boneIdx: bi.head, weight: t });
    }

    return inf;
  }

  _computeArmWeights(side, x, y, _z, shoulderFrac) {
    const bi = this._boneIndex;
    const clavIdx = side === 'L' ? bi.clavicleL : bi.clavicleR;
    const upperIdx = side === 'L' ? bi.upperArmL : bi.upperArmR;
    const foreIdx = side === 'L' ? bi.forearmL : bi.forearmR;
    const wristIdx = side === 'L' ? bi.wristL : bi.wristR;

    // Shoulder junction transition (shoulderFrac: 0 = armhole rim on torso -> 1 = pure upperArm)
    if (shoulderFrac < 0.999) {
      const torsoInf = this._computeSpineWeights(x, y, _z, { includeClavicles: true });
      const blendArm = cosBlend(shoulderFrac);
      const topBias = cosBlend((y - 1.36) / 0.13);
      const wClavExtra = (1.0 - blendArm) * blendArm * 1.15 * topBias;
      const wTorso = Math.max(0.0, (1.0 - blendArm) * (1.0 - wClavExtra));
      const wUpper = Math.max(0.0, blendArm * (1.0 - wClavExtra * 0.4));

      const out = [];
      for (let i = 0; i < torsoInf.length; i++) {
        out.push({ boneIdx: torsoInf[i].boneIdx, weight: torsoInf[i].weight * wTorso });
      }
      if (wClavExtra > 0.001) out.push({ boneIdx: clavIdx, weight: wClavExtra });
      if (wUpper > 0.001) out.push({ boneIdx: upperIdx, weight: wUpper });
      return out;
    }

    // Upper arm -> Elbow (centered at y = 1.19, +/- 0.06m smooth cosine band) -> Forearm -> Wrist (y = 0.94)
    if (y >= 1.25) {
      return [{ boneIdx: upperIdx, weight: 1.0 }];
    }
    if (y >= 1.13) {
      const wFore = cosBlend((1.25 - y) / 0.12);
      return [
        { boneIdx: upperIdx, weight: 1.0 - wFore },
        { boneIdx: foreIdx, weight: wFore },
      ];
    }
    if (y >= 0.985) {
      return [{ boneIdx: foreIdx, weight: 1.0 }];
    }
    const wWrist = cosBlend((0.985 - y) / 0.05);
    return [
      { boneIdx: foreIdx, weight: 1.0 - wWrist * 0.85 },
      { boneIdx: wristIdx, weight: wWrist * 0.85 },
    ];
  }

  _computeLowerBodyWeights(side, x, y, _z) {
    const bi = this._boneIndex;
    const hipsIdx = bi.hips;
    const spine1Idx = bi.spine1;

    // Waist & upper pelvis
    if (y >= 0.96) {
      const wSpine1 = cosBlend((y - 0.96) / 0.09) * 0.55;
      return [
        { boneIdx: hipsIdx, weight: 1.0 - wSpine1 },
        { boneIdx: spine1Idx, weight: wSpine1 },
      ];
    }

    // Pelvis-to-hip socket transition band (y = 0.96 down to 0.78)
    if (side === 'pelvis' || y >= 0.78) {
      const vFrac = cosBlend((0.96 - y) / 0.18);
      if (side === 'pelvis') {
        const absX = Math.abs(x);
        const lat = cosBlend((absX - 0.025) / 0.11);
        const legIdx = x >= 0 ? bi.thighL : bi.thighR;
        const wLeg = vFrac * lat * 0.45;
        return [
          { boneIdx: hipsIdx, weight: 1.0 - wLeg },
          { boneIdx: legIdx, weight: wLeg },
        ];
      }

      const thighIdx = side === 'L' ? bi.thighL : bi.thighR;
      const otherThighIdx = side === 'L' ? bi.thighR : bi.thighL;
      const absX = Math.abs(x);
      // Centerline crotch seam keeps smooth hips anchor so big strides never pinch
      const centerProtect = 1.0 - cosBlend(absX / 0.055);
      const yBelowCrotch = cosBlend((0.865 - y) / 0.085);
      const wThigh = lerp(vFrac * (1.0 - centerProtect * 0.72), 1.0, yBelowCrotch);
      const wHips = Math.max(0.0, 1.0 - wThigh);
      const wOther = centerProtect * (1.0 - yBelowCrotch) * 0.08;
      return [
        { boneIdx: thighIdx, weight: Math.max(0.0, wThigh - wOther * 0.5) },
        { boneIdx: hipsIdx, weight: Math.max(0.0, wHips - wOther * 0.5) },
        { boneIdx: otherThighIdx, weight: wOther },
      ];
    }

    const thighIdx = side === 'L' ? bi.thighL : bi.thighR;
    const shinIdx = side === 'L' ? bi.shinL : bi.shinR;
    const ankleIdx = side === 'L' ? bi.ankleL : bi.ankleR;

    // Mid thigh
    if (y >= 0.55) {
      return [{ boneIdx: thighIdx, weight: 1.0 }];
    }
    // Knee deformation band (centered at shin.y = 0.48, +/- 0.07m)
    if (y >= 0.41) {
      const wShin = cosBlend((0.55 - y) / 0.14);
      return [
        { boneIdx: thighIdx, weight: 1.0 - wShin },
        { boneIdx: shinIdx, weight: wShin },
      ];
    }
    // Mid shin / calf
    if (y >= 0.13) {
      return [{ boneIdx: shinIdx, weight: 1.0 }];
    }
    // Ankle deformation band (centered near ankle.y = 0.06)
    const wAnkle = cosBlend((0.13 - y) / 0.075);
    return [
      { boneIdx: shinIdx, weight: 1.0 - wAnkle },
      { boneIdx: ankleIdx, weight: wAnkle },
    ];
  }

  _computeFootwearWeights(side, _x, y, z) {
    const bi = this._boneIndex;
    const shinIdx = side === 'L' ? bi.shinL : bi.shinR;
    const ankleIdx = side === 'L' ? bi.ankleL : bi.ankleR;
    const toeIdx = side === 'L' ? bi.toeL : bi.toeR;

    // Upper shaft blends smoothly into shin bone
    if (y > 0.072) {
      const wShin = cosBlend((y - 0.072) / 0.085);
      return [
        { boneIdx: ankleIdx, weight: 1.0 - wShin },
        { boneIdx: shinIdx, weight: wShin },
      ];
    }
    // Forefoot toe-flex bend band centered around toe bone z = 0.115
    if (z > 0.082) {
      const wToe = cosBlend((z - 0.082) / 0.062);
      return [
        { boneIdx: ankleIdx, weight: 1.0 - wToe },
        { boneIdx: toeIdx, weight: wToe },
      ];
    }
    return [{ boneIdx: ankleIdx, weight: 1.0 }];
  }

  // ---------------------------------------------------------------------------
  // Continuous Watertight Upper Body + Shoulders + Arms SkinnedMesh Builder
  // ---------------------------------------------------------------------------

  _buildContinuousUpperBody(spec) {
    const ws = this._cfg.waistScale;
    const cs = this._cfg.chestScale;
    const as = this._cfg.armScale;
    const shX = this._cfg.shoulderX;

    // 16 vertical rings from pelvis tuck (0.88) -> chest (1.365) -> armhole (1.32..1.495) -> neck (1.61)
    const torsoRings = [
      { y: 0.88, rx: 0.148 * ws, rz: 0.104 * ws, sq: 0.22, mat: 0 },
      { y: 0.94, rx: 0.152 * ws, rz: 0.107 * ws, sq: 0.24, mat: 0 },
      { y: 1.00, rx: 0.150 * ws, rz: 0.105 * ws, sq: 0.24, mat: 0 },
      { y: 1.05, rx: 0.149 * ws, rz: 0.105 * ws, sq: 0.24, mat: 0 },
      { y: 1.12, rx: 0.157 * cs, rz: 0.110 * cs, sq: 0.25, mat: 0 },
      { y: 1.19, rx: 0.168 * cs, rz: 0.117 * cs, frontScale: 1.06, sq: 0.27, mat: 0 },
      { y: 1.26, rx: 0.178 * cs, rz: 0.122 * cs, frontScale: 1.08, sq: 0.28, mat: 0 },
      // Armhole rows r = 7..11
      { y: 1.32, rx: 0.183 * cs, rz: 0.123 * cs, frontScale: 1.10, sq: 0.28, mat: 0 },
      { y: 1.365, rx: 0.188 * cs, rz: 0.124 * cs, frontScale: 1.11, sq: 0.30, mat: 0 },
      { y: 1.41, rx: 0.186 * cs, rz: 0.119 * cs, frontScale: 1.07, sq: 0.28, mat: 0 },
      { y: 1.455, rx: 0.176 * cs, rz: 0.111 * cs, frontScale: 1.03, sq: 0.25, mat: 0 },
      { y: 1.495, rx: 0.148 * cs, rz: 0.098 * cs, frontScale: 1.00, sq: 0.18, mat: 0 },
      // Trapezius -> collar -> sculpted skin neck
      { y: 1.522, rx: 0.082, rz: 0.074, oz: 0.005, mat: 0 },
      { y: 1.545, rx: 0.059, rz: 0.060, oz: 0.009, mat: 3 },
      { y: 1.578, rx: 0.056, rz: 0.058, oz: 0.013, mat: 3 },
      { y: 1.612, rx: 0.058, rz: 0.061, oz: 0.018, mat: 3 },
    ];

    const C = 32;
    const cols = C + 1;
    const R = torsoRings.length;
    const rArmBot = 7;
    const rArmTop = 11;

    const positions = [];
    const uvs = [];
    const skinIndices = [];
    const skinWeights = [];
    const legHeights = [];
    const sweatMasks = [];
    const clothPins = [];
    const matBuckets = new Map();

    const pushTri = (matIdx, i0, i1, i2) => {
      let b = matBuckets.get(matIdx);
      if (!b) {
        b = [];
        matBuckets.set(matIdx, b);
      }
      b.push(i0, i1, i2);
    };

    const addVert = (x, y, z, u, v, influences, sweat = 0.35) => {
      const idx = positions.length / 3;
      positions.push(x, y, z);
      uvs.push(u, v);
      const packed = packSkinWeights(influences, this._boneIndex.chest);
      skinIndices.push(packed.indices[0], packed.indices[1], packed.indices[2], packed.indices[3]);
      skinWeights.push(packed.weights[0], packed.weights[1], packed.weights[2], packed.weights[3]);
      legHeights.push(Math.max(0.0, y));
      sweatMasks.push(clamp(sweat, 0.0, 1.0));
      clothPins.push(0.0);
      return idx;
    };

    // Build torso grid vertices (rounding the 4 corners of each 4x4 armhole slightly into an oval!)
    const torsoVert = Array.from({ length: R }, () => new Int32Array(cols));
    for (let r = 0; r < R; r++) {
      const ring = torsoRings[r];
      const vFrac = r / (R - 1);
      const ox = ring.ox ?? 0;
      const oz = ring.oz ?? 0;
      const frontScale = ring.frontScale ?? 1.0;
      const backScale = ring.backScale ?? 1.0;
      const sq = ring.sq ?? 0.0;

      for (let c = 0; c <= C; c++) {
        // Skip interior vertices strictly inside the 4x4 armhole cutouts (never referenced by triangles)
        const inInteriorArmRow = r > rArmBot && r < rArmTop;
        const inInteriorHole = (c > 6 && c < 10) || (c > 22 && c < 26);
        if (inInteriorArmRow && inInteriorHole) {
          torsoVert[r][c] = -1;
          continue;
        }

        const uFrac = c / C;
        const theta = uFrac * Math.PI * 2;
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);
        let sx = sinT;
        let sz = cosT;
        if (sq > 0) {
          const p = 1.0 - sq * 0.35;
          sx = Math.sign(sinT) * Math.pow(Math.abs(sinT), p);
          sz = Math.sign(cosT) * Math.pow(Math.abs(cosT), p);
        }
        const zMult = sz >= 0 ? frontScale : backScale;
        let x = ox + sx * ring.rx;
        let y = ring.y;
        let z = oz + sz * ring.rz * zMult;

        // Round the 4 corner vertices of each armhole slightly inward toward armhole center for anatomical oval
        const isLeftCorner = (r === rArmBot || r === rArmTop) && (c === 6 || c === 10);
        const isRightCorner = (r === rArmBot || r === rArmTop) && (c === 22 || c === 26);
        if (isLeftCorner || isRightCorner) {
          const midY = (torsoRings[rArmBot].y + torsoRings[rArmTop].y) * 0.5;
          y = lerp(y, midY, 0.24);
          z *= 0.88;
        }

        const sweat = r >= 13 ? 0.55 + (z > 0 ? 0.18 : 0.0) : 0.32;
        const inf = this._computeSpineWeights(x, y, z, { includeClavicles: true });
        torsoVert[r][c] = addVert(x, y, z, uFrac * 1.6, vFrac * 1.2, inf, sweat);
      }
    }

    // Emit torso quads, skipping the 4x4 left & right armhole openings
    for (let r = 0; r < R - 1; r++) {
      const matIdx = torsoRings[r].mat;
      for (let c = 0; c < C; c++) {
        const inArmRow = r >= rArmBot && r < rArmTop;
        const inLeftHole = c >= 6 && c < 10;
        const inRightHole = c >= 22 && c < 26;
        if (inArmRow && (inLeftHole || inRightHole)) continue;

        const a = torsoVert[r][c];
        const b = torsoVert[r][c + 1];
        const d = torsoVert[r + 1][c];
        const e = torsoVert[r + 1][c + 1];
        pushTri(matIdx, a, b, e);
        pushTri(matIdx, a, e, d);
      }
    }

    // Bottom cap at pelvis base & top cap inside head
    const botCenter = addVert(0, torsoRings[0].y, 0, 0.5, 0, [{ boneIdx: this._boneIndex.hips, weight: 1.0 }]);
    for (let c = 0; c < C; c++) {
      pushTri(0, botCenter, torsoVert[0][c + 1], torsoVert[0][c]);
    }
    const topRing = torsoRings[R - 1];
    const topCenter = addVert(0, topRing.y, topRing.oz ?? 0, 0.5, 1, [{ boneIdx: this._boneIndex.head, weight: 1.0 }], 0.4);
    for (let c = 0; c < C; c++) {
      pushTri(3, topCenter, torsoVert[R - 1][c], torsoVert[R - 1][c + 1]);
    }

    // Extrude BOTH continuous 16-segment arms seamlessly from the torso armhole boundaries!
    // Left armhole boundary loop (CCW outward when extruding +X then -Y):
    const leftLoopCoords = [
      [11, 10], [11, 9], [11, 8], [11, 7],
      [11, 6], [10, 6], [9, 6], [8, 6],
      [7, 6], [7, 7], [7, 8], [7, 9],
      [7, 10], [8, 10], [9, 10], [10, 10],
    ];
    // Right armhole boundary loop (mirror-exact CCW outward when extruding -X then -Y):
    const rightLoopCoords = [
      [11, 26], [11, 25], [11, 24], [11, 23],
      [11, 22], [10, 22], [9, 22], [8, 22],
      [7, 22], [7, 23], [7, 24], [7, 25],
      [7, 26], [8, 26], [9, 26], [10, 26],
    ];

    // Arm profile rings from shoulder deltoid -> upper arm -> dense 5-ring elbow (1.19) -> forearm -> wrist (0.935)
    const armRingSpecs = spec.armRings || [
      // Shoulder curve-out rings (shoulderFrac transitions smoothly 0 -> 1)
      { y: 1.44, cx: shX * 0.90, rx: 0.068 * as, rz: 0.070 * as, tilt: 0.52, shFrac: 0.38, mat: 1 },
      { y: 1.41, cx: shX * 0.985, rx: 0.064 * as, rz: 0.066 * as, tilt: 0.82, shFrac: 0.72, mat: 1 },
      { y: 1.37, cx: shX, rx: 0.061 * as, rz: 0.062 * as, tilt: 1.0, shFrac: 0.96, mat: 1 },
      // Bicep & tricep
      { y: 1.315, cx: shX, rx: 0.056 * as, rz: 0.058 * as, shFrac: 1.0, mat: 1 },
      { y: 1.26, cx: shX, rx: 0.052 * as, rz: 0.054 * as, shFrac: 1.0, mat: 1 },
      // Dense 5-ring anatomical elbow bend zone centered at y = 1.19
      { y: 1.225, cx: shX, rx: 0.049 * as, rz: 0.050 * as, shFrac: 1.0, mat: 1 },
      { y: 1.205, cx: shX, rx: 0.047 * as, rz: 0.048 * as, shFrac: 1.0, mat: 1 },
      { y: 1.19, cx: shX, rx: 0.046 * as, rz: 0.047 * as, shFrac: 1.0, mat: 1 },
      { y: 1.17, cx: shX, rx: 0.047 * as, rz: 0.048 * as, shFrac: 1.0, mat: 1 },
      { y: 1.145, cx: shX, rx: 0.051 * as, rz: 0.051 * as, shFrac: 1.0, mat: 2 },
      // Forearm transition (cuff / bracer / sleeve -> lower forearm -> wrist)
      { y: 1.11, cx: shX, rx: 0.052 * as, rz: 0.052 * as, shFrac: 1.0, mat: 2 },
      { y: 1.085, cx: shX, rx: 0.044 * as, rz: 0.045 * as, shFrac: 1.0, mat: 3 },
      { y: 1.035, cx: shX, rx: 0.039 * as, rz: 0.041 * as, shFrac: 1.0, mat: 3 },
      { y: 0.985, cx: shX, rx: 0.034 * as, rz: 0.037 * as, shFrac: 1.0, mat: 3 },
      { y: 0.955, cx: shX, rx: 0.031 * as, rz: 0.035 * as, shFrac: 1.0, mat: 3 },
      { y: 0.935, cx: shX, rx: 0.029 * as, rz: 0.033 * as, shFrac: 1.0, mat: 3 },
    ];

    const N = 16;
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const loopCoords = side === 'L' ? leftLoopCoords : rightLoopCoords;

      // Capture exact 3D positions of Ring 0 (torso armhole boundary)
      const ring0Pts = [];
      const armRingsVerts = [];
      const row0 = new Int32Array(N + 1);
      for (let k = 0; k <= N; k++) {
        const [rIdx, cIdx] = loopCoords[k % N];
        const tv = torsoVert[rIdx][cIdx];
        const px = positions[tv * 3];
        const py = positions[tv * 3 + 1];
        const pz = positions[tv * 3 + 2];
        ring0Pts.push([px, py, pz]);
        // Duplicate vertex with arm UV while sharing exact 3D position + exact torso skin weights (welded normals!)
        const inf = this._computeSpineWeights(px, py, pz, { includeClavicles: true });
        row0[k] = addVert(px, py, pz, (k / N) * 1.2, 0.0, inf, 0.35);
      }
      armRingsVerts.push(row0);

      for (let a = 0; a < armRingSpecs.length; a++) {
        const ar = armRingSpecs[a];
        const row = new Int32Array(N + 1);
        const vCoord = ((a + 1) / armRingSpecs.length) * 1.4;
        const tilt = ar.tilt ?? 1.0;

        for (let k = 0; k <= N; k++) {
          const phi = ((k - 2) / N) * Math.PI * 2;
          const cosP = Math.cos(phi);
          const sinP = Math.sin(phi);

          // Pure horizontal downward arm cross-section around (s * ar.cx, ar.y, 0)
          const horizX = s * ar.cx + s * cosP * ar.rx;
          const horizY = ar.y + (ar.shFrac < 0.85 ? cosP * 0.032 * (1.0 - ar.shFrac) : 0);
          const horizZ = s * sinP * ar.rz;

          // Smoothly blend from the vertical oval armhole rim into the horizontal arm cylinder
          const base = ring0Pts[k % N];
          const px = lerp(base[0] + s * 0.028, horizX, tilt);
          const py = lerp(base[1] + 0.008, horizY, tilt);
          const pz = lerp(base[2], horizZ, tilt);

          const inf = this._computeArmWeights(side, px, py, pz, ar.shFrac);
          const sweat = ar.mat === 3 ? 0.45 : 0.30;
          row[k] = addVert(px, py, pz, (k / N) * 1.2, vCoord, inf, sweat);
        }
        armRingsVerts.push(row);
      }

      // Stitch continuous quads down the entire arm
      for (let a = 0; a < armRingsVerts.length - 1; a++) {
        const matIdx = a === 0 ? armRingSpecs[0].mat : armRingSpecs[a - 1].mat;
        const rA = armRingsVerts[a];
        const rB = armRingsVerts[a + 1];
        for (let k = 0; k < N; k++) {
          pushTri(matIdx, rA[k], rA[k + 1], rB[k + 1]);
          pushTri(matIdx, rA[k], rB[k + 1], rB[k]);
        }
      }

      // Close wrist cap cleanly at wrist joint
      const lastSpec = armRingSpecs[armRingSpecs.length - 1];
      const lastRow = armRingsVerts[armRingsVerts.length - 1];
      const wristCenter = addVert(
        s * lastSpec.cx,
        lastSpec.y - 0.004,
        0,
        0.5,
        1.5,
        [{ boneIdx: side === 'L' ? this._boneIndex.wristL : this._boneIndex.wristR, weight: 1.0 }],
        0.35
      );
      for (let k = 0; k < N; k++) {
        pushTri(lastSpec.mat, wristCenter, lastRow[k], lastRow[k + 1]);
      }
    }

    const geo = new THREE.BufferGeometry();
    const finalIndices = [];
    const sortedMats = Array.from(matBuckets.keys()).sort((a, b) => a - b);
    for (const mIdx of sortedMats) {
      const bucket = matBuckets.get(mIdx);
      if (!bucket.length) continue;
      const start = finalIndices.length;
      for (let i = 0; i < bucket.length; i++) finalIndices.push(bucket[i]);
      geo.addGroup(start, bucket.length, mIdx);
    }

    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    geo.setAttribute('aLegHeight', new THREE.Float32BufferAttribute(legHeights, 1));
    geo.setAttribute('aSweatMask', new THREE.Float32BufferAttribute(sweatMasks, 1));
    geo.setAttribute('aClothPin', new THREE.Float32BufferAttribute(clothPins, 1));
    geo.setIndex(finalIndices);
    geo.computeVertexNormals();
    weldBoundaryNormals(geo);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    this._trackGeo(geo);
    return this._createSkinnedMesh(geo, spec.materials, { name: `SkinnedUpperBody_${this.id}` });
  }

  // ---------------------------------------------------------------------------
  // Continuous Watertight Pelvis + Hips + Thighs + Knees + Shins SkinnedMesh
  // ---------------------------------------------------------------------------

  _buildContinuousLowerBody(spec) {
    const hs = this._cfg.hipScale;
    const ls = this._cfg.legScale;
    const hipX = this.metrics.hipOffsetX; // exact 0.105m for IK!
    const isHakama = Boolean(spec.isHakama);

    // Pelvis rings from waist top (1.02) down to crotch split ring (0.865)
    const pelvisRings = [
      { y: 1.02, rx: 0.156 * hs, rz: 0.111 * hs, backScale: 1.06, sq: 0.22 },
      { y: 0.98, rx: 0.163 * hs, rz: 0.115 * hs, backScale: 1.10, sq: 0.24 },
      { y: 0.94, rx: 0.168 * hs, rz: 0.118 * hs, backScale: 1.15, sq: 0.25 },
      { y: 0.90, rx: 0.169 * hs, rz: 0.119 * hs, backScale: 1.14, sq: 0.22 },
      { y: 0.865, rx: 0.164 * hs, rz: 0.114 * hs, backScale: 1.10, sq: 0.18 },
    ];

    const C = 32;
    const cols = C + 1;
    const positions = [];
    const uvs = [];
    const skinIndices = [];
    const skinWeights = [];
    const legHeights = [];
    const sweatMasks = [];
    const clothPins = [];
    const matBuckets = new Map();

    const pushTri = (matIdx, i0, i1, i2) => {
      let b = matBuckets.get(matIdx);
      if (!b) {
        b = [];
        matBuckets.set(matIdx, b);
      }
      b.push(i0, i1, i2);
    };

    const addVert = (x, y, z, u, v, influences, pin = 0.0) => {
      const idx = positions.length / 3;
      positions.push(x, y, z);
      uvs.push(u, v);
      const packed = packSkinWeights(influences, this._boneIndex.hips);
      skinIndices.push(packed.indices[0], packed.indices[1], packed.indices[2], packed.indices[3]);
      skinWeights.push(packed.weights[0], packed.weights[1], packed.weights[2], packed.weights[3]);
      legHeights.push(Math.max(0.0, y));
      sweatMasks.push(0.25);
      clothPins.push(clamp(pin, 0.0, 1.0));
      return idx;
    };

    // 1. Pelvis wall vertices
    const pVert = Array.from({ length: pelvisRings.length }, () => new Int32Array(cols));
    for (let r = 0; r < pelvisRings.length; r++) {
      const ring = pelvisRings[r];
      const vFrac = r / (pelvisRings.length - 1);
      for (let c = 0; c <= C; c++) {
        const uFrac = c / C;
        const theta = uFrac * Math.PI * 2;
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);
        const p = 1.0 - ring.sq * 0.35;
        const sx = Math.sign(sinT) * Math.pow(Math.abs(sinT), p);
        const sz = Math.sign(cosT) * Math.pow(Math.abs(cosT), p);
        const zMult = sz >= 0 ? 1.0 : ring.backScale;
        const pleat = isHakama ? 1.0 + 0.05 * Math.cos(theta * 10.0) * smoothstep(1.01, 0.87, ring.y) : 1.0;
        const x = sx * ring.rx * pleat;
        const z = sz * ring.rz * zMult * pleat;
        const inf = this._computeLowerBodyWeights('pelvis', x, ring.y, z);
        pVert[r][c] = addVert(x, ring.y, z, uFrac * 1.6, vFrac * 0.4, inf, 0.0);
      }
    }

    // Pelvis quads (rings descend in Y -> outward winding is (a, e, b), (a, d, e))
    for (let r = 0; r < pelvisRings.length - 1; r++) {
      for (let c = 0; c < C; c++) {
        const a = pVert[r][c];
        const b = pVert[r][c + 1];
        const d = pVert[r + 1][c];
        const e = pVert[r + 1][c + 1];
        pushTri(0, a, e, b);
        pushTri(0, a, d, e);
      }
    }

    // Top waist cap
    const waistCenter = addVert(0, pelvisRings[0].y, 0, 0.5, 0, [{ boneIdx: this._boneIndex.spine1, weight: 0.55 }, { boneIdx: this._boneIndex.hips, weight: 0.45 }]);
    for (let c = 0; c < C; c++) {
      pushTri(0, waistCenter, pVert[0][c], pVert[0][c + 1]);
    }

    // Shared 3-vertex anatomical inner-crotch bridge along x = 0
    const botIdx = pelvisRings.length - 1;
    const crotchFront = [0, 0.852, 0.056 * hs];
    const crotchMid = [0, 0.840, 0.0];
    const crotchBack = [0, 0.852, -0.058 * hs];

    const getPelvisBotPt = (cIdx) => {
      const vi = pVert[botIdx][cIdx % C];
      return [positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]];
    };

    // 2. Continuous 20-segment Left & Right legs bifurcating seamlessly from pelvis + crotch bridge!
    const legRingSpecs = spec.legRings || [
      { y: 0.815, rx: 0.090 * ls, rz: 0.094 * ls, blend: 0.58, mat: 0 },
      { y: 0.75, rx: 0.088 * ls, rz: 0.093 * ls, frontScale: 1.08, backScale: 1.08, mat: 0 },
      { y: 0.66, rx: 0.082 * ls, rz: 0.086 * ls, frontScale: 1.10, mat: 0 },
      { y: 0.57, rx: 0.073 * ls, rz: 0.077 * ls, frontScale: 1.06, mat: 0 },
      // Dense 5-ring anatomical knee deformation zone centered at shin.y = 0.48
      { y: 0.525, rx: 0.068 * ls, rz: 0.072 * ls, frontScale: 1.06, mat: 0 },
      { y: 0.50, rx: 0.065 * ls, rz: 0.069 * ls, frontScale: 1.08, mat: 0 },
      { y: 0.48, rx: 0.064 * ls, rz: 0.068 * ls, frontScale: 1.08, mat: 0 },
      { y: 0.455, rx: 0.065 * ls, rz: 0.069 * ls, backScale: 1.04, mat: 0 },
      { y: 0.42, rx: 0.066 * ls, rz: 0.071 * ls, backScale: 1.12, mat: 0 },
      // Sculpted calf / shin
      { y: 0.34, rx: 0.067 * ls, rz: 0.074 * ls, backScale: 1.20, mat: 0 },
      { y: 0.25, rx: 0.061 * ls, rz: 0.066 * ls, backScale: 1.12, mat: 0 },
      { y: 0.16, rx: 0.056 * ls, rz: 0.059 * ls, mat: 0 },
      { y: 0.105, rx: 0.054 * ls, rz: 0.056 * ls, mat: 0 },
      { y: 0.072, rx: 0.051 * ls, rz: 0.054 * ls, mat: 0 },
    ];

    const N = 20;
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;

      // Build exact 20-vertex top loop matching pelvis bottom + shared inner-crotch bridge
      const ring0Pts = [];
      if (side === 'L') {
        ring0Pts.push(getPelvisBotPt(0));
        ring0Pts.push(crotchFront);
        ring0Pts.push(crotchMid);
        ring0Pts.push(crotchBack);
        for (let c = 16; c >= 1; c--) ring0Pts.push(getPelvisBotPt(c));
      } else {
        ring0Pts.push(getPelvisBotPt(16));
        ring0Pts.push(crotchBack);
        ring0Pts.push(crotchMid);
        ring0Pts.push(crotchFront);
        ring0Pts.push(getPelvisBotPt(0));
        for (let c = 31; c >= 17; c--) ring0Pts.push(getPelvisBotPt(c));
      }

      const legVerts = [];
      const row0 = new Int32Array(N + 1);
      for (let k = 0; k <= N; k++) {
        const pt = ring0Pts[k % N];
        const inf = this._computeLowerBodyWeights(side, pt[0], pt[1], pt[2]);
        row0[k] = addVert(pt[0], pt[1], pt[2], (k / N) * 1.4, 0.4, inf, 0.0);
      }
      legVerts.push(row0);

      for (let r = 0; r < legRingSpecs.length; r++) {
        const lr = legRingSpecs[r];
        const row = new Int32Array(N + 1);
        const blend = lr.blend ?? 1.0;
        const vCoord = 0.4 + ((r + 1) / legRingSpecs.length) * 1.6;
        const fScale = lr.frontScale ?? 1.0;
        const bScale = lr.backScale ?? 1.0;
        const pleatAmp = lr.pleatAmp ?? 0.0;
        const clothPin = lr.clothPin ?? 0.0;

        for (let k = 0; k <= N; k++) {
          const alpha = side === 'L' ? ((k - 12) / N) * Math.PI * 2 : ((k - 2) / N) * Math.PI * 2;
          const cosA = Math.cos(alpha);
          const sinA = Math.sin(alpha);
          const zMult = sinA >= 0 ? fScale : bScale;
          // Deep crisp vertical box-pleat ridges on Kenji's hakama
          const pleat = pleatAmp > 0 ? 1.0 + pleatAmp * Math.cos(alpha * 7.0) : 1.0;

          const tx = s * hipX + cosA * lr.rx * pleat;
          const tz = sinA * lr.rz * zMult * pleat;
          const base = ring0Pts[k % N];
          const px = lerp(base[0], tx, blend);
          const py = lr.y;
          const pz = lerp(base[2], tz, blend);

          const inf = this._computeLowerBodyWeights(side, px, py, pz);
          row[k] = addVert(px, py, pz, (k / N) * 1.4, vCoord, inf, clothPin);
        }
        legVerts.push(row);
      }

      // Stitch continuous quads down the entire leg (outward CCW verified!)
      for (let r = 0; r < legVerts.length - 1; r++) {
        const matIdx = r === 0 ? legRingSpecs[0].mat : legRingSpecs[r - 1].mat;
        const rA = legVerts[r];
        const rB = legVerts[r + 1];
        for (let k = 0; k < N; k++) {
          pushTri(matIdx, rA[k], rA[k + 1], rB[k + 1]);
          pushTri(matIdx, rA[k], rB[k + 1], rB[k]);
        }
      }

      // Clean ankle bottom cap tucked inside boot collar
      const lastSpec = legRingSpecs[legRingSpecs.length - 1];
      const lastRow = legVerts[legVerts.length - 1];
      const ankCenter = addVert(
        s * hipX,
        lastSpec.y - 0.005,
        0,
        0.5,
        2.0,
        [{ boneIdx: side === 'L' ? this._boneIndex.ankleL : this._boneIndex.ankleR, weight: 1.0 }],
        0.0
      );
      for (let k = 0; k < N; k++) {
        pushTri(lastSpec.mat, ankCenter, lastRow[k], lastRow[k + 1]);
      }
    }

    const geo = new THREE.BufferGeometry();
    const finalIndices = [];
    const sortedMats = Array.from(matBuckets.keys()).sort((a, b) => a - b);
    for (const mIdx of sortedMats) {
      const bucket = matBuckets.get(mIdx);
      if (!bucket.length) continue;
      const start = finalIndices.length;
      for (let i = 0; i < bucket.length; i++) finalIndices.push(bucket[i]);
      geo.addGroup(start, bucket.length, mIdx);
    }

    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    geo.setAttribute('aLegHeight', new THREE.Float32BufferAttribute(legHeights, 1));
    geo.setAttribute('aSweatMask', new THREE.Float32BufferAttribute(sweatMasks, 1));
    geo.setAttribute('aClothPin', new THREE.Float32BufferAttribute(clothPins, 1));
    geo.setIndex(finalIndices);
    geo.computeVertexNormals();
    weldBoundaryNormals(geo);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    this._trackGeo(geo);
    return this._createSkinnedMesh(geo, spec.materials, { name: `SkinnedLowerBody_${this.id}` });
  }

  // ---------------------------------------------------------------------------
  // Continuous Skinned Footwear (Sole Strictly at y = 0.000!)
  // ---------------------------------------------------------------------------

  _buildContinuousSkinnedFootwear() {
    const hipX = this.metrics.hipOffsetX;

    if (this.id === 'liam') {
      const parts = [];
      const materials = [this.mats.leather, this.mats.darkLeather, this.mats.rubber, this.mats.brass, this.mats.laces];

      // Full continuous sole + vamp + collar built in root bind space (sole bottom at y = 0.000!)
      const soleGeo = this._createSculptedLoft(
        [
          { y: 0.000, rx: 0.058, rz: 0.132, oz: 0.048, frontScale: 1.08, backScale: 0.92, squareness: 0.45 },
          { y: 0.026, rx: 0.059, rz: 0.134, oz: 0.048, frontScale: 1.08, backScale: 0.92, squareness: 0.45 },
        ],
        22
      );
      const upperGeo = this._createSculptedLoft(
        [
          { y: 0.024, rx: 0.055, rz: 0.128, oz: 0.046, frontScale: 1.06, backScale: 0.92, squareness: 0.36 },
          { y: 0.048, rx: 0.052, rz: 0.106, oz: 0.032, frontScale: 1.15, backScale: 0.88, squareness: 0.28 },
          { y: 0.072, rx: 0.052, rz: 0.072, oz: 0.008, frontScale: 1.18, squareness: 0.22 },
          { y: 0.112, rx: 0.054, rz: 0.062, oz: -0.002, squareness: 0.18 },
          { y: 0.148, rx: 0.057, rz: 0.064, oz: -0.004, squareness: 0.16 },
        ],
        22
      );
      const collarGeo = this._trackGeo(new THREE.TorusGeometry(0.057, 0.013, 10, 18));
      collarGeo.rotateX(Math.PI / 2);
      collarGeo.scale(1.0, 1.0, 1.08);
      const toeCapGeo = this._trackGeo(
        new THREE.SphereGeometry(0.051, 14, 10, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.28, Math.PI * 0.42)
      );
      toeCapGeo.rotateY(Math.PI / 2);
      toeCapGeo.scale(1.04, 0.78, 1.12);
      const lugGeo = this._trackGeo(new THREE.BoxGeometry(0.098, 0.008, 0.018));
      const eyeletGeo = this._trackGeo(new THREE.TorusGeometry(0.0038, 0.0014, 6, 10));
      const laceGeo = this._trackGeo(new THREE.CylinderGeometry(0.0022, 0.0022, 0.058, 6));

      for (const side of ['L', 'R']) {
        const s = side === 'L' ? 1 : -1;
        const bx = s * hipX;
        parts.push({ geo: soleGeo, matIndex: 2, side, matrix: this._partTransform(bx, 0, 0) });
        parts.push({ geo: upperGeo, matIndex: 0, side, matrix: this._partTransform(bx, 0, 0) });
        parts.push({ geo: collarGeo, matIndex: 1, side, matrix: this._partTransform(bx, 0.148, -0.004) });
        parts.push({ geo: toeCapGeo, matIndex: 1, side, matrix: this._partTransform(bx, 0.028, 0.136) });

        for (const lz of [-0.045, -0.005, 0.036, 0.078, 0.118, 0.152]) {
          parts.push({ geo: lugGeo, matIndex: 2, side, matrix: this._partTransform(bx, 0.004, lz) });
        }

        for (let i = 0; i < 4; i++) {
          const ly = 0.064 + i * 0.022;
          const lz = 0.084 - i * 0.008;
          for (const es of [1, -1]) {
            parts.push({
              geo: eyeletGeo,
              matIndex: 3,
              side,
              matrix: this._partTransform(bx + es * 0.024, ly, lz, 0, es * 0.35, 0),
            });
          }
          for (const cs of [1, -1]) {
            parts.push({
              geo: laceGeo,
              matIndex: 4,
              side,
              matrix: this._partTransform(bx, ly + 0.008, lz + 0.004, 0, 0, Math.PI / 2 + cs * 0.34),
            });
          }
        }
      }

      const geo = this._mergeToSkinnedGeometry(parts, (x, y, z, part) => this._computeFootwearWeights(part.side, x, y, z));
      this._createSkinnedMesh(geo, materials, { name: 'SkinnedBoots_liam' });
    } else if (this.id === 'lyra') {
      // Sleek knee-high laced leather archer boots (sole strictly y = 0.000, laced shaft up to y = 0.42!)
      const parts = [];
      const materials = [this.mats.leather, this.mats.darkLeather, this.mats.rubber, this.mats.brass, this.mats.laces];

      const soleGeo = this._createSculptedLoft(
        [
          { y: 0.000, rx: 0.048, rz: 0.126, oz: 0.046, frontScale: 1.06, backScale: 0.90, squareness: 0.35 },
          { y: 0.020, rx: 0.049, rz: 0.128, oz: 0.046, frontScale: 1.06, backScale: 0.90, squareness: 0.35 },
        ],
        20
      );
      const vampGeo = this._createSculptedLoft(
        [
          { y: 0.018, rx: 0.047, rz: 0.124, oz: 0.045, frontScale: 1.04, backScale: 0.90, squareness: 0.28 },
          { y: 0.042, rx: 0.046, rz: 0.100, oz: 0.030, frontScale: 1.12, backScale: 0.88, squareness: 0.22 },
          { y: 0.072, rx: 0.049, rz: 0.064, oz: 0.005, frontScale: 1.14, squareness: 0.18 },
          { y: 0.14, rx: 0.053, rz: 0.056, oz: -0.002 },
          { y: 0.24, rx: 0.058, rz: 0.063, backScale: 1.14 },
          { y: 0.34, rx: 0.064, rz: 0.071, backScale: 1.18 },
          { y: 0.415, rx: 0.064, rz: 0.068, backScale: 1.08 },
        ],
        22
      );
      const foldCuffGeo = this._createSculptedLoft(
        [
          { y: 0.365, rx: 0.069, rz: 0.074, backScale: 1.12 },
          { y: 0.422, rx: 0.068, rz: 0.072, backScale: 1.08 },
        ],
        20,
        { capBottom: false, capTop: false }
      );
      const eyeletGeo = this._trackGeo(new THREE.TorusGeometry(0.0034, 0.0012, 6, 8));
      const laceGeo = this._trackGeo(new THREE.CylinderGeometry(0.002, 0.002, 0.052, 6));

      for (const side of ['L', 'R']) {
        const s = side === 'L' ? 1 : -1;
        const bx = s * hipX;
        parts.push({ geo: soleGeo, matIndex: 2, side, matrix: this._partTransform(bx, 0, 0) });
        parts.push({ geo: vampGeo, matIndex: 0, side, matrix: this._partTransform(bx, 0, 0) });
        parts.push({ geo: foldCuffGeo, matIndex: 1, side, matrix: this._partTransform(bx, 0, 0) });

        // Crisscrossed front archer boot lacing from instep all the way up the shin!
        for (let i = 0; i < 8; i++) {
          const ly = 0.068 + i * 0.036;
          const lz = i < 2 ? 0.076 - i * 0.008 : 0.059 + (i - 2) * 0.002;
          for (const es of [1, -1]) {
            parts.push({
              geo: eyeletGeo,
              matIndex: 3,
              side,
              matrix: this._partTransform(bx + es * 0.022, ly, lz, 0, es * 0.3, 0),
            });
          }
          for (const cs of [1, -1]) {
            parts.push({
              geo: laceGeo,
              matIndex: 4,
              side,
              matrix: this._partTransform(bx, ly + 0.01, lz + 0.004, 0, 0, Math.PI / 2 + cs * 0.36),
            });
          }
        }
      }

      const geo = this._mergeToSkinnedGeometry(parts, (x, y, z, part) => this._computeFootwearWeights(part.side, x, y, z));
      this._createSkinnedMesh(geo, materials, { name: 'SkinnedArcherBoots_lyra' });
    } else if (this.id === 'kael') {
      // Sleek illuminated kinetic running shoes with glowing HDR cyan sole lightbars (sole at y = 0.000!)
      const parts = [];
      const materials = [this.mats.shoeMesh, this.mats.carbonMatte, this.mats.rubber, this.mats.cyanGlow, this.mats.titanium];

      const outsoleGeo = this._createSculptedLoft(
        [
          { y: 0.000, rx: 0.055, rz: 0.132, oz: 0.048, frontScale: 1.08, backScale: 0.94, squareness: 0.42 },
          { y: 0.014, rx: 0.057, rz: 0.135, oz: 0.048, frontScale: 1.08, backScale: 0.94, squareness: 0.42 },
        ],
        22
      );
      // Glowing cyan midsole lightbar ring wrapping around the kinetic trainer!
      const lightbarGeo = this._createSculptedLoft(
        [
          { y: 0.014, rx: 0.058, rz: 0.136, oz: 0.048, frontScale: 1.08, backScale: 0.94, squareness: 0.40 },
          { y: 0.024, rx: 0.057, rz: 0.134, oz: 0.048, frontScale: 1.08, backScale: 0.94, squareness: 0.38 },
        ],
        22
      );
      const upperGeo = this._createSculptedLoft(
        [
          { y: 0.024, rx: 0.054, rz: 0.128, oz: 0.046, frontScale: 1.06, backScale: 0.92, squareness: 0.34 },
          { y: 0.046, rx: 0.049, rz: 0.104, oz: 0.032, frontScale: 1.12, backScale: 0.88, squareness: 0.25 },
          { y: 0.072, rx: 0.049, rz: 0.068, oz: 0.006, frontScale: 1.15, squareness: 0.2 },
          { y: 0.118, rx: 0.051, rz: 0.056, oz: -0.002 },
        ],
        22
      );
      const heelCageGeo = this._createOpenSculptedShell(
        [
          { y: 0.026, rx: 0.056, rz: 0.068, oz: -0.016, gapHalfAngle: 1.15 },
          { y: 0.075, rx: 0.053, rz: 0.062, oz: -0.012, gapHalfAngle: 1.32 },
        ],
        14,
        { thickness: 0.008 }
      );
      const techStrapGeo = this._trackGeo(new THREE.BoxGeometry(0.088, 0.012, 0.024));
      const sideGlowGeo = this._trackGeo(new THREE.BoxGeometry(0.006, 0.012, 0.082));

      for (const side of ['L', 'R']) {
        const s = side === 'L' ? 1 : -1;
        const bx = s * hipX;
        parts.push({ geo: outsoleGeo, matIndex: 2, side, matrix: this._partTransform(bx, 0, 0) });
        parts.push({ geo: lightbarGeo, matIndex: 3, side, matrix: this._partTransform(bx, 0, 0) });
        parts.push({ geo: upperGeo, matIndex: 0, side, matrix: this._partTransform(bx, 0, 0) });
        parts.push({ geo: heelCageGeo, matIndex: 1, side, matrix: this._partTransform(bx, 0, 0) });
        parts.push({ geo: techStrapGeo, matIndex: 1, side, matrix: this._partTransform(bx, 0.078, 0.056, 0.45, 0, 0) });
        parts.push({ geo: techStrapGeo, matIndex: 4, side, matrix: this._partTransform(bx, 0.058, 0.086, 0.35, 0, 0) });
        parts.push({ geo: sideGlowGeo, matIndex: 3, side, matrix: this._partTransform(bx + s * 0.055, 0.052, 0.042, 0.14, 0, 0) });
      }

      const geo = this._mergeToSkinnedGeometry(parts, (x, y, z, part) => this._computeFootwearWeights(part.side, x, y, z));
      this._createSkinnedMesh(geo, materials, { name: 'SkinnedKineticShoes_kael' });
    } else if (this.id === 'kenji') {
      // Strapped bamboo-straw waraji sandals over charcoal tabi socks (sole strictly y = 0.000!)
      const parts = [];
      const materials = [this.mats.bamboo, this.mats.tabi, this.mats.cord, this.mats.rubber];

      // Thin protective travel outsole at y = 0.000..0.007 + thick woven straw waraji footbed y = 0.007..0.022
      const basePadGeo = this._createSculptedLoft(
        [
          { y: 0.000, rx: 0.052, rz: 0.130, oz: 0.048, frontScale: 1.04, backScale: 0.94, squareness: 0.40 },
          { y: 0.007, rx: 0.053, rz: 0.132, oz: 0.048, frontScale: 1.04, backScale: 0.94, squareness: 0.40 },
        ],
        20
      );
      const strawSoleGeo = this._createSculptedLoft(
        [
          { y: 0.007, rx: 0.054, rz: 0.134, oz: 0.048, frontScale: 1.05, backScale: 0.95, squareness: 0.42 },
          { y: 0.022, rx: 0.053, rz: 0.132, oz: 0.048, frontScale: 1.05, backScale: 0.95, squareness: 0.42 },
        ],
        20
      );
      // Tabi foot sock resting snugly on waraji footbed
      const tabiFootGeo = this._createSculptedLoft(
        [
          { y: 0.020, rx: 0.046, rz: 0.122, oz: 0.046, frontScale: 1.02, backScale: 0.90, squareness: 0.28 },
          { y: 0.042, rx: 0.044, rz: 0.098, oz: 0.028, frontScale: 1.08, backScale: 0.88, squareness: 0.22 },
          { y: 0.068, rx: 0.044, rz: 0.058, oz: 0.004, frontScale: 1.1 },
          { y: 0.112, rx: 0.046, rz: 0.052, oz: -0.002 },
        ],
        20
      );
      // Traditional waraji toe thong & crisscrossed ankle cord straps
      const thongGeo = this._trackGeo(new THREE.CylinderGeometry(0.0042, 0.0042, 0.105, 8));
      const ankleStrapGeo = this._trackGeo(new THREE.TorusGeometry(0.049, 0.0048, 8, 18));
      ankleStrapGeo.rotateX(Math.PI / 2);

      for (const side of ['L', 'R']) {
        const s = side === 'L' ? 1 : -1;
        const bx = s * hipX;
        parts.push({ geo: basePadGeo, matIndex: 3, side, matrix: this._partTransform(bx, 0, 0) });
        parts.push({ geo: strawSoleGeo, matIndex: 0, side, matrix: this._partTransform(bx, 0, 0) });
        parts.push({ geo: tabiFootGeo, matIndex: 1, side, matrix: this._partTransform(bx, 0, 0) });

        // V-shaped toe-thong cords anchoring forefoot to straw sole
        for (const ts of [1, -1]) {
          parts.push({
            geo: thongGeo,
            matIndex: 2,
            side,
            matrix: this._partTransform(bx + ts * 0.024, 0.040, 0.102, 1.08, ts * 0.36, 0),
          });
        }
        // Crisscrossed ankle waraji wrap cords
        parts.push({ geo: ankleStrapGeo, matIndex: 2, side, matrix: this._partTransform(bx, 0.062, 0.002, 0.28, 0, 0.18) });
        parts.push({ geo: ankleStrapGeo, matIndex: 2, side, matrix: this._partTransform(bx, 0.068, 0.002, -0.25, 0, -0.18) });
        parts.push({ geo: ankleStrapGeo, matIndex: 2, side, matrix: this._partTransform(bx, 0.092, -0.002, 0.04, 0, 0) });
      }

      const geo = this._mergeToSkinnedGeometry(parts, (x, y, z, part) => this._computeFootwearWeights(part.side, x, y, z));
      this._createSkinnedMesh(geo, materials, { name: 'SkinnedWarajiSandals_kenji' });
    }
  }

  // ---------------------------------------------------------------------------
  // High-Detail Expressive Face, Hair & Character Headgear (ALL in headMeshes!)
  // ---------------------------------------------------------------------------

  _buildHeadAndFace() {
    const {
      head,
      jaw,
      eyeL,
      eyeR,
      upperLidL,
      upperLidR,
      lowerLidL,
      lowerLidR,
      browL,
      browR,
      hairLocks,
    } = this.bones;

    const [hsx, hsy, hsz] = this._cfg.headScale;
    const jw = this._cfg.jawWidth;

    // 1. Sculpted cranium + cheekbones + orbital sockets (head bone at y = 1.61 -> crown ~1.79-1.80)
    const craniumGeo = this._createSculptedLoft(
      [
        { y: -0.048 * hsy, rx: 0.062 * hsx, rz: 0.072 * hsz, oz: -0.006, frontScale: 0.85, backScale: 1.05 },
        { y: -0.015 * hsy, rx: 0.078 * hsx, rz: 0.095 * hsz, oz: 0.005, frontScale: 1.05, backScale: 1.02 },
        { y: 0.028 * hsy, rx: 0.084 * hsx, rz: 0.104 * hsz, oz: 0.008, frontScale: 1.04, backScale: 1.04 },
        { y: 0.068 * hsy, rx: 0.086 * hsx, rz: 0.107 * hsz, oz: 0.006, frontScale: 1.02, backScale: 1.05 },
        { y: 0.114 * hsy, rx: 0.082 * hsx, rz: 0.102 * hsz, oz: -0.004, frontScale: 0.96, backScale: 1.04 },
        { y: 0.152 * hsy, rx: 0.062 * hsx, rz: 0.078 * hsz, oz: -0.008 },
        { y: 0.172 * hsy, rx: 0.024 * hsx, rz: 0.030 * hsz, oz: -0.008 },
      ],
      24
    );

    const cPos = craniumGeo.attributes.position;
    for (let i = 0; i < cPos.count; i++) {
      let x = cPos.getX(i);
      let y = cPos.getY(i);
      let z = cPos.getZ(i);

      if (z > 0.055) {
        const dEyeL = Math.hypot(x - 0.034, (y - 0.048) * 1.25);
        const dEyeR = Math.hypot(x + 0.034, (y - 0.048) * 1.25);
        const dEye = Math.min(dEyeL, dEyeR);
        const socket = Math.exp(-(dEye * dEye) / 0.00055);
        z -= socket * 0.015;

        const dCheekL = Math.hypot(x - 0.048, y - 0.014);
        const dCheekR = Math.hypot(x + 0.048, y - 0.014);
        const dCheek = Math.min(dCheekL, dCheekR);
        const cheek = Math.exp(-(dCheek * dCheek) / 0.00085);
        z += cheek * 0.008;
        x += Math.sign(x) * cheek * 0.004;

        const browBand = Math.exp(-((y - 0.072) ** 2) / 0.00022) * smoothstep(0.075, 0.01, Math.abs(x));
        z += browBand * (this.id === 'lyra' ? 0.0045 : 0.0072);

        const philtrum = Math.exp(-((x * x) / 0.000045 + ((y + 0.003) ** 2) / 0.00009));
        z -= philtrum * 0.0024;
      }

      cPos.setXYZ(i, x, y, z);
    }
    craniumGeo.computeVertexNormals();
    this._tagSweatMask(craniumGeo, (x, y, z) => {
      if (z < 0.02) return 0.18;
      const brow = Math.exp(-((y - 0.088) ** 2) / 0.0014) * smoothstep(0.08, 0.0, Math.abs(x));
      const cheeks = Math.exp(-((y - 0.015) ** 2) / 0.0012) * smoothstep(0.085, 0.015, Math.abs(x));
      return clamp(0.25 + brow * 0.78 + cheeks * 0.58, 0, 1);
    });
    head.add(this._makeMesh(craniumGeo, this.mats.skin, { name: 'HeadCranium', isHead: true }));

    // Dark oral cavity interior tucked behind upper lip & jaw
    const cavityGeo = this._trackGeo(new THREE.SphereGeometry(0.036, 12, 10));
    cavityGeo.scale(1.0, 0.82, 1.1);
    const cavity = this._makeMesh(cavityGeo, this.mats.mouthCavity, {
      name: 'OralCavity',
      castShadow: false,
      isHead: true,
    });
    cavity.position.set(0, -0.028, 0.064);
    head.add(cavity);

    // Sculpted natural warm upper lip (cupid's bow arch — clean, warm, zero harsh mustache line!)
    const upperLipGeo = this._createSculptedLoft(
      [
        { y: -0.025, rx: 0.0022, rz: 0.0040, oz: -0.007 },
        { y: -0.014, rx: 0.0052, rz: 0.0088, oz: -0.0018 },
        { y: -0.0055, rx: 0.0066, rz: 0.0108, oz: 0.0018, frontScale: 1.12 },
        { y: 0.0, rx: 0.0058, rz: 0.0104, oz: 0.0020, frontScale: 1.06 },
        { y: 0.0055, rx: 0.0066, rz: 0.0108, oz: 0.0018, frontScale: 1.12 },
        { y: 0.014, rx: 0.0052, rz: 0.0088, oz: -0.0018 },
        { y: 0.025, rx: 0.0022, rz: 0.0040, oz: -0.007 },
      ],
      10
    );
    upperLipGeo.rotateZ(Math.PI / 2);
    const upperLip = this._makeMesh(upperLipGeo, this.mats.lips, {
      name: 'UpperLip',
      castShadow: false,
      isHead: true,
    });
    upperLip.position.set(0, -0.0145, 0.0965);
    head.add(upperLip);

    // Subtle recessed warm lip parting contour tucked cleanly between upper & lower lips
    const mouthLineGeo = this._createSculptedLoft(
      [
        { y: -0.022, rx: 0.0010, rz: 0.0018, oz: -0.006 },
        { y: -0.010, rx: 0.0012, rz: 0.0024, oz: -0.001 },
        { y: 0.0, rx: 0.0014, rz: 0.0028, oz: 0.0005 },
        { y: 0.010, rx: 0.0012, rz: 0.0024, oz: -0.001 },
        { y: 0.022, rx: 0.0010, rz: 0.0018, oz: -0.006 },
      ],
      8
    );
    mouthLineGeo.rotateZ(Math.PI / 2);
    const mouthLine = this._makeMesh(mouthLineGeo, this.mats.mouthCrease, {
      name: 'MouthContourLine',
      castShadow: false,
      isHead: true,
    });
    mouthLine.position.set(0, -0.0195, 0.0928);
    mouthLine.scale.set(0.84, 0.45, 0.55);
    head.add(mouthLine);

    // 2. Sculpted nose bridge, tip & nostrils
    const noseScale = this.id === 'lyra' ? 0.88 : 1.0;
    const noseBridgeGeo = this._createSculptedLoft(
      [
        { y: -0.015, rx: 0.014 * noseScale, rz: 0.0155 * noseScale, frontScale: 1.18 },
        { y: -0.005, rx: 0.0115 * noseScale, rz: 0.0185 * noseScale, oz: 0.0075, frontScale: 1.24 },
        { y: 0.025, rx: 0.0082 * noseScale, rz: 0.0118 * noseScale, oz: 0.002 },
        { y: 0.052, rx: 0.0092 * noseScale, rz: 0.009 * noseScale, oz: -0.004 },
      ],
      12
    );
    this._tagSweatMask(noseBridgeGeo, () => 0.92);
    const nose = this._makeMesh(noseBridgeGeo, this.mats.skin, { name: 'NoseBridge', isHead: true });
    nose.position.set(0, 0.014, 0.103);
    head.add(nose);

    const nostrilGeo = this._trackGeo(new THREE.SphereGeometry(0.0068 * noseScale, 10, 8));
    nostrilGeo.scale(1.05, 0.78, 1.1);
    for (const s of [1, -1]) {
      const nostril = this._makeMesh(nostrilGeo, this.mats.skin, {
        name: s > 0 ? 'NostrilL' : 'NostrilR',
        isHead: true,
      });
      nostril.position.set(s * 0.011 * noseScale, 0.004, 0.1055);
      head.add(nostril);
    }

    // 3. Articulated lower jaw & chin + pillowed warm lower lip
    const jawGeo = this._createSculptedLoft(
      [
        { y: -0.054, rx: 0.031 * jw, rz: 0.043, oz: 0.024, frontScale: 1.14 },
        { y: -0.032, rx: 0.051 * jw, rz: 0.061, oz: 0.018, frontScale: 1.12 },
        { y: -0.004, rx: 0.061 * jw, rz: 0.067, oz: 0.008, frontScale: 1.04 },
        { y: 0.016, rx: 0.063 * jw, rz: 0.063, oz: 0.002 },
      ],
      18
    );
    this._tagSweatMask(jawGeo, () => 0.55);
    jaw.add(this._makeMesh(jawGeo, this.mats.skin, { name: 'LowerJaw', isHead: true }));

    const lowerLipGeo = this._createSculptedLoft(
      [
        { y: -0.023, rx: 0.0020, rz: 0.0040, oz: -0.007 },
        { y: -0.011, rx: 0.0058, rz: 0.0094, oz: -0.001, frontScale: 1.12 },
        { y: 0.0, rx: 0.0070, rz: 0.0110, oz: 0.0022, frontScale: 1.16 },
        { y: 0.011, rx: 0.0058, rz: 0.0094, oz: -0.001, frontScale: 1.12 },
        { y: 0.023, rx: 0.0020, rz: 0.0040, oz: -0.007 },
      ],
      10
    );
    lowerLipGeo.rotateZ(Math.PI / 2);
    const lowerLip = this._makeMesh(lowerLipGeo, this.mats.lips, {
      name: 'LowerLip',
      castShadow: false,
      isHead: true,
    });
    lowerLip.position.set(0, 0.0165, 0.0615);
    jaw.add(lowerLip);

    // 4. Anatomical ears
    const earGeo = this._trackGeo(new THREE.TorusGeometry(0.018, 0.0066, 8, 14, Math.PI * 1.45));
    const earBowlGeo = this._trackGeo(new THREE.SphereGeometry(0.0145, 10, 8));
    earBowlGeo.scale(0.42, 1.18, 0.85);
    for (const s of [1, -1]) {
      const earGrp = new THREE.Group();
      earGrp.position.set(s * 0.082 * hsx, 0.032, -0.004);
      earGrp.rotation.y = s * -0.22;
      earGrp.rotation.z = s * -0.1;

      earGrp.add(this._makeMesh(earBowlGeo, this.mats.skin, { name: s > 0 ? 'EarBowlL' : 'EarBowlR', isHead: true }));
      const helix = this._makeMesh(earGeo, this.mats.skin, { name: s > 0 ? 'EarHelixL' : 'EarHelixR', isHead: true });
      helix.rotation.y = Math.PI / 2;
      helix.rotation.z = -0.35;
      helix.scale.set(0.82, 1.18, 0.72);
      earGrp.add(helix);
      head.add(earGrp);
    }

    // 5. Glossy eyes + dual specular catchlights + articulating eyelids & lashes
    const eyeGeo = this._trackGeo(new THREE.SphereGeometry(0.0138, 16, 14));
    eyeGeo.rotateX(Math.PI / 2);

    const catchlightMainGeo = this._trackGeo(new THREE.SphereGeometry(0.0019, 8, 6));
    catchlightMainGeo.scale(1.15, 1.0, 0.35);
    const catchlightSubGeo = this._trackGeo(new THREE.SphereGeometry(0.00095, 8, 6));
    catchlightSubGeo.scale(1.0, 1.0, 0.35);

    const upperLidGeo = this._trackGeo(
      new THREE.SphereGeometry(0.0154, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.37)
    );
    upperLidGeo.scale(1.04, 1.0, 1.04);

    const lowerLidGeo = this._trackGeo(
      new THREE.SphereGeometry(0.0151, 14, 8, 0, Math.PI * 2, Math.PI * 0.64, Math.PI * 0.36)
    );
    lowerLidGeo.scale(1.03, 1.0, 1.03);

    const lashRadius = 0.0154 * Math.sin(Math.PI * 0.37);
    const lashY = 0.0154 * Math.cos(Math.PI * 0.37);
    const lashGeo = this._trackGeo(new THREE.TorusGeometry(lashRadius, 0.0013, 6, 14, Math.PI * 0.72));
    lashGeo.rotateZ(Math.PI * 0.14);
    lashGeo.rotateX(Math.PI / 2);

    for (const [side, eyeBone, uLidBone, lLidBone] of [
      ['L', eyeL, upperLidL, lowerLidL],
      ['R', eyeR, upperLidR, lowerLidR],
    ]) {
      eyeBone.add(
        this._makeMesh(eyeGeo, this.mats.eye, {
          name: `Eyeball${side}`,
          castShadow: false,
          receiveShadow: false,
          isHead: true,
        })
      );

      const catchMain = this._makeMesh(catchlightMainGeo, this.mats.eyeCatchlight, {
        name: `EyeCatchlightMain${side}`,
        castShadow: false,
        receiveShadow: false,
        isHead: true,
      });
      catchMain.position.set(0.0024, 0.0026, 0.0136);
      eyeBone.add(catchMain);

      const catchSub = this._makeMesh(catchlightSubGeo, this.mats.eyeCatchlight, {
        name: `EyeCatchlightSub${side}`,
        castShadow: false,
        receiveShadow: false,
        isHead: true,
      });
      catchSub.position.set(-0.0022, -0.002, 0.0137);
      eyeBone.add(catchSub);

      uLidBone.add(this._makeMesh(upperLidGeo, this.mats.skin, { name: `UpperLid${side}`, castShadow: false, isHead: true }));
      const lashMesh = this._makeMesh(lashGeo, this.mats.lash, { name: `Eyelash${side}`, castShadow: false, isHead: true });
      lashMesh.position.set(0, lashY, 0.0008);
      uLidBone.add(lashMesh);

      lLidBone.add(this._makeMesh(lowerLidGeo, this.mats.skin, { name: `LowerLid${side}`, castShadow: false, isHead: true }));
    }

    // 6. Sculpted eyebrows
    const browThickness = this.id === 'lyra' ? 0.78 : 1.0;
    const browGeo = this._createSculptedLoft(
      [
        { y: -0.019, rx: 0.003 * browThickness, rz: 0.004 * browThickness },
        { y: -0.006, rx: 0.005 * browThickness, rz: 0.0058 * browThickness },
        { y: 0.008, rx: 0.0055 * browThickness, rz: 0.0062 * browThickness },
        { y: 0.019, rx: 0.0028 * browThickness, rz: 0.0036 * browThickness },
      ],
      10
    );
    browGeo.rotateZ(Math.PI / 2);
    for (const [side, browBone] of [
      ['L', browL],
      ['R', browR],
    ]) {
      const s = side === 'L' ? 1 : -1;
      const bMesh = this._makeMesh(browGeo, this.mats.hair, { name: `Eyebrow${side}`, castShadow: false, isHead: true });
      bMesh.rotation.y = s * 0.24;
      bMesh.rotation.z = s * (this.id === 'lyra' ? -0.12 : -0.08);
      browBone.add(bMesh);
    }

    // 7. Layered character-specific hairstyle & iconic headgear (ALL registered in headMeshes!)
    this._buildHairAndHeadgear(head, hairLocks);
  }

  _buildHairAndHeadgear(head, hairLocks) {
    const tuftRng = createRng(this._seed + 404);
    const hairPivotX = hairLocks.position.x;
    const hairPivotY = hairLocks.position.y;
    const hairPivotZ = hairLocks.position.z;

    // Base hair skull cap & nape volume
    const hairCapGeo = this._trackGeo(
      new THREE.SphereGeometry(0.094, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.62)
    );
    hairCapGeo.scale(0.97, 1.05, 1.14);
    const hairCap = this._makeMesh(hairCapGeo, this.mats.hair, { name: 'HairBaseCap', isHead: true });
    hairCap.position.set(0, 0.078, -0.008);
    hairCap.rotation.x = -0.22;
    head.add(hairCap);

    const napeGeo = this._trackGeo(new THREE.SphereGeometry(0.082, 16, 12));
    napeGeo.scale(0.98, 1.08, 0.92);
    const nape = this._makeMesh(napeGeo, this.mats.hair, { name: 'HairNape', isHead: true });
    nape.position.set(0, 0.036, -0.036);
    head.add(nape);

    const tuftGeo = this._createSculptedLoft(
      [
        { y: 0.0, rx: 0.018, rz: 0.011 },
        { y: 0.025, rx: 0.020, rz: 0.012, oz: 0.006 },
        { y: 0.056, rx: 0.014, rz: 0.009, oz: 0.012 },
        { y: 0.084, rx: 0.004, rz: 0.003, oz: 0.016 },
      ],
      8
    );

    const addTufts = (specs, geo = tuftGeo) => {
      specs.forEach((t, idx) => {
        const m = this._makeMesh(geo, this.mats.hair, {
          name: t.dynamic ? `HairLock_${idx}` : `HairTuft_${idx}`,
          isHead: true,
        });
        if (t.dynamic) {
          m.position.set(t.p[0] - hairPivotX, t.p[1] - hairPivotY, t.p[2] - hairPivotZ);
        } else {
          m.position.set(t.p[0], t.p[1], t.p[2]);
        }
        m.rotation.set(
          t.r[0] + (tuftRng() - 0.5) * 0.08,
          t.r[1] + (tuftRng() - 0.5) * 0.08,
          t.r[2] + (tuftRng() - 0.5) * 0.08
        );
        m.scale.set(t.s[0], t.s[1], t.s[2]);
        (t.dynamic ? hairLocks : head).add(m);
      });
    };

    if (this.id === 'liam') {
      addTufts([
        { p: [-0.044, 0.134, 0.068], r: [1.18, -0.35, -0.52], s: [1.12, 0.95, 0.92], dynamic: true },
        { p: [-0.014, 0.146, 0.076], r: [1.26, -0.1, -0.32], s: [1.2, 1.02, 0.96], dynamic: true },
        { p: [0.02, 0.145, 0.075], r: [1.22, 0.18, -0.18], s: [1.16, 0.98, 0.92], dynamic: true },
        { p: [0.052, 0.130, 0.063], r: [1.1, 0.45, 0.35], s: [1.02, 0.9, 0.88], dynamic: true },
        { p: [0.0, 0.148, 0.026], r: [1.05, 0.08, -0.25], s: [1.32, 0.82, 0.95], dynamic: true },
        { p: [-0.038, 0.144, 0.014], r: [0.92, -0.4, -0.58], s: [1.2, 0.8, 0.9], dynamic: true },
        { p: [0.038, 0.142, 0.016], r: [0.94, 0.38, 0.46], s: [1.2, 0.8, 0.9], dynamic: true },
        { p: [0.074, 0.108, 0.038], r: [0.58, 0.95, 1.52], s: [0.96, 0.9, 0.86], dynamic: true },
        { p: [-0.074, 0.108, 0.038], r: [0.58, -0.95, -1.52], s: [0.96, 0.9, 0.86], dynamic: true },
        { p: [0.0, 0.144, -0.028], r: [-1.08, 0.0, 0.12], s: [1.35, 0.82, 0.95], dynamic: false },
        { p: [-0.046, 0.136, -0.035], r: [-1.05, -0.45, -0.55], s: [1.18, 0.82, 0.92], dynamic: false },
        { p: [0.046, 0.136, -0.035], r: [-1.05, 0.45, 0.55], s: [1.18, 0.82, 0.92], dynamic: false },
        { p: [0.0, 0.095, -0.092], r: [-2.15, 0.0, 0.08], s: [1.35, 1.05, 0.95], dynamic: false },
        { p: [0.045, 0.088, -0.082], r: [-2.12, 0.42, 0.25], s: [1.2, 0.98, 0.9], dynamic: false },
        { p: [-0.045, 0.088, -0.082], r: [-2.12, -0.42, -0.25], s: [1.2, 0.98, 0.9], dynamic: false },
      ]);
    } else if (this.id === 'lyra') {
      // Flowing windswept auburn hair locks + emerald hooded cowl framing her face!
      const longLockGeo = this._createSculptedLoft(
        [
          { y: 0.0, rx: 0.020, rz: 0.013 },
          { y: -0.055, rx: 0.022, rz: 0.014, oz: -0.008 },
          { y: -0.125, rx: 0.017, rz: 0.011, oz: -0.022 },
          { y: -0.195, rx: 0.009, rz: 0.006, oz: -0.034 },
          { y: -0.245, rx: 0.003, rz: 0.002, oz: -0.042 },
        ],
        8
      );
      addTufts([
        { p: [-0.050, 0.132, 0.064], r: [1.32, -0.42, -0.68], s: [1.08, 1.15, 0.92], dynamic: true },
        { p: [-0.012, 0.146, 0.074], r: [1.38, -0.12, -0.44], s: [1.16, 1.12, 0.94], dynamic: true },
        { p: [0.030, 0.142, 0.072], r: [1.34, 0.25, 0.36], s: [1.14, 1.10, 0.92], dynamic: true },
        { p: [0.064, 0.118, 0.054], r: [1.15, 0.65, 0.85], s: [1.05, 1.25, 0.90], dynamic: true },
        { p: [-0.064, 0.118, 0.054], r: [1.15, -0.65, -0.85], s: [1.05, 1.25, 0.90], dynamic: true },
      ]);
      // Flowing long auburn side & back windswept locks on hairLocks spring bone
      for (const spec of [
        { p: [0.078, 0.095, 0.034], r: [0.12, 0.25, 0.18], s: [0.95, 0.92, 0.95] },
        { p: [-0.078, 0.095, 0.034], r: [0.12, -0.25, -0.18], s: [0.95, 0.92, 0.95] },
        { p: [0.048, 0.088, -0.072], r: [-0.18, 0.15, 0.12], s: [1.25, 1.15, 1.1] },
        { p: [0.0, 0.092, -0.082], r: [-0.22, 0.0, 0.0], s: [1.45, 1.22, 1.15] },
        { p: [-0.048, 0.088, -0.072], r: [-0.18, -0.15, -0.12], s: [1.25, 1.15, 1.1] },
      ]) {
        const lock = this._makeMesh(longLockGeo, this.mats.hair, { name: 'LyraLongHairLock', isHead: true });
        lock.position.set(spec.p[0] - hairPivotX, spec.p[1] - hairPivotY, spec.p[2] - hairPivotZ);
        lock.rotation.set(spec.r[0], spec.r[1], spec.r[2]);
        lock.scale.set(spec.s[0], spec.s[1], spec.s[2]);
        hairLocks.add(lock);
      }

      // Sculpted emerald archer's hooded cowl framing face & hair (registered in headMeshes!)
      const hoodGeo = this._createOpenSculptedShell(
        [
          { y: -0.045, rx: 0.112, rz: 0.124, oz: -0.015, backScale: 1.18, gapHalfAngle: 0.88 },
          { y: 0.025, rx: 0.118, rz: 0.132, oz: -0.012, backScale: 1.20, gapHalfAngle: 0.78 },
          { y: 0.098, rx: 0.116, rz: 0.136, oz: -0.008, backScale: 1.22, gapHalfAngle: 0.66 },
          { y: 0.158, rx: 0.096, rz: 0.126, oz: -0.012, backScale: 1.24, gapHalfAngle: 0.42 },
          { y: 0.194, rx: 0.045, rz: 0.095, oz: -0.032, backScale: 1.28, gapHalfAngle: 0.16 },
        ],
        22,
        { thickness: 0.009, uvRepeatU: 1.2, uvRepeatV: 1.0 }
      );
      head.add(this._makeMesh(hoodGeo, this.mats.hood, { name: 'LyraHoodCowl', isHead: true }));

      // Gold embroidered front hood rim framing face
      const hoodRimGeo = this._trackGeo(new THREE.TorusGeometry(0.112, 0.007, 8, 22, Math.PI * 1.18));
      const hoodRim = this._makeMesh(hoodRimGeo, this.mats.goldTrim, { name: 'LyraHoodGoldRim', isHead: true });
      hoodRim.position.set(0, 0.088, 0.068);
      hoodRim.rotation.set(-0.24, 0, -Math.PI * 0.09);
      hoodRim.scale.set(0.95, 1.05, 0.75);
      head.add(hoodRim);
    } else if (this.id === 'kael') {
      // Sleek swept dark obsidian undercut hair + translucent cyan-tinted forehead visor goggles!
      addTufts([
        { p: [-0.032, 0.146, 0.062], r: [0.82, -0.25, -0.62], s: [1.12, 1.05, 0.92], dynamic: true },
        { p: [0.004, 0.156, 0.066], r: [0.76, 0.12, -0.42], s: [1.28, 1.12, 0.98], dynamic: true },
        { p: [0.038, 0.148, 0.056], r: [0.80, 0.35, -0.24], s: [1.14, 1.02, 0.94], dynamic: true },
        { p: [0.01, 0.158, 0.015], r: [-0.45, 0.08, -0.25], s: [1.38, 0.96, 1.0], dynamic: true },
        { p: [-0.032, 0.150, 0.008], r: [-0.52, -0.35, -0.45], s: [1.20, 0.88, 0.92], dynamic: true },
        { p: [0.034, 0.148, 0.010], r: [-0.50, 0.35, 0.38], s: [1.20, 0.88, 0.92], dynamic: true },
        { p: [0.0, 0.142, -0.042], r: [-1.25, 0.0, 0.0], s: [1.25, 0.82, 0.90], dynamic: false },
      ]);

      // Translucent cyan-tinted forehead visor goggles resting on brow/forehead (ALL isHead: true!)
      const visorGrp = new THREE.Group();
      visorGrp.name = 'KaelForeheadVisorGroup';
      visorGrp.position.set(0, 0.104, 0.022);
      visorGrp.rotation.x = -0.24;

      // Curved elastic strap wrapping cleanly around temples & back of head
      const strapGeo = this._trackGeo(new THREE.TorusGeometry(0.095, 0.009, 8, 24));
      strapGeo.rotateX(Math.PI / 2);
      strapGeo.scale(0.95, 1.0, 1.12);
      const strap = this._makeMesh(strapGeo, this.mats.carbonMatte, { name: 'VisorStrap', isHead: true });
      strap.position.set(0, -0.004, -0.026);
      visorGrp.add(strap);

      // Curved matte-carbon goggle frame housing
      const frameGeo = this._trackGeo(
        new THREE.CylinderGeometry(0.094, 0.096, 0.042, 20, 1, true, -Math.PI * 0.34, Math.PI * 0.68)
      );
      const frame = this._makeMesh(frameGeo, this.mats.carbon, { name: 'VisorFrame', isHead: true });
      frame.position.set(0, 0, -0.006);
      visorGrp.add(frame);

      // Upper & lower carbon visor trim bezels + HDR cyan side accent bars
      const bezelGeo = this._trackGeo(new THREE.TorusGeometry(0.0955, 0.0048, 6, 18, Math.PI * 0.68));
      bezelGeo.rotateX(Math.PI / 2);
      bezelGeo.rotateY(Math.PI * 0.16);
      for (const by of [0.020, -0.020]) {
        const bezel = this._makeMesh(bezelGeo, this.mats.carbonMatte, { name: 'VisorBezel', isHead: true });
        bezel.position.set(0, by, -0.006);
        visorGrp.add(bezel);
      }

      // Translucent cyan optical visor lens
      const lensGeo = this._trackGeo(
        new THREE.CylinderGeometry(0.0975, 0.0985, 0.034, 20, 1, true, -Math.PI * 0.31, Math.PI * 0.62)
      );
      const lens = this._makeMesh(lensGeo, this.mats.visorGlass, {
        name: 'VisorCyanLens',
        castShadow: false,
        isHead: true,
      });
      lens.position.set(0, 0, -0.005);
      visorGrp.add(lens);

      // Titanium side temple hinges + tiny glowing cyan HUD indicator strips
      const hingeGeo = this._trackGeo(new THREE.BoxGeometry(0.014, 0.026, 0.024));
      const hudLedGeo = this._trackGeo(new THREE.BoxGeometry(0.006, 0.016, 0.014));
      for (const s of [1, -1]) {
        const hinge = this._makeMesh(hingeGeo, this.mats.titanium, { name: `VisorHinge_${s > 0 ? 'L' : 'R'}`, isHead: true });
        hinge.position.set(s * 0.088, 0, 0.044);
        hinge.rotation.y = s * -0.48;
        visorGrp.add(hinge);

        const led = this._makeMesh(hudLedGeo, this.mats.cyanGlow, {
          name: `VisorLed_${s > 0 ? 'L' : 'R'}`,
          castShadow: false,
          isHead: true,
        });
        led.position.set(s * 0.092, 0.004, 0.052);
        led.rotation.y = s * -0.48;
        visorGrp.add(led);
      }

      head.add(visorGrp);
    } else if (this.id === 'kenji') {
      // Tied-back black samurai hair with topknot + loose temple strands + wide woven bamboo-straw kasa conical hat!
      addTufts([
        { p: [0.068, 0.098, 0.048], r: [0.85, 0.72, 1.35], s: [0.85, 1.15, 0.80], dynamic: true },
        { p: [-0.068, 0.098, 0.048], r: [0.85, -0.72, -1.35], s: [0.85, 1.15, 0.80], dynamic: true },
        { p: [0.022, 0.132, 0.068], r: [1.32, 0.2, 0.35], s: [0.82, 0.92, 0.78], dynamic: true },
        { p: [-0.026, 0.130, 0.066], r: [1.28, -0.22, -0.42], s: [0.82, 0.90, 0.78], dynamic: true },
        { p: [0.0, 0.072, -0.096], r: [-2.35, 0.0, 0.0], s: [1.25, 1.12, 0.95], dynamic: false },
      ]);

      // Tied samurai hair knot tucked at upper rear crown
      const knotGeo = this._trackGeo(new THREE.SphereGeometry(0.034, 12, 10));
      knotGeo.scale(0.85, 0.92, 1.25);
      const knot = this._makeMesh(knotGeo, this.mats.hair, { name: 'KenjiHairKnot', isHead: true });
      knot.position.set(0, 0.118, -0.098);
      head.add(knot);

      // Wide woven bamboo-straw KASA conical hat + reinforced rim + braided silk chin tie (ALL isHead: true!)
      const kasaGrp = new THREE.Group();
      kasaGrp.name = 'KenjiKasaHatGroup';
      kasaGrp.position.set(0, 0.108, -0.004);
      kasaGrp.rotation.x = 0.06;

      // Graceful curved conical straw dome (outer + inner surface via DoubleSide + woven bamboo PBR)
      const kasaProfile = [
        { y: 0.000, rx: 0.285, rz: 0.285 },
        { y: 0.026, rx: 0.242, rz: 0.242 },
        { y: 0.056, rx: 0.190, rz: 0.190 },
        { y: 0.088, rx: 0.132, rz: 0.132 },
        { y: 0.118, rx: 0.076, rz: 0.076 },
        { y: 0.140, rx: 0.028, rz: 0.028 },
        { y: 0.148, rx: 0.004, rz: 0.004 },
      ];
      const kasaGeo = this._createSculptedLoft(kasaProfile, 32, {
        capBottom: false,
        capTop: true,
        uvRepeatU: 3.0,
        uvRepeatV: 1.8,
      });
      kasaGrp.add(this._makeMesh(kasaGeo, this.mats.bamboo, { name: 'KenjiKasaCone', isHead: true }));

      // Reinforced braided bamboo outer edge hoop & peak cap ring
      const kasaRimGeo = this._trackGeo(new THREE.TorusGeometry(0.285, 0.0085, 8, 32));
      kasaRimGeo.rotateX(Math.PI / 2);
      kasaGrp.add(this._makeMesh(kasaRimGeo, this.mats.bamboo, { name: 'KenjiKasaRim', isHead: true }));

      const peakRingGeo = this._trackGeo(new THREE.TorusGeometry(0.036, 0.0055, 6, 16));
      peakRingGeo.rotateX(Math.PI / 2);
      const peakRing = this._makeMesh(peakRingGeo, this.mats.cord, { name: 'KenjiKasaPeakRing', isHead: true });
      peakRing.position.set(0, 0.136, 0);
      kasaGrp.add(peakRing);

      // Interior woven crown head-ring seated securely on brow
      const innerCrownGeo = this._trackGeo(new THREE.TorusGeometry(0.092, 0.011, 8, 20));
      innerCrownGeo.rotateX(Math.PI / 2);
      const innerCrown = this._makeMesh(innerCrownGeo, this.mats.bamboo, { name: 'KenjiKasaInnerRing', isHead: true });
      innerCrown.position.set(0, 0.044, 0);
      kasaGrp.add(innerCrown);

      // Braided crimson-silk chin tie looping down cleanly beneath chin with twin tassels!
      const chinCordCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.095, 0.045, 0.015),
        new THREE.Vector3(0.082, -0.055, 0.032),
        new THREE.Vector3(0.034, -0.155, 0.052),
        new THREE.Vector3(0.0, -0.172, 0.056),
        new THREE.Vector3(-0.034, -0.155, 0.052),
        new THREE.Vector3(-0.082, -0.055, 0.032),
        new THREE.Vector3(-0.095, 0.045, 0.015),
      ]);
      const chinCordGeo = this._trackGeo(new THREE.TubeGeometry(chinCordCurve, 24, 0.0042, 6, false));
      kasaGrp.add(this._makeMesh(chinCordGeo, this.mats.cord, { name: 'KenjiKasaChinTie', castShadow: false, isHead: true }));

      const tasselGeo = this._trackGeo(new THREE.CylinderGeometry(0.0032, 0.0055, 0.044, 6));
      for (const s of [1, -1]) {
        const tassel = this._makeMesh(tasselGeo, this.mats.cord, {
          name: `KenjiChinTassel_${s > 0 ? 'L' : 'R'}`,
          castShadow: false,
          isHead: true,
        });
        tassel.position.set(s * 0.010, -0.194, 0.058);
        tassel.rotation.z = s * 0.16;
        kasaGrp.add(tassel);
      }

      head.add(kasaGrp);
    }
  }

  // ---------------------------------------------------------------------------
  // Articulated 5-Finger Hands (Preserving Exact setHandPose Kinematics!)
  // ---------------------------------------------------------------------------

  _buildArticulatedHands() {
    const hs = this.id === 'lyra' ? 0.90 : 1.0;
    const palmMat = this.id === 'kael' ? this.mats.carbonMatte : this.mats.skin;

    const wristCapGeo = this._trackGeo(new THREE.SphereGeometry(0.028 * hs, 12, 10));
    wristCapGeo.scale(0.95, 0.9, 1.12);
    this._tagSweatMask(wristCapGeo, () => 0.35);

    const palmGeo = this._createSculptedLoft(
      [
        { y: -0.08, rx: 0.0145 * hs, rz: 0.041 * hs, squareness: 0.25 },
        { y: -0.048, rx: 0.019 * hs, rz: 0.044 * hs, frontScale: 1.06, squareness: 0.22 },
        { y: -0.015, rx: 0.0205 * hs, rz: 0.036 * hs },
        { y: 0.008, rx: 0.0215 * hs, rz: 0.031 * hs },
      ],
      14
    );
    this._tagSweatMask(palmGeo, () => 0.3);

    const thenarGeo = this._trackGeo(new THREE.SphereGeometry(0.016 * hs, 10, 8));
    thenarGeo.scale(0.85, 1.35, 0.95);
    this._tagSweatMask(thenarGeo, () => 0.28);

    const knuckleGeo = this._trackGeo(new THREE.SphereGeometry(0.0082 * hs, 8, 6));
    this._tagSweatMask(knuckleGeo, () => 0.25);

    const fingerProxGeo = this._createSculptedLoft(
      [
        { y: -0.04, rx: 0.0072 * hs, rz: 0.0076 * hs },
        { y: -0.02, rx: 0.0080 * hs, rz: 0.0084 * hs },
        { y: 0.004, rx: 0.0086 * hs, rz: 0.0088 * hs },
      ],
      10
    );
    this._tagSweatMask(fingerProxGeo, () => 0.25);

    const fingerDistGeo = this._createSculptedLoft(
      [
        { y: -0.036, rx: 0.0048 * hs, rz: 0.0052 * hs },
        { y: -0.020, rx: 0.0066 * hs, rz: 0.0070 * hs },
        { y: 0.004, rx: 0.0072 * hs, rz: 0.0075 * hs },
      ],
      10
    );
    this._tagSweatMask(fingerDistGeo, () => 0.25);

    const thumbProxGeo = this._createSculptedLoft(
      [
        { y: -0.035, rx: 0.0086 * hs, rz: 0.0092 * hs },
        { y: -0.016, rx: 0.0098 * hs, rz: 0.0104 * hs },
        { y: 0.005, rx: 0.0112 * hs, rz: 0.0116 * hs },
      ],
      10
    );
    this._tagSweatMask(thumbProxGeo, () => 0.25);

    const thumbDistGeo = this._createSculptedLoft(
      [
        { y: -0.028, rx: 0.0062 * hs, rz: 0.0068 * hs },
        { y: -0.014, rx: 0.0082 * hs, rz: 0.0088 * hs },
        { y: 0.004, rx: 0.0086 * hs, rz: 0.0092 * hs },
      ],
      10
    );
    this._tagSweatMask(thumbDistGeo, () => 0.25);

    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const wrist = this.bones[`wrist${side}`];
      const hand = this.bones[`hand${side}`];
      const thumbBone = this.bones[`thumb${side}`];
      const thumbTipBone = this.bones[`thumbTip${side}`];

      wrist.add(this._makeMesh(wristCapGeo, this.mats.skin, { name: `WristCap${side}` }));
      hand.add(this._makeMesh(palmGeo, palmMat, { name: `HandPalm${side}` }));

      const thenar = this._makeMesh(thenarGeo, palmMat, { name: `HandThenar${side}`, castShadow: false });
      thenar.position.set(-s * 0.009, -0.034, 0.026);
      hand.add(thenar);

      // Cyber Scout glowing knuckle accent bar on back of fingerless tactical gloves
      if (this.id === 'kael') {
        const kBarGeo = this._trackGeo(new THREE.BoxGeometry(0.006, 0.012, 0.068));
        const kBar = this._makeMesh(kBarGeo, this.mats.cyanGlow, { name: `GloveGlow${side}`, castShadow: false });
        kBar.position.set(s * 0.018, -0.066, 0.004);
        hand.add(kBar);
      }

      thumbBone.add(this._makeMesh(thumbProxGeo, this.mats.skin, { name: `ThumbProx${side}` }));
      const thumbKnuckle = this._makeMesh(knuckleGeo, this.mats.skin, { name: `ThumbKnuckle${side}`, castShadow: false });
      thumbKnuckle.scale.setScalar(1.06);
      thumbTipBone.add(thumbKnuckle);
      thumbTipBone.add(this._makeMesh(thumbDistGeo, this.mats.skin, { name: `ThumbDist${side}` }));

      const fingerLayouts = [
        { key: 'index', scaleX: 0.96, scaleY: 0.92, tipScaleY: 0.92 },
        { key: 'middle', scaleX: 1.0, scaleY: 1.04, tipScaleY: 1.04 },
        { key: 'ring', scaleX: 0.94, scaleY: 0.96, tipScaleY: 0.95 },
        { key: 'pinky', scaleX: 0.82, scaleY: 0.76, tipScaleY: 0.76 },
      ];
      for (const f of fingerLayouts) {
        const proxBone = this.bones[`${f.key}${side}`];
        const tipBone = this.bones[`${f.key}Tip${side}`];

        const mcpCap = this._makeMesh(knuckleGeo, palmMat, { name: `KnuckleMCP_${f.key}${side}`, castShadow: false });
        mcpCap.scale.setScalar(f.scaleX);
        proxBone.add(mcpCap);

        const proxMesh = this._makeMesh(fingerProxGeo, this.mats.skin, { name: `FingerProx_${f.key}${side}` });
        proxMesh.scale.set(f.scaleX, f.scaleY, f.scaleX);
        proxBone.add(proxMesh);

        const pipCap = this._makeMesh(knuckleGeo, this.mats.skin, { name: `KnucklePIP_${f.key}${side}`, castShadow: false });
        pipCap.scale.setScalar(f.scaleX * 0.88);
        tipBone.add(pipCap);

        const distMesh = this._makeMesh(fingerDistGeo, this.mats.skin, { name: `FingerDist_${f.key}${side}` });
        distMesh.scale.set(f.scaleX * 0.94, f.tipScaleY, f.scaleX * 0.94);
        tipBone.add(distMesh);
      }

      this.setHandPose(side, 0.22, 0.0);
    }
  }

  // ---------------------------------------------------------------------------
  // Character Master Construction Dispatch
  // ---------------------------------------------------------------------------

  _buildCharacterGeometry() {
    if (this.id === 'liam') {
      this._buildLiamCharacter();
    } else if (this.id === 'lyra') {
      this._buildLyraCharacter();
    } else if (this.id === 'kael') {
      this._buildKaelCharacter();
    } else if (this.id === 'kenji') {
      this._buildKenjiCharacter();
    }

    this._buildContinuousSkinnedFootwear();
    this._buildHeadAndFace();
    this._buildArticulatedHands();
  }

  // ===========================================================================
  // PRESET 1: 'liam' — Forest Ranger (Liam)
  // ===========================================================================

  _buildLiamCharacter() {
    const shX = this._cfg.shoulderX;
    // 1. Continuous Skinned Upper Body (plaid flannel torso + olive jacket sleeves + rolled cuff + bare skin forearms)
    this._buildContinuousUpperBody({
      materials: [this.mats.flannel, this.mats.jacket, this.mats.jacketTrim, this.mats.skin],
    });

    // 2. Continuous Skinned Lower Body (pleated khaki-charcoal cargo pants from waist to ankles)
    this._buildContinuousLowerBody({
      materials: [this.mats.pants],
    });

    // 3. Continuous Skinned Open Waxed-Canvas Field Jacket + Flannel Placket + Lapels + Stitched Flap Pockets + Buttons
    const jacketParts = [];
    const jacketMats = [
      this.mats.jacket,
      this.mats.jacketTrim,
      this.mats.stitching,
      this.mats.brass,
      this.mats.flannel,
      this.mats.darkLeather,
    ];

    // Full continuous open-front C-shell spanning hem (0.76) -> waist (1.02) -> chest (1.49) -> neck
    const openJacketGeo = this._createOpenSculptedShell(
      [
        { y: 0.755, rx: 0.204, rz: 0.146, backScale: 1.08, squareness: 0.30, gapHalfAngle: 0.64 },
        { y: 0.85, rx: 0.190, rz: 0.136, backScale: 1.04, squareness: 0.28, gapHalfAngle: 0.60 },
        { y: 0.945, rx: 0.178, rz: 0.127, squareness: 0.28, gapHalfAngle: 0.56 },
        { y: 1.02, rx: 0.172, rz: 0.123, squareness: 0.28, gapHalfAngle: 0.54 },
        { y: 1.12, rx: 0.177, rz: 0.127, squareness: 0.28, gapHalfAngle: 0.49 },
        { y: 1.22, rx: 0.188, rz: 0.133, frontScale: 1.06, squareness: 0.30, gapHalfAngle: 0.46 },
        { y: 1.32, rx: 0.204, rz: 0.138, frontScale: 1.10, squareness: 0.32, gapHalfAngle: 0.45 },
        { y: 1.40, rx: 0.210, rz: 0.140, frontScale: 1.12, squareness: 0.34, gapHalfAngle: 0.44 },
        { y: 1.47, rx: 0.198, rz: 0.125, frontScale: 1.04, squareness: 0.30, gapHalfAngle: 0.48 },
        { y: 1.515, rx: 0.140, rz: 0.098, squareness: 0.20, gapHalfAngle: 0.56 },
      ],
      24,
      { thickness: 0.012, uvRepeatU: 1.6, uvRepeatV: 1.8 }
    );
    jacketParts.push({ geo: openJacketGeo, matIndex: 0 });

    // Waist cinch trim + folded storm collar
    const cinchGeo = this._createOpenSculptedShell(
      [
        { y: 1.00, rx: 0.176, rz: 0.126, squareness: 0.28, gapHalfAngle: 0.55 },
        { y: 1.032, rx: 0.174, rz: 0.125, squareness: 0.28, gapHalfAngle: 0.53 },
      ],
      22,
      { thickness: 0.008 }
    );
    jacketParts.push({ geo: cinchGeo, matIndex: 1 });

    const collarGeo = this._createOpenSculptedShell(
      [
        { y: 1.494, rx: 0.092, rz: 0.095, frontScale: 0.94, backScale: 1.08, gapHalfAngle: 0.62 },
        { y: 1.534, rx: 0.102, rz: 0.101, frontScale: 0.88, backScale: 1.15, gapHalfAngle: 0.66 },
        { y: 1.566, rx: 0.109, rz: 0.104, frontScale: 0.82, backScale: 1.18, gapHalfAngle: 0.72 },
      ],
      20,
      { thickness: 0.013 }
    );
    jacketParts.push({ geo: collarGeo, matIndex: 1 });

    // Open flannel shirt placket, buttons & folded flannel collar points
    const shirtPlacketGeo = this._trackGeo(new THREE.BoxGeometry(0.022, 0.28, 0.008));
    jacketParts.push({ geo: shirtPlacketGeo, matIndex: 4, matrix: this._partTransform(0, 1.345, 0.134, -0.04, 0, 0) });

    const shirtBtnGeo = this._trackGeo(new THREE.CylinderGeometry(0.0042, 0.0042, 0.0045, 8));
    shirtBtnGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      jacketParts.push({ geo: shirtBtnGeo, matIndex: 5, matrix: this._partTransform(0, 1.455 - i * 0.068, 0.139 - i * 0.003) });
    }

    const shirtCollarPtGeo = this._trackGeo(new THREE.BoxGeometry(0.044, 0.036, 0.01));
    for (const s of [1, -1]) {
      jacketParts.push({
        geo: shirtCollarPtGeo,
        matIndex: 4,
        matrix: this._partTransform(s * 0.042, 1.512, 0.078, -0.22, s * 0.42, s * -0.28),
      });
    }

    // Jacket front edges, folded lapels with topstitching, brass buttons & stitched pockets
    const edgePlacketGeo = this._trackGeo(new THREE.BoxGeometry(0.026, 0.30, 0.016));
    const lapelGeo = this._trackGeo(new THREE.BoxGeometry(0.048, 0.112, 0.013));
    const lapelStitchGeo = this._trackGeo(new THREE.BoxGeometry(0.004, 0.104, 0.015));
    const btnGeo = this._trackGeo(new THREE.CylinderGeometry(0.0068, 0.0068, 0.007, 10));
    btnGeo.rotateX(Math.PI / 2);
    const tabGeo = this._trackGeo(new THREE.BoxGeometry(0.016, 0.0055, 0.006));
    const pktBodyGeo = this._trackGeo(new THREE.BoxGeometry(0.084, 0.082, 0.02));
    const pktFlapGeo = this._trackGeo(new THREE.BoxGeometry(0.088, 0.026, 0.024));
    const pktStitchHGeo = this._trackGeo(new THREE.BoxGeometry(0.078, 0.004, 0.025));
    const lowPktGeo = this._trackGeo(new THREE.BoxGeometry(0.088, 0.092, 0.024));
    const lowFlapGeo = this._trackGeo(new THREE.BoxGeometry(0.092, 0.026, 0.028));

    for (const s of [1, -1]) {
      jacketParts.push({
        geo: edgePlacketGeo,
        matIndex: 1,
        matrix: this._partTransform(s * 0.084, 1.33, 0.134, -0.05, s * 0.34, s * 0.03),
      });
      jacketParts.push({
        geo: lapelGeo,
        matIndex: 1,
        matrix: this._partTransform(s * 0.082, 1.468, 0.124, -0.14, s * 0.42, s * -0.26),
      });
      jacketParts.push({
        geo: lapelStitchGeo,
        matIndex: 2,
        matrix: this._partTransform(s * 0.096, 1.468, 0.129, -0.14, s * 0.42, s * -0.26),
      });

      // Chest flap pockets
      jacketParts.push({
        geo: pktBodyGeo,
        matIndex: 0,
        matrix: this._partTransform(s * 0.138, 1.374, 0.108, -0.06, s * 0.56, 0),
      });
      jacketParts.push({
        geo: pktFlapGeo,
        matIndex: 1,
        matrix: this._partTransform(s * 0.140, 1.408, 0.111, -0.06, s * 0.56, 0),
      });
      jacketParts.push({
        geo: pktStitchHGeo,
        matIndex: 2,
        matrix: this._partTransform(s * 0.141, 1.399, 0.112, -0.06, s * 0.56, 0),
      });
      jacketParts.push({
        geo: btnGeo,
        matIndex: 3,
        matrix: this._partTransform(s * 0.148, 1.408, 0.120, 0, s * 0.56, 0),
      });

      // Lower jacket cargo pockets on skirt hem
      jacketParts.push({
        geo: lowPktGeo,
        matIndex: 0,
        matrix: this._partTransform(s * 0.148, 0.865, 0.088, 0, s * 0.68, 0),
      });
      jacketParts.push({
        geo: lowFlapGeo,
        matIndex: 1,
        matrix: this._partTransform(s * 0.150, 0.901, 0.090, 0, s * 0.68, 0),
      });
      jacketParts.push({
        geo: btnGeo,
        matIndex: 3,
        matrix: this._partTransform(s * 0.160, 0.901, 0.099, 0, s * 0.68, 0),
      });
    }

    for (let i = 0; i < 4; i++) {
      const by = 1.422 - i * 0.068;
      const bz = 0.144 - i * 0.004;
      jacketParts.push({ geo: btnGeo, matIndex: 3, matrix: this._partTransform(-0.082, by, bz, 0, -0.34, 0) });
      jacketParts.push({ geo: tabGeo, matIndex: 2, matrix: this._partTransform(0.083, by, bz, 0, 0.34, 0) });
    }

    const jacketGeo = this._mergeToSkinnedGeometry(jacketParts, (x, y, z) =>
      this._computeSpineWeights(x, y, z, { includeClavicles: true, includeJacketHem: true })
    );
    this._createSkinnedMesh(jacketGeo, jacketMats, { name: 'SkinnedFieldJacket_liam' });

    // 4. Skinned Belt, Hollow 4-Bar Brass Buckle, Cargo Pant Pleats, Thigh Pockets & Knee Panels
    const accParts = [];
    const accMats = [this.mats.darkLeather, this.mats.brass, this.mats.pantsReinforced, this.mats.pants];

    const beltGeo = this._createSculptedLoft(
      [
        { y: 0.975, rx: 0.166, rz: 0.118, squareness: 0.24 },
        { y: 1.015, rx: 0.165, rz: 0.117, squareness: 0.24 },
      ],
      22,
      { capBottom: false, capTop: false }
    );
    accParts.push({ geo: beltGeo, matIndex: 0, region: 'pelvis' });

    const beltLoopGeo = this._trackGeo(new THREE.BoxGeometry(0.011, 0.046, 0.01));
    for (const ang of [-0.42, 0.42, 1.48, -1.48, Math.PI]) {
      accParts.push({
        geo: beltLoopGeo,
        matIndex: 2,
        region: 'pelvis',
        matrix: this._partTransform(Math.sin(ang) * 0.166, 0.995, Math.cos(ang) * 0.119, 0, ang, 0),
      });
    }

    // Hollow 4-bar brass belt buckle + prong + keeper
    const fBarH = this._trackGeo(new THREE.BoxGeometry(0.056, 0.008, 0.012));
    const fBarV = this._trackGeo(new THREE.BoxGeometry(0.008, 0.044, 0.012));
    const prongGeo = this._trackGeo(new THREE.CylinderGeometry(0.0024, 0.0024, 0.036, 8));
    prongGeo.rotateZ(Math.PI / 2);
    const keeperGeo = this._trackGeo(new THREE.BoxGeometry(0.014, 0.046, 0.014));
    accParts.push({ geo: fBarH, matIndex: 1, region: 'pelvis', matrix: this._partTransform(0, 1.013, 0.122) });
    accParts.push({ geo: fBarH, matIndex: 1, region: 'pelvis', matrix: this._partTransform(0, 0.977, 0.122) });
    accParts.push({ geo: fBarV, matIndex: 1, region: 'pelvis', matrix: this._partTransform(0.024, 0.995, 0.122) });
    accParts.push({ geo: fBarV, matIndex: 1, region: 'pelvis', matrix: this._partTransform(-0.024, 0.995, 0.122) });
    accParts.push({ geo: prongGeo, matIndex: 1, region: 'pelvis', matrix: this._partTransform(0.003, 0.995, 0.126) });
    accParts.push({ geo: keeperGeo, matIndex: 0, region: 'pelvis', matrix: this._partTransform(-0.042, 0.995, 0.120) });

    // Front cargo pleats & fly seam
    const pleatGeo = this._trackGeo(new THREE.BoxGeometry(0.011, 0.088, 0.012));
    const flyGeo = this._trackGeo(new THREE.BoxGeometry(0.014, 0.095, 0.009));
    accParts.push({ geo: flyGeo, matIndex: 2, region: 'pelvis', matrix: this._partTransform(0.004, 0.92, 0.118) });
    for (const s of [1, -1]) {
      accParts.push({ geo: pleatGeo, matIndex: 2, region: 'pelvis', matrix: this._partTransform(s * 0.056, 0.924, 0.112, 0, s * 0.24, s * -0.04) });
      accParts.push({ geo: pleatGeo, matIndex: 3, region: 'pelvis', matrix: this._partTransform(s * 0.034, 0.925, 0.116, 0, s * 0.12, 0) });
    }

    // Thigh cargo bellows pockets & reinforced knee panels
    const cargoPktGeo = this._trackGeo(new THREE.BoxGeometry(0.026, 0.135, 0.105));
    const cargoFlapGeo = this._trackGeo(new THREE.BoxGeometry(0.030, 0.032, 0.110));
    const kneePadGeo = this._trackGeo(new THREE.SphereGeometry(0.068, 14, 10, -Math.PI * 0.35, Math.PI * 0.7, Math.PI * 0.25, Math.PI * 0.5));
    kneePadGeo.rotateY(Math.PI / 2);

    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const bx = s * this.metrics.hipOffsetX;
      accParts.push({
        geo: cargoPktGeo,
        matIndex: 2,
        region: side,
        matrix: this._partTransform(bx + s * 0.086, 0.71, 0.004, 0, 0, s * 0.06),
      });
      accParts.push({
        geo: cargoFlapGeo,
        matIndex: 3,
        region: side,
        matrix: this._partTransform(bx + s * 0.090, 0.775, 0.004),
      });
      accParts.push({
        geo: kneePadGeo,
        matIndex: 2,
        region: side,
        matrix: this._partTransform(bx, 0.478, 0.012),
      });
    }

    const accGeo = this._mergeToSkinnedGeometry(accParts, (x, y, z, part) =>
      this._computeLowerBodyWeights(part.region, x, y, z)
    );
    this._createSkinnedMesh(accGeo, accMats, { name: 'SkinnedBeltAndCargo_liam' });

    // Field watch on left forearm
    const watchStrapGeo = this._trackGeo(new THREE.CylinderGeometry(0.033, 0.032, 0.022, 14));
    const watchStrap = this._makeMesh(watchStrapGeo, this.mats.darkLeather, { name: 'FieldWatchStrap' });
    watchStrap.position.set(0, -0.228, 0);
    this.bones.forearmL.add(watchStrap);
    const dialGeo = this._trackGeo(new THREE.CylinderGeometry(0.014, 0.014, 0.008, 12));
    dialGeo.rotateZ(Math.PI / 2);
    const dial = this._makeMesh(dialGeo, this.mats.brass, { name: 'FieldWatchCase' });
    dial.position.set(0.03, -0.228, 0.005);
    this.bones.forearmL.add(dial);
    void shX;

    // 5. Weathered Canvas Backpack + Rolled Blanket + Swinging Brushed-Aluminum Canteen
    this._buildLiamBackpackAndCanteen();
  }

  _buildLiamBackpackAndCanteen() {
    const { chest, backpack, canteen } = this.bones;

    const packGeo = this._createSculptedLoft(
      [
        { y: -0.22, rx: 0.142, rz: 0.082, squareness: 0.65 },
        { y: -0.14, rx: 0.158, rz: 0.095, squareness: 0.7 },
        { y: 0.02, rx: 0.156, rz: 0.094, squareness: 0.7 },
        { y: 0.135, rx: 0.145, rz: 0.085, squareness: 0.62 },
        { y: 0.165, rx: 0.115, rz: 0.062, squareness: 0.5 },
      ],
      20
    );
    const packBody = this._makeMesh(packGeo, this.mats.pack, { name: 'BackpackBody' });
    packBody.position.set(0, 0, -0.055);
    backpack.add(packBody);

    const lidGeo = this._createSculptedLoft(
      [
        { y: 0.055, rx: 0.162, rz: 0.098, squareness: 0.68 },
        { y: 0.145, rx: 0.164, rz: 0.10, squareness: 0.68 },
        { y: 0.18, rx: 0.128, rz: 0.075, squareness: 0.52 },
      ],
      20
    );
    const lid = this._makeMesh(lidGeo, this.mats.pack, { name: 'BackpackLid' });
    lid.position.set(0, 0.005, -0.062);
    backpack.add(lid);

    const pouchGeo = this._trackGeo(new THREE.BoxGeometry(0.18, 0.14, 0.058));
    const pouch = this._makeMesh(pouchGeo, this.mats.pack, { name: 'BackpackRearPouch' });
    pouch.position.set(0, -0.085, -0.155);
    backpack.add(pouch);

    const sidePktGeo = this._trackGeo(new THREE.BoxGeometry(0.052, 0.15, 0.092));
    const sidePkt = this._makeMesh(sidePktGeo, this.mats.pack, { name: 'BackpackSidePocket' });
    sidePkt.position.set(0.165, -0.07, -0.055);
    backpack.add(sidePkt);

    const strapGeo = this._trackGeo(new THREE.BoxGeometry(0.026, 0.29, 0.012));
    const buckleGeo = this._trackGeo(new THREE.BoxGeometry(0.036, 0.032, 0.018));
    for (const sx of [-0.075, 0.075]) {
      const strap = this._makeMesh(strapGeo, this.mats.darkLeather, { name: 'PackClosureStrap' });
      strap.position.set(sx, 0.02, -0.156);
      backpack.add(strap);

      const bkl = this._makeMesh(buckleGeo, this.mats.brass, { name: 'PackBuckle' });
      bkl.position.set(sx, -0.05, -0.164);
      backpack.add(bkl);
    }

    const rollGeo = this._trackGeo(new THREE.CylinderGeometry(0.062, 0.062, 0.34, 18));
    rollGeo.rotateZ(Math.PI / 2);
    const blanketRoll = this._makeMesh(rollGeo, this.mats.blanket, { name: 'RolledBlanket' });
    blanketRoll.position.set(0, 0.222, -0.055);
    backpack.add(blanketRoll);

    const lashRingGeo = this._trackGeo(new THREE.TorusGeometry(0.065, 0.0085, 8, 18));
    lashRingGeo.rotateY(Math.PI / 2);
    for (const lx of [-0.095, 0.095]) {
      const lash = this._makeMesh(lashRingGeo, this.mats.darkLeather, { name: 'BlanketLashStrap' });
      lash.position.set(lx, 0.222, -0.055);
      backpack.add(lash);
    }

    for (const s of [1, -1]) {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(s * 0.115, 0.155, -0.14),
        new THREE.Vector3(s * 0.125, 0.175, -0.02),
        new THREE.Vector3(s * 0.125, 0.125, 0.118),
        new THREE.Vector3(s * 0.132, -0.035, 0.128),
        new THREE.Vector3(s * 0.162, -0.145, 0.015),
        new THREE.Vector3(s * 0.138, -0.155, -0.135),
      ]);
      const strapTubeGeo = this._trackGeo(new THREE.TubeGeometry(curve, 22, 0.016, 8, false));
      strapTubeGeo.scale(1.2, 1.0, 0.85);
      chest.add(this._makeMesh(strapTubeGeo, this.mats.darkLeather, { name: s > 0 ? 'ShoulderStrapL' : 'ShoulderStrapR' }));

      const dRingGeo = this._trackGeo(new THREE.TorusGeometry(0.012, 0.0028, 6, 12));
      const dRing = this._makeMesh(dRingGeo, this.mats.brass, { name: `StrapRing_${s > 0 ? 'L' : 'R'}` });
      dRing.position.set(s * 0.148, 0.055, 0.118);
      chest.add(dRing);
    }

    const sternumGeo = this._trackGeo(new THREE.BoxGeometry(0.28, 0.016, 0.012));
    const sternum = this._makeMesh(sternumGeo, this.mats.darkLeather, { name: 'SternumStrap' });
    sternum.position.set(0, 0.086, 0.144);
    chest.add(sternum);
    const claspGeo = this._trackGeo(new THREE.BoxGeometry(0.028, 0.022, 0.018));
    const clasp = this._makeMesh(claspGeo, this.mats.brass, { name: 'SternumClasp' });
    clasp.position.set(0, 0.086, 0.147);
    chest.add(clasp);

    // Swinging brushed-aluminum canteen on pendulum bone `canteen`
    const hangStrapGeo = this._trackGeo(new THREE.BoxGeometry(0.016, 0.075, 0.01));
    const hangStrap = this._makeMesh(hangStrapGeo, this.mats.darkLeather, { name: 'CanteenHangStrap' });
    hangStrap.position.set(0, -0.036, 0);
    canteen.add(hangStrap);

    const hangRingGeo = this._trackGeo(new THREE.TorusGeometry(0.012, 0.0028, 6, 12));
    const hangRing = this._makeMesh(hangRingGeo, this.mats.brass, { name: 'CanteenHangRing' });
    hangRing.position.set(0, -0.005, 0);
    canteen.add(hangRing);

    const capGeo = this._trackGeo(new THREE.CylinderGeometry(0.015, 0.015, 0.022, 12));
    const cap = this._makeMesh(capGeo, this.mats.aluminum, { name: 'CanteenCap' });
    cap.position.set(0, -0.072, 0);
    canteen.add(cap);

    const flaskGeo = this._trackGeo(new THREE.SphereGeometry(0.062, 16, 14));
    flaskGeo.scale(0.56, 1.08, 0.94);
    const flask = this._makeMesh(flaskGeo, this.mats.aluminum, { name: 'CanteenFlask' });
    flask.position.set(0, -0.142, 0);
    canteen.add(flask);

    const sleeveGeo = this._trackGeo(
      new THREE.SphereGeometry(0.065, 16, 10, 0, Math.PI * 2, Math.PI * 0.48, Math.PI * 0.52)
    );
    sleeveGeo.scale(0.58, 1.06, 0.96);
    const sleeve = this._makeMesh(sleeveGeo, this.mats.pack, { name: 'CanteenSleeve' });
    sleeve.position.set(0, -0.142, 0);
    canteen.add(sleeve);
  }

  // ===========================================================================
  // PRESET 2: 'lyra' — Woodland Archer (Lyra)
  // ===========================================================================

  _buildLyraCharacter() {
    const shX = this._cfg.shoulderX;
    const as = this._cfg.armScale;

    // 1. Continuous Skinned Upper Body: Emerald woodland tunic -> bare upper forearm -> embossed leather archer bracers!
    this._buildContinuousUpperBody({
      materials: [this.mats.tunic, this.mats.tunic, this.mats.leather, this.mats.skin],
      armRings: [
        { y: 1.44, cx: shX * 0.90, rx: 0.064 * as, rz: 0.066 * as, tilt: 0.52, shFrac: 0.38, mat: 1 },
        { y: 1.41, cx: shX * 0.985, rx: 0.060 * as, rz: 0.062 * as, tilt: 0.82, shFrac: 0.72, mat: 1 },
        { y: 1.37, cx: shX, rx: 0.056 * as, rz: 0.058 * as, tilt: 1.0, shFrac: 0.96, mat: 1 },
        { y: 1.315, cx: shX, rx: 0.051 * as, rz: 0.053 * as, shFrac: 1.0, mat: 1 },
        { y: 1.26, cx: shX, rx: 0.048 * as, rz: 0.050 * as, shFrac: 1.0, mat: 1 },
        { y: 1.225, cx: shX, rx: 0.045 * as, rz: 0.046 * as, shFrac: 1.0, mat: 1 },
        { y: 1.205, cx: shX, rx: 0.043 * as, rz: 0.044 * as, shFrac: 1.0, mat: 1 },
        { y: 1.19, cx: shX, rx: 0.042 * as, rz: 0.043 * as, shFrac: 1.0, mat: 3 },
        { y: 1.17, cx: shX, rx: 0.043 * as, rz: 0.044 * as, shFrac: 1.0, mat: 3 },
        { y: 1.145, cx: shX, rx: 0.044 * as, rz: 0.045 * as, shFrac: 1.0, mat: 3 },
        // Embossed leather archer forearm bracer sleeve (y = 1.12 -> 0.97)
        { y: 1.115, cx: shX, rx: 0.048 * as, rz: 0.050 * as, shFrac: 1.0, mat: 2 },
        { y: 1.07, cx: shX, rx: 0.046 * as, rz: 0.048 * as, shFrac: 1.0, mat: 2 },
        { y: 1.02, cx: shX, rx: 0.043 * as, rz: 0.045 * as, shFrac: 1.0, mat: 2 },
        { y: 0.975, cx: shX, rx: 0.039 * as, rz: 0.042 * as, shFrac: 1.0, mat: 2 },
        { y: 0.955, cx: shX, rx: 0.031 * as, rz: 0.034 * as, shFrac: 1.0, mat: 3 },
        { y: 0.935, cx: shX, rx: 0.028 * as, rz: 0.032 * as, shFrac: 1.0, mat: 3 },
      ],
    });

    // 2. Continuous Skinned Lower Body: fitted dark moss archer breeches tapering cleanly into knee-high boots
    this._buildContinuousLowerBody({
      materials: [this.mats.pants],
    });

    // 3. Skinned Gold-Trimmed Embroidered Woodland Tunic Skirt, Corset Belt, Shoulder Trim & Forearm Bracer Buckles
    const tunicParts = [];
    const tunicMats = [this.mats.tunic, this.mats.goldTrim, this.mats.darkLeather, this.mats.leather, this.mats.brass];

    // Flared split archer tunic skirt hanging from waist (1.03) over upper thighs (0.72)
    const skirtGeo = this._createOpenSculptedShell(
      [
        { y: 0.72, rx: 0.205, rz: 0.148, backScale: 1.12, squareness: 0.22, gapHalfAngle: 0.34 },
        { y: 0.82, rx: 0.184, rz: 0.132, backScale: 1.08, squareness: 0.22, gapHalfAngle: 0.26 },
        { y: 0.92, rx: 0.168, rz: 0.120, squareness: 0.20, gapHalfAngle: 0.18 },
        { y: 1.02, rx: 0.146, rz: 0.104, squareness: 0.20, gapHalfAngle: 0.12 },
      ],
      24,
      { thickness: 0.009, uvRepeatU: 1.5, uvRepeatV: 1.0 }
    );
    tunicParts.push({ geo: skirtGeo, matIndex: 0, region: 'skirt' });

    // Gold embroidered border along bottom tunic hem
    const hemGoldGeo = this._createOpenSculptedShell(
      [
        { y: 0.716, rx: 0.208, rz: 0.151, backScale: 1.12, squareness: 0.22, gapHalfAngle: 0.34 },
        { y: 0.742, rx: 0.201, rz: 0.145, backScale: 1.10, squareness: 0.22, gapHalfAngle: 0.32 },
      ],
      24,
      { thickness: 0.006 }
    );
    tunicParts.push({ geo: hemGoldGeo, matIndex: 1, region: 'skirt' });

    // Contoured embossed leather archer waist corset-belt + antique gold leaf clasp
    const corsetGeo = this._createSculptedLoft(
      [
        { y: 0.955, rx: 0.162, rz: 0.114, squareness: 0.22 },
        { y: 1.015, rx: 0.144, rz: 0.104, squareness: 0.22 },
        { y: 1.075, rx: 0.146, rz: 0.106, squareness: 0.22 },
      ],
      24,
      { capBottom: false, capTop: false }
    );
    tunicParts.push({ geo: corsetGeo, matIndex: 2, region: 'torso' });

    // Gold filigree belt trim bands & leaf clasp
    const goldBandGeo = this._createSculptedLoft(
      [
        { y: 0.952, rx: 0.165, rz: 0.117, squareness: 0.22 },
        { y: 0.964, rx: 0.163, rz: 0.115, squareness: 0.22 },
      ],
      22,
      { capBottom: false, capTop: false }
    );
    tunicParts.push({ geo: goldBandGeo, matIndex: 1, region: 'torso' });
    const leafBuckleGeo = this._trackGeo(new THREE.OctahedronGeometry(0.026, 1));
    leafBuckleGeo.scale(1.15, 0.85, 0.35);
    tunicParts.push({ geo: leafBuckleGeo, matIndex: 1, region: 'torso', matrix: this._partTransform(0, 1.015, 0.112) });

    // Embroidered gold V-neck collar trim & chest diamond embroidery on tunic
    const vTrimGeo = this._trackGeo(new THREE.BoxGeometry(0.014, 0.135, 0.012));
    for (const s of [1, -1]) {
      tunicParts.push({
        geo: vTrimGeo,
        matIndex: 1,
        region: 'torso',
        matrix: this._partTransform(s * 0.040, 1.445, 0.112, -0.14, s * 0.24, s * 0.42),
      });
    }
    // Ornate shoulder cloak-brooch clasp on upper chest
    const broochGeo = this._trackGeo(new THREE.TorusGeometry(0.016, 0.0045, 8, 16));
    const claspBarGeo = this._trackGeo(new THREE.CylinderGeometry(0.003, 0.003, 0.12, 8));
    claspBarGeo.rotateZ(Math.PI / 2);
    tunicParts.push({ geo: claspBarGeo, matIndex: 1, region: 'torso', matrix: this._partTransform(0, 1.482, 0.106) });
    for (const s of [1, -1]) {
      tunicParts.push({ geo: broochGeo, matIndex: 1, region: 'torso', matrix: this._partTransform(s * 0.064, 1.482, 0.102, 0, s * 0.28, 0) });
    }

    // Diagonal leather quiver baldric strap across chest
    const baldricCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.115, 1.50, -0.095),
      new THREE.Vector3(-0.112, 1.505, 0.03),
      new THREE.Vector3(-0.075, 1.41, 0.128),
      new THREE.Vector3(0.025, 1.24, 0.128),
      new THREE.Vector3(0.125, 1.06, 0.088),
      new THREE.Vector3(0.148, 1.02, -0.02),
      new THREE.Vector3(0.115, 1.06, -0.115),
    ]);
    const baldricGeo = this._trackGeo(new THREE.TubeGeometry(baldricCurve, 26, 0.013, 8, false));
    baldricGeo.scale(1.0, 1.0, 0.96);
    tunicParts.push({ geo: baldricGeo, matIndex: 2, region: 'torso' });

    // Gold-buckled straps around both embossed leather forearm bracers
    const bracerStrapGeo = this._trackGeo(new THREE.TorusGeometry(0.044 * as, 0.0045, 8, 16));
    bracerStrapGeo.rotateX(Math.PI / 2);
    const bracerBklGeo = this._trackGeo(new THREE.BoxGeometry(0.010, 0.014, 0.014));
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      for (const by of [1.095, 1.045, 0.995]) {
        tunicParts.push({
          geo: bracerStrapGeo,
          matIndex: 2,
          region: `arm${side}`,
          matrix: this._partTransform(s * shX, by, 0),
        });
        tunicParts.push({
          geo: bracerBklGeo,
          matIndex: 4,
          region: `arm${side}`,
          matrix: this._partTransform(s * (shX + 0.043 * as), by, 0.008),
        });
      }
    }

    const tunicGeo = this._mergeToSkinnedGeometry(tunicParts, (x, y, z, part) => {
      if (part.region === 'armL') return this._computeArmWeights('L', x, y, z, 1.0);
      if (part.region === 'armR') return this._computeArmWeights('R', x, y, z, 1.0);
      if (part.region === 'skirt') return this._computeSpineWeights(x, y, z, { includeClavicles: false, includeJacketHem: true });
      return this._computeSpineWeights(x, y, z, { includeClavicles: true });
    });
    this._createSkinnedMesh(tunicGeo, tunicMats, { name: 'SkinnedArcherTunic_lyra' });

    // 4. High-Segment Billowing Emerald Cloak SkinnedMesh with Real GPU Vertex Cloth-Wave Shader!
    this._buildLyraEmeraldCloak();

    // 5. Embossed Leather Quiver + 7 Feathered Fletched Arrows mounted diagonally on `backpack`!
    this._buildLyraQuiverAndArrows();
  }

  _buildLyraEmeraldCloak() {
    const bi = this._boneIndex;
    const cols = 28;
    const rows = 24;
    const positions = [];
    const uvs = [];
    const skinIndices = [];
    const skinWeights = [];
    const legHeights = [];
    const sweatMasks = [];
    const clothPins = [];
    const mainIndices = [];
    const trimIndices = [];

    // Sculpted cape flowing from shoulders/collar (y = 1.505, anchored strictly with aClothPin = 0.0)
    // draping smoothly over back shoulders down past knees (y = 0.34, full billow aClothPin = 1.0)!
    for (let r = 0; r <= rows; r++) {
      const v = r / rows; // 0 = anchored collar/shoulders, 1 = bottom billowing hem
      const y = lerp(1.505, 0.34, v);
      // Graceful cape flare from narrow shoulder yoke to sweeping emerald mantle hem
      const halfArc = lerp(Math.PI * 0.48, Math.PI * 0.56, smoothstep(0.0, 0.65, v));
      const rx = lerp(0.188, 0.365, Math.pow(v, 0.82));
      const rz = lerp(0.132, 0.245, Math.pow(v, 0.88));
      const backDriftZ = -0.02 - 0.14 * Math.pow(v, 1.25);

      // Cloth pin strictly 0.0 at shoulders/collar, smoothly ramping quadratically toward bottom hem!
      const pin = Math.pow(smoothstep(0.08, 1.0, v), 1.45);

      for (let c = 0; c <= cols; c++) {
        const u = c / cols; // 0 = right front shoulder edge -> 0.5 = center back -> 1 = left front shoulder edge
        const sAngle = lerp(-halfArc, halfArc, u);
        // Angle 0 points straight -Z (center back); ±halfArc wraps forward toward shoulders!
        const x = Math.sin(sAngle) * rx;
        const baseZ = -Math.cos(sAngle) * rz + backDriftZ;
        // Subtle natural vertical fabric drape folds baked into rest mesh
        const fold = Math.sin(u * Math.PI * 7.0) * 0.012 * smoothstep(0.1, 0.9, v);
        const z = baseZ + fold;

        positions.push(x, y, z);
        uvs.push(u * 2.0, v * 2.2);
        legHeights.push(Math.max(0.0, y));
        sweatMasks.push(0.2);
        clothPins.push(pin);

        // Smooth skin weights: anchored to chest/clavicleL/R at shoulders -> blending cleanly into `cloak` spring bone!
        const wCloak = cosBlend(smoothstep(0.06, 0.46, v));
        const wShoulder = 1.0 - wCloak;
        const lat = cosBlend((Math.abs(x) - 0.06) / 0.12);
        const wClav = wShoulder * lat * 0.55;
        const wChest = Math.max(0.0, wShoulder - wClav);

        const packed = packSkinWeights(
          [
            { boneIdx: bi.cloak, weight: wCloak },
            { boneIdx: bi.chest, weight: wChest },
            { boneIdx: x >= 0 ? bi.clavicleL : bi.clavicleR, weight: wClav },
          ],
          bi.chest
        );
        skinIndices.push(packed.indices[0], packed.indices[1], packed.indices[2], packed.indices[3]);
        skinWeights.push(packed.weights[0], packed.weights[1], packed.weights[2], packed.weights[3]);
      }
    }

    const stride = cols + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * stride + c;
        const b = a + 1;
        const d = (r + 1) * stride + c;
        const e = d + 1;
        const isBorder = r >= rows - 2 || c === 0 || c === cols - 1;
        const target = isBorder ? trimIndices : mainIndices;
        target.push(a, d, e, a, e, b);
      }
    }

    const geo = new THREE.BufferGeometry();
    const allIndices = mainIndices.concat(trimIndices);
    geo.addGroup(0, mainIndices.length, 0);
    geo.addGroup(mainIndices.length, trimIndices.length, 1);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    geo.setAttribute('aLegHeight', new THREE.Float32BufferAttribute(legHeights, 1));
    geo.setAttribute('aSweatMask', new THREE.Float32BufferAttribute(sweatMasks, 1));
    geo.setAttribute('aClothPin', new THREE.Float32BufferAttribute(clothPins, 1));
    geo.setIndex(allIndices);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    this._trackGeo(geo);
    this._createSkinnedMesh(geo, [this.mats.cloak, this.mats.cloakGoldTrim], { name: 'SkinnedEmeraldCloak_lyra' });
  }

  _buildLyraQuiverAndArrows() {
    const { backpack } = this.bones;

    const quiverGrp = new THREE.Group();
    quiverGrp.name = 'LyraQuiverGroup';
    // Strapped diagonally across upper back (arrow fletchings fan clearly above her right shoulder!)
    quiverGrp.position.set(-0.02, 0.01, -0.035);
    quiverGrp.rotation.set(0.14, 0.08, 0.44);

    const quiverTubeGeo = this._createSculptedLoft(
      [
        { y: -0.24, rx: 0.036, rz: 0.032 },
        { y: -0.14, rx: 0.044, rz: 0.039 },
        { y: 0.04, rx: 0.051, rz: 0.045 },
        { y: 0.16, rx: 0.056, rz: 0.049 },
      ],
      16,
      { capBottom: true, capTop: false }
    );
    quiverGrp.add(this._makeMesh(quiverTubeGeo, this.mats.leather, { name: 'QuiverBody' }));

    const rimBandGeo = this._trackGeo(new THREE.TorusGeometry(0.054, 0.0065, 8, 18));
    rimBandGeo.rotateX(Math.PI / 2);
    for (const ry of [0.155, 0.03, -0.16]) {
      const band = this._makeMesh(rimBandGeo, ry > 0.1 ? this.mats.goldTrim : this.mats.darkLeather, { name: 'QuiverBand' });
      band.position.set(0, ry, 0);
      const sc = ry > 0.1 ? 1.02 : ry > 0 ? 0.94 : 0.80;
      band.scale.set(sc, 1.0, sc * 0.90);
      quiverGrp.add(band);
    }

    // 7 individually sculpted feathered fletched arrows!
    const shaftGeo = this._trackGeo(new THREE.CylinderGeometry(0.0034, 0.0038, 0.30, 8));
    const nockGeo = this._trackGeo(new THREE.SphereGeometry(0.0046, 6, 6));
    const vaneGeo = this._trackGeo(new THREE.PlaneGeometry(0.014, 0.068));
    const fletchMats = [this.mats.fletchCream, this.mats.fletchEmerald, this.mats.fletchCrimson];

    const arrowOffsets = [
      { x: 0.0, z: 0.0, rx: 0.02, rz: 0.0, dy: 0.018 },
      { x: 0.022, z: 0.012, rx: 0.08, rz: -0.11, dy: 0.008 },
      { x: -0.022, z: 0.014, rx: 0.09, rz: 0.10, dy: 0.012 },
      { x: 0.024, z: -0.014, rx: -0.09, rz: -0.12, dy: 0.004 },
      { x: -0.024, z: -0.014, rx: -0.08, rz: 0.12, dy: 0.006 },
      { x: 0.004, z: 0.024, rx: 0.14, rz: -0.02, dy: 0.014 },
      { x: -0.004, z: -0.024, rx: -0.13, rz: 0.03, dy: 0.002 },
    ];

    arrowOffsets.forEach((a, idx) => {
      const arrowGrp = new THREE.Group();
      arrowGrp.name = `QuiverArrow_${idx}`;
      arrowGrp.position.set(a.x, 0.18 + a.dy, a.z);
      arrowGrp.rotation.set(a.rx, idx * 0.9, a.rz);

      const shaft = this._makeMesh(shaftGeo, this.mats.arrowShaft, { name: `ArrowShaft_${idx}` });
      arrowGrp.add(shaft);

      const nock = this._makeMesh(nockGeo, this.mats.goldTrim, { name: `ArrowNock_${idx}`, castShadow: false });
      nock.position.set(0, 0.152, 0);
      arrowGrp.add(nock);

      // 3 radial feathered fletching vanes per arrow!
      const fMat = fletchMats[idx % fletchMats.length];
      for (let v = 0; v < 3; v++) {
        const ang = (v / 3) * Math.PI * 2;
        const vane = this._makeMesh(vaneGeo, fMat, { name: `ArrowFletch_${idx}_${v}`, castShadow: false });
        vane.position.set(Math.cos(ang) * 0.0085, 0.108, Math.sin(ang) * 0.0085);
        vane.rotation.y = -ang;
        arrowGrp.add(vane);
      }
      quiverGrp.add(arrowGrp);
    });

    backpack.add(quiverGrp);
  }

  // ===========================================================================
  // PRESET 3: 'kael' — Cyber Scout (Kael)
  // ===========================================================================

  _buildKaelCharacter() {
    const shX = this._cfg.shoulderX;
    const as = this._cfg.armScale;

    // 1. Continuous Skinned Upper Body: Matte-carbon hexagonal weave exo-suit + sleeves + armored forearms
    this._buildContinuousUpperBody({
      materials: [this.mats.carbonMatte, this.mats.carbon, this.mats.carbonMatte, this.mats.skin],
      armRings: [
        { y: 1.44, cx: shX * 0.90, rx: 0.070 * as, rz: 0.072 * as, tilt: 0.52, shFrac: 0.38, mat: 1 },
        { y: 1.41, cx: shX * 0.985, rx: 0.065 * as, rz: 0.067 * as, tilt: 0.82, shFrac: 0.72, mat: 1 },
        { y: 1.37, cx: shX, rx: 0.061 * as, rz: 0.063 * as, tilt: 1.0, shFrac: 0.96, mat: 1 },
        { y: 1.315, cx: shX, rx: 0.055 * as, rz: 0.057 * as, shFrac: 1.0, mat: 1 },
        { y: 1.26, cx: shX, rx: 0.051 * as, rz: 0.053 * as, shFrac: 1.0, mat: 2 },
        { y: 1.225, cx: shX, rx: 0.049 * as, rz: 0.050 * as, shFrac: 1.0, mat: 2 },
        { y: 1.205, cx: shX, rx: 0.047 * as, rz: 0.048 * as, shFrac: 1.0, mat: 2 },
        { y: 1.19, cx: shX, rx: 0.046 * as, rz: 0.047 * as, shFrac: 1.0, mat: 2 },
        { y: 1.17, cx: shX, rx: 0.047 * as, rz: 0.048 * as, shFrac: 1.0, mat: 1 },
        { y: 1.145, cx: shX, rx: 0.050 * as, rz: 0.052 * as, shFrac: 1.0, mat: 1 },
        { y: 1.10, cx: shX, rx: 0.047 * as, rz: 0.049 * as, shFrac: 1.0, mat: 1 },
        { y: 1.04, cx: shX, rx: 0.042 * as, rz: 0.044 * as, shFrac: 1.0, mat: 1 },
        { y: 0.985, cx: shX, rx: 0.037 * as, rz: 0.040 * as, shFrac: 1.0, mat: 2 },
        { y: 0.955, cx: shX, rx: 0.033 * as, rz: 0.036 * as, shFrac: 1.0, mat: 2 },
        { y: 0.935, cx: shX, rx: 0.030 * as, rz: 0.033 * as, shFrac: 1.0, mat: 2 },
      ],
    });

    // 2. Continuous Skinned Lower Body: Paneled slate tech-wear trousers
    this._buildContinuousLowerBody({
      materials: [this.mats.techPants],
    });

    // 3. Continuous Skinned Matte-Carbon Hex-Weave Exo-Jacket + Glowing HDR Cyan Trim Strips!
    const exoParts = [];
    const exoMats = [this.mats.carbon, this.mats.carbonMatte, this.mats.cyanGlow, this.mats.titanium];

    const exoShellGeo = this._createOpenSculptedShell(
      [
        { y: 0.93, rx: 0.168, rz: 0.118, squareness: 0.42, gapHalfAngle: 0.34 },
        { y: 1.03, rx: 0.165, rz: 0.116, squareness: 0.42, gapHalfAngle: 0.30 },
        { y: 1.15, rx: 0.180, rz: 0.128, frontScale: 1.06, squareness: 0.45, gapHalfAngle: 0.28 },
        { y: 1.28, rx: 0.198, rz: 0.136, frontScale: 1.12, squareness: 0.48, gapHalfAngle: 0.28 },
        { y: 1.40, rx: 0.208, rz: 0.140, frontScale: 1.12, squareness: 0.50, gapHalfAngle: 0.32 },
        { y: 1.48, rx: 0.194, rz: 0.124, frontScale: 1.04, squareness: 0.42, gapHalfAngle: 0.42 },
        { y: 1.52, rx: 0.135, rz: 0.098, squareness: 0.30, gapHalfAngle: 0.52 },
      ],
      24,
      { thickness: 0.013, uvRepeatU: 2.2, uvRepeatV: 2.0 }
    );
    exoParts.push({ geo: exoShellGeo, matIndex: 0, region: 'torso' });

    // High angular tactical collar with glowing HDR cyan upper rim!
    const techCollarGeo = this._createOpenSculptedShell(
      [
        { y: 1.50, rx: 0.095, rz: 0.096, backScale: 1.15, squareness: 0.38, gapHalfAngle: 0.62 },
        { y: 1.565, rx: 0.106, rz: 0.104, backScale: 1.20, squareness: 0.42, gapHalfAngle: 0.68 },
      ],
      20,
      { thickness: 0.012 }
    );
    exoParts.push({ geo: techCollarGeo, matIndex: 1, region: 'torso' });

    const collarGlowGeo = this._createOpenSculptedShell(
      [
        { y: 1.562, rx: 0.108, rz: 0.106, backScale: 1.20, squareness: 0.42, gapHalfAngle: 0.68 },
        { y: 1.573, rx: 0.109, rz: 0.107, backScale: 1.20, squareness: 0.42, gapHalfAngle: 0.70 },
      ],
      20,
      { thickness: 0.008 }
    );
    exoParts.push({ geo: collarGlowGeo, matIndex: 2, region: 'torso' });

    // Angular chest armor chevron plates & glowing HDR cyan luminous strips!
    const chestPlateGeo = this._trackGeo(new THREE.BoxGeometry(0.11, 0.11, 0.022));
    const glowStripLongGeo = this._trackGeo(new THREE.BoxGeometry(0.011, 0.24, 0.011));
    const glowChevGeo = this._trackGeo(new THREE.BoxGeometry(0.098, 0.011, 0.014));
    const shoulderPlateGeo = this._trackGeo(new THREE.BoxGeometry(0.072, 0.088, 0.115));
    const armGlowGeo = this._trackGeo(new THREE.BoxGeometry(0.010, 0.155, 0.012));

    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      exoParts.push({
        geo: chestPlateGeo,
        matIndex: 1,
        region: 'torso',
        matrix: this._partTransform(s * 0.088, 1.385, 0.132, -0.10, s * 0.28, s * -0.08),
      });
      // Luminous cyan front vertical zipper/exo-rail strips
      exoParts.push({
        geo: glowStripLongGeo,
        matIndex: 2,
        region: 'torso',
        matrix: this._partTransform(s * 0.058, 1.24, 0.136, -0.05, s * 0.22, s * 0.05),
      });
      // Luminous cyan chest chevron wings
      exoParts.push({
        geo: glowChevGeo,
        matIndex: 2,
        region: 'torso',
        matrix: this._partTransform(s * 0.094, 1.348, 0.140, -0.10, s * 0.30, s * 0.26),
      });
      // Sculpted carbon shoulder pauldron + glowing cyan shoulder/forearm conduit strips
      exoParts.push({
        geo: shoulderPlateGeo,
        matIndex: 0,
        region: `arm${side}`,
        matrix: this._partTransform(s * (shX + 0.036), 1.43, 0, 0, 0, s * -0.22),
      });
      exoParts.push({
        geo: armGlowGeo,
        matIndex: 2,
        region: `arm${side}`,
        matrix: this._partTransform(s * (shX + 0.056), 1.33, 0.014, 0, 0, s * -0.04),
      });
      exoParts.push({
        geo: armGlowGeo,
        matIndex: 2,
        region: `arm${side}`,
        matrix: this._partTransform(s * (shX + 0.046), 1.07, 0.012, 0, 0, 0),
      });
    }

    // Center spine cyan telemetry conduit on back
    const spineGlowGeo = this._trackGeo(new THREE.BoxGeometry(0.016, 0.26, 0.014));
    exoParts.push({ geo: spineGlowGeo, matIndex: 2, region: 'torso', matrix: this._partTransform(0, 1.15, -0.132) });

    // Tactical carbon belt + glowing cyan status buckle bar
    const techBeltGeo = this._createSculptedLoft(
      [
        { y: 0.955, rx: 0.168, rz: 0.119, squareness: 0.38 },
        { y: 1.005, rx: 0.167, rz: 0.118, squareness: 0.38 },
      ],
      22,
      { capBottom: false, capTop: false }
    );
    exoParts.push({ geo: techBeltGeo, matIndex: 1, region: 'torso' });
    const techBklGeo = this._trackGeo(new THREE.BoxGeometry(0.072, 0.042, 0.018));
    const techBklGlowGeo = this._trackGeo(new THREE.BoxGeometry(0.054, 0.011, 0.022));
    exoParts.push({ geo: techBklGeo, matIndex: 3, region: 'torso', matrix: this._partTransform(0, 0.98, 0.122) });
    exoParts.push({ geo: techBklGlowGeo, matIndex: 2, region: 'torso', matrix: this._partTransform(0, 0.98, 0.125) });

    const exoGeo = this._mergeToSkinnedGeometry(exoParts, (x, y, z, part) => {
      if (part.region === 'armL') return this._computeArmWeights('L', x, y, z, y > 1.38 ? 0.85 : 1.0);
      if (part.region === 'armR') return this._computeArmWeights('R', x, y, z, y > 1.38 ? 0.85 : 1.0);
      return this._computeSpineWeights(x, y, z, { includeClavicles: true });
    });
    this._createSkinnedMesh(exoGeo, exoMats, { name: 'SkinnedExoJacket_kael' });

    // 4. Skinned Carbon Thigh Tech-Panels, Geometric Knee Guards & Cyan Leg Strips
    const legTechParts = [];
    const thighPanelGeo = this._trackGeo(new THREE.BoxGeometry(0.022, 0.18, 0.092));
    const legGlowGeo = this._trackGeo(new THREE.BoxGeometry(0.008, 0.15, 0.010));
    const kneeArmorGeo = this._trackGeo(new THREE.BoxGeometry(0.088, 0.096, 0.032));
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const bx = s * this.metrics.hipOffsetX;
      legTechParts.push({
        geo: thighPanelGeo,
        matIndex: 0,
        side,
        matrix: this._partTransform(bx + s * 0.084, 0.72, 0.004, 0, 0, s * 0.05),
      });
      legTechParts.push({
        geo: legGlowGeo,
        matIndex: 2,
        side,
        matrix: this._partTransform(bx + s * 0.096, 0.72, 0.024, 0, 0, s * 0.05),
      });
      legTechParts.push({
        geo: kneeArmorGeo,
        matIndex: 1,
        side,
        matrix: this._partTransform(bx, 0.482, 0.068, 0.06, 0, 0),
      });
      legTechParts.push({
        geo: legGlowGeo,
        matIndex: 2,
        side,
        matrix: this._partTransform(bx + s * 0.062, 0.28, 0.012),
      });
    }
    const legTechGeo = this._mergeToSkinnedGeometry(legTechParts, (x, y, z, part) =>
      this._computeLowerBodyWeights(part.side, x, y, z)
    );
    this._createSkinnedMesh(legTechGeo, exoMats, { name: 'SkinnedLegTech_kael' });

    // 5. Compact Angular Carbon Thruster-Pack on `backpack` + Power Cell on `canteen`
    this._buildKaelThrusterPack();
  }

  _buildKaelThrusterPack() {
    const { chest, backpack, canteen } = this.bones;

    // Faceted angular matte-carbon thruster chassis
    const chassisGeo = this._createSculptedLoft(
      [
        { y: -0.16, rx: 0.105, rz: 0.052, squareness: 0.85 },
        { y: -0.06, rx: 0.132, rz: 0.068, squareness: 0.88 },
        { y: 0.08, rx: 0.138, rz: 0.072, squareness: 0.88 },
        { y: 0.155, rx: 0.102, rz: 0.052, squareness: 0.82 },
      ],
      12
    );
    const chassis = this._makeMesh(chassisGeo, this.mats.carbon, { name: 'ThrusterChassis' });
    chassis.position.set(0, 0.01, -0.045);
    backpack.add(chassis);

    // Center glowing HDR cyan vertical plasma-core energy spine
    const coreGeo = this._trackGeo(new THREE.BoxGeometry(0.026, 0.22, 0.018));
    const core = this._makeMesh(coreGeo, this.mats.cyanGlow, { name: 'ThrusterEnergyCore', castShadow: false });
    core.position.set(0, 0.015, -0.118);
    backpack.add(core);

    // Twin angled directional carbon micro-thruster nozzles with glowing cyan inner rings
    const nozzleGeo = this._trackGeo(new THREE.CylinderGeometry(0.024, 0.036, 0.076, 12));
    const nozzleGlowGeo = this._trackGeo(new THREE.TorusGeometry(0.026, 0.0055, 6, 14));
    nozzleGlowGeo.rotateX(Math.PI / 2);
    for (const s of [1, -1]) {
      const nGrp = new THREE.Group();
      nGrp.position.set(s * 0.086, -0.145, -0.068);
      nGrp.rotation.set(-0.24, 0, s * -0.18);
      nGrp.add(this._makeMesh(nozzleGeo, this.mats.titanium, { name: `ThrusterNozzle_${s > 0 ? 'L' : 'R'}` }));
      const ng = this._makeMesh(nozzleGlowGeo, this.mats.cyanGlow, { name: `ThrusterGlow_${s > 0 ? 'L' : 'R'}`, castShadow: false });
      ng.position.set(0, -0.036, 0);
      nGrp.add(ng);
      backpack.add(nGrp);

      // Angled upper winglet vents
      const wingGeo = this._trackGeo(new THREE.BoxGeometry(0.046, 0.11, 0.018));
      const wing = this._makeMesh(wingGeo, this.mats.carbonMatte, { name: `ThrusterWing_${s > 0 ? 'L' : 'R'}` });
      wing.position.set(s * 0.132, 0.095, -0.056);
      wing.rotation.z = s * -0.28;
      backpack.add(wing);
    }

    // Compact tactical telemetry antenna fin on upper-left pack corner
    const antGeo = this._trackGeo(new THREE.CylinderGeometry(0.0025, 0.0045, 0.19, 6));
    const ant = this._makeMesh(antGeo, this.mats.titanium, { name: 'ThrusterAntenna' });
    ant.position.set(0.098, 0.215, -0.052);
    ant.rotation.x = -0.16;
    backpack.add(ant);
    const antTipGeo = this._trackGeo(new THREE.SphereGeometry(0.006, 6, 6));
    const antTip = this._makeMesh(antTipGeo, this.mats.cyanGlow, { name: 'ThrusterAntennaTip', castShadow: false });
    antTip.position.set(0.098, 0.308, -0.068);
    backpack.add(antTip);

    // Carbon shoulder harness straps hugging upper chest
    for (const s of [1, -1]) {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(s * 0.105, 0.155, -0.14),
        new THREE.Vector3(s * 0.118, 0.172, -0.01),
        new THREE.Vector3(s * 0.115, 0.115, 0.125),
        new THREE.Vector3(s * 0.125, -0.04, 0.128),
        new THREE.Vector3(s * 0.145, -0.14, -0.02),
      ]);
      const hGeo = this._trackGeo(new THREE.TubeGeometry(curve, 18, 0.013, 6, false));
      chest.add(this._makeMesh(hGeo, this.mats.carbonMatte, { name: `ExoHarness_${s > 0 ? 'L' : 'R'}` }));
    }

    // Swinging compact cyan plasma power-cell pod on `canteen` spring bone
    const cellGeo = this._trackGeo(new THREE.CylinderGeometry(0.024, 0.024, 0.095, 10));
    const cell = this._makeMesh(cellGeo, this.mats.carbonMatte, { name: 'PowerCellBody' });
    cell.position.set(0, -0.068, 0);
    canteen.add(cell);
    const cellGlowGeo = this._trackGeo(new THREE.CylinderGeometry(0.0255, 0.0255, 0.032, 10));
    const cellGlow = this._makeMesh(cellGlowGeo, this.mats.cyanGlow, { name: 'PowerCellGlow', castShadow: false });
    cellGlow.position.set(0, -0.068, 0);
    canteen.add(cellGlow);
  }

  // ===========================================================================
  // PRESET 4: 'kenji' — Wandering Ronin (Kenji)
  // ===========================================================================

  _buildKenjiCharacter() {
    const shX = this._cfg.shoulderX;
    const as = this._cfg.armScale;
    const ls = this._cfg.legScale;

    // 1. Continuous Skinned Upper Body: Indigo kosode torso + wide draped indigo haori sleeves + bare forearms
    this._buildContinuousUpperBody({
      materials: [this.mats.kosode, this.mats.haori, this.mats.kosode, this.mats.skin],
      armRings: [
        { y: 1.44, cx: shX * 0.90, rx: 0.078 * as, rz: 0.088 * as, tilt: 0.52, shFrac: 0.38, mat: 1 },
        { y: 1.40, cx: shX * 0.985, rx: 0.076 * as, rz: 0.086 * as, tilt: 0.82, shFrac: 0.72, mat: 1 },
        { y: 1.35, cx: shX, rx: 0.074 * as, rz: 0.086 * as, tilt: 1.0, shFrac: 0.96, mat: 1 },
        { y: 1.29, cx: shX, rx: 0.072 * as, rz: 0.086 * as, shFrac: 1.0, mat: 1 },
        { y: 1.24, cx: shX, rx: 0.070 * as, rz: 0.084 * as, shFrac: 1.0, mat: 1 },
        { y: 1.21, cx: shX, rx: 0.068 * as, rz: 0.082 * as, shFrac: 1.0, mat: 1 },
        { y: 1.19, cx: shX, rx: 0.066 * as, rz: 0.080 * as, shFrac: 1.0, mat: 1 },
        { y: 1.16, cx: shX, rx: 0.068 * as, rz: 0.082 * as, shFrac: 1.0, mat: 1 },
        { y: 1.115, cx: shX, rx: 0.064 * as, rz: 0.074 * as, shFrac: 1.0, mat: 1 },
        // Taper from wide kimono/haori sleeve into tied forearm wrist-wrap (tekko) & skin
        { y: 1.08, cx: shX, rx: 0.044 * as, rz: 0.046 * as, shFrac: 1.0, mat: 2 },
        { y: 1.03, cx: shX, rx: 0.039 * as, rz: 0.041 * as, shFrac: 1.0, mat: 2 },
        { y: 0.985, cx: shX, rx: 0.035 * as, rz: 0.038 * as, shFrac: 1.0, mat: 2 },
        { y: 0.955, cx: shX, rx: 0.031 * as, rz: 0.035 * as, shFrac: 1.0, mat: 3 },
        { y: 0.935, cx: shX, rx: 0.029 * as, rz: 0.033 * as, shFrac: 1.0, mat: 3 },
      ],
    });

    // 2. Continuous Skinned Lower Body: Flowing wide dark box-pleated Hakama trousers tapering into wrapped Kyahan shin guards!
    this._buildContinuousLowerBody({
      materials: [this.mats.hakama, this.mats.kyahan],
      isHakama: true,
      legRings: [
        { y: 0.815, rx: 0.118 * ls, rz: 0.124 * ls, blend: 0.62, pleatAmp: 0.06, clothPin: 0.08, mat: 0 },
        { y: 0.74, rx: 0.126 * ls, rz: 0.132 * ls, frontScale: 1.08, backScale: 1.12, pleatAmp: 0.085, clothPin: 0.20, mat: 0 },
        { y: 0.65, rx: 0.128 * ls, rz: 0.134 * ls, frontScale: 1.08, backScale: 1.12, pleatAmp: 0.095, clothPin: 0.35, mat: 0 },
        { y: 0.56, rx: 0.124 * ls, rz: 0.130 * ls, frontScale: 1.06, backScale: 1.10, pleatAmp: 0.095, clothPin: 0.50, mat: 0 },
        // Dense 5-ring knee deformation zone with deep dramatic hakama pleats
        { y: 0.52, rx: 0.120 * ls, rz: 0.126 * ls, frontScale: 1.06, backScale: 1.08, pleatAmp: 0.09, clothPin: 0.60, mat: 0 },
        { y: 0.495, rx: 0.116 * ls, rz: 0.122 * ls, frontScale: 1.06, backScale: 1.08, pleatAmp: 0.085, clothPin: 0.68, mat: 0 },
        { y: 0.475, rx: 0.114 * ls, rz: 0.120 * ls, frontScale: 1.06, backScale: 1.08, pleatAmp: 0.085, clothPin: 0.74, mat: 0 },
        { y: 0.445, rx: 0.112 * ls, rz: 0.118 * ls, backScale: 1.10, pleatAmp: 0.085, clothPin: 0.82, mat: 0 },
        { y: 0.39, rx: 0.108 * ls, rz: 0.114 * ls, backScale: 1.10, pleatAmp: 0.08, clothPin: 0.90, mat: 0 },
        // Tucked neatly into wrapped kyahan cloth calf guards!
        { y: 0.33, rx: 0.068 * ls, rz: 0.074 * ls, backScale: 1.16, pleatAmp: 0.0, clothPin: 0.0, mat: 1 },
        { y: 0.25, rx: 0.063 * ls, rz: 0.068 * ls, backScale: 1.12, pleatAmp: 0.0, clothPin: 0.0, mat: 1 },
        { y: 0.16, rx: 0.056 * ls, rz: 0.060 * ls, pleatAmp: 0.0, clothPin: 0.0, mat: 1 },
        { y: 0.105, rx: 0.052 * ls, rz: 0.055 * ls, pleatAmp: 0.0, clothPin: 0.0, mat: 1 },
        { y: 0.072, rx: 0.048 * ls, rz: 0.051 * ls, pleatAmp: 0.0, clothPin: 0.0, mat: 1 },
      ],
    });

    // 3. Continuous Skinned Deep-Indigo Haori Coat + Crisp White Mon Crests + Ivory Juban Collar + Woven Obi Sash
    const haoriParts = [];
    const haoriMats = [this.mats.haori, this.mats.monCrest, this.mats.juban, this.mats.obi, this.mats.cord];

    // Draped open-front indigo haori coat from mid-thigh (0.71) up over shoulders (1.51) with subtle cloth flutter!
    const haoriGeo = this._createOpenSculptedShell(
      [
        { y: 0.71, rx: 0.228, rz: 0.162, backScale: 1.14, squareness: 0.28, gapHalfAngle: 0.56 },
        { y: 0.82, rx: 0.212, rz: 0.150, backScale: 1.10, squareness: 0.28, gapHalfAngle: 0.52 },
        { y: 0.94, rx: 0.198, rz: 0.140, backScale: 1.06, squareness: 0.28, gapHalfAngle: 0.48 },
        { y: 1.06, rx: 0.192, rz: 0.136, squareness: 0.28, gapHalfAngle: 0.46 },
        { y: 1.20, rx: 0.200, rz: 0.140, frontScale: 1.06, squareness: 0.30, gapHalfAngle: 0.44 },
        { y: 1.35, rx: 0.214, rz: 0.146, frontScale: 1.10, squareness: 0.32, gapHalfAngle: 0.44 },
        { y: 1.46, rx: 0.206, rz: 0.132, frontScale: 1.04, squareness: 0.28, gapHalfAngle: 0.48 },
        { y: 1.515, rx: 0.146, rz: 0.102, squareness: 0.20, gapHalfAngle: 0.55 },
      ],
      24,
      { thickness: 0.010, uvRepeatU: 1.6, uvRepeatV: 1.8 }
    );
    haoriParts.push({
      geo: haoriGeo,
      matIndex: 0,
      pinFn: (_x, y) => Math.pow(smoothstep(1.06, 0.71, y), 1.35),
    });

    // Crisp white circular Japanese mon family crest on upper back + twin chest crests!
    const backCrestGeo = this._trackGeo(new THREE.PlaneGeometry(0.115, 0.115));
    haoriParts.push({
      geo: backCrestGeo,
      matIndex: 1,
      matrix: this._partTransform(0, 1.395, -0.149, 0, Math.PI, 0),
    });
    const chestCrestGeo = this._trackGeo(new THREE.PlaneGeometry(0.052, 0.052));
    for (const s of [1, -1]) {
      haoriParts.push({
        geo: chestCrestGeo,
        matIndex: 1,
        matrix: this._partTransform(s * 0.124, 1.385, 0.132, -0.06, s * 0.46, 0),
      });
    }

    // Crisp ivory-cream crossed inner kimono collar (juban) peeking cleanly at chest V-neck
    const jubanStripGeo = this._trackGeo(new THREE.BoxGeometry(0.028, 0.185, 0.012));
    haoriParts.push({
      geo: jubanStripGeo,
      matIndex: 2,
      matrix: this._partTransform(0.022, 1.438, 0.116, -0.14, 0.18, 0.34),
    });
    haoriParts.push({
      geo: jubanStripGeo,
      matIndex: 2,
      matrix: this._partTransform(-0.022, 1.438, 0.120, -0.14, -0.18, -0.34),
    });

    // Braided crimson silk haori-himo chest tie bridging the open haori lapels
    const himoCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.092, 1.325, 0.138),
      new THREE.Vector3(0.042, 1.312, 0.148),
      new THREE.Vector3(0.0, 1.306, 0.151),
      new THREE.Vector3(-0.042, 1.312, 0.148),
      new THREE.Vector3(-0.092, 1.325, 0.138),
    ]);
    const himoGeo = this._trackGeo(new THREE.TubeGeometry(himoCurve, 16, 0.0062, 6, false));
    haoriParts.push({ geo: himoGeo, matIndex: 4 });
    const himoKnotGeo = this._trackGeo(new THREE.SphereGeometry(0.011, 8, 8));
    haoriParts.push({ geo: himoKnotGeo, matIndex: 4, matrix: this._partTransform(0, 1.306, 0.152) });

    // Thick woven crimson-gold brocade OBI waist sash with sculpted rear knot!
    const obiGeo = this._createSculptedLoft(
      [
        { y: 0.93, rx: 0.178, rz: 0.128, backScale: 1.08, squareness: 0.25 },
        { y: 0.995, rx: 0.176, rz: 0.126, backScale: 1.06, squareness: 0.25 },
        { y: 1.055, rx: 0.174, rz: 0.124, squareness: 0.24 },
      ],
      24,
      { capBottom: false, capTop: false, uvRepeatU: 2.0, uvRepeatV: 1.0 }
    );
    haoriParts.push({ geo: obiGeo, matIndex: 3 });

    const obiKnotGeo = this._trackGeo(new THREE.BoxGeometry(0.115, 0.072, 0.048));
    haoriParts.push({ geo: obiKnotGeo, matIndex: 3, matrix: this._partTransform(0, 0.995, -0.144, 0.08, 0, 0.12) });

    const haoriMerged = this._mergeToSkinnedGeometry(haoriParts, (x, y, z) =>
      this._computeSpineWeights(x, y, z, { includeClavicles: true, includeJacketHem: true })
    );
    this._createSkinnedMesh(haoriMerged, haoriMats, { name: 'SkinnedHaoriAndObi_kenji' });

    // 4. Crisscrossed kyahan shin-wrap binding cords skinned cleanly on shins
    const cordParts = [];
    const shinCordGeo = this._trackGeo(new THREE.TorusGeometry(0.066, 0.0045, 6, 18));
    shinCordGeo.rotateX(Math.PI / 2);
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const bx = s * this.metrics.hipOffsetX;
      for (let i = 0; i < 4; i++) {
        const cy = 0.14 + i * 0.055;
        const sc = lerp(0.86, 1.04, i / 3);
        cordParts.push({
          geo: shinCordGeo,
          matIndex: 0,
          side,
          matrix: this._partTransform(bx, cy, -0.002, (i & 1 ? 0.12 : -0.12), 0, 0, sc, 1, sc * 1.05),
        });
      }
    }
    const cordGeo = this._mergeToSkinnedGeometry(cordParts, (x, y, z, part) =>
      this._computeLowerBodyWeights(part.side, x, y, z)
    );
    this._createSkinnedMesh(cordGeo, [this.mats.cord], { name: 'SkinnedKyahanCords_kenji' });

    // 5. Carved Wooden Bokken & Glossy Lacquered Scabbard mounted at LEFT hip on swinging `canteen` bone!
    this._buildKenjiBokkenAndScabbard();
  }

  _buildKenjiBokkenAndScabbard() {
    // `canteen` bone is placed at Kenji's LEFT hip (+0.168, 0.015, -0.015 on hips) so it swings naturally!
    const { canteen } = this.bones;

    const weaponGrp = new THREE.Group();
    weaponGrp.name = 'KenjiBokkenScabbardGroup';
    // Tucked diagonally through left obi sash: hilt angled forward-up (+Z, +Y), scabbard trailing backward-down (-Z, -Y)
    weaponGrp.position.set(0.015, 0.01, 0.02);
    weaponGrp.rotation.set(0.46, 0.14, 0.08);

    // Curved glossy black-crimson lacquered scabbard (saya)
    const sayaCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.0, 0.02, 0.08),
      new THREE.Vector3(0.0, 0.00, -0.12),
      new THREE.Vector3(0.0, -0.032, -0.34),
      new THREE.Vector3(0.0, -0.078, -0.58),
    ]);
    const sayaGeo = this._trackGeo(new THREE.TubeGeometry(sayaCurve, 22, 0.0165, 10, false));
    sayaGeo.scale(0.68, 1.15, 1.0);
    weaponGrp.add(this._makeMesh(sayaGeo, this.mats.lacquer, { name: 'ScabbardSaya' }));

    // Brass scabbard mouth (koiguchi) & end cap (kojiri) + braided crimson sageo cord wrap
    const collarGeo = this._trackGeo(new THREE.CylinderGeometry(0.018, 0.018, 0.022, 12));
    collarGeo.rotateX(Math.PI / 2);
    collarGeo.scale(0.72, 1.18, 1.0);
    const mouthRing = this._makeMesh(collarGeo, this.mats.brass, { name: 'ScabbardKoiguchi' });
    mouthRing.position.set(0, 0.02, 0.082);
    weaponGrp.add(mouthRing);

    const endCap = this._makeMesh(collarGeo, this.mats.brass, { name: 'ScabbardKojiri' });
    endCap.position.set(0, -0.078, -0.585);
    endCap.rotation.x = 0.2;
    endCap.scale.set(0.65, 1.0, 1.0);
    weaponGrp.add(endCap);

    const sageoGeo = this._trackGeo(new THREE.TorusGeometry(0.020, 0.0055, 8, 16));
    for (let i = 0; i < 3; i++) {
      const wrap = this._makeMesh(sageoGeo, this.mats.cord, { name: `ScabbardSageo_${i}` });
      wrap.position.set(0, 0.008 - i * 0.003, -0.02 - i * 0.024);
      wrap.scale.set(0.76, 1.12, 1.0);
      weaponGrp.add(wrap);
    }

    // Carved wooden oval handguard (tsuba) + wooden bokken blade collar + wrapped tsuka hilt
    const tsubaGeo = this._trackGeo(new THREE.CylinderGeometry(0.036, 0.036, 0.009, 16));
    tsubaGeo.rotateX(Math.PI / 2);
    tsubaGeo.scale(0.84, 1.06, 1.0);
    const tsuba = this._makeMesh(tsubaGeo, this.mats.bokkenWood, { name: 'BokkenTsuba' });
    tsuba.position.set(0, 0.023, 0.098);
    weaponGrp.add(tsuba);

    // Carved oak wooden bokken hilt (tsuka) protruding cleanly forward-upward
    const hiltCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.023, 0.102),
      new THREE.Vector3(0, 0.026, 0.21),
      new THREE.Vector3(0, 0.024, 0.33),
    ]);
    const hiltGeo = this._trackGeo(new THREE.TubeGeometry(hiltCurve, 12, 0.0155, 10, false));
    hiltGeo.scale(0.74, 1.14, 1.0);
    weaponGrp.add(this._makeMesh(hiltGeo, this.mats.bokkenWood, { name: 'BokkenHiltWood' }));

    // Diamond-crossed silk tsuka-ito grip wrappings & brass pommel (kashira)
    const wrapBandGeo = this._trackGeo(new THREE.TorusGeometry(0.017, 0.0038, 6, 12));
    for (let i = 0; i < 6; i++) {
      const band = this._makeMesh(wrapBandGeo, this.mats.cord, { name: `BokkenGripWrap_${i}`, castShadow: false });
      band.position.set(0, 0.025, 0.125 + i * 0.033);
      band.rotation.z = (i & 1 ? 0.18 : -0.18);
      band.scale.set(0.76, 1.14, 1.0);
      weaponGrp.add(band);
    }

    const pommel = this._makeMesh(collarGeo, this.mats.brass, { name: 'BokkenPommel' });
    pommel.position.set(0, 0.024, 0.332);
    pommel.scale.set(0.66, 0.96, 0.9);
    weaponGrp.add(pommel);

    canteen.add(weaponGrp);
  }

  // ---------------------------------------------------------------------------
  // Soft Ground Contact-Shadow Decals under Boot Soles
  // ---------------------------------------------------------------------------

  _generateContactShadowTexture(size = 64) {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const ny = (y / (size - 1)) * 2 - 1;
      for (let x = 0; x < size; x++) {
        const nx = (x / (size - 1)) * 2 - 1;
        const r = Math.hypot(nx * 1.15, ny * 0.96);
        const falloff = r >= 1.0 ? 0.0 : Math.pow(1.0 - r, 2.25);
        const core = r >= 0.72 ? 0.0 : Math.pow(1.0 - r / 0.72, 1.6) * 0.35;
        const alpha = clamp(falloff * 0.85 + core, 0.0, 1.0);
        const idx = (y * size + x) * 4;
        data[idx] = 14;
        data[idx + 1] = 12;
        data[idx + 2] = 10;
        data[idx + 3] = Math.round(alpha * 255);
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return this._trackTex(tex);
  }

  _buildContactShadows() {
    const shadowTex = this._generateContactShadowTexture(64);
    const shadowGeo = this._trackGeo(new THREE.PlaneGeometry(0.28, 0.38));
    shadowGeo.rotateX(-Math.PI / 2);

    const makeShadowMesh = (name, initX) => {
      const mat = this._trackMat(
        new THREE.MeshBasicMaterial({
          map: shadowTex,
          transparent: true,
          opacity: 0.52,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          side: THREE.DoubleSide,
        })
      );
      const mesh = new THREE.Mesh(shadowGeo, mat);
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 1;
      mesh.position.set(initX, 0.012, 0.035);
      this.root.add(mesh);
      return mesh;
    };

    this.contactShadowL = makeShadowMesh('BootContactShadowL', this.metrics.hipOffsetX);
    this.contactShadowR = makeShadowMesh('BootContactShadowR', -this.metrics.hipOffsetX);
  }

  updateContactShadows(leftWorldPos, leftNormal, leftLift = 0, rightWorldPos, rightNormal, rightLift = 0) {
    if (!this.contactShadowL || !this.contactShadowR) return;

    this.root.updateMatrixWorld(false);
    this.root.matrixWorld.decompose(this._shadowRootPos, this._shadowRootQuat, this._shadowRootScale);
    this._shadowInvRootMat.copy(this.root.matrixWorld).invert();
    this._shadowInvRootQuat.copy(this._shadowRootQuat).invert();

    const applyDecal = (mesh, worldPos, worldNorm, liftVal) => {
      if (!worldPos || !Number.isFinite(worldPos.x) || !Number.isFinite(worldPos.y) || !Number.isFinite(worldPos.z)) {
        mesh.visible = false;
        return;
      }

      const lift = Math.max(0, Number.isFinite(liftVal) ? liftVal : 0);
      const fade = 1.0 - smoothstep(0.0, 0.34, lift);
      const opacity = 0.52 * fade;

      if (opacity <= 0.01) {
        mesh.visible = false;
        mesh.material.opacity = 0;
        return;
      }

      mesh.visible = true;
      mesh.material.opacity = opacity;

      if (
        worldNorm &&
        Number.isFinite(worldNorm.x) &&
        Number.isFinite(worldNorm.y) &&
        Number.isFinite(worldNorm.z) &&
        worldNorm.lengthSq() > 1e-6
      ) {
        this._shadowLocalNorm.copy(worldNorm).normalize().applyQuaternion(this._shadowInvRootQuat).normalize();
      } else {
        this._shadowLocalNorm.set(0, 1, 0);
      }

      this._shadowLocalPos.copy(worldPos).applyMatrix4(this._shadowInvRootMat);
      this._shadowLocalPos.addScaledVector(this._shadowLocalNorm, 0.012);
      mesh.position.copy(this._shadowLocalPos);

      const up = this._shadowUp.copy(this._shadowLocalNorm);
      const fwd = this._shadowFwd.set(0, 0, 1).addScaledVector(up, -up.z);
      if (fwd.lengthSq() < 1e-5) {
        fwd.set(0, 0, 1);
      } else {
        fwd.normalize();
      }
      const left = this._shadowLeft.crossVectors(up, fwd).normalize();
      fwd.crossVectors(left, up).normalize();
      this._shadowBasis.makeBasis(left, up, fwd);
      mesh.quaternion.setFromRotationMatrix(this._shadowBasis);

      const spread = 1.0 + clamp(lift / 0.34, 0, 1) * 0.28;
      mesh.scale.set(spread, 1.0, spread);
    };

    applyDecal(this.contactShadowL, leftWorldPos, leftNormal, leftLift);
    applyDecal(this.contactShadowR, rightWorldPos, rightNormal, rightLift);
  }

  // ---------------------------------------------------------------------------
  // 5-Finger Articulated Hand Pose API
  // ---------------------------------------------------------------------------

  setHandPose(side, curl = 0.22, splay = 0.0) {
    const s = side === 'L' ? 1 : -1;
    const c = clamp(Number.isFinite(curl) ? curl : 0.22, -0.35, 1.45);
    const sp = clamp(
      Number.isFinite(splay) && splay > 0 ? splay : c < 0 ? clamp(-c / 0.32, 0, 1) : 0,
      0,
      1
    );

    const fingersBone = this.bones[`fingers${side}`];
    if (fingersBone) {
      fingersBone.rotation.set(0, 0, -s * c * 0.42);
    }

    const idleCascadeWeight = clamp(1.0 - Math.max(0, c - 0.35) * 0.85, 0.15, 1.0) * (1.0 - sp);
    const specs = [
      { key: 'index', cascade: -0.05, baseSplay: 0.06, panicFan: 0.28 },
      { key: 'middle', cascade: 0.02, baseSplay: 0.01, panicFan: 0.08 },
      { key: 'ring', cascade: 0.09, baseSplay: -0.04, panicFan: -0.10 },
      { key: 'pinky', cascade: 0.17, baseSplay: -0.10, panicFan: -0.28 },
    ];

    for (let i = 0; i < specs.length; i++) {
      const f = specs[i];
      const prox = this.bones[`${f.key}${side}`];
      const tip = this.bones[`${f.key}Tip${side}`];
      if (!prox || !tip) continue;

      const casc = f.cascade * idleCascadeWeight;
      const proxCurl = clamp(c * 0.58 + casc, -0.24, 1.05);
      const tipCurl = clamp(c * 0.82 + casc * 1.15 - sp * 0.16, -0.18, 1.32);
      const fanX = -(f.baseSplay + f.panicFan * sp);

      prox.rotation.set(fanX, 0, -s * proxCurl);
      tip.rotation.set(0, 0, -s * tipCurl);
    }

    const thumb = this.bones[`thumb${side}`];
    const thumbTip = this.bones[`thumbTip${side}`];
    if (thumb && thumbTip) {
      const fistT = clamp((c - 0.45) / 0.85, 0, 1);
      const thumbX = lerp(-0.48, -0.16, fistT) - sp * 0.36;
      const thumbY = s * (lerp(0.06, 0.38, fistT) - sp * 0.14);
      const thumbZ = -s * (lerp(0.24, 0.78, fistT) - sp * 0.48);
      const tipZ = -s * (lerp(0.18, 0.68, fistT) - sp * 0.28);

      thumb.rotation.set(thumbX, thumbY, thumbZ);
      thumbTip.rotation.set(0, 0, tipZ);
    }
  }

  // ---------------------------------------------------------------------------
  // Public Control, Cloth Motion, Query & Strict Zero-Leak Disposal API
  // ---------------------------------------------------------------------------

  setHeadVisible(visible) {
    const flag = Boolean(visible);
    for (let i = 0; i < this.headMeshes.length; i++) {
      this.headMeshes[i].visible = flag;
    }
  }

  setSweatLevel(v) {
    this.shaderUniforms.uSweatLevel.value = clamp(Number.isFinite(v) ? v : 0, 0, 1);
  }

  setLegWetness(v) {
    this.shaderUniforms.uLegWetness.value = clamp(Number.isFinite(v) ? v : 0, 0, 1);
  }

  setRainWetness(v) {
    this.shaderUniforms.uRainWetness.value = clamp(Number.isFinite(v) ? v : 0, 0, 1);
  }

  setFaceFlush(v) {
    this.shaderUniforms.uFaceFlush.value = clamp(Number.isFinite(v) ? v : 0, 0, 1);
  }

  /**
   * Drives GPU vertex cloth-wave uniforms (uClothSpeed, uClothWind, uClothTime) for
   * Lyra's billowing emerald cloak & Kenji's flowing haori/hakama, plus organic
   * secondary motion on the `cloak` bone.
   */
  setClothMotion(speed = 0, windIntensity = 0.25, elapsed = 0) {
    const safeSpeed = clamp(Number.isFinite(speed) ? speed : 0, 0, 14);
    const safeWind = clamp(Number.isFinite(windIntensity) ? windIntensity : 0.25, 0, 4);
    const safeTime = Number.isFinite(elapsed) ? elapsed : 0;

    this.shaderUniforms.uClothSpeed.value = safeSpeed;
    this.shaderUniforms.uClothWind.value = safeWind;
    this.shaderUniforms.uClothTime.value = safeTime;

    if (this.bones.cloak) {
      const speedRatio = clamp(safeSpeed / 6.5, 0, 1.35);
      const windRatio = clamp(safeWind / 2.0, 0, 1.4);
      const billowPitch = clamp(
        0.05 +
          speedRatio * 0.40 +
          windRatio * 0.14 +
          Math.sin(safeTime * (3.2 + safeSpeed * 0.6)) * (0.028 + windRatio * 0.052),
        -0.12,
        0.70
      );
      const billowRoll = clamp(
        Math.cos(safeTime * (2.5 + safeWind * 1.1) + 0.7) * (0.022 + windRatio * 0.062),
        -0.25,
        0.25
      );
      this.bones.cloak.rotation.set(billowPitch, 0, billowRoll);
    }
  }

  getBoneWorldPosition(name, target = new THREE.Vector3()) {
    const bone = this.bones[name];
    if (!bone) {
      return target.set(0, 0, 0);
    }
    bone.updateWorldMatrix(true, false);
    return bone.getWorldPosition(target);
  }

  getFootWorldPositions(leftOut = new THREE.Vector3(), rightOut = new THREE.Vector3()) {
    const ankleL = this.bones.ankleL;
    const ankleR = this.bones.ankleR;

    ankleL.updateWorldMatrix(true, false);
    ankleR.updateWorldMatrix(true, false);

    this._tmpFootLocal.set(0, -this._soleOffsetBelowAnkle, 0.035);
    leftOut.copy(this._tmpFootLocal).applyMatrix4(ankleL.matrixWorld);
    rightOut.copy(this._tmpFootLocal).applyMatrix4(ankleR.matrixWorld);

    return { left: leftOut, right: rightOut };
  }

  /**
   * Thoroughly disposes EVERY geometry, material, texture, and skeleton boneTexture
   * created for this character and releases all scene-graph & map references so
   * cycling characters repeatedly leaks ZERO GPU resources.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    const geoSet = new Set(this._geometries);
    const matSet = new Set(this._materials);
    const texSet = new Set(this._textures);

    if (this.root) {
      this.root.traverse((obj) => {
        if (obj.geometry) geoSet.add(obj.geometry);
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (let i = 0; i < mats.length; i++) {
            const m = mats[i];
            if (!m) continue;
            matSet.add(m);
            for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap']) {
              if (m[key] && m[key].isTexture) {
                texSet.add(m[key]);
              }
            }
          }
        }
      });
    }

    if (this.skeleton && typeof this.skeleton.dispose === 'function') {
      this.skeleton.dispose();
    }

    for (const geo of geoSet) {
      geo.dispose();
    }
    for (const mat of matSet) {
      mat.dispose();
    }
    for (const tex of texSet) {
      tex.dispose();
    }

    if (this.root) {
      this.root.clear();
    }

    this._geometries.length = 0;
    this._materials.length = 0;
    this._textures.length = 0;
    this.headMeshes.length = 0;
    this.skinnedMeshes.length = 0;
    this._boneList.length = 0;
    this.bones = {};
    this._boneIndex = {};
    this.mats = {};
    this.contactShadowL = null;
    this.contactShadowR = null;
    this.eyeTarget = null;
    this.skeleton = null;
  }
}

/**
 * Factory creating all 4 distinct procedural vertex-weighted SkinnedMesh playable characters:
 *   'liam'  — Forest Ranger (Liam)
 *   'lyra'  — Woodland Archer (Lyra)
 *   'kael'  — Cyber Scout (Kael)
 *   'kenji' — Wandering Ronin (Kenji)
 */
export class CharacterFactory {
  static getPresetIds() {
    return CHARACTER_PRESETS.slice();
  }

  static getLabel(presetId) {
    return CHARACTER_LABELS[presetId] ?? CHARACTER_LABELS.liam;
  }

  static createCharacter(presetId = 'liam', options = {}) {
    const normalized = typeof presetId === 'string' ? presetId.toLowerCase().trim() : 'liam';
    const resolved = PRESET_CONFIGS[normalized] ? normalized : 'liam';
    return new CharacterRig(resolved, options);
  }
}
