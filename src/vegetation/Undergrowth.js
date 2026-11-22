import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise2D, createNoise3D } from 'simplex-noise';
import { createRng, clamp, lerp, smoothstep } from '../utils/random.js';

const UP = new THREE.Vector3(0, 1, 0);

const QUALITY_COUNTS = {
  Medium: {
    grass: 24000,
    ferns: 760,
    wildflowers: 520,
    boulders: 115,
    logs: 26,
    stumps: 30,
    mushrooms: 140,
    twigs: 260,
    pebbles: 360,
    clovers: 290,
    pineNeedles: 290,
  },
  High: {
    grass: 38000,
    ferns: 1060,
    wildflowers: 720,
    boulders: 160,
    logs: 35,
    stumps: 40,
    mushrooms: 195,
    twigs: 390,
    pebbles: 530,
    clovers: 420,
    pineNeedles: 420,
  },
  Ultra: {
    grass: 52000,
    ferns: 1350,
    wildflowers: 900,
    boulders: 200,
    logs: 42,
    stumps: 48,
    mushrooms: 240,
    twigs: 480,
    pebbles: 650,
    clovers: 520,
    pineNeedles: 520,
  },
};

const MAX_COUNTS = QUALITY_COUNTS.Ultra;

/**
 * Dilates RGB colors outward into transparent pixels so alpha-tested textures
 * never suffer dark mipmap halos.
 */
function dilateAlphaRGB(data, width, height, fallbackRGB, iterations = 10) {
  const total = width * height;
  const valid = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (data[i * 4 + 3] > 28) valid[i] = 1;
  }

  const nextValid = new Uint8Array(valid);
  const offsets = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [1, -1], [-1, 1], [1, 1],
  ];

  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (valid[idx]) continue;
        let rS = 0;
        let gS = 0;
        let bS = 0;
        let cnt = 0;
        for (let k = 0; k < offsets.length; k++) {
          const nx = x + offsets[k][0];
          const ny = y + offsets[k][1];
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (valid[nIdx]) {
            const p = nIdx * 4;
            rS += data[p];
            gS += data[p + 1];
            bS += data[p + 2];
            cnt++;
          }
        }
        if (cnt > 0) {
          const p = idx * 4;
          data[p] = Math.round(rS / cnt);
          data[p + 1] = Math.round(gS / cnt);
          data[p + 2] = Math.round(bS / cnt);
          nextValid[idx] = 1;
          changed = true;
        }
      }
    }
    valid.set(nextValid);
    if (!changed) break;
  }

  for (let i = 0; i < total; i++) {
    if (!valid[i]) {
      const p = i * 4;
      data[p] = fallbackRGB[0];
      data[p + 1] = fallbackRGB[1];
      data[p + 2] = fallbackRGB[2];
    }
  }
}

/**
 * Normalizes any BufferGeometry to non-indexed with an exact list of attributes
 * so mergeGeometries NEVER fails or returns null.
 */
function normalizeGeometry(geo, extraBuilders = {}) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  if (!src.attributes.normal) src.computeVertexNormals();

  const pos = src.attributes.position;
  const norm = src.attributes.normal;
  const uv = src.attributes.uv;
  const count = pos.count;

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    positions[i * 3] = pos.getX(i);
    positions[i * 3 + 1] = pos.getY(i);
    positions[i * 3 + 2] = pos.getZ(i);

    normals[i * 3] = norm.getX(i);
    normals[i * 3 + 1] = norm.getY(i);
    normals[i * 3 + 2] = norm.getZ(i);

    uvs[i * 2] = uv ? uv.getX(i) : 0;
    uvs[i * 2 + 1] = uv ? uv.getY(i) : 0;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  for (const [attrName, spec] of Object.entries(extraBuilders)) {
    const itemSize = spec.itemSize ?? 1;
    const arr = new Float32Array(count * itemSize);
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const u = uvs[i * 2];
      const v = uvs[i * 2 + 1];
      const val = spec.fn(x, y, z, u, v, i);
      if (itemSize === 1) {
        arr[i] = val;
      } else {
        for (let c = 0; c < itemSize; c++) arr[i * itemSize + c] = val[c];
      }
    }
    out.setAttribute(attrName, new THREE.BufferAttribute(arr, itemSize));
  }

  if (src !== geo) src.dispose();
  geo.dispose();
  return out;
}

function safeMergeParts(parts, label) {
  const merged = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  if (!merged) {
    throw new Error(`Undergrowth: mergeGeometries failed for ${label}`);
  }
  merged.computeBoundingSphere();
  return merged;
}

function shuffleDeterministic(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * Generates a Sobel tangent-space normal DataTexture from a seamless height buffer.
 */
function buildNormalMapFromHeight(heightBuf, size, strength = 2.6) {
  const normData = new Uint8Array(size * size * 4);
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
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      const p = (y * size + x) * 4;
      normData[p] = Math.round((nx * 0.5 + 0.5) * 255);
      normData[p + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normData[p + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normData[p + 3] = 255;
    }
  }

  const normalTex = new THREE.DataTexture(normData, size, size, THREE.RGBAFormat);
  normalTex.wrapS = THREE.RepeatWrapping;
  normalTex.wrapT = THREE.RepeatWrapping;
  normalTex.magFilter = THREE.LinearFilter;
  normalTex.minFilter = THREE.LinearMipmapLinearFilter;
  normalTex.generateMipmaps = true;
  normalTex.colorSpace = THREE.NoColorSpace;
  normalTex.flipY = true;
  normalTex.needsUpdate = true;
  return normalTex;
}

/**
 * Rich layered forest floor ecosystem:
 *  - 52,000 max instanced 4-segment curved grass blades (High default: 38,000)
 *  - 1,350 instanced multi-frond sword ferns with procedural serrated alpha fronds
 *  - 900 instanced multi-species wildflower clusters
 *  - 200 instanced mossy granite boulders with world-up dynamic moss + wetness shader
 *  - 42 mossy rotting nurse logs resting flush along terrain slopes
 *  - 48 weathered tree stumps with concentric annual growth-ring cut tops
 *  - 240 bioluminescent cyan & amber mushroom clusters blooming ethereally at night
 */
export class Undergrowth {
  constructor(scene, terrain, windSystem, treePositions = [], exclusionZones = []) {
    this.scene = scene;
    this.terrain = terrain;
    this.windSystem = windSystem;
    this.treePositions = treePositions || [];
    this.exclusionZones = Array.isArray(exclusionZones) ? exclusionZones : [];

    this.group = new THREE.Group();
    this.group.name = 'ForestUndergrowth';
    this.scene.add(this.group);

    this._geometries = [];
    this._materials = [];
    this._textures = [];

    // Shared reactive uniforms updated every frame via update()
    this._sharedUniforms = {
      uTime: { value: 0 },
      uNightGlow: { value: 0 },
      uWetness: { value: 0 },
    };

    this._boulderRecords = [];
    this._logRecords = [];
    this._stumpRecords = [];

    this.colliders = [];
    this._currentQuality = 'High';

    // Build all layers in ecological order so smaller floor flora & micro-details nestle organically!
    this.boulderMesh = this._buildBoulders();
    this.logMesh = this._buildNurseLogs();
    this.stumpMesh = this._buildTreeStumps();
    this.grassMesh = this._buildGrassBlades();
    this.fernMesh = this._buildSwordFerns();
    this.wildflowerMesh = this._buildWildflowers();
    this.mushroomMesh = this._buildBioluminescentMushrooms();

    // 4 rich forest-floor micro-detail scatter layers
    this.twigMesh = this._buildFallenTwigs();
    this.pebbleMesh = this._buildMossyPebbles();
    this.cloverMesh = this._buildCloverPatches();
    this.pineNeedleMesh = this._buildPineNeedleClusters();

    this.group.add(
      this.boulderMesh,
      this.logMesh,
      this.stumpMesh,
      this.grassMesh,
      this.fernMesh,
      this.wildflowerMesh,
      this.mushroomMesh,
      this.twigMesh,
      this.pebbleMesh,
      this.cloverMesh,
      this.pineNeedleMesh
    );

    this.setQuality('High');
  }

  _isInExclusionZone(x, z, pad = 0.0) {
    for (let i = 0; i < this.exclusionZones.length; i++) {
      const zone = this.exclusionZones[i];
      if (!zone) continue;
      const r = (zone.radius ?? 0) + pad;
      if (r <= 0) continue;
      const dx = x - zone.x;
      const dz = z - zone.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  _isNearTree(x, z, pad = 0.0) {
    for (let i = 0; i < this.treePositions.length; i++) {
      const t = this.treePositions[i];
      const r = (t.radius ?? 0.5) + pad;
      const dx = x - t.x;
      const dz = z - t.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  _isNearBoulder(x, z, pad = 0.0) {
    for (let i = 0; i < this._boulderRecords.length; i++) {
      const b = this._boulderRecords[i];
      const r = b.radius + pad;
      const dx = x - b.x;
      const dz = z - b.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  // =========================================================================
  // 1. INSTANCED GRASS BLADES (4-segment curved, tapered, 9 verts / 7 tris)
  // =========================================================================

  _buildGrassGeometry() {
    // 5 height rows -> 4 segments, 9 vertices, 7 triangles
    // Gentle forward arch + outward-canted V-fold normals for crisp specular light catching
    const baseHalfW = 0.052;
    const rows = [
      { t: 0.00, y: 0.00, z: 0.000, w: baseHalfW * 1.00 },
      { t: 0.25, y: 0.245, z: 0.018, w: baseHalfW * 0.84 },
      { t: 0.50, y: 0.485, z: 0.068, w: baseHalfW * 0.62 },
      { t: 0.75, y: 0.715, z: 0.152, w: baseHalfW * 0.34 },
    ];

    const positions = new Float32Array(9 * 3);
    const normals = new Float32Array(9 * 3);
    const uvs = new Float32Array(9 * 2);
    const bend = new Float32Array(9);

    const tmpN = new THREE.Vector3();

    for (let r = 0; r < 4; r++) {
      const row = rows[r];
      const leftIdx = r * 2;
      const rightIdx = r * 2 + 1;

      // Left edge vertex
      positions[leftIdx * 3] = -row.w;
      positions[leftIdx * 3 + 1] = row.y;
      positions[leftIdx * 3 + 2] = row.z;

      // Slight V-fold outward-canted normal on left half
      tmpN.set(-0.46 * (1 - row.t * 0.45), 0.26 + row.t * 0.28, 0.84).normalize();
      normals[leftIdx * 3] = tmpN.x;
      normals[leftIdx * 3 + 1] = tmpN.y;
      normals[leftIdx * 3 + 2] = tmpN.z;

      uvs[leftIdx * 2] = 0.0;
      uvs[leftIdx * 2 + 1] = row.t;
      bend[leftIdx] = row.t;

      // Right edge vertex
      positions[rightIdx * 3] = row.w;
      positions[rightIdx * 3 + 1] = row.y;
      positions[rightIdx * 3 + 2] = row.z;

      // Slight V-fold outward-canted normal on right half
      tmpN.set(0.46 * (1 - row.t * 0.45), 0.26 + row.t * 0.28, 0.84).normalize();
      normals[rightIdx * 3] = tmpN.x;
      normals[rightIdx * 3 + 1] = tmpN.y;
      normals[rightIdx * 3 + 2] = tmpN.z;

      uvs[rightIdx * 2] = 1.0;
      uvs[rightIdx * 2 + 1] = row.t;
      bend[rightIdx] = row.t;
    }

    // Row 4: single apex tip vertex (vertex index 8)
    positions[8 * 3] = 0.0;
    positions[8 * 3 + 1] = 0.935;
    positions[8 * 3 + 2] = 0.268;
    tmpN.set(0.0, 0.56, 0.83).normalize();
    normals[8 * 3] = tmpN.x;
    normals[8 * 3 + 1] = tmpN.y;
    normals[8 * 3 + 2] = tmpN.z;
    uvs[8 * 2] = 0.5;
    uvs[8 * 2 + 1] = 1.0;
    bend[8] = 1.0;

    // 7 triangles across 4 vertical segments
    const indices = [
      0, 1, 3,  0, 3, 2,
      2, 3, 5,  2, 5, 4,
      4, 5, 7,  4, 7, 6,
      6, 7, 8,
    ];

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aBend', new THREE.BufferAttribute(bend, 1));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }

  _buildGrassBlades() {
    const rng = createRng(8101);
    const patchNoise = createNoise2D(createRng(8102));
    const colorNoise = createNoise2D(createRng(8103));

    const geo = this._buildGrassGeometry();
    this._geometries.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.68,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    this.windSystem.applyFoliageWindShader(mat, {
      bendStrength: 0.62,
      flutterStrength: 0.16,
      partStrength: 1.25,
      useRootAO: true,
      useBendAttr: true,
    });
    this._materials.push(mat);

    const maxCount = MAX_COUNTS.grass;
    const mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    mesh.name = 'ForestGrassBlades';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const palette = [
      new THREE.Color('#346e2b'), // lush emerald
      new THREE.Color('#57762c'), // woodland olive
      new THREE.Color('#7ca337'), // sunlit chartreuse
      new THREE.Color('#245222'), // shadowed deep moss green
    ];

    const clearingC = this.terrain.clearingCenter;
    const placements = [];

    // Generate organic clumped tufts so the forest floor has lush carpets & natural bare pine-litter pockets
    const addTufts = (targetBlades, radiusMode) => {
      let added = 0;
      let tries = 0;
      const maxTries = targetBlades * 4;

      while (added < targetBlades && tries < maxTries) {
        tries++;
        let cx;
        let cz;

        if (radiusMode === 'clearingAndMeadows') {
          // Dense lush grass around clearing perimeter, inner glades & stream banks
          const rRoll = rng();
          if (rRoll < 0.42) {
            // Clearing & sunlit border meadows (r = 2.7 .. 28)
            const a = rng() * Math.PI * 2;
            const d = 2.75 + Math.pow(rng(), 0.72) * 26.5;
            cx = clearingC.x + Math.cos(a) * d;
            cz = clearingC.y + Math.sin(a) * d;
          } else if (rRoll < 0.70) {
            // Lush stream bank corridors
            cz = (rng() * 2 - 1) * 86;
            const scx = this.terrain.getStreamCenterX(cz);
            const hw = this.terrain.getStreamHalfWidth(cz);
            const side = rng() > 0.5 ? 1 : -1;
            cx = scx + side * (hw + 0.6 + Math.pow(rng(), 0.8) * 16.5);
          } else {
            // Mid-range walkable forest floor
            const a = rng() * Math.PI * 2;
            const d = 14 + Math.sqrt(rng()) * 54;
            cx = clearingC.x * 0.5 + Math.cos(a) * d;
            cz = clearingC.y * 0.5 + Math.sin(a) * d;
          }
        } else {
          // Wider forest carpet out to [-104, 104]
          cx = (rng() * 2 - 1) * 104;
          cz = (rng() * 2 - 1) * 104;
        }

        if (Math.abs(cx) > 105 || Math.abs(cz) > 105) continue;
        if (this._isInExclusionZone(cx, cz, 0.25)) continue;

        const distClear = this.terrain.getClearingDistance(cx, cz);
        if (distClear < 2.7) continue;

        const cy = this.terrain.getHeightAt(cx, cz);
        if (cy < 0.22) continue;

        const slope = this.terrain.getSlopeAt(cx, cz);
        if (slope > 0.38) continue;

        // Organic patchiness (lush near clearing & banks, dappled in deep pine woods)
        const patch = patchNoise(cx * 0.048, cz * 0.048) * 0.5 + 0.5;
        const clearingBoost = distClear < 16.0 ? 0.35 : 0.0;
        if (patch + clearingBoost < 0.24 && rng() > 0.28) continue;

        if (this._isNearBoulder(cx, cz, -0.15)) continue;

        // Plant a micro-tuft of 3-6 blades around (cx, cz)
        const tuftSize = Math.min(3 + Math.floor(rng() * 4), targetBlades - added);
        const tuftSpread = 0.20 + rng() * 0.36;
        const heightBase =
          distClear < 6.8
            ? 0.40 + rng() * 0.28 // softer shorter mossy meadow turf near campfire
            : 0.52 + rng() * 0.58; // taller wild forest grass in meadows & banks

        for (let b = 0; b < tuftSize; b++) {
          const ba = rng() * Math.PI * 2;
          const bd = Math.sqrt(rng()) * tuftSpread;
          const bx = cx + Math.cos(ba) * bd;
          const bz = cz + Math.sin(ba) * bd;

          if (this._isInExclusionZone(bx, bz, 0.15)) continue;
          if (this.terrain.getClearingDistance(bx, bz) < 2.7) continue;
          const by = this.terrain.getHeightAt(bx, bz);
          if (by < 0.22) continue;

          const hScale = heightBase * (0.78 + rng() * 0.44);
          const wScale = 0.78 + rng() * 0.54;

          placements.push({
            x: bx,
            y: by - 0.025,
            z: bz,
            yaw: rng() * Math.PI * 2,
            tiltX: (rng() - 0.5) * 0.24,
            tiltZ: (rng() - 0.5) * 0.24,
            hScale,
            wScale,
            distClear,
          });
          added++;
        }
      }
    };

    // 66% concentrated in prime meadows, clearing perimeter & banks; 34% across outer forest hills
    addTufts(Math.floor(maxCount * 0.66), 'clearingAndMeadows');
    addTufts(maxCount - placements.length, 'outerForest');

    // Shuffle uniformly so setQuality('Medium' | 'High' | 'Ultra') scales density evenly everywhere
    shuffleDeterministic(placements, rng);

    const dummy = new THREE.Object3D();
    const cTemp = new THREE.Color();
    const finalCount = Math.min(placements.length, maxCount);

    for (let i = 0; i < finalCount; i++) {
      const p = placements[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(p.tiltX, p.yaw, p.tiltZ);
      dummy.scale.set(p.wScale, p.hScale, p.wScale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Rich organic per-blade color variation driven by macro patch & clearing sunlight
      const nCol = colorNoise(p.x * 0.055 + 4.2, p.z * 0.055 - 1.7) * 0.5 + 0.5;
      const sunZone = smoothstep(26.0, 5.0, p.distClear) * 0.35;
      const tCol = clamp(nCol * 0.8 + sunZone + (rng() - 0.5) * 0.28, 0, 1);

      if (tCol < 0.35) {
        cTemp.copy(palette[3]).lerp(palette[0], tCol / 0.35);
      } else if (tCol < 0.72) {
        cTemp.copy(palette[0]).lerp(palette[1], (tCol - 0.35) / 0.37);
      } else {
        cTemp.copy(palette[1]).lerp(palette[2], (tCol - 0.72) / 0.28);
      }
      // Subtle individual brightness jitter
      cTemp.multiplyScalar(0.86 + rng() * 0.28);
      mesh.setColorAt(i, cTemp);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this._grassMaxPlaced = finalCount;
    return mesh;
  }

  // =========================================================================
  // 2. INSTANCED SWORD FERNS (8 arched radiating fronds + serrated alpha texture)
  // =========================================================================

  _generateFernTexture(seed) {
    const w = 256;
    const h = 512;
    const rng = createRng(seed);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    // Central woody green rachis stem (v=0 bottom -> v=1 tip)
    const stemGrad = ctx.createLinearGradient(w * 0.5, h, w * 0.5, 14);
    stemGrad.addColorStop(0, '#2a4d1e');
    stemGrad.addColorStop(0.5, '#3b6f29');
    stemGrad.addColorStop(1, '#589437');
    ctx.strokeStyle = stemGrad;
    ctx.lineWidth = 5.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(w * 0.5, h - 10);
    ctx.lineTo(w * 0.5, 16);
    ctx.stroke();

    // 26 pairs of alternating serrated tapering sword-fern pinnae leaflets
    const pairs = 26;
    for (let i = 0; i < pairs; i++) {
      const t = i / (pairs - 1); // 0 base -> 1 tip
      const py = lerp(h - 32, 26, t);

      // Authentic sword fern blade silhouette (widest around t=0.25..0.55, tapering cleanly to tip)
      const env = Math.sin(Math.pow(t, 0.72) * Math.PI * 0.94 + 0.14);
      const pinnaLen = (18 + env * 94) * (0.94 + rng() * 0.12);
      const pinnaWid = lerp(13.5, 5.2, Math.pow(t, 0.9));

      for (const side of [-1, 1]) {
        const yOff = side === 1 ? -4.5 : 0;
        const ang = side * (Math.PI * 0.43 - t * 0.30 + (rng() - 0.5) * 0.05);

        ctx.save();
        ctx.translate(w * 0.5, py + yOff);
        ctx.rotate(ang - Math.PI * 0.5);

        // Draw sword-shaped leaflet with tiny basal "hilt" lobe and serrated edge
        ctx.beginPath();
        ctx.moveTo(0, -pinnaWid * 0.35);
        const segs = 9;
        for (let s = 1; s <= segs; s++) {
          const sf = s / segs;
          const tooth = s < segs ? (s % 2 === 0 ? 1.12 : 0.88) : 0;
          const hilt = s === 1 ? 1.38 : 1.0;
          const lx = sf * pinnaLen;
          const ly = -pinnaWid * 0.52 * (1.0 - Math.pow(sf, 1.3)) * tooth * hilt;
          ctx.lineTo(lx, ly);
        }
        ctx.lineTo(pinnaLen * 1.03, 0);
        for (let s = segs - 1; s >= 1; s--) {
          const sf = s / segs;
          const tooth = s % 2 === 0 ? 1.12 : 0.88;
          const lx = sf * pinnaLen;
          const ly = pinnaWid * 0.44 * (1.0 - Math.pow(sf, 1.3)) * tooth;
          ctx.lineTo(lx, ly);
        }
        ctx.lineTo(0, pinnaWid * 0.32);
        ctx.closePath();

        const g = ctx.createLinearGradient(0, 0, pinnaLen, 0);
        const bright = t * 0.28 + (rng() - 0.5) * 0.12;
        g.addColorStop(0, bright > 0.12 ? '#2c6324' : '#23521e');
        g.addColorStop(0.6, bright > 0.12 ? '#448232' : '#38702a');
        g.addColorStop(1, bright > 0.12 ? '#609e40' : '#4f8c36');
        ctx.fillStyle = g;
        ctx.fill();

        // Subtle pale leaflet midvein
        ctx.strokeStyle = 'rgba(148, 198, 92, 0.38)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(2, 0);
        ctx.lineTo(pinnaLen * 0.86, 0);
        ctx.stroke();

        ctx.restore();
      }
    }

    const img = ctx.getImageData(0, 0, w, h);
    const bytes = new Uint8Array(img.data);
    dilateAlphaRGB(bytes, w, h, [58, 114, 44], 10);

    const tex = new THREE.DataTexture(bytes, w, h, THREE.RGBAFormat);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    tex.needsUpdate = true;
    this._textures.push(tex);
    return tex;
  }

  _buildFernRosetteGeometry() {
    const rng = createRng(8201);
    const frondParts = [];

    // 8 radiating arched fronds (5 wider outer fronds + 3 taller inner fronds)
    const frondConfigs = [
      { az: 0.05, len: 1.18, wid: 0.42, archH: 0.42, droop: 0.24 },
      { az: 1.32, len: 1.24, wid: 0.44, archH: 0.45, droop: 0.26 },
      { az: 2.58, len: 1.15, wid: 0.40, archH: 0.40, droop: 0.22 },
      { az: 3.84, len: 1.22, wid: 0.43, archH: 0.44, droop: 0.25 },
      { az: 5.08, len: 1.16, wid: 0.41, archH: 0.41, droop: 0.23 },
      // Inner ascending crown of 3 younger fronds
      { az: 0.68, len: 0.88, wid: 0.34, archH: 0.58, droop: 0.14 },
      { az: 2.78, len: 0.92, wid: 0.35, archH: 0.62, droop: 0.15 },
      { az: 4.85, len: 0.86, wid: 0.33, archH: 0.56, droop: 0.13 },
    ];

    const lenSegs = 5;

    for (let f = 0; f < frondConfigs.length; f++) {
      const cfg = frondConfigs[f];
      const az = cfg.az + (rng() - 0.5) * 0.22;
      const cosA = Math.cos(az);
      const sinA = Math.sin(az);
      const perpX = -sinA;
      const perpZ = cosA;

      const posArr = [];
      const normArr = [];
      const uvArr = [];
      const bendArr = [];

      // 3 columns per row (left edge, center V-rachis, right edge) for natural V-trough frond
      const gridP = [];
      const gridN = [];
      const gridUV = [];
      const gridB = [];

      for (let i = 0; i <= lenSegs; i++) {
        const t = i / lenSegs;
        const reach = t * cfg.len;
        const yCenter = Math.sin(t * Math.PI * 0.72) * cfg.archH - t * t * cfg.droop + 0.04;
        const halfW = cfg.wid * 0.5 * (0.28 + 0.72 * Math.sin(Math.pow(t, 0.7) * Math.PI * 0.85 + 0.15));
        const vFoldLift = halfW * 0.24;

        const cx = cosA * reach;
        const cz = sinA * reach;

        const pLeft = new THREE.Vector3(cx - perpX * halfW, yCenter + vFoldLift, cz - perpZ * halfW);
        const pMid = new THREE.Vector3(cx, yCenter, cz);
        const pRight = new THREE.Vector3(cx + perpX * halfW, yCenter + vFoldLift, cz + perpZ * halfW);

        const nMid = new THREE.Vector3(cosA * (t - 0.25) * 0.45, 0.92, sinA * (t - 0.25) * 0.45).normalize();
        const nLeft = nMid.clone().addScaledVector(new THREE.Vector3(-perpX, 0, -perpZ), -0.22).normalize();
        const nRight = nMid.clone().addScaledVector(new THREE.Vector3(perpX, 0, perpZ), -0.22).normalize();

        gridP.push([pLeft, pMid, pRight]);
        gridN.push([nLeft, nMid, nRight]);
        gridUV.push([[0, t], [0.5, t], [1, t]]);
        gridB.push(t);
      }

      const pushTri = (p0, n0, uv0, b0, p1, n1, uv1, b1, p2, n2, uv2, b2) => {
        posArr.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        normArr.push(n0.x, n0.y, n0.z, n1.x, n1.y, n1.z, n2.x, n2.y, n2.z);
        uvArr.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
        bendArr.push(b0, b1, b2);
      };

      for (let i = 0; i < lenSegs; i++) {
        for (let c = 0; c < 2; c++) {
          pushTri(
            gridP[i][c], gridN[i][c], gridUV[i][c], gridB[i],
            gridP[i][c + 1], gridN[i][c + 1], gridUV[i][c + 1], gridB[i],
            gridP[i + 1][c + 1], gridN[i + 1][c + 1], gridUV[i + 1][c + 1], gridB[i + 1]
          );
          pushTri(
            gridP[i][c], gridN[i][c], gridUV[i][c], gridB[i],
            gridP[i + 1][c + 1], gridN[i + 1][c + 1], gridUV[i + 1][c + 1], gridB[i + 1],
            gridP[i + 1][c], gridN[i + 1][c], gridUV[i + 1][c], gridB[i + 1]
          );
        }
      }

      const fGeo = new THREE.BufferGeometry();
      fGeo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
      fGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normArr, 3));
      fGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
      fGeo.setAttribute('aBend', new THREE.Float32BufferAttribute(bendArr, 1));
      frondParts.push(fGeo);
    }

    return safeMergeParts(frondParts, 'SwordFernRosette');
  }

  _buildSwordFerns() {
    const rng = createRng(8202);
    const fernGeo = this._buildFernRosetteGeometry();
    const fernTex = this._generateFernTexture(8203);
    this._geometries.push(fernGeo);

    const mat = new THREE.MeshStandardMaterial({
      map: fernTex,
      alphaTest: 0.36,
      side: THREE.DoubleSide,
      roughness: 0.72,
      metalness: 0.0,
    });

    this.windSystem.applyFoliageWindShader(mat, {
      bendStrength: 0.44,
      flutterStrength: 0.13,
      partStrength: 1.08,
      useRootAO: true,
      useBendAttr: true,
    });
    this._materials.push(mat);

    const maxCount = MAX_COUNTS.ferns;
    const placements = [];

    const tryAddFern = (x, z, scaleMin = 0.68, scaleMax = 1.32) => {
      if (Math.abs(x) > 104 || Math.abs(z) > 104) return false;
      if (this._isInExclusionZone(x, z, 0.5)) return false;
      if (this.terrain.getClearingDistance(x, z) < 4.4) return false;
      const y = this.terrain.getHeightAt(x, z);
      if (y < 0.32) return false;
      if (this.terrain.getSlopeAt(x, z) > 0.36) return false;
      if (this._isNearTree(x, z, 0.25)) return false;
      if (this._isNearBoulder(x, z, -0.1)) return false;

      placements.push({
        x,
        y: y - 0.03,
        z,
        scale: scaleMin + rng() * (scaleMax - scaleMin),
        yaw: rng() * Math.PI * 2,
      });
      return true;
    };

    // 1. Nestle ferns around mossy nurse logs (~180 ferns)
    for (let i = 0; i < this._logRecords.length && placements.length < 180; i++) {
      const log = this._logRecords[i];
      const count = 3 + Math.floor(rng() * 4);
      for (let k = 0; k < count && placements.length < 180; k++) {
        const along = (rng() - 0.5) * log.length;
        const side = (rng() > 0.5 ? 1 : -1) * (log.radius + 0.35 + rng() * 1.15);
        const fx = log.x + log.dirX * along - log.dirZ * side;
        const fz = log.z + log.dirZ * along + log.dirX * side;
        tryAddFern(fx, fz, 0.72, 1.25);
      }
    }

    // 2. Nestle ferns around shady tree bases (~360 ferns)
    for (let i = 0; i < this.treePositions.length && placements.length < 540; i++) {
      const t = this.treePositions[i];
      if (rng() > 0.78) continue;
      const count = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < count && placements.length < 540; k++) {
        const a = rng() * Math.PI * 2;
        const d = t.radius + 0.65 + rng() * 2.2;
        tryAddFern(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, 0.65, 1.28);
      }
    }

    // 3. Lush fern banks along stream corridor & shady woodland floor up to maxCount
    let tries = 0;
    while (placements.length < maxCount && tries < 14000) {
      tries++;
      let x;
      let z;
      if (rng() < 0.34) {
        // Damp stream bank ferns
        z = (rng() * 2 - 1) * 92;
        const scx = this.terrain.getStreamCenterX(z);
        const hw = this.terrain.getStreamHalfWidth(z);
        const side = rng() > 0.5 ? 1 : -1;
        x = scx + side * (hw + 0.9 + Math.pow(rng(), 0.7) * 14.0);
      } else {
        x = (rng() * 2 - 1) * 102;
        z = (rng() * 2 - 1) * 102;
      }
      tryAddFern(x, z, 0.62, 1.38);
    }

    shuffleDeterministic(placements, rng);

    const mesh = new THREE.InstancedMesh(fernGeo, mat, maxCount);
    mesh.name = 'ForestSwordFerns';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    const nVec = new THREE.Vector3();
    const qSlope = new THREE.Quaternion();
    const qYaw = new THREE.Quaternion();
    const col = new THREE.Color();
    const count = Math.min(placements.length, maxCount);

    for (let i = 0; i < count; i++) {
      const p = placements[i];
      this.terrain.getNormalAt(p.x, p.z, nVec);
      // Partially blend with terrain slope so ferns tilt gracefully on hillsides
      nVec.lerp(UP, 0.55).normalize();
      qSlope.setFromUnitVectors(UP, nVec);
      qYaw.setFromAxisAngle(UP, p.yaw);

      dummy.position.set(p.x, p.y, p.z);
      dummy.quaternion.copy(qSlope).multiply(qYaw);
      dummy.scale.set(p.scale, p.scale * (0.9 + rng() * 0.22), p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Subtle fresh/deep emerald shade variation per fern rosette
      const shade = 0.84 + rng() * 0.32;
      col.setRGB(shade * (0.94 + rng() * 0.14), shade * (0.98 + rng() * 0.08), shade * (0.88 + rng() * 0.14));
      mesh.setColorAt(i, col);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this._fernsMaxPlaced = count;
    return mesh;
  }

  // =========================================================================
  // 3. INSTANCED WILDFLOWER CLUSTERS (stems + 5-petal blossoms + golden centers)
  // =========================================================================

  _buildWildflowerGeometry() {
    const rng = createRng(8301);
    const parts = [];

    // 1. Basal rosette of 5 slender ground leaves (aPartType = 0.0)
    for (let l = 0; l < 5; l++) {
      const az = (l / 5) * Math.PI * 2 + (rng() - 0.5) * 0.3;
      const leaf = new THREE.PlaneGeometry(0.065, 0.20, 1, 2);
      leaf.translate(0, 0.10, 0);
      leaf.rotateX(1.05 + rng() * 0.25);
      leaf.rotateY(az);
      parts.push(
        normalizeGeometry(leaf, {
          aBend: { itemSize: 1, fn: (x, y) => clamp(y / 0.55, 0, 0.35) },
          aPartType: { itemSize: 1, fn: () => 0.0 },
        })
      );
    }

    // 2. 6 graceful arched stems topped with 5-petal blossom heads + golden pollen centers
    const stemCount = 6;
    const qRot = new THREE.Quaternion();
    const eul = new THREE.Euler();

    for (let s = 0; s < stemCount; s++) {
      const az = (s / stemCount) * Math.PI * 2 + (rng() - 0.5) * 0.38;
      const reach = 0.07 + rng() * 0.16;
      const height = 0.34 + rng() * 0.24;
      const tipX = Math.cos(az) * reach;
      const tipZ = Math.sin(az) * reach;

      // Slender curved 3-segment stem (aPartType = 0.0)
      const stemCurve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(tipX * 0.18, 0.0, tipZ * 0.18),
        new THREE.Vector3(tipX * 0.45, height * 0.58, tipZ * 0.45),
        new THREE.Vector3(tipX, height, tipZ)
      );
      const stemGeo = new THREE.TubeGeometry(stemCurve, 4, 0.011, 4, false);
      parts.push(
        normalizeGeometry(stemGeo, {
          aBend: { itemSize: 1, fn: (x, y) => clamp(y / 0.58, 0, 1) },
          aPartType: { itemSize: 1, fn: () => 0.0 },
        })
      );

      // Blossom orientation slightly facing outward & upward toward sunlight
      const tiltOut = 0.22 + rng() * 0.35;
      eul.set(tiltOut, az, 0, 'YXZ');
      qRot.setFromEuler(eul);

      // 5 radiating slightly cupped petals (aPartType = 1.0)
      const petalRadius = 0.055 + rng() * 0.025;
      for (let p = 0; p < 5; p++) {
        const pAng = (p / 5) * Math.PI * 2;
        const petalGeo = new THREE.CircleGeometry(petalRadius * 0.52, 5);
        petalGeo.scale(0.85, 1.38, 1.0);
        petalGeo.translate(0, petalRadius * 0.62, 0);
        // Cup upward slightly around flower center
        petalGeo.rotateX(-Math.PI * 0.5 + 0.30);
        petalGeo.rotateY(pAng);
        petalGeo.applyQuaternion(qRot);
        petalGeo.translate(tipX, height, tipZ);

        parts.push(
          normalizeGeometry(petalGeo, {
            aBend: { itemSize: 1, fn: () => clamp(height / 0.58, 0.45, 1.0) },
            aPartType: { itemSize: 1, fn: () => 1.0 },
          })
        );
      }

      // Tiny warm golden stamen center dome (aPartType = 2.0)
      const centerGeo = new THREE.SphereGeometry(petalRadius * 0.34, 5, 4);
      centerGeo.scale(1.0, 0.65, 1.0);
      centerGeo.translate(tipX, height + 0.008, tipZ);
      parts.push(
        normalizeGeometry(centerGeo, {
          aBend: { itemSize: 1, fn: () => clamp(height / 0.58, 0.45, 1.0) },
          aPartType: { itemSize: 1, fn: () => 2.0 },
        })
      );
    }

    return safeMergeParts(parts, 'WildflowerCluster');
  }

  _buildWildflowers() {
    const rng = createRng(8302);
    const geo = this._buildWildflowerGeometry();
    this._geometries.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.62,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    // Apply unified foliage wind & player parting shader first
    this.windSystem.applyFoliageWindShader(mat, {
      bendStrength: 0.56,
      flutterStrength: 0.18,
      partStrength: 1.18,
      useRootAO: true,
      useBendAttr: true,
    });

    // Chain part-type coloring cleanly so stems stay forest green, petals take instanceColor,
    // and blossom centers stay warm golden pollen — all in ONE InstancedMesh draw call!
    const prevCompile = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () => `${prevKey ? prevKey() : 'wf'}_wildflowerParts`;
    mat.onBeforeCompile = (shader, renderer) => {
      if (prevCompile) prevCompile(shader, renderer);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        attribute float aPartType;
        varying float vPartType;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vPartType = aPartType;`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        varying float vPartType;`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `vec3 wfStemCol = vec3( 0.09, 0.25, 0.06 );
        vec3 wfCenterCol = vec3( 0.90, 0.62, 0.06 );
        vec3 wfPetalCol = vec3( 1.0 );
        #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
          wfPetalCol = vColor.rgb;
        #endif
        if ( vPartType < 0.5 ) {
          diffuseColor.rgb *= wfStemCol;
        } else if ( vPartType < 1.5 ) {
          diffuseColor.rgb *= wfPetalCol;
        } else {
          diffuseColor.rgb *= wfCenterCol;
        }`
      );
    };
    this._materials.push(mat);

    // 4 botanical wildflower palettes: wood sorrel, forest bluebells, buttercups, wild rose
    const flowerPalettes = [
      new THREE.Color('#f7f8f0'), // white wood sorrel
      new THREE.Color('#5a86f2'), // forest bluebells
      new THREE.Color('#f9c628'), // golden buttercups
      new THREE.Color('#f08aae'), // soft wild rose
    ];

    const maxCount = MAX_COUNTS.wildflowers;
    const clearingC = this.terrain.clearingCenter;
    const placements = [];

    let tries = 0;
    while (placements.length < maxCount && tries < 10000) {
      tries++;
      let cx;
      let cz;
      const zoneRoll = rng();
      if (zoneRoll < 0.44) {
        // Sunlit campfire clearing meadow border
        const a = rng() * Math.PI * 2;
        const d = 3.5 + Math.pow(rng(), 0.78) * 14.5;
        cx = clearingC.x + Math.cos(a) * d;
        cz = clearingC.y + Math.sin(a) * d;
      } else if (zoneRoll < 0.74) {
        // Sunlit gentle stream banks
        cz = (rng() * 2 - 1) * 78;
        const scx = this.terrain.getStreamCenterX(cz);
        const hw = this.terrain.getStreamHalfWidth(cz);
        const side = rng() > 0.5 ? 1 : -1;
        cx = scx + side * (hw + 0.9 + rng() * 11.5);
      } else {
        // Dappled woodland glades
        cx = (rng() * 2 - 1) * 84;
        cz = (rng() * 2 - 1) * 84;
      }

      if (Math.abs(cx) > 96 || Math.abs(cz) > 96) continue;
      if (this._isInExclusionZone(cx, cz, 0.35)) continue;
      if (this.terrain.getClearingDistance(cx, cz) < 3.4) continue;
      const cy = this.terrain.getHeightAt(cx, cz);
      if (cy < 0.35) continue;
      if (this.terrain.getSlopeAt(cx, cz) > 0.32) continue;
      if (this._isNearTree(cx, cz, 0.5) || this._isNearBoulder(cx, cz, 0.25)) continue;

      // Plant charming 2-4 cluster floral drift of the same wildflower species
      const speciesIdx = Math.floor(rng() * flowerPalettes.length);
      const driftCount = Math.min(2 + Math.floor(rng() * 3), maxCount - placements.length);

      for (let d = 0; d < driftCount; d++) {
        const da = rng() * Math.PI * 2;
        const dr = d === 0 ? 0 : 0.45 + rng() * 1.45;
        const fx = cx + Math.cos(da) * dr;
        const fz = cz + Math.sin(da) * dr;
        if (this._isInExclusionZone(fx, fz, 0.25)) continue;
        if (this.terrain.getClearingDistance(fx, fz) < 3.2) continue;
        const fy = this.terrain.getHeightAt(fx, fz);
        if (fy < 0.32 || this.terrain.getSlopeAt(fx, fz) > 0.34) continue;

        placements.push({
          x: fx,
          y: fy - 0.02,
          z: fz,
          yaw: rng() * Math.PI * 2,
          scale: 0.78 + rng() * 0.52,
          speciesIdx,
        });
      }
    }

    shuffleDeterministic(placements, rng);

    const mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    mesh.name = 'ForestWildflowers';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    const count = Math.min(placements.length, maxCount);

    for (let i = 0; i < count; i++) {
      const p = placements[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set((rng() - 0.5) * 0.14, p.yaw, (rng() - 0.5) * 0.14);
      dummy.scale.set(p.scale, p.scale * (0.88 + rng() * 0.28), p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      col.copy(flowerPalettes[p.speciesIdx]).multiplyScalar(0.92 + rng() * 0.16);
      mesh.setColorAt(i, col);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this._wildflowersMaxPlaced = count;
    return mesh;
  }

  // =========================================================================
  // 4. INSTANCED MOSSY GRANITE BOULDERS (3D noise craggy geo + world-up moss)
  // =========================================================================

  _generateGraniteTextures(seed) {
    const size = 256;
    const rng = createRng(seed);
    const n1 = createNoise2D(rng);
    const n2 = createNoise2D(createRng(seed + 37));

    const tileNoise = (u, v, freq, fn) => {
      const a = fn(u * freq, v * freq);
      const b = fn((u - 1) * freq, v * freq);
      const c = fn(u * freq, (v - 1) * freq);
      const d = fn((u - 1) * freq, (v - 1) * freq);
      const wx = smoothstep(0.0, 1.0, u);
      const wy = smoothstep(0.0, 1.0, v);
      return lerp(lerp(a, b, wx), lerp(c, d, wx), wy);
    };

    const heightBuf = new Float32Array(size * size);
    const diff = new Uint8Array(size * size * 4);

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const idx = y * size + x;
        const p = idx * 4;

        const base =
          tileNoise(u, v, 5.0, n1) * 0.52 +
          tileNoise(u, v, 12.0, n2) * 0.30 +
          tileNoise(u, v, 28.0, n1) * 0.18;
        const grain = tileNoise(u, v, 44.0, n2) * 0.5 + 0.5;
        const crack = 1.0 - Math.abs(tileNoise(u, v, 7.5, n2));
        const crackMask = Math.pow(clamp(crack, 0, 1), 6.0);

        const val = clamp(base * 0.5 + 0.5, 0, 1);
        // Speckled feldspar/quartz/biotite granite mineral tones
        let r = lerp(74, 152, val) + (grain - 0.5) * 32;
        let g = lerp(76, 150, val) + (grain - 0.5) * 30;
        let b = lerp(78, 146, val) + (grain - 0.5) * 28;

        // Dark biotite mica flecks
        if (grain < 0.18) {
          r *= 0.58;
          g *= 0.58;
          b *= 0.60;
        }
        // Subtle weathered fissure cracks
        r *= 1.0 - crackMask * 0.45;
        g *= 1.0 - crackMask * 0.45;
        b *= 1.0 - crackMask * 0.45;

        diff[p] = clamp(Math.round(r), 0, 255);
        diff[p + 1] = clamp(Math.round(g), 0, 255);
        diff[p + 2] = clamp(Math.round(b), 0, 255);
        diff[p + 3] = 255;

        heightBuf[idx] = clamp(val * 0.72 + grain * 0.28 - crackMask * 0.35, 0, 1);
      }
    }

    const diffuse = new THREE.DataTexture(diff, size, size, THREE.RGBAFormat);
    diffuse.wrapS = THREE.RepeatWrapping;
    diffuse.wrapT = THREE.RepeatWrapping;
    diffuse.magFilter = THREE.LinearFilter;
    diffuse.minFilter = THREE.LinearMipmapLinearFilter;
    diffuse.generateMipmaps = true;
    diffuse.colorSpace = THREE.SRGBColorSpace;
    diffuse.flipY = true;
    diffuse.needsUpdate = true;

    const normal = buildNormalMapFromHeight(heightBuf, size, 3.6);
    this._textures.push(diffuse, normal);
    return { diffuse, normal };
  }

  _buildBoulderGeometry() {
    const noise3D = createNoise3D(createRng(8401));
    const geo = new THREE.IcosahedronGeometry(1.0, 3);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const nx = v.x;
      const ny = v.y;
      const nz = v.z;

      // Multi-octave 3D craggy granite displacement
      const macro = noise3D(nx * 1.15 + 2.3, ny * 1.15 - 1.4, nz * 1.15 + 3.1);
      const ridge = 1.0 - Math.abs(noise3D(nx * 2.1 - 4.2, ny * 2.1 + 1.9, nz * 2.1 - 0.8));
      const detail = noise3D(nx * 4.2 + 7.1, ny * 4.2 - 5.3, nz * 4.2 + 2.4);

      const disp = 0.86 + macro * 0.22 + (ridge * ridge - 0.35) * 0.16 + detail * 0.055;
      v.multiplyScalar(disp);

      // Asymmetrical boulder proportions & flattened stable underside
      v.x *= 1.14;
      v.y *= 0.78;
      v.z *= 0.98;
      if (v.y < -0.32) {
        v.y = lerp(v.y, -0.36, smoothstep(-0.32, -0.82, v.y) * 0.78);
      }

      pos.setXYZ(i, v.x, v.y, v.z);
    }

    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * Injects dynamic world-up lush moss blending + rain wetness sheen onto granite & logs.
   */
  _applyWorldUpMossShader(material, { cacheKey, mossLow = 0.45, mossHigh = 0.82, mossScale = 1.35 }) {
    const sharedUniforms = this._sharedUniforms;
    material.customProgramCacheKey = () => cacheKey;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uWetness = sharedUniforms.uWetness;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        varying vec3 vMossWorldPos;
        varying vec3 vMossWorldNormal;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 mwp = vec4( transformed, 1.0 );
        mat3 mMat3 = mat3( modelMatrix );
        #ifdef USE_INSTANCING
          mwp = instanceMatrix * mwp;
          mMat3 = mMat3 * mat3( instanceMatrix );
        #endif
        mwp = modelMatrix * mwp;
        vMossWorldPos = mwp.xyz;
        vMossWorldNormal = normalize( transpose( inverse( mMat3 ) ) * objectNormal );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uWetness;
        varying vec3 vMossWorldPos;
        varying vec3 vMossWorldNormal;

        float mHash2( vec2 p ) {
          return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
        }
        float mNoise2( vec2 p ) {
          vec2 i = floor( p );
          vec2 f = fract( p );
          vec2 u = f * f * ( 3.0 - 2.0 * f );
          return mix(
            mix( mHash2( i ), mHash2( i + vec2( 1.0, 0.0 ) ), u.x ),
            mix( mHash2( i + vec2( 0.0, 1.0 ) ), mHash2( i + vec2( 1.0, 1.0 ) ), u.x ),
            u.y
          );
        }`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 mossWN = normalize( vMossWorldNormal );
        float mN1 = mNoise2( vMossWorldPos.xz * ${mossScale.toFixed(2)} + vMossWorldPos.y * 0.85 );
        float mN2 = mNoise2( vMossWorldPos.xz * ${(mossScale * 2.7).toFixed(2)} - vec2( 3.1, 5.7 ) );
        float mossPatch = mN1 * 0.65 + mN2 * 0.35;
        float topMossMask = smoothstep( ${mossLow.toFixed(2)}, ${mossHigh.toFixed(2)}, mossWN.y + ( mossPatch - 0.48 ) * 0.28 );
        vec3 lushMossCol = mix( vec3( 0.055, 0.145, 0.032 ), vec3( 0.155, 0.285, 0.058 ), mossPatch );
        diffuseColor.rgb = mix( diffuseColor.rgb, lushMossCol, topMossMask * 0.88 );
        // Darken granite & moss when rain-soaked
        diffuseColor.rgb *= mix( 1.0, 0.64, uWetness * 0.85 );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.92, topMossMask * 0.72 );
        roughnessFactor = mix( roughnessFactor, 0.18, uWetness * 0.82 );`
      );
    };
  }

  _buildBoulders() {
    const rng = createRng(8402);
    const geo = this._buildBoulderGeometry();
    const tex = this._generateGraniteTextures(8403);
    this._geometries.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      map: tex.diffuse,
      normalMap: tex.normal,
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughness: 0.76,
      metalness: 0.04,
    });

    this._applyWorldUpMossShader(mat, {
      cacheKey: 'mossyGraniteBoulder_v1',
      mossLow: 0.45,
      mossHigh: 0.82,
      mossScale: 1.4,
    });
    this._materials.push(mat);

    const maxCount = MAX_COUNTS.boulders;
    const records = [];

    let tries = 0;
    while (records.length < maxCount && tries < 6000) {
      tries++;
      let x;
      let z;
      const roll = rng();
      if (roll < 0.44) {
        // Classic mossy boulders lining meandering stream banks & shallows
        z = (rng() * 2 - 1) * 96;
        const scx = this.terrain.getStreamCenterX(z);
        const hw = this.terrain.getStreamHalfWidth(z);
        const side = rng() > 0.5 ? 1 : -1;
        x = scx + side * (hw * 0.72 + rng() * 6.2);
      } else if (roll < 0.62) {
        // Accent boulders near the campfire clearing outer edge
        const a = rng() * Math.PI * 2;
        const d = 7.2 + rng() * 14.0;
        x = this.terrain.clearingCenter.x + Math.cos(a) * d;
        z = this.terrain.clearingCenter.y + Math.sin(a) * d;
      } else {
        // Rocky woodland ridges & forest floor
        x = (rng() * 2 - 1) * 102;
        z = (rng() * 2 - 1) * 102;
      }

      if (Math.abs(x) > 104 || Math.abs(z) > 104) continue;
      if (this.terrain.getClearingDistance(x, z) < 5.0) continue;

      const y = this.terrain.getHeightAt(x, z);
      if (y < -0.55) continue;

      const scaleBase = 0.48 + Math.pow(rng(), 1.35) * 1.48;
      const sx = scaleBase * (0.85 + rng() * 0.35);
      const sy = scaleBase * (0.68 + rng() * 0.42);
      const sz = scaleBase * (0.85 + rng() * 0.35);
      const colliderRadius = Math.max(sx, sz) * 0.92;

      if (this._isInExclusionZone(x, z, colliderRadius + 0.4)) continue;
      if (this._isNearTree(x, z, colliderRadius + 0.55)) continue;

      // Avoid heavy overlap with existing boulders (allow occasional nestled rock clusters)
      let overlap = false;
      for (let i = 0; i < records.length; i++) {
        const o = records[i];
        const minD = (colliderRadius + o.radius) * 0.78;
        const dx = x - o.x;
        const dz = z - o.z;
        if (dx * dx + dz * dz < minD * minD) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;

      records.push({
        x,
        y: y + sy * 0.14,
        z,
        sx,
        sy,
        sz,
        yaw: rng() * Math.PI * 2,
        pitch: (rng() - 0.5) * 0.35,
        roll: (rng() - 0.5) * 0.35,
        radius: colliderRadius,
      });
    }

    shuffleDeterministic(records, rng);
    this._boulderRecords = records;

    const mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    mesh.name = 'ForestMossyBoulders';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    const count = Math.min(records.length, maxCount);

    for (let i = 0; i < count; i++) {
      const b = records[i];
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(b.pitch, b.yaw, b.roll);
      dummy.scale.set(b.sx, b.sy, b.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const tone = 0.80 + rng() * 0.32;
      col.setRGB(tone * (0.96 + rng() * 0.08), tone, tone * (0.95 + rng() * 0.09));
      mesh.setColorAt(i, col);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }

  // =========================================================================
  // 5. ROTTING NURSE LOGS & WEATHERED TREE STUMPS
  // =========================================================================

  _generateRottingBarkTextures(seed) {
    const size = 256;
    const rng = createRng(seed);
    const n1 = createNoise2D(rng);
    const n2 = createNoise2D(createRng(seed + 19));

    const tileNoise = (u, v, fx, fy, fn) => {
      const a = fn(u * fx, v * fy);
      const b = fn((u - 1) * fx, v * fy);
      const c = fn(u * fx, (v - 1) * fy);
      const d = fn((u - 1) * fx, (v - 1) * fy);
      const wx = smoothstep(0.0, 1.0, u);
      const wy = smoothstep(0.0, 1.0, v);
      return lerp(lerp(a, b, wx), lerp(c, d, wx), wy);
    };

    const heightBuf = new Float32Array(size * size);
    const diff = new Uint8Array(size * size * 4);

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const idx = y * size + x;
        const p = idx * 4;

        const ridge = Math.abs(tileNoise(u, v, 11.0, 2.8, n1));
        const rot = tileNoise(u, v, 7.0, 7.0, n2) * 0.5 + 0.5;
        const fine = tileNoise(u, v, 26.0, 16.0, n1) * 0.5 + 0.5;
        const crest = smoothstep(0.08, 0.44, ridge);

        const r = lerp(34, 86, crest) + (rot - 0.5) * 18;
        const g = lerp(24, 62, crest) + (rot - 0.5) * 14;
        const b = lerp(18, 42, crest) + (fine - 0.5) * 10;

        diff[p] = clamp(Math.round(r), 0, 255);
        diff[p + 1] = clamp(Math.round(g), 0, 255);
        diff[p + 2] = clamp(Math.round(b), 0, 255);
        diff[p + 3] = 255;
        heightBuf[idx] = clamp(crest * 0.78 + fine * 0.22, 0, 1);
      }
    }

    const diffuse = new THREE.DataTexture(diff, size, size, THREE.RGBAFormat);
    diffuse.wrapS = THREE.RepeatWrapping;
    diffuse.wrapT = THREE.RepeatWrapping;
    diffuse.magFilter = THREE.LinearFilter;
    diffuse.minFilter = THREE.LinearMipmapLinearFilter;
    diffuse.generateMipmaps = true;
    diffuse.colorSpace = THREE.SRGBColorSpace;
    diffuse.flipY = true;
    diffuse.needsUpdate = true;

    const normal = buildNormalMapFromHeight(heightBuf, size, 3.8);
    this._textures.push(diffuse, normal);
    return { diffuse, normal };
  }

  _buildNurseLogGeometry() {
    const noise3D = createNoise3D(createRng(8501));
    const parts = [];

    // Main decaying trunk lying along local Z axis (-2.4 .. +2.4)
    const length = 4.8;
    const cyl = new THREE.CylinderGeometry(0.28, 0.40, length, 12, 10, false);
    cyl.rotateX(Math.PI * 0.5); // align along Z

    const pos = cyl.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);

      const t = (z + length * 0.5) / length; // 0 -> 1
      // Gentle natural arch & decay warp
      x += Math.sin(t * Math.PI) * 0.14;
      y += Math.sin(t * Math.PI) * 0.05;

      // Organic gnarled bark lumps & splintered uneven ends
      const n = noise3D(x * 3.1 + 1.2, y * 3.1 - 0.7, z * 1.4);
      const radScale = 1.0 + n * 0.12;
      x *= radScale;
      y *= radScale;

      if (Math.abs(z) > length * 0.46) {
        z += noise3D(x * 4.5, y * 4.5, z * 2.0) * 0.22;
      }
      pos.setXYZ(i, x, y, z);
    }
    cyl.computeVertexNormals();
    parts.push(normalizeGeometry(cyl));

    // Short broken branch stub protruding organically from log side
    const stub = new THREE.CylinderGeometry(0.065, 0.13, 0.92, 7, 3, false);
    stub.translate(0, 0.42, 0);
    stub.rotateZ(-0.92);
    stub.rotateY(0.45);
    stub.translate(0.18, 0.08, -0.55);
    stub.computeVertexNormals();
    parts.push(normalizeGeometry(stub));

    return safeMergeParts(parts, 'NurseLog');
  }

  _buildNurseLogs() {
    const rng = createRng(8502);
    const geo = this._buildNurseLogGeometry();
    const tex = this._generateRottingBarkTextures(8503);
    this._geometries.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      map: tex.diffuse,
      normalMap: tex.normal,
      normalScale: new THREE.Vector2(1.25, 1.25),
      roughness: 0.90,
      metalness: 0.0,
    });

    this._applyWorldUpMossShader(mat, {
      cacheKey: 'mossyNurseLog_v1',
      mossLow: 0.36,
      mossHigh: 0.76,
      mossScale: 1.65,
    });
    this._materials.push(mat);

    const maxCount = MAX_COUNTS.logs;
    const records = [];
    let tries = 0;

    while (records.length < maxCount && tries < 4000) {
      tries++;
      const x = (rng() * 2 - 1) * 94;
      const z = (rng() * 2 - 1) * 94;

      const distClear = this.terrain.getClearingDistance(x, z);
      if (distClear < 8.5) continue;

      const y = this.terrain.getHeightAt(x, z);
      if (y < 0.55) continue;

      const slope = this.terrain.getSlopeAt(x, z);
      if (slope > 0.26) continue;

      if (this._isInExclusionZone(x, z, 2.8)) continue;
      if (this._isNearTree(x, z, 2.6) || this._isNearBoulder(x, z, 2.4)) continue;

      // Avoid stacking nurse logs on top of each other
      let tooClose = false;
      for (let i = 0; i < records.length; i++) {
        const dx = x - records[i].x;
        const dz = z - records[i].z;
        if (dx * dx + dz * dz < 64.0) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const scaleLen = 0.78 + rng() * 0.56;
      const scaleRad = 0.80 + rng() * 0.48;
      const yaw = rng() * Math.PI * 2;
      const fullLen = 4.8 * scaleLen;
      const avgRad = 0.36 * scaleRad;

      // Sample terrain at both ends to ensure log rests cleanly without dangling off a cliff
      const dirX = Math.sin(yaw);
      const dirZ = Math.cos(yaw);
      const endAx = x - dirX * fullLen * 0.42;
      const endAz = z - dirZ * fullLen * 0.42;
      const endBx = x + dirX * fullLen * 0.42;
      const endBz = z + dirZ * fullLen * 0.42;
      if (this._isInExclusionZone(endAx, endAz, 0.8) || this._isInExclusionZone(endBx, endBz, 0.8)) continue;
      const yA = this.terrain.getHeightAt(endAx, endAz);
      const yB = this.terrain.getHeightAt(endBx, endBz);
      if (Math.min(yA, yB) < 0.35 || Math.abs(yA - yB) > 1.35) continue;

      records.push({
        x,
        y: (y * 0.5 + (yA + yB) * 0.25) + avgRad * 0.52,
        z,
        yaw,
        dirX,
        dirZ,
        scaleLen,
        scaleRad,
        length: fullLen,
        radius: avgRad,
      });
    }

    shuffleDeterministic(records, rng);
    this._logRecords = records;

    const mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    mesh.name = 'ForestNurseLogs';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    const tNorm = new THREE.Vector3();
    const qSlope = new THREE.Quaternion();
    const qYaw = new THREE.Quaternion();
    const col = new THREE.Color();
    const count = Math.min(records.length, maxCount);

    for (let i = 0; i < count; i++) {
      const log = records[i];
      this.terrain.getNormalAt(log.x, log.z, tNorm);
      // Rest snugly along terrain slope using Quaternion.setFromUnitVectors(UP, terrainNormal)
      qSlope.setFromUnitVectors(UP, tNorm);
      qYaw.setFromAxisAngle(UP, log.yaw);

      dummy.position.set(log.x, log.y, log.z);
      dummy.quaternion.copy(qSlope).multiply(qYaw);
      dummy.scale.set(log.scaleRad, log.scaleRad, log.scaleLen);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const shade = 0.82 + rng() * 0.28;
      col.setRGB(shade, shade * 0.96, shade * 0.90);
      mesh.setColorAt(i, col);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }

  /**
   * Combined 256x512 atlas texture for tree stumps:
   *  - Bottom half (v = 0..0.5): rough mossy bark for fluted stump sides
   *  - Top half (v = 0.5..1.0): crisp concentric annual wood-growth rings + radial drying cracks
   */
  _generateStumpAtlasTextures(seed) {
    const w = 256;
    const h = 512;
    const rng = createRng(seed);
    const n1 = createNoise2D(rng);
    const n2 = createNoise2D(createRng(seed + 53));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const heightBuf = new Float32Array(w * h);

    // Top half of canvas (y: 0..255 -> v: 0.5..1.0 after flipY=true): concentric wood rings!
    for (let y = 0; y < 256; y++) {
      const ny = (y / 255) * 2 - 1;
      for (let x = 0; x < w; x++) {
        const nx = (x / (w - 1)) * 2 - 1;
        const rDist = Math.hypot(nx, ny);
        const ang = Math.atan2(ny, nx);

        const warp = n1(nx * 2.2, ny * 2.2) * 0.08 + n2(nx * 5.0, ny * 5.0) * 0.025;
        const ringCoord = (rDist + warp) * 16.5;
        const ringBand = Math.pow(Math.sin(ringCoord * Math.PI) * 0.5 + 0.5, 0.65);

        // Heartwood darker center -> lighter golden-tan sapwood -> dark outer bark rim
        const heartwood = smoothstep(0.12, 0.62, rDist);
        const barkRim = smoothstep(0.84, 0.95, rDist);

        // Radial drying check cracks
        const crackWave = Math.abs(Math.sin(ang * 5.0 + n1(nx * 3.0, ny * 3.0) * 1.4));
        const crack = (1.0 - smoothstep(0.0, 0.045, crackWave)) * smoothstep(0.08, 0.80, rDist) * (1 - barkRim);

        let cr = lerp(118, 186, heartwood) * lerp(0.76, 1.06, ringBand);
        let cg = lerp(84, 144, heartwood) * lerp(0.74, 1.06, ringBand);
        let cb = lerp(52, 94, heartwood) * lerp(0.72, 1.05, ringBand);

        cr = lerp(cr, 52, barkRim) * (1.0 - crack * 0.65);
        cg = lerp(cg, 40, barkRim) * (1.0 - crack * 0.65);
        cb = lerp(cb, 30, barkRim) * (1.0 - crack * 0.65);

        const idx = y * w + x;
        const p = idx * 4;
        d[p] = clamp(Math.round(cr), 0, 255);
        d[p + 1] = clamp(Math.round(cg), 0, 255);
        d[p + 2] = clamp(Math.round(cb), 0, 255);
        d[p + 3] = 255;
        heightBuf[idx] = clamp(0.6 + ringBand * 0.16 - crack * 0.48, 0, 1);
      }
    }

    // Bottom half of canvas (y: 256..511 -> v: 0.0..0.5 after flipY=true): weathered bark sides
    for (let y = 256; y < h; y++) {
      const vLocal = (y - 256) / 256;
      for (let x = 0; x < w; x++) {
        const uLocal = x / w;
        const ridge = Math.abs(n1(uLocal * 12.0, vLocal * 3.2));
        const fine = n2(uLocal * 26.0, vLocal * 14.0) * 0.5 + 0.5;
        const crest = smoothstep(0.08, 0.45, ridge);

        let cr = lerp(36, 92, crest) + (fine - 0.5) * 16;
        let cg = lerp(29, 74, crest) + (fine - 0.5) * 14;
        let cb = lerp(22, 54, crest) + (fine - 0.5) * 10;

        // Basal moss collar creeping up from roots (near y = 511 -> bottom of stump)
        const baseMoss = smoothstep(0.55, 0.96, vLocal) * (0.45 + fine * 0.55);
        cr = lerp(cr, 54, baseMoss * 0.72);
        cg = lerp(cg, 96, baseMoss * 0.76);
        cb = lerp(cb, 36, baseMoss * 0.72);

        const idx = y * w + x;
        const p = idx * 4;
        d[p] = clamp(Math.round(cr), 0, 255);
        d[p + 1] = clamp(Math.round(cg), 0, 255);
        d[p + 2] = clamp(Math.round(cb), 0, 255);
        d[p + 3] = 255;
        heightBuf[idx] = clamp(crest * 0.8 + fine * 0.2, 0, 1);
      }
    }

    const diffuse = new THREE.DataTexture(new Uint8Array(d), w, h, THREE.RGBAFormat);
    diffuse.wrapS = THREE.RepeatWrapping;
    diffuse.wrapT = THREE.ClampToEdgeWrapping;
    diffuse.magFilter = THREE.LinearFilter;
    diffuse.minFilter = THREE.LinearMipmapLinearFilter;
    diffuse.generateMipmaps = true;
    diffuse.colorSpace = THREE.SRGBColorSpace;
    diffuse.flipY = true;
    diffuse.needsUpdate = true;

    this._textures.push(diffuse);
    return diffuse;
  }

  _buildStumpGeometry() {
    const parts = [];
    const height = 0.88;
    const radialSegs = 12;

    // 1. Fluted root-buttressed stump sides (UV v mapped to bottom half: 0.02..0.48)
    const sideGeo = new THREE.CylinderGeometry(0.36, 0.46, height, radialSegs, 5, true);
    sideGeo.translate(0, height * 0.5 - 0.14, 0);

    const pos = sideGeo.attributes.position;
    const uv = sideGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);

      const t = clamp((y + 0.14) / height, 0, 1); // 0 bottom -> 1 top cut
      const ang = Math.atan2(z, x);

      // 5 dramatic root buttresses flaring out at the ground
      const rootFlare = Math.pow(1.0 - t, 2.0) * 0.58 * (0.55 + 0.45 * Math.cos(ang * 5.0 + 0.6));
      const mult = 1.0 + rootFlare;
      x *= mult;
      z *= mult;

      // Subtle angled storm/saw cut tilt on top edge
      if (t > 0.7) {
        y += x * 0.14 * smoothstep(0.7, 1.0, t);
      }

      pos.setXYZ(i, x, y, z);
      uv.setY(i, lerp(0.02, 0.48, t));
    }
    sideGeo.computeVertexNormals();
    parts.push(normalizeGeometry(sideGeo));

    // 2. Concentric wood-ring cut top face (UV v mapped to top half: 0.52..0.98)
    const topGeo = new THREE.CircleGeometry(0.365, radialSegs);
    topGeo.rotateX(-Math.PI * 0.5);
    const tPos = topGeo.attributes.position;
    const tUv = topGeo.attributes.uv;
    for (let i = 0; i < tPos.count; i++) {
      const x = tPos.getX(i);
      const z = tPos.getZ(i);
      const y = height - 0.14 + x * 0.14;
      tPos.setY(i, y);
      const u = clamp((x / 0.365) * 0.47 + 0.5, 0.02, 0.98);
      const v = clamp((z / 0.365) * 0.23 + 0.75, 0.52, 0.98);
      tUv.setXY(i, u, v);
    }
    topGeo.computeVertexNormals();
    parts.push(normalizeGeometry(topGeo));

    return safeMergeParts(parts, 'WeatheredTreeStump');
  }

  _buildTreeStumps() {
    const rng = createRng(8602);
    const geo = this._buildStumpGeometry();
    const atlas = this._generateStumpAtlasTextures(8603);
    this._geometries.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      map: atlas,
      roughness: 0.86,
      metalness: 0.0,
    });

    // Inject subtle rain wetness darkening & sheen
    const sharedUniforms = this._sharedUniforms;
    mat.customProgramCacheKey = () => 'weatheredStumpWet_v1';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWetness = sharedUniforms.uWetness;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uWetness;`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= mix( 1.0, 0.68, uWetness * 0.85 );`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.28, uWetness * 0.8 );`
      );
    };
    this._materials.push(mat);

    const maxCount = MAX_COUNTS.stumps;
    const records = [];
    let tries = 0;

    while (records.length < maxCount && tries < 4000) {
      tries++;
      let x;
      let z;
      if (rng() < 0.28) {
        // Place a few rustic weathered stumps around clearing edges (great visual storytelling!)
        const a = rng() * Math.PI * 2;
        const d = 7.8 + rng() * 14.0;
        x = this.terrain.clearingCenter.x + Math.cos(a) * d;
        z = this.terrain.clearingCenter.y + Math.sin(a) * d;
      } else {
        x = (rng() * 2 - 1) * 96;
        z = (rng() * 2 - 1) * 96;
      }

      if (Math.abs(x) > 100 || Math.abs(z) > 100) continue;
      if (this._isInExclusionZone(x, z, 0.9)) continue;
      if (this.terrain.getClearingDistance(x, z) < 6.8) continue;

      const y = this.terrain.getHeightAt(x, z);
      if (y < 0.55) continue;
      if (this.terrain.getSlopeAt(x, z) > 0.29) continue;
      if (this._isNearTree(x, z, 1.8) || this._isNearBoulder(x, z, 1.4)) continue;

      const scaleXZ = 0.85 + rng() * 0.72;
      const scaleY = 0.78 + rng() * 0.58;
      records.push({
        x,
        y: y - 0.04,
        z,
        yaw: rng() * Math.PI * 2,
        scaleXZ,
        scaleY,
        radius: 0.44 * scaleXZ,
      });
    }

    shuffleDeterministic(records, rng);
    this._stumpRecords = records;

    const mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    mesh.name = 'ForestTreeStumps';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    const count = Math.min(records.length, maxCount);

    for (let i = 0; i < count; i++) {
      const s = records[i];
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set((rng() - 0.5) * 0.08, s.yaw, (rng() - 0.5) * 0.08);
      dummy.scale.set(s.scaleXZ, s.scaleY, s.scaleXZ);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const shade = 0.84 + rng() * 0.26;
      col.setRGB(shade, shade * 0.98, shade * 0.94);
      mesh.setColorAt(i, col);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }

  // =========================================================================
  // 6. BIOLUMINESCENT MUSHROOM CLUSTERS (cyan & amber HDR night glow!)
  // =========================================================================

  _buildMushroomClusterGeometry() {
    const parts = [];

    // 5 organically arranged forest mushrooms per cluster (tall hero + medium + small buds)
    const specs = [
      { ox: 0.00, oz: 0.00, h: 0.34, leanX: 0.03, leanZ: 0.02, stemR: 0.024, capR: 0.145, capH: 0.095 },
      { ox: 0.11, oz: 0.07, h: 0.25, leanX: 0.07, leanZ: 0.04, stemR: 0.019, capR: 0.110, capH: 0.072 },
      { ox: -0.10, oz: 0.08, h: 0.21, leanX: -0.06, leanZ: 0.05, stemR: 0.017, capR: 0.095, capH: 0.064 },
      { ox: -0.04, oz: -0.11, h: 0.16, leanX: -0.03, leanZ: -0.06, stemR: 0.014, capR: 0.074, capH: 0.052 },
      { ox: 0.08, oz: -0.09, h: 0.12, leanX: 0.05, leanZ: -0.04, stemR: 0.012, capR: 0.058, capH: 0.042 },
    ];

    for (let m = 0; m < specs.length; m++) {
      const sp = specs[m];
      const basePt = new THREE.Vector3(sp.ox, -0.02, sp.oz);
      const midPt = new THREE.Vector3(sp.ox + sp.leanX * 0.42, sp.h * 0.52, sp.oz + sp.leanZ * 0.42);
      const topPt = new THREE.Vector3(sp.ox + sp.leanX, sp.h, sp.oz + sp.leanZ);

      // Curved slender stem (aIsCap = 0.0)
      const curve = new THREE.QuadraticBezierCurve3(basePt, midPt, topPt);
      const stemGeo = new THREE.TubeGeometry(curve, 5, sp.stemR, 6, false);
      parts.push(
        normalizeGeometry(stemGeo, {
          aIsCap: { itemSize: 1, fn: () => 0.0 },
        })
      );

      // Smooth organically undulating bell/dome cap (aIsCap = 0.72..1.0)
      const capGeo = new THREE.SphereGeometry(sp.capR, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.58);
      capGeo.scale(1.0, sp.capH / sp.capR, 1.0);

      const cPos = capGeo.attributes.position;
      for (let i = 0; i < cPos.count; i++) {
        const vx = cPos.getX(i);
        const vy = cPos.getY(i);
        const vz = cPos.getZ(i);
        const ang = Math.atan2(vz, vx);
        const rimT = clamp(Math.hypot(vx, vz) / sp.capR, 0, 1);
        // Subtle natural scalloped mushroom cap rim wave
        const wave = Math.sin(ang * 4.0 + m * 1.7) * 0.012 * rimT * rimT;
        cPos.setY(i, vy + wave);
      }

      // Tilt cap naturally with stem tip tangent
      const tipDir = new THREE.Vector3().subVectors(topPt, midPt).normalize();
      const qTilt = new THREE.Quaternion().setFromUnitVectors(UP, tipDir);
      capGeo.applyQuaternion(qTilt);
      capGeo.translate(topPt.x, topPt.y - sp.capH * 0.14, topPt.z);
      capGeo.computeVertexNormals();

      parts.push(
        normalizeGeometry(capGeo, {
          aIsCap: {
            itemSize: 1,
            fn: (x, y, z) => {
              const distFromCenter = Math.hypot(x - topPt.x, z - topPt.z) / Math.max(sp.capR, 0.01);
              return clamp(0.84 + 0.16 * (1.0 - distFromCenter * 0.5), 0.76, 1.0);
            },
          },
        })
      );

      // Subtle glowing underside gill cone so caps look complete from low crouch views (aIsCap = 0.72)
      const gillGeo = new THREE.CircleGeometry(sp.capR * 0.96, 10);
      gillGeo.rotateX(Math.PI * 0.5);
      gillGeo.applyQuaternion(qTilt);
      gillGeo.translate(topPt.x, topPt.y - sp.capH * 0.16, topPt.z);
      gillGeo.computeVertexNormals();
      parts.push(
        normalizeGeometry(gillGeo, {
          aIsCap: { itemSize: 1, fn: () => 0.72 },
        })
      );
    }

    return safeMergeParts(parts, 'BioluminescentMushroomCluster');
  }

  _buildBioluminescentMushrooms() {
    const rng = createRng(8702);
    const geo = this._buildMushroomClusterGeometry();
    this._geometries.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.44,
      metalness: 0.0,
    });

    const sharedUniforms = this._sharedUniforms;
    mat.customProgramCacheKey = () => 'bioluminescentMushrooms_v1';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = sharedUniforms.uTime;
      shader.uniforms.uNightGlow = sharedUniforms.uNightGlow;
      shader.uniforms.uWetness = sharedUniforms.uWetness;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        attribute float aIsCap;
        varying float vIsCap;
        varying vec3 vMushGlowColor;
        varying float vMushPhase;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vIsCap = aIsCap;
        vMushGlowColor = vec3( 0.17, 0.95, 0.84 );
        #ifdef USE_INSTANCING_COLOR
          vMushGlowColor = instanceColor.rgb;
        #endif
        vec4 mwOrigin = vec4( 0.0, 0.0, 0.0, 1.0 );
        #ifdef USE_INSTANCING
          mwOrigin = instanceMatrix * mwOrigin;
        #endif
        mwOrigin = modelMatrix * mwOrigin;
        vMushPhase = dot( mwOrigin.xz, vec2( 0.43, 0.67 ) );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uNightGlow;
        uniform float uWetness;
        varying float vIsCap;
        varying vec3 vMushGlowColor;
        varying float vMushPhase;`
      );

      // Keep stems pale cream-brown while caps carry subtle translucent pigment & HDR night bloom!
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `vec3 stemBase = vec3( 0.44, 0.37, 0.27 );
        vec3 capDayBase = mix( vec3( 0.42, 0.39, 0.34 ), vMushGlowColor * 0.62, 0.55 );
        float capMask = smoothstep( 0.15, 0.55, vIsCap );
        diffuseColor.rgb *= mix( stemBase, capDayBase, capMask );
        diffuseColor.rgb *= mix( 1.0, 0.78, uWetness );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.18, uWetness * 0.8 );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float bioPulse = 0.86 + 0.14 * sin( uTime * 1.45 + vMushPhase );
        totalEmissiveRadiance += vMushGlowColor * vIsCap * uNightGlow * bioPulse;`
      );
    };
    this._materials.push(mat);

    const maxCount = MAX_COUNTS.mushrooms;
    const placements = [];

    const tryAddMushroom = (x, z, scaleMin = 0.82, scaleMax = 1.55) => {
      if (Math.abs(x) > 100 || Math.abs(z) > 100) return false;
      if (this._isInExclusionZone(x, z, 0.35)) return false;
      if (this.terrain.getClearingDistance(x, z) < 4.5) return false;
      const y = this.terrain.getHeightAt(x, z);
      if (y < 0.26) return false;
      if (this.terrain.getSlopeAt(x, z) > 0.36) return false;

      // Cyan (#2bf2d6) or warm amber (#ffaa38) bioluminescence
      const isCyan = rng() < 0.56;
      placements.push({
        x,
        y: y - 0.015,
        z,
        yaw: rng() * Math.PI * 2,
        scale: scaleMin + rng() * (scaleMax - scaleMin),
        isCyan,
      });
      return true;
    };

    // 1. Lovingly clustered along rotting nurse logs (~86 clusters; prioritize logs visible at Medium+)
    const medLogCount = Math.min(QUALITY_COUNTS.Medium.logs, this._logRecords.length);
    for (let i = 0; i < medLogCount && placements.length < 86; i++) {
      const log = this._logRecords[i];
      const nClusters = 3 + Math.floor(rng() * 2);
      for (let k = 0; k < nClusters && placements.length < 86; k++) {
        const along = (rng() - 0.5) * log.length * 0.95;
        const side = (rng() > 0.5 ? 1 : -1) * (log.radius + 0.18 + rng() * 0.55);
        const mx = log.x + log.dirX * along - log.dirZ * side;
        const mz = log.z + log.dirZ * along + log.dirX * side;
        tryAddMushroom(mx, mz, 0.90, 1.55);
      }
    }

    // 2. Tucked beside mossy granite boulders (~54 clusters; prioritize boulders visible at Medium+)
    const medBoulderCount = Math.min(QUALITY_COUNTS.Medium.boulders, this._boulderRecords.length);
    for (let i = 0; i < medBoulderCount && placements.length < 140; i++) {
      const b = this._boulderRecords[i];
      if (rng() > 0.58) continue;
      const a = rng() * Math.PI * 2;
      const d = b.radius + 0.16 + rng() * 0.42;
      tryAddMushroom(b.x + Math.cos(a) * d, b.z + Math.sin(a) * d, 0.85, 1.48);
    }

    // 3. Nestled at shady tree roots (~64 clusters, favoring hero & near-clearing trees too!)
    for (let i = 0; i < this.treePositions.length && placements.length < 204; i++) {
      const t = this.treePositions[i];
      if (rng() > 0.35) continue;
      const a = rng() * Math.PI * 2;
      const d = t.radius + 0.22 + rng() * 0.65;
      tryAddMushroom(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, 0.85, 1.52);
    }

    // 4. Shady damp stream banks & clearing perimeter tree shadows up to maxCount
    let tries = 0;
    while (placements.length < maxCount && tries < 3000) {
      tries++;
      const z = (rng() * 2 - 1) * 86;
      const scx = this.terrain.getStreamCenterX(z);
      const hw = this.terrain.getStreamHalfWidth(z);
      const side = rng() > 0.5 ? 1 : -1;
      const x = scx + side * (hw + 0.8 + rng() * 5.2);
      tryAddMushroom(x, z, 0.80, 1.45);
    }

    shuffleDeterministic(placements, rng);

    const mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    mesh.name = 'ForestBioluminescentMushrooms';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const cyanBase = new THREE.Color('#2bf2d6');
    const amberBase = new THREE.Color('#ffaa38');
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    const count = Math.min(placements.length, maxCount);

    for (let i = 0; i < count; i++) {
      const p = placements[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set((rng() - 0.5) * 0.16, p.yaw, (rng() - 0.5) * 0.16);
      dummy.scale.set(p.scale, p.scale * (0.9 + rng() * 0.25), p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      col.copy(p.isCyan ? cyanBase : amberBase);
      // Slight organic hue/intensity variance per cluster
      col.offsetHSL((rng() - 0.5) * 0.035, (rng() - 0.5) * 0.06, (rng() - 0.5) * 0.06);
      mesh.setColorAt(i, col);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this._mushroomsMaxPlaced = count;
    return mesh;
  }

  // =========================================================================
  // 7. FOREST-FLOOR MICRO-DETAIL SCATTER LAYERS (Twigs, Pebbles, Clovers, Pine Needles)
  // =========================================================================

  _applySimpleWetnessShader(material, cacheKey, darken = 0.68, wetRoughness = 0.28) {
    const sharedUniforms = this._sharedUniforms;
    material.customProgramCacheKey = () => cacheKey;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uWetness = sharedUniforms.uWetness;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uWetness;`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= mix( 1.0, ${darken.toFixed(2)}, uWetness * 0.85 );`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, ${wetRoughness.toFixed(2)}, uWetness * 0.8 );`
      );
    };
  }

  // 7A. Scattered Fallen Twigs & Small Branches (~480)
  _buildFallenTwigs() {
    const rng = createRng(8801);
    const parts = [];

    // Main gently bent woody twig lying along local Z
    const mainCurve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(-0.04, 0.018, -0.34),
      new THREE.Vector3(0.035, 0.024, 0.0),
      new THREE.Vector3(-0.02, 0.015, 0.32)
    );
    parts.push(normalizeGeometry(new THREE.TubeGeometry(mainCurve, 5, 0.015, 5, false)));

    // Forked side shoot 1
    const fork1 = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(0.02, 0.022, -0.04),
      new THREE.Vector3(0.11, 0.028, 0.08),
      new THREE.Vector3(0.19, 0.018, 0.20)
    );
    parts.push(normalizeGeometry(new THREE.TubeGeometry(fork1, 4, 0.009, 4, false)));

    // Smaller opposite twig spur 2
    const fork2 = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(-0.005, 0.020, -0.14),
      new THREE.Vector3(-0.085, 0.025, -0.22),
      new THREE.Vector3(-0.15, 0.016, -0.28)
    );
    parts.push(normalizeGeometry(new THREE.TubeGeometry(fork2, 3, 0.0075, 4, false)));

    const geo = safeMergeParts(parts, 'FallenTwigCluster');
    this._geometries.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.0,
    });
    this._applySimpleWetnessShader(mat, 'fallenTwigsWet_v1', 0.62, 0.30);
    this._materials.push(mat);

    const maxCount = MAX_COUNTS.twigs;
    const placements = [];
    const clearingC = this.terrain.clearingCenter;

    let tries = 0;
    while (placements.length < maxCount && tries < 6000) {
      tries++;
      let x;
      let z;
      const roll = rng();
      if (roll < 0.45 && this.treePositions.length > 0) {
        const t = this.treePositions[Math.floor(rng() * this.treePositions.length)];
        const a = rng() * Math.PI * 2;
        const d = t.radius + 0.65 + rng() * 4.4;
        x = t.x + Math.cos(a) * d;
        z = t.z + Math.sin(a) * d;
      } else if (roll < 0.68) {
        const a = rng() * Math.PI * 2;
        const d = 4.2 + rng() * 20.0;
        x = clearingC.x + Math.cos(a) * d;
        z = clearingC.y + Math.sin(a) * d;
      } else {
        x = (rng() * 2 - 1) * 92;
        z = (rng() * 2 - 1) * 92;
      }

      if (Math.abs(x) > 98 || Math.abs(z) > 98) continue;
      if (this._isInExclusionZone(x, z, 0.4)) continue;
      if (this.terrain.getClearingDistance(x, z) < 2.6) continue;
      const y = this.terrain.getHeightAt(x, z);
      if (y < 0.22) continue;
      if (this.terrain.getSlopeAt(x, z) > 0.36) continue;
      if (this._isNearBoulder(x, z, 0.1)) continue;

      placements.push({
        x,
        y,
        z,
        yaw: rng() * Math.PI * 2,
        scale: 0.58 + rng() * 0.88,
      });
    }

    shuffleDeterministic(placements, rng);

    const mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    mesh.name = 'ForestFallenTwigs';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const palette = [
      new THREE.Color('#5a422e'), // weathered cedar brown
      new THREE.Color('#473527'), // damp forest bark
      new THREE.Color('#6b5a49'), // dry silvered twig
      new THREE.Color('#3c2d21'), // dark oak branch
    ];
    const dummy = new THREE.Object3D();
    const tNorm = new THREE.Vector3();
    const qSlope = new THREE.Quaternion();
    const qYaw = new THREE.Quaternion();
    const col = new THREE.Color();
    const count = Math.min(placements.length, maxCount);

    for (let i = 0; i < count; i++) {
      const p = placements[i];
      this.terrain.getNormalAt(p.x, p.z, tNorm);
      qSlope.setFromUnitVectors(UP, tNorm);
      qYaw.setFromAxisAngle(UP, p.yaw);

      dummy.position.set(p.x, p.y - 0.004, p.z);
      dummy.quaternion.copy(qSlope).multiply(qYaw);
      dummy.scale.set(p.scale, p.scale * (0.85 + rng() * 0.3), p.scale * (0.88 + rng() * 0.35));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      col.copy(palette[Math.floor(rng() * palette.length)]).multiplyScalar(0.84 + rng() * 0.32);
      mesh.setColorAt(i, col);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this._twigsMaxPlaced = count;
    return mesh;
  }

  // 7B. Small Mossy Forest Pebbles (~650)
  _buildMossyPebbles() {
    const rng = createRng(8821);
    const n3 = createNoise3D(createRng(8822));
    const parts = [];

    const pebbleSpecs = [
      { ox: 0.0, oz: 0.0, rx: 0.095, ry: 0.052, rz: 0.078, seed: 1.1 },
      { ox: 0.115, oz: 0.048, rx: 0.058, ry: 0.036, rz: 0.050, seed: 3.7 },
      { ox: -0.088, oz: 0.068, rx: 0.044, ry: 0.028, rz: 0.042, seed: 6.2 },
    ];

    const tmpV = new THREE.Vector3();
    for (const sp of pebbleSpecs) {
      const g = new THREE.IcosahedronGeometry(1.0, 1);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        tmpV.fromBufferAttribute(pos, i);
        const w = 0.86 + n3(tmpV.x * 1.9 + sp.seed, tmpV.y * 1.9, tmpV.z * 1.9 - sp.seed) * 0.24;
        tmpV.multiplyScalar(w);
        tmpV.x = tmpV.x * sp.rx + sp.ox;
        tmpV.y = Math.max(-sp.ry * 0.42, tmpV.y * sp.ry) + sp.ry * 0.36;
        tmpV.z = tmpV.z * sp.rz + sp.oz;
        pos.setXYZ(i, tmpV.x, tmpV.y, tmpV.z);
      }
      g.computeVertexNormals();
      parts.push(normalizeGeometry(g));
    }

    const geo = safeMergeParts(parts, 'MossyForestPebbles');
    this._geometries.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.03,
    });
    this._applyWorldUpMossShader(mat, {
      cacheKey: 'mossyForestPebbles_v1',
      mossLow: 0.56,
      mossHigh: 0.88,
      mossScale: 2.8,
    });
    this._materials.push(mat);

    const maxCount = MAX_COUNTS.pebbles;
    const placements = [];
    const clearingC = this.terrain.clearingCenter;

    let tries = 0;
    while (placements.length < maxCount && tries < 7500) {
      tries++;
      let x;
      let z;
      const roll = rng();
      if (roll < 0.48) {
        // Dense river-worn pebbles lining stream banks & gravelly shallows
        z = (rng() * 2 - 1) * 90;
        const scx = this.terrain.getStreamCenterX(z);
        const hw = this.terrain.getStreamHalfWidth(z);
        const side = rng() > 0.5 ? 1 : -1;
        x = scx + side * (hw * 0.55 + Math.pow(rng(), 0.78) * 7.8);
      } else if (roll < 0.72) {
        // Clearing perimeter & trail edges
        const a = rng() * Math.PI * 2;
        const d = 3.0 + rng() * 18.0;
        x = clearingC.x + Math.cos(a) * d;
        z = clearingC.y + Math.sin(a) * d;
      } else {
        x = (rng() * 2 - 1) * 92;
        z = (rng() * 2 - 1) * 92;
      }

      if (Math.abs(x) > 98 || Math.abs(z) > 98) continue;
      if (this._isInExclusionZone(x, z, 0.35)) continue;
      const y = this.terrain.getHeightAt(x, z);
      if (y < -0.45) continue;
      if (this.terrain.getSlopeAt(x, z) > 0.42) continue;

      placements.push({
        x,
        y,
        z,
        yaw: rng() * Math.PI * 2,
        scale: 0.62 + rng() * 0.92,
      });
    }

    shuffleDeterministic(placements, rng);

    const mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    mesh.name = 'ForestMossyPebbles';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const stonePalette = [
      new THREE.Color('#777c79'), // cool granite grey
      new THREE.Color('#8e8577'), // warm river sandstone
      new THREE.Color('#5d6266'), // wet dark slate
      new THREE.Color('#9a988e'), // pale quartz cobble
    ];
    const dummy = new THREE.Object3D();
    const tNorm = new THREE.Vector3();
    const qSlope = new THREE.Quaternion();
    const qYaw = new THREE.Quaternion();
    const col = new THREE.Color();
    const count = Math.min(placements.length, maxCount);

    for (let i = 0; i < count; i++) {
      const p = placements[i];
      this.terrain.getNormalAt(p.x, p.z, tNorm);
      qSlope.setFromUnitVectors(UP, tNorm);
      qYaw.setFromAxisAngle(UP, p.yaw);

      dummy.position.set(p.x, p.y - 0.008, p.z);
      dummy.quaternion.copy(qSlope).multiply(qYaw);
      dummy.scale.set(
        p.scale * (0.88 + rng() * 0.28),
        p.scale * (0.78 + rng() * 0.34),
        p.scale * (0.88 + rng() * 0.28)
      );
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      col.copy(stonePalette[Math.floor(rng() * stonePalette.length)]).multiplyScalar(0.84 + rng() * 0.30);
      mesh.setColorAt(i, col);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this._pebblesMaxPlaced = count;
    return mesh;
  }

  // 7C. Lush Three-Leaf Clover Patches (~520)
  _buildCloverPatches() {
    const rng = createRng(8841);
    const parts = [];

    // 6 delicate clover sprigs per lush ground patch, each crowned with 3 distinct leaflets at 120 deg!
    const sprigOffsets = [
      { ox: 0.0, oz: 0.0, h: 0.092, r: 0.036, yaw: 0.2 },
      { ox: 0.088, oz: 0.042, h: 0.078, r: 0.032, yaw: 1.4 },
      { ox: -0.082, oz: 0.056, h: 0.082, r: 0.033, yaw: 2.6 },
      { ox: 0.032, oz: -0.092, h: 0.072, r: 0.030, yaw: 3.9 },
      { ox: -0.072, oz: -0.068, h: 0.068, r: 0.029, yaw: 5.1 },
      { ox: 0.115, oz: -0.045, h: 0.064, r: 0.028, yaw: 0.9 },
    ];

    for (const sp of sprigOffsets) {
      // Short slender petiole stem
      const stem = new THREE.CylinderGeometry(0.0032, 0.0042, sp.h, 4, 1);
      stem.translate(sp.ox, sp.h * 0.5, sp.oz);
      parts.push(
        normalizeGeometry(stem, {
          aBend: { itemSize: 1, fn: (_x, y) => clamp(y / 0.10, 0, 1) },
        })
      );

      // 3 distinct radiating obovate/heart-shaped clover leaflets
      for (let k = 0; k < 3; k++) {
        const ang = sp.yaw + (k / 3) * Math.PI * 2;
        const leaf = new THREE.CircleGeometry(sp.r, 6);
        leaf.scale(0.92, 1.15, 1.0);
        leaf.translate(0, sp.r * 0.88, 0);
        // Slightly cupped upward to catch dappled forest sunlight
        leaf.rotateX(-Math.PI * 0.5 + 0.18);
        leaf.rotateY(ang);
        leaf.translate(sp.ox, sp.h, sp.oz);
        parts.push(
          normalizeGeometry(leaf, {
            aBend: { itemSize: 1, fn: () => clamp(sp.h / 0.10, 0.55, 1.0) },
          })
        );
      }
    }

    const geo = safeMergeParts(parts, 'ThreeLeafCloverPatch');
    this._geometries.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.62,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    this.windSystem.applyFoliageWindShader(mat, {
      bendStrength: 0.24,
      flutterStrength: 0.09,
      partStrength: 0.72,
      useRootAO: true,
      useBendAttr: true,
    });
    this._materials.push(mat);

    const maxCount = MAX_COUNTS.clovers;
    const placements = [];
    const clearingC = this.terrain.clearingCenter;

    let tries = 0;
    while (placements.length < maxCount && tries < 6500) {
      tries++;
      let x;
      let z;
      const roll = rng();
      if (roll < 0.48) {
        // Lush clearing border meadows
        const a = rng() * Math.PI * 2;
        const d = 3.0 + Math.pow(rng(), 0.78) * 18.5;
        x = clearingC.x + Math.cos(a) * d;
        z = clearingC.y + Math.sin(a) * d;
      } else if (roll < 0.78) {
        // Damp mossy stream corridors
        z = (rng() * 2 - 1) * 82;
        const scx = this.terrain.getStreamCenterX(z);
        const hw = this.terrain.getStreamHalfWidth(z);
        const side = rng() > 0.5 ? 1 : -1;
        x = scx + side * (hw + 0.9 + rng() * 12.5);
      } else {
        x = (rng() * 2 - 1) * 86;
        z = (rng() * 2 - 1) * 86;
      }

      if (Math.abs(x) > 94 || Math.abs(z) > 94) continue;
      if (this._isInExclusionZone(x, z, 0.35)) continue;
      if (this.terrain.getClearingDistance(x, z) < 2.8) continue;
      const y = this.terrain.getHeightAt(x, z);
      if (y < 0.26) continue;
      if (this.terrain.getSlopeAt(x, z) > 0.34) continue;
      if (this._isNearBoulder(x, z, 0.15)) continue;

      placements.push({
        x,
        y,
        z,
        yaw: rng() * Math.PI * 2,
        scale: 0.76 + rng() * 0.74,
      });
    }

    shuffleDeterministic(placements, rng);

    const mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    mesh.name = 'ForestCloverPatches';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const cloverPalette = [
      new THREE.Color('#2d7427'), // shamrock emerald
      new THREE.Color('#3f8a2d'), // sunlit clover green
      new THREE.Color('#539b35'), // fresh spring clover
      new THREE.Color('#245f22'), // shady mossy clover
    ];
    const dummy = new THREE.Object3D();
    const tNorm = new THREE.Vector3();
    const qSlope = new THREE.Quaternion();
    const qYaw = new THREE.Quaternion();
    const col = new THREE.Color();
    const count = Math.min(placements.length, maxCount);

    for (let i = 0; i < count; i++) {
      const p = placements[i];
      this.terrain.getNormalAt(p.x, p.z, tNorm);
      tNorm.lerp(UP, 0.35).normalize();
      qSlope.setFromUnitVectors(UP, tNorm);
      qYaw.setFromAxisAngle(UP, p.yaw);

      dummy.position.set(p.x, p.y - 0.008, p.z);
      dummy.quaternion.copy(qSlope).multiply(qYaw);
      dummy.scale.set(p.scale, p.scale * (0.85 + rng() * 0.32), p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      col.copy(cloverPalette[Math.floor(rng() * cloverPalette.length)]).multiplyScalar(0.88 + rng() * 0.26);
      mesh.setColorAt(i, col);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this._cloversMaxPlaced = count;
    return mesh;
  }

  // 7D. Clusters of Fallen Reddish-Brown Pine Needles (~520 near pines & forest soil)
  _buildPineNeedleClusters() {
    const rng = createRng(8861);
    const parts = [];

    // 16 slender crisscrossed reddish-brown fallen pine needles fanned softly over the forest floor
    for (let n = 0; n < 16; n++) {
      const a = rng() * Math.PI * 2;
      const dist = Math.sqrt(rng()) * 0.28;
      const ox = Math.cos(a) * dist;
      const oz = Math.sin(a) * dist;
      const len = 0.14 + rng() * 0.14;
      const wid = 0.011 + rng() * 0.006;

      const blade = new THREE.PlaneGeometry(wid, len, 1, 1);
      blade.rotateX(-Math.PI * 0.5 + (rng() - 0.5) * 0.14);
      blade.rotateY(rng() * Math.PI * 2);
      blade.translate(ox, 0.012 + rng() * 0.014, oz);
      parts.push(normalizeGeometry(blade));
    }

    const geo = safeMergeParts(parts, 'FallenPineNeedleCluster');
    this._geometries.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    this._applySimpleWetnessShader(mat, 'fallenPineNeedlesWet_v1', 0.60, 0.32);
    this._materials.push(mat);

    const maxCount = MAX_COUNTS.pineNeedles;
    const placements = [];
    const pineTrees = this.treePositions.filter((t) => t.species === 'pine');

    let tries = 0;
    while (placements.length < maxCount && tries < 6500) {
      tries++;
      let x;
      let z;
      if (pineTrees.length > 0 && rng() < 0.72) {
        // Carpets beneath pine canopies & root flares
        const pine = pineTrees[Math.floor(rng() * pineTrees.length)];
        const a = rng() * Math.PI * 2;
        const d = pine.radius + 0.35 + Math.pow(rng(), 0.75) * 4.6;
        x = pine.x + Math.cos(a) * d;
        z = pine.z + Math.sin(a) * d;
      } else {
        // Scattered woodland forest soil
        x = (rng() * 2 - 1) * 94;
        z = (rng() * 2 - 1) * 94;
      }

      if (Math.abs(x) > 98 || Math.abs(z) > 98) continue;
      if (this._isInExclusionZone(x, z, 0.35)) continue;
      if (this.terrain.getClearingDistance(x, z) < 3.4) continue;
      const y = this.terrain.getHeightAt(x, z);
      if (y < 0.25) continue;
      if (this.terrain.getSlopeAt(x, z) > 0.36) continue;
      if (this._isNearBoulder(x, z, 0.1)) continue;

      placements.push({
        x,
        y,
        z,
        yaw: rng() * Math.PI * 2,
        scale: 0.78 + rng() * 0.88,
      });
    }

    shuffleDeterministic(placements, rng);

    const mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    mesh.name = 'ForestPineNeedleClusters';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const needlePalette = [
      new THREE.Color('#7c4322'), // rich russet pine needle
      new THREE.Color('#925128'), // warm cinnamon auburn
      new THREE.Color('#65361d'), // deep damp duff brown
      new THREE.Color('#a46331'), // sunlit amber-russet needle
    ];
    const dummy = new THREE.Object3D();
    const tNorm = new THREE.Vector3();
    const qSlope = new THREE.Quaternion();
    const qYaw = new THREE.Quaternion();
    const col = new THREE.Color();
    const count = Math.min(placements.length, maxCount);

    for (let i = 0; i < count; i++) {
      const p = placements[i];
      this.terrain.getNormalAt(p.x, p.z, tNorm);
      qSlope.setFromUnitVectors(UP, tNorm);
      qYaw.setFromAxisAngle(UP, p.yaw);

      dummy.position.set(p.x, p.y, p.z);
      dummy.quaternion.copy(qSlope).multiply(qYaw);
      dummy.scale.set(p.scale, p.scale, p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      col.copy(needlePalette[Math.floor(rng() * needlePalette.length)]).multiplyScalar(0.86 + rng() * 0.28);
      mesh.setColorAt(i, col);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this._pineNeedlesMaxPlaced = count;
    return mesh;
  }

  // =========================================================================
  // QUALITY SCALING, COLLIDERS, REAL-TIME UPDATES & CLEANUP
  // =========================================================================

  setQuality(preset = 'High') {
    const cfg = QUALITY_COUNTS[preset] ?? QUALITY_COUNTS.High;
    this._currentQuality = preset in QUALITY_COUNTS ? preset : 'High';

    this.grassMesh.count = Math.min(cfg.grass, this._grassMaxPlaced ?? cfg.grass);
    this.fernMesh.count = Math.min(cfg.ferns, this._fernsMaxPlaced ?? cfg.ferns);
    this.wildflowerMesh.count = Math.min(cfg.wildflowers, this._wildflowersMaxPlaced ?? cfg.wildflowers);
    this.boulderMesh.count = Math.min(cfg.boulders, this._boulderRecords.length);
    this.logMesh.count = Math.min(cfg.logs, this._logRecords.length);
    this.stumpMesh.count = Math.min(cfg.stumps, this._stumpRecords.length);
    this.mushroomMesh.count = Math.min(cfg.mushrooms, this._mushroomsMaxPlaced ?? cfg.mushrooms);
    if (this.twigMesh) {
      this.twigMesh.count = Math.min(cfg.twigs, this._twigsMaxPlaced ?? cfg.twigs);
    }
    if (this.pebbleMesh) {
      this.pebbleMesh.count = Math.min(cfg.pebbles, this._pebblesMaxPlaced ?? cfg.pebbles);
    }
    if (this.cloverMesh) {
      this.cloverMesh.count = Math.min(cfg.clovers, this._cloversMaxPlaced ?? cfg.clovers);
    }
    if (this.pineNeedleMesh) {
      this.pineNeedleMesh.count = Math.min(cfg.pineNeedles, this._pineNeedlesMaxPlaced ?? cfg.pineNeedles);
    }

    // Rebuild active collision list to strictly match visible boulders, large logs & large stumps
    const activeColliders = [];

    for (let i = 0; i < this.boulderMesh.count; i++) {
      const b = this._boulderRecords[i];
      activeColliders.push({
        x: b.x,
        z: b.z,
        radius: b.radius,
        kind: 'boulder',
      });
    }

    // Add 3 bounding circles along the spine of each active nurse log for solid walk collision
    for (let i = 0; i < this.logMesh.count; i++) {
      const log = this._logRecords[i];
      if (log.radius < 0.28) continue;
      const span = log.length * 0.34;
      for (const offset of [-span, 0, span]) {
        activeColliders.push({
          x: log.x + log.dirX * offset,
          z: log.z + log.dirZ * offset,
          radius: log.radius * 1.25,
          kind: 'log',
        });
      }
    }

    for (let i = 0; i < this.stumpMesh.count; i++) {
      const s = this._stumpRecords[i];
      if (s.radius >= 0.42) {
        activeColliders.push({
          x: s.x,
          z: s.z,
          radius: s.radius,
          kind: 'stump',
        });
      }
    }

    this.colliders = activeColliders;
  }

  getActiveColliders() {
    return this.colliders;
  }

  update(dt, elapsed, { nightFactor = 0, wetness = 0 } = {}) {
    this._sharedUniforms.uTime.value = elapsed;
    this._sharedUniforms.uWetness.value = clamp(wetness, 0, 1);

    // Smooth HDR ramp: dark at bright midday, enchanting ethereal HDR ~2.45 bloom at night!
    const nightGlow = smoothstep(0.22, 0.90, clamp(nightFactor, 0, 1)) * 2.45;
    this._sharedUniforms.uNightGlow.value = nightGlow;
  }

  dispose() {
    this.scene.remove(this.group);

    for (const g of this._geometries) g.dispose();
    for (const m of this._materials) m.dispose();
    for (const t of this._textures) t.dispose();

    this._geometries.length = 0;
    this._materials.length = 0;
    this._textures.length = 0;
    this.colliders.length = 0;
  }
}
