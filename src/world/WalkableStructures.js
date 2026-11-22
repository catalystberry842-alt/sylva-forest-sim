import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { WATER_LEVEL } from './Terrain.js';
import { createRng, clamp, lerp, smoothstep } from '../utils/random.js';

/**
 * Canonical site coordinates and orientation metadata for all 4 walkable structures.
 */
export const STRUCTURE_SITES = {
  cabin: {
    id: 'ranger_cabin',
    name: 'Timber Ranger Cabin',
    x: 17.2,
    z: -1.8,
    yaw: Math.atan2(10.5 - 17.2, 6.0 - -1.8), // local +Z faces southwest toward campfire clearing (10.5, 6.0)
    groundY: 2.45,
    floorY: 3.2,
  },
  redwood: {
    id: 'hollow_redwood',
    name: 'Hollow Giant Ancient Redwood',
    x: -20.5,
    z: 13.5,
    gapAngle: -0.22, // natural split archway faces east toward bridge & clearing
    gapHalfWidth: 0.42,
    innerRadius: 1.72,
    outerRadius: 2.4,
  },
  cavern: {
    id: 'mossy_cavern',
    name: 'Mossy Stone Cavern',
    x: 26.8,
    z: 14.5,
    yaw: Math.atan2(-0.821107, -0.570774), // local +Z faces northwest along (-0.82, -0.57) toward clearing
    floorY: 4.22,
  },
  bridge: {
    id: 'wooden_footbridge',
    name: 'Arched Wooden Footbridge',
    z: 6.5,
    halfLength: 8.1,
    halfWidth: 1.3,
  },
};

// -----------------------------------------------------------------------------
// Coordinate Frame Helper (Matches Three.js Object3D.rotation.y = yaw)
// -----------------------------------------------------------------------------

function createLocalFrame(cx, cz, yaw) {
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);

  return {
    cx,
    cz,
    yaw,
    cosY,
    sinY,

    toWorldXZ(lx, lz) {
      return {
        x: cx + lx * cosY + lz * sinY,
        z: cz - lx * sinY + lz * cosY,
      };
    },

    toWorldVec3(lx, y, lz) {
      return new THREE.Vector3(
        cx + lx * cosY + lz * sinY,
        y,
        cz - lx * sinY + lz * cosY
      );
    },

    addLocalDeck(surfaceSolver, { id, lx = 0, lz = 0, halfW, halfD, heightFn, normalFn = null, surfaceType = 'wood' }) {
      const w = this.toWorldXZ(lx, lz);
      return surfaceSolver.addDeck({
        id,
        cx: w.x,
        cz: w.z,
        halfW,
        halfD,
        yaw,
        heightFn,
        normalFn,
        surfaceType,
      });
    },

    addLocalWallOBB(surfaceSolver, { id, lx = 0, lz = 0, halfW, halfD, minY = -10, maxY = 20 }) {
      const w = this.toWorldXZ(lx, lz);
      return surfaceSolver.addWallOBB({
        id,
        cx: w.x,
        cz: w.z,
        halfW,
        halfD,
        yaw,
        minY,
        maxY,
      });
    },

    addLocalShelter(
      surfaceSolver,
      { id, type, minLx, maxLx, minY, maxY, minLz, maxLz, blocksRain = true, windDamping = 0.85, acousticZone = 'wood' }
    ) {
      const c0 = this.toWorldXZ(minLx, minLz);
      const c1 = this.toWorldXZ(maxLx, minLz);
      const c2 = this.toWorldXZ(minLx, maxLz);
      const c3 = this.toWorldXZ(maxLx, maxLz);
      const min = new THREE.Vector3(
        Math.min(c0.x, c1.x, c2.x, c3.x),
        minY,
        Math.min(c0.z, c1.z, c2.z, c3.z)
      );
      const max = new THREE.Vector3(
        Math.max(c0.x, c1.x, c2.x, c3.x),
        maxY,
        Math.max(c0.z, c1.z, c2.z, c3.z)
      );
      return surfaceSolver.addShelterVolume({
        id,
        type,
        min,
        max,
        testFn: (pos) => {
          const dx = pos.x - cx;
          const dz = pos.z - cz;
          const lx = dx * cosY - dz * sinY;
          const lz = dx * sinY + dz * cosY;
          return (
            lx >= minLx &&
            lx <= maxLx &&
            lz >= minLz &&
            lz <= maxLz &&
            pos.y >= minY &&
            pos.y <= maxY
          );
        },
        blocksRain,
        windDamping,
        acousticZone,
      });
    },
  };
}

function makeWaypoint(posVec3, yaw, label) {
  return {
    position: posVec3,
    x: posVec3.x,
    y: posVec3.y,
    z: posVec3.z,
    yaw,
    label,
  };
}

// -----------------------------------------------------------------------------
// Procedural PBR Texture Suite (Canvas + Sobel Normal + Roughness, Headless Safe)
// -----------------------------------------------------------------------------

function configureTexture(tex, repeatX, repeatY, isColor) {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createProceduralTextureSet(kind, seed, repeatX = 1, repeatY = 1, textureList = []) {
  const size = 256;
  const rng = createRng(seed);
  const nA = createNoise2D(rng);
  const nB = createNoise2D(createRng(seed + 79));

  const tileN = (u, v, freq, fn) => {
    const a = fn(u * freq, v * freq);
    const b = fn((u - 1) * freq, v * freq);
    const c = fn(u * freq, (v - 1) * freq);
    const d = fn((u - 1) * freq, (v - 1) * freq);
    const wx = smoothstep(0, 1, u);
    const wy = smoothstep(0, 1, v);
    return lerp(lerp(a, b, wx), lerp(c, d, wx), wy);
  };

  const albedoData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);
  const heightBuf = new Float32Array(size * size);

  // Pre-seed stones for hearthStone
  const stones = [];
  if (kind === 'hearthStone') {
    const rows = 7;
    for (let r = 0; r < rows; r++) {
      const cols = 4 + (r % 2);
      for (let c = 0; c < cols; c++) {
        stones.push({
          cx: ((c + (r % 2) * 0.48 + (rng() - 0.5) * 0.14) / cols) * size,
          cy: ((r + 0.5 + (rng() - 0.5) * 0.12) / rows) * size,
          rx: (size / cols) * (0.43 + rng() * 0.06),
          ry: (size / rows) * (0.42 + rng() * 0.06),
          tone: 0.72 + rng() * 0.42,
          warm: (rng() - 0.45) * 24,
        });
      }
    }
  }

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      const pIdx = idx * 4;

      const fbm =
        tileN(u, v, 4.0, nA) * 0.55 +
        tileN(u, v, 10.0, nB) * 0.3 +
        tileN(u, v, 22.0, nA) * 0.15;
      const n = fbm * 0.5 + 0.5;
      const fine = tileN(u, v, 34.0, nB) * 0.5 + 0.5;

      let r = 128;
      let g = 110;
      let b = 90;
      let rough = 0.82;
      let h = n;

      if (kind === 'log') {
        // Horizontal peeled cedar log grain with dark checks and warm knots
        const grain = Math.sin((v * 26 + tileN(u, v, 6.0, nA) * 2.2) * Math.PI) * 0.5 + 0.5;
        const streak = tileN(u * 0.35, v * 3.8, 8.0, nB) * 0.5 + 0.5;
        const val = clamp(grain * 0.45 + streak * 0.4 + fine * 0.15, 0, 1);
        r = lerp(84, 152, val);
        g = lerp(52, 98, val);
        b = lerp(31, 60, val);
        rough = lerp(0.88, 0.7, val);
        h = val * 0.75 + grain * 0.25;
      } else if (kind === 'plank') {
        // Horizontal timber deck / cabin floor planks with dark groove joints
        const plankRows = 6;
        const py = v * plankRows;
        const rowIdx = Math.floor(py);
        const rowFrac = py - rowIdx;
        const buttShift = (rowIdx * 0.37) % 1.0;
        const buttFrac = (u + buttShift) % 1.0;

        const grooveH = Math.min(rowFrac, 1.0 - rowFrac);
        const grooveMask = smoothstep(0.0, 0.045, grooveH) * smoothstep(0.0, 0.014, Math.min(buttFrac, 1.0 - buttFrac));
        const rowTint = 0.84 + ((rowIdx * 53) % 10) * 0.032;

        const grain = Math.sin((py * 7.5 + tileN(u, v, 5.0, nA) * 1.9) * Math.PI) * 0.5 + 0.5;
        const wood = clamp(grain * 0.5 + n * 0.35 + fine * 0.15, 0, 1);

        r = lerp(96, 166, wood) * rowTint * lerp(0.28, 1.0, grooveMask);
        g = lerp(66, 118, wood) * rowTint * lerp(0.28, 1.0, grooveMask);
        b = lerp(42, 76, wood) * rowTint * lerp(0.28, 1.0, grooveMask);
        rough = lerp(0.95, lerp(0.86, 0.66, wood), grooveMask);
        h = (0.15 + wood * 0.85) * grooveMask;
      } else if (kind === 'shingle') {
        // Staggered overlapping split cedar roof shingles with subtle moss hints
        const courses = 8;
        const cy = v * courses;
        const cRow = Math.floor(cy);
        const cFrac = cy - cRow;
        const stagger = (cRow % 2) * 0.5;
        const cols = 7;
        const cx = (u * cols + stagger) % cols;
        const cCol = Math.floor(cx);
        const xFrac = cx - cCol;

        const lapShadow = smoothstep(0.0, 0.14, cFrac);
        const seamX = smoothstep(0.0, 0.055, Math.min(xFrac, 1.0 - xFrac));
        const shakeSeed = ((cRow * 17 + cCol * 31) % 13) / 13;
        const grain = tileN(u * 2.5, v * 0.6, 12.0, nB) * 0.5 + 0.5;

        const baseShade = (0.72 + shakeSeed * 0.36) * lerp(0.45, 1.0, lapShadow) * lerp(0.4, 1.0, seamX);
        r = lerp(74, 118, grain) * baseShade;
        g = lerp(56, 88, grain) * baseShade;
        b = lerp(44, 68, grain) * baseShade;

        // Subtle weathered cedar moss flecks near overlap line
        if (cFrac < 0.25 && n > 0.6) {
          const mossAmt = (1.0 - cFrac / 0.25) * smoothstep(0.6, 0.82, n) * 0.55;
          r = lerp(r, 56, mossAmt);
          g = lerp(g, 88, mossAmt);
          b = lerp(b, 42, mossAmt);
        }

        rough = lerp(0.95, 0.78, grain * lapShadow);
        h = (cFrac * 0.55 + grain * 0.35 + 0.1) * seamX;
      } else if (kind === 'rug') {
        // Cozy frontier woven area rug: rust red, forest pine, warm cream, golden ochre
        const weaveX = Math.sin(u * Math.PI * 96) * 0.5 + 0.5;
        const weaveY = Math.sin(v * Math.PI * 64) * 0.5 + 0.5;
        const weave = (weaveX * 0.5 + weaveY * 0.5) * 0.14 + 0.88;

        const bx = Math.abs(u - 0.5) * 2.0; // 0 center -> 1 edge
        const by = Math.abs(v - 0.5) * 2.0;
        const border = Math.max(bx, by);

        // Center diamond lattice
        const dm = Math.abs(((u * 4.0) % 1.0) - 0.5) + Math.abs(((v * 3.0) % 1.0) - 0.5);

        if (border > 0.88) {
          // Outer deep pine trim
          r = 44; g = 68; b = 52;
        } else if (border > 0.80) {
          // Cream accent stripe
          r = 212; g = 196; b = 164;
        } else if (border > 0.70) {
          // Warm ochre stripe with dark chevrons
          const chev = ((Math.floor((u + v) * 24) % 2) === 0) ? 1 : 0;
          r = chev ? 188 : 142;
          g = chev ? 138 : 66;
          b = chev ? 64 : 44;
        } else {
          // Terracotta rust field with cream/pine geometric diamonds
          if (dm < 0.22) {
            r = 216; g = 198; b = 166;
          } else if (dm < 0.31) {
            r = 46; g = 74; b = 56;
          } else if (dm < 0.37) {
            r = 196; g = 148; b = 68;
          } else {
            r = 152; g = 58; b = 44;
          }
        }
        r *= weave * (0.94 + fine * 0.12);
        g *= weave * (0.94 + fine * 0.12);
        b *= weave * (0.94 + fine * 0.12);
        rough = 0.94;
        h = weave * 0.6 + fine * 0.4;
      } else if (kind === 'hearthStone') {
        // Warm mortar base (stones stamped right below)
        r = lerp(96, 122, n);
        g = lerp(92, 116, n);
        b = lerp(84, 106, n);
        rough = 0.93;
        h = 0.18 + fine * 0.12;
      } else if (kind === 'redwoodBark') {
        // Deep vertical fibrous reddish-cinnamon ancient sequoia furrows
        const furrow = Math.sin((u * 16.0 + tileN(u, v, 5.0, nA) * 1.4) * Math.PI);
        const ridge = smoothstep(-0.75, 0.72, furrow);
        const fiber = tileN(u * 2.2, v * 0.45, 16.0, nB) * 0.5 + 0.5;
        const val = clamp(ridge * 0.72 + fiber * 0.28, 0, 1);
        r = lerp(48, 138, val);
        g = lerp(24, 66, val);
        b = lerp(16, 40, val);
        rough = lerp(0.96, 0.76, val);
        h = ridge * 0.78 + fiber * 0.22;
      } else if (kind === 'heartwood') {
        // Warm cinnamon-amber aged hollowed inner redwood heartwood
        const grain = Math.sin((u * 22.0 + tileN(u, v, 4.0, nA) * 1.8) * Math.PI) * 0.5 + 0.5;
        const check = smoothstep(0.15, 0.85, n);
        const val = clamp(grain * 0.52 + check * 0.34 + fine * 0.14, 0, 1);
        r = lerp(74, 152, val);
        g = lerp(42, 86, val);
        b = lerp(26, 52, val);
        rough = lerp(0.9, 0.72, val);
        h = val;
      } else if (kind === 'cavernRock') {
        // Damp stratified mossy granite with glistening mineral veins
        const strata = Math.sin((v * 9.0 + n * 2.2) * Math.PI) * 0.5 + 0.5;
        const crack = 1.0 - Math.abs(tileN(u, v, 8.0, nB));
        const rock = clamp(n * 0.42 + strata * 0.34 + crack * crack * 0.28, 0, 1);
        r = lerp(38, 92, rock);
        g = lerp(43, 96, rock);
        b = lerp(48, 102, rock);
        // Damp emerald moss veins
        const mossPatch = smoothstep(0.56, 0.8, tileN(u, v, 4.5, nA) * 0.5 + 0.5 + (1.0 - strata) * 0.18);
        r = lerp(r, 42, mossPatch * 0.65);
        g = lerp(g, 82, mossPatch * 0.65);
        b = lerp(b, 40, mossPatch * 0.65);
        // Wet mineral sheen on rock faces, rougher on moss
        rough = lerp(lerp(0.68, 0.36, rock), 0.88, mossPatch);
        h = rock * 0.85 + fine * 0.15;
      }

      albedoData[pIdx] = clamp(Math.round(r), 0, 255);
      albedoData[pIdx + 1] = clamp(Math.round(g), 0, 255);
      albedoData[pIdx + 2] = clamp(Math.round(b), 0, 255);
      albedoData[pIdx + 3] = 255;

      const rv = clamp(Math.round(rough * 255), 0, 255);
      roughData[pIdx] = rv;
      roughData[pIdx + 1] = rv;
      roughData[pIdx + 2] = rv;
      roughData[pIdx + 3] = 255;

      heightBuf[idx] = h;
    }
  }

  // Stamp cobbled river stones onto hearthStone height + albedo buffers
  if (kind === 'hearthStone') {
    for (let i = 0; i < stones.length; i++) {
      const st = stones[i];
      const radX = Math.ceil(st.rx) + 2;
      const radY = Math.ceil(st.ry) + 2;
      for (let dy = -radY; dy <= radY; dy++) {
        for (let dx = -radX; dx <= radX; dx++) {
          const nx = dx / st.rx;
          const ny = dy / st.ry;
          const d2 = nx * nx + ny * ny;
          if (d2 >= 1.0) continue;
          const dome = Math.pow(1.0 - d2, 0.45);
          const px = ((Math.round(st.cx + dx) % size) + size) % size;
          const py = ((Math.round(st.cy + dy) % size) + size) % size;
          const idx = py * size + px;
          const hNew = 0.25 + dome * 0.75;
          if (hNew > heightBuf[idx]) {
            heightBuf[idx] = hNew;
            const pIdx = idx * 4;
            const shade = (0.64 + dome * 0.36) * st.tone;
            albedoData[pIdx] = clamp(Math.round((108 + st.warm) * shade), 0, 255);
            albedoData[pIdx + 1] = clamp(Math.round((104 + st.warm * 0.5) * shade), 0, 255);
            albedoData[pIdx + 2] = clamp(Math.round((98 - st.warm * 0.4) * shade), 0, 255);
            const rByte = clamp(Math.round(lerp(0.88, 0.68, dome) * 255), 0, 255);
            roughData[pIdx] = rByte;
            roughData[pIdx + 1] = rByte;
            roughData[pIdx + 2] = rByte;
          }
        }
      }
    }
  }

  // Sobel height-to-tangent-normal map
  const normalData = new Uint8Array(size * size * 4);
  const strengthMap = {
    log: 1.5,
    plank: 1.75,
    shingle: 2.1,
    rug: 0.75,
    hearthStone: 2.35,
    redwoodBark: 2.7,
    heartwood: 1.45,
    cavernRock: 2.3,
  };
  const strength = strengthMap[kind] ?? 1.5;
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
      const invLen = 1.0 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;

      const pIdx = (y * size + x) * 4;
      normalData[pIdx] = Math.round((nx * 0.5 + 0.5) * 255);
      normalData[pIdx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalData[pIdx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normalData[pIdx + 3] = 255;
    }
  }

  // Create CanvasTexture in browser (with optional crisp vector nail accents) or DataTexture in headless Node
  let map;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(size, size);
    imgData.data.set(albedoData);
    ctx.putImageData(imgData, 0, 0);

    // Subtle crisp dark nail heads on plank texture in browser canvas
    if (kind === 'plank') {
      ctx.fillStyle = 'rgba(26, 20, 16, 0.72)';
      const rows = 6;
      const rowH = size / rows;
      for (let r = 0; r < rows; r++) {
        const yMid = (r + 0.5) * rowH;
        const buttX = ((1.0 - ((r * 0.37) % 1.0)) % 1.0) * size;
        for (const off of [-6, 6]) {
          const nx = ((buttX + off) % size + size) % size;
          ctx.beginPath();
          ctx.arc(nx, yMid - rowH * 0.24, 1.8, 0, Math.PI * 2);
          ctx.arc(nx, yMid + rowH * 0.24, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    map = new THREE.CanvasTexture(canvas);
  } else {
    map = new THREE.DataTexture(albedoData, size, size, THREE.RGBAFormat);
  }

  const normalMap = new THREE.DataTexture(normalData, size, size, THREE.RGBAFormat);
  const roughnessMap = new THREE.DataTexture(roughData, size, size, THREE.RGBAFormat);

  configureTexture(map, repeatX, repeatY, true);
  configureTexture(normalMap, repeatX, repeatY, false);
  configureTexture(roughnessMap, repeatX, repeatY, false);

  textureList.push(map, normalMap, roughnessMap);
  return { map, normalMap, roughnessMap };
}

// -----------------------------------------------------------------------------
// Soft Radial Glow Texture (for Lantern Halo & Window Light Spill)
// -----------------------------------------------------------------------------

function createSoftGlowTexture(textureList) {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ny = (y / (size - 1)) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      const r = Math.hypot(nx, ny);
      const falloff = Math.pow(clamp(1.0 - r, 0, 1), 2.2);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = Math.round(lerp(150, 245, falloff));
      data[idx + 2] = Math.round(lerp(45, 175, falloff * falloff));
      data[idx + 3] = Math.round(falloff * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  textureList.push(tex);
  return tex;
}

// -----------------------------------------------------------------------------
// WalkableStructures Main Class
// -----------------------------------------------------------------------------

export class WalkableStructures {
  constructor(scene, terrain, surfaceSolver) {
    this.scene = scene;
    this.terrain = terrain;
    this.surfaceSolver = surfaceSolver;

    this.group = new THREE.Group();
    this.group.name = 'WalkableStructures';

    this.bridgePilings = [];
    this.exclusionZones = [];
    this.waypoints = {};

    // Track GPU resources for clean disposal
    this._geometries = [];
    this._materials = [];
    this._textures = [];

    // Animated element handles updated per frame
    this._anim = {
      lanternLight: null,
      lanternFlame: null,
      lanternHalos: [],
      hearthEmberMat: null,
      windowGlowMats: [],
      redwoodSunbeams: [],
      redwoodGlowLight: null,
      redwoodMushroomMats: [],
      cavernCrystalMats: [],
      cavernMushroomMats: [],
      cavernLights: [],
    };

    // Build shared PBR materials
    this._mats = this._createSharedMaterials();

    // Build all 4 hyper-detailed, enterable 3D structures
    this._buildRangerCabin();
    this._buildHollowRedwood();
    this._buildMossyCavern();
    this._buildArchedFootbridge();

    if (this.scene) {
      this.scene.add(this.group);
    }
  }

  _trackGeo(geo) {
    this._geometries.push(geo);
    return geo;
  }

  _trackMat(mat) {
    this._materials.push(mat);
    return mat;
  }

  _addMesh(parent, geo, mat, { pos = null, rot = null, scale = null, castShadow = true, receiveShadow = true, name = '' } = {}) {
    const mesh = new THREE.Mesh(geo, mat);
    if (pos) mesh.position.set(pos[0], pos[1], pos[2]);
    if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
    if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    if (name) mesh.name = name;
    parent.add(mesh);
    return mesh;
  }

  _createSharedMaterials() {
    const logTex = createProceduralTextureSet('log', 3101, 2, 1, this._textures);
    const plankTex = createProceduralTextureSet('plank', 3202, 2, 2, this._textures);
    const bridgePlankTex = createProceduralTextureSet('plank', 3219, 1, 1, this._textures);
    const shingleTex = createProceduralTextureSet('shingle', 3303, 3, 2, this._textures);
    const rugTex = createProceduralTextureSet('rug', 3404, 1, 1, this._textures);
    const hearthTex = createProceduralTextureSet('hearthStone', 3505, 1.5, 2.0, this._textures);
    const redwoodBarkTex = createProceduralTextureSet('redwoodBark', 3606, 4, 6, this._textures);
    const heartwoodTex = createProceduralTextureSet('heartwood', 3707, 3, 2, this._textures);
    const cavernRockTex = createProceduralTextureSet('cavernRock', 3808, 3, 2, this._textures);
    const glowTex = createSoftGlowTexture(this._textures);

    const makeStd = (opts) => this._trackMat(new THREE.MeshStandardMaterial(opts));

    return {
      glowTex,
      log: makeStd({
        map: logTex.map,
        normalMap: logTex.normalMap,
        normalScale: new THREE.Vector2(1.1, 1.1),
        roughnessMap: logTex.roughnessMap,
        roughness: 0.92,
        metalness: 0.02,
      }),
      darkTimber: makeStd({
        map: logTex.map,
        normalMap: logTex.normalMap,
        normalScale: new THREE.Vector2(0.95, 0.95),
        roughnessMap: logTex.roughnessMap,
        color: new THREE.Color(0x8c6d52),
        roughness: 0.92,
        metalness: 0.02,
      }),
      plank: makeStd({
        map: plankTex.map,
        normalMap: plankTex.normalMap,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughnessMap: plankTex.roughnessMap,
        roughness: 0.88,
        metalness: 0.02,
      }),
      bridgePlank: makeStd({
        map: bridgePlankTex.map,
        normalMap: bridgePlankTex.normalMap,
        normalScale: new THREE.Vector2(1.0, 1.0),
        roughnessMap: bridgePlankTex.roughnessMap,
        color: new THREE.Color(0xb8a084),
        roughness: 0.9,
        metalness: 0.02,
      }),
      shingle: makeStd({
        map: shingleTex.map,
        normalMap: shingleTex.normalMap,
        normalScale: new THREE.Vector2(1.25, 1.25),
        roughnessMap: shingleTex.roughnessMap,
        roughness: 0.92,
        metalness: 0.02,
      }),
      rug: makeStd({
        map: rugTex.map,
        normalMap: rugTex.normalMap,
        normalScale: new THREE.Vector2(0.55, 0.55),
        roughnessMap: rugTex.roughnessMap,
        roughness: 0.96,
        metalness: 0.0,
      }),
      hearthStone: makeStd({
        map: hearthTex.map,
        normalMap: hearthTex.normalMap,
        normalScale: new THREE.Vector2(1.3, 1.3),
        roughnessMap: hearthTex.roughnessMap,
        roughness: 0.9,
        metalness: 0.04,
      }),
      redwoodBark: makeStd({
        map: redwoodBarkTex.map,
        normalMap: redwoodBarkTex.normalMap,
        normalScale: new THREE.Vector2(1.45, 1.45),
        roughnessMap: redwoodBarkTex.roughnessMap,
        roughness: 0.95,
        metalness: 0.0,
      }),
      heartwood: makeStd({
        map: heartwoodTex.map,
        normalMap: heartwoodTex.normalMap,
        normalScale: new THREE.Vector2(1.0, 1.0),
        roughnessMap: heartwoodTex.roughnessMap,
        roughness: 0.88,
        metalness: 0.02,
        side: THREE.DoubleSide,
      }),
      cavernRock: makeStd({
        map: cavernRockTex.map,
        normalMap: cavernRockTex.normalMap,
        normalScale: new THREE.Vector2(1.35, 1.35),
        roughnessMap: cavernRockTex.roughnessMap,
        roughness: 0.85,
        metalness: 0.06,
      }),
      cavernRockInner: makeStd({
        map: cavernRockTex.map,
        normalMap: cavernRockTex.normalMap,
        normalScale: new THREE.Vector2(1.45, 1.45),
        roughnessMap: cavernRockTex.roughnessMap,
        color: new THREE.Color(0xa6b2b8),
        roughness: 0.72,
        metalness: 0.08,
        side: THREE.DoubleSide,
      }),
      mossFloor: makeStd({
        color: new THREE.Color(0x3a6434),
        roughness: 0.94,
        metalness: 0.0,
      }),
      redwoodFoliage: makeStd({
        color: new THREE.Color(0x1f4729),
        roughness: 0.88,
        metalness: 0.0,
        side: THREE.DoubleSide,
      }),
      vineMoss: makeStd({
        color: new THREE.Color(0x3b6c34),
        roughness: 0.9,
        metalness: 0.0,
        side: THREE.DoubleSide,
      }),
      glass: makeStd({
        color: new THREE.Color(0xbcd8e6),
        emissive: new THREE.Color(0x2e2112),
        emissiveIntensity: 0.15,
        transparent: true,
        opacity: 0.28,
        roughness: 0.12,
        metalness: 0.14,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      brass: makeStd({
        color: new THREE.Color(0xc99c46),
        roughness: 0.32,
        metalness: 0.82,
      }),
      iron: makeStd({
        color: new THREE.Color(0x2c2e32),
        roughness: 0.62,
        metalness: 0.76,
      }),
      hempRope: makeStd({
        color: new THREE.Color(0xa98d62),
        roughness: 0.95,
        metalness: 0.0,
      }),
      canvasCloth: makeStd({
        color: new THREE.Color(0xdcd4c0),
        roughness: 0.92,
        metalness: 0.0,
      }),
      blanketWool: makeStd({
        color: new THREE.Color(0x8d342c),
        roughness: 0.95,
        metalness: 0.0,
      }),
      mushroomStem: makeStd({
        color: new THREE.Color(0xd2d6c8),
        emissive: new THREE.Color(0x183430),
        emissiveIntensity: 0.25,
        roughness: 0.78,
        metalness: 0.0,
      }),
    };
  }

  // ===========================================================================
  // 1. WALK-IN RUSTIC TIMBER RANGER CABIN (17.2, -1.8)
  // ===========================================================================

  _buildRangerCabin() {
    const site = STRUCTURE_SITES.cabin;
    const { x: cx, z: cz, yaw, groundY, floorY } = site;
    const frame = createLocalFrame(cx, cz, yaw);

    const root = new THREE.Group();
    root.name = 'RangerCabin';
    root.position.set(cx, 0, cz);
    root.rotation.y = yaw;
    this.group.add(root);

    const M = this._mats;

    // Dimensions in local coordinates:
    // Cabin room: lx in [-3.2, +3.2] (6.4m wide), lz in [-3.6, +1.6] (5.2m deep)
    // Front porch deck: lx in [-3.2, +3.2] (6.4m wide), lz in [+1.6, +3.6] (2.0m deep)
    // Doorway centered at lx = 0, lz = +1.6: 1.50m wide ([-0.75, +0.75]) x 2.38m tall (floorY..floorY+2.38)
    const halfW = 3.2;
    const backZ = -3.6;
    const frontWallZ = 1.6;
    const porchEdgeZ = 3.6;
    const eavesH = 2.95;
    const eavesY = floorY + eavesH; // 6.15
    const ridgeY = floorY + 4.65;   // 7.85

    // --- A. Stone Foundation Piers & Dark Timber Sill Skirt (flush into groundY = 2.45) ---
    const foundH = floorY - (groundY - 0.35); // 1.10m deep skirt so zero corner floats
    const foundGeo = this._trackGeo(new THREE.BoxGeometry(6.32, foundH, 5.14));
    this._addMesh(root, foundGeo, M.hearthStone, {
      pos: [0, groundY - 0.35 + foundH * 0.5, -1.0],
      name: 'CabinFoundation',
    });

    // Porch timber piers & cross-beam
    const pierGeo = this._trackGeo(new THREE.BoxGeometry(0.32, foundH, 0.32));
    for (const px of [-3.02, -1.1, 1.1, 3.02]) {
      this._addMesh(root, pierGeo, M.hearthStone, {
        pos: [px, groundY - 0.35 + foundH * 0.5, porchEdgeZ - 0.16],
      });
    }
    const porchRimGeo = this._trackGeo(new THREE.BoxGeometry(6.46, 0.24, 2.04));
    this._addMesh(root, porchRimGeo, M.darkTimber, {
      pos: [0, floorY - 0.14, 2.6],
    });

    // --- B. Plank Wood Floor (Cabin Interior + Front Deck) ---
    const floorGeo = this._trackGeo(new THREE.BoxGeometry(6.42, 0.1, 7.22));
    this._addMesh(root, floorGeo, M.plank, {
      pos: [0, floorY - 0.05, 0.0],
      name: 'CabinFloorDeck',
    });

    // --- C. 3 Walkable Wooden Porch Steps (2.45 -> 2.70 -> 2.95 -> 3.20) ---
    const stepDefs = [
      { id: 'cabin_step_1', y: 2.7, zMin: 4.26, zMax: 4.68 },
      { id: 'cabin_step_2', y: 2.95, zMin: 3.9, zMax: 4.3 },
      { id: 'cabin_step_3', y: 3.2, zMin: 3.55, zMax: 3.94 },
    ];
    const stepWidth = 2.12;
    const treadGeo = this._trackGeo(new THREE.BoxGeometry(stepWidth, 0.07, 0.42));

    for (let i = 0; i < stepDefs.length; i++) {
      const s = stepDefs[i];
      const zCenter = (s.zMin + s.zMax) * 0.5;
      const riserH = s.y - (groundY - 0.28);
      const riserGeo = this._trackGeo(new THREE.BoxGeometry(stepWidth - 0.12, riserH, 0.34));
      this._addMesh(root, riserGeo, M.darkTimber, {
        pos: [0, groundY - 0.28 + riserH * 0.5, zCenter - 0.02],
      });
      this._addMesh(root, treadGeo, M.plank, {
        pos: [0, s.y - 0.035, zCenter],
        name: s.id,
      });

      // Register each step individually in SurfaceSolver
      frame.addLocalDeck(this.surfaceSolver, {
        id: s.id,
        lx: 0,
        lz: zCenter,
        halfW: stepWidth * 0.52,
        halfD: (s.zMax - s.zMin) * 0.5,
        heightFn: () => s.y,
        surfaceType: 'wood',
      });
    }

    // Slanted stair side stringers
    const stringerLen = Math.hypot(1.18, 0.78);
    const stringerGeo = this._trackGeo(new THREE.BoxGeometry(0.12, 0.24, stringerLen));
    const stringerTilt = Math.atan2(0.75, 1.12);
    for (const sx of [-stepWidth * 0.5 + 0.04, stepWidth * 0.5 - 0.04]) {
      this._addMesh(root, stringerGeo, M.darkTimber, {
        pos: [sx, groundY + 0.34, 4.14],
        rot: [stringerTilt, 0, 0],
      });
    }

    // --- D. Notched Interlocking Log Walls with Doorway & 4 Multi-Pane Windows ---
    const logR = 0.135;
    const courseStep = 0.268;
    const courseCount = 11; // 11 * 0.268 = 2.948m eaves
    const cornerOverhang = 0.36;

    const addHorizontalLog = (axis, fixedCoord, start, end, y) => {
      const len = end - start;
      if (len <= 0.08) return;
      const geo = this._trackGeo(new THREE.CylinderGeometry(logR, logR * 1.03, len, 10));
      const mid = (start + end) * 0.5;
      if (axis === 'x') {
        this._addMesh(root, geo, M.log, {
          pos: [mid, y, fixedCoord],
          rot: [0, 0, Math.PI * 0.5],
        });
      } else {
        this._addMesh(root, geo, M.log, {
          pos: [fixedCoord, y, mid],
          rot: [Math.PI * 0.5, 0, 0],
        });
      }
    };

    // Helper: subtract cutout intervals [a, b] from full span [fullA, fullB]
    const splitSpan = (fullA, fullB, gaps) => {
      let segs = [[fullA, fullB]];
      for (const [gA, gB] of gaps) {
        const next = [];
        for (const [sA, sB] of segs) {
          if (gB <= sA || gA >= sB) {
            next.push([sA, sB]);
          } else {
            if (gA > sA + 0.04) next.push([sA, gA]);
            if (gB < sB - 0.04) next.push([gB, sB]);
          }
        }
        segs = next;
      }
      return segs;
    };

    const winMinY = floorY + 0.96; // 4.16
    const winMaxY = floorY + 2.02; // 5.22
    const doorMaxY = floorY + 2.38; // 5.58

    for (let c = 0; c < courseCount; c++) {
      const yFB = floorY + logR + c * courseStep;
      const yLR = yFB + courseStep * 0.5; // Half-log staggered saddle-notch interlock!

      // Back wall (lz = -3.6, full width + corner overhangs)
      addHorizontalLog('x', backZ, -halfW - cornerOverhang, halfW + cornerOverhang, yFB);

      // Front wall (lz = +1.6): cutout doorway [-0.78, +0.78] + 2 front windows [-2.52,-1.48] & [+1.48,+2.52]
      const frontGaps = [];
      if (yFB - logR < doorMaxY) frontGaps.push([-0.78, 0.78]);
      if (yFB + logR > winMinY && yFB - logR < winMaxY) {
        frontGaps.push([-2.52, -1.48], [1.48, 2.52]);
      }
      for (const [a, b] of splitSpan(-halfW - cornerOverhang, halfW + cornerOverhang, frontGaps)) {
        addHorizontalLog('x', frontWallZ, a, b, yFB);
      }

      // Left & right side walls (lx = ±3.2): cutout side window lz in [-1.58, -0.26]
      if (yLR <= eavesY + 0.05) {
        const sideGaps = [];
        if (yLR + logR > winMinY && yLR - logR < winMaxY) {
          sideGaps.push([-1.58, -0.26]);
        }
        for (const [a, b] of splitSpan(backZ - cornerOverhang, frontWallZ + cornerOverhang, sideGaps)) {
          addHorizontalLog('z', -halfW, a, b, yLR);
          addHorizontalLog('z', halfW, a, b, yLR);
        }
      }
    }

    // --- E. Door Frame, Open Timber Door & Multi-Pane Translucent Windows ---
    const jambGeo = this._trackGeo(new THREE.BoxGeometry(0.14, 2.42, 0.32));
    this._addMesh(root, jambGeo, M.darkTimber, { pos: [-0.81, floorY + 1.21, frontWallZ] });
    this._addMesh(root, jambGeo, M.darkTimber, { pos: [0.81, floorY + 1.21, frontWallZ] });
    const lintelGeo = this._trackGeo(new THREE.BoxGeometry(1.78, 0.18, 0.34));
    this._addMesh(root, lintelGeo, M.darkTimber, { pos: [0, doorMaxY + 0.09, frontWallZ] });

    // Swung-open wooden door hinged on left jamb (-0.75, +1.50), angled wide open inward (~116 deg)
    const doorPivot = new THREE.Group();
    doorPivot.position.set(-0.74, floorY + 0.02, frontWallZ - 0.1);
    doorPivot.rotation.y = 2.02; // swings smoothly back against interior front-left wall
    root.add(doorPivot);
    const doorLeafGeo = this._trackGeo(new THREE.BoxGeometry(1.32, 2.3, 0.07));
    this._addMesh(doorPivot, doorLeafGeo, M.plank, { pos: [0.66, 1.15, 0], name: 'CabinOpenDoor' });
    const braceGeo = this._trackGeo(new THREE.BoxGeometry(1.22, 0.14, 0.09));
    this._addMesh(doorPivot, braceGeo, M.darkTimber, { pos: [0.66, 0.42, 0] });
    this._addMesh(doorPivot, braceGeo, M.darkTimber, { pos: [0.66, 1.88, 0] });
    const hingeGeo = this._trackGeo(new THREE.BoxGeometry(0.36, 0.06, 0.09));
    this._addMesh(doorPivot, hingeGeo, M.iron, { pos: [0.22, 0.42, 0] });
    this._addMesh(doorPivot, hingeGeo, M.iron, { pos: [0.22, 1.88, 0] });
    const handleGeo = this._trackGeo(new THREE.TorusGeometry(0.055, 0.014, 6, 12));
    this._addMesh(doorPivot, handleGeo, M.brass, { pos: [1.14, 1.06, 0.05] });

    // Multi-pane windows builder (casing + sill + mullions + translucent glass + dusk/night exterior glow)
    const buildWindow = (wPos, rotY, width, height, cols, rows, glowOutOffset) => {
      const wg = new THREE.Group();
      wg.position.set(wPos[0], wPos[1], wPos[2]);
      wg.rotation.y = rotY;
      root.add(wg);

      const frameT = 0.08;
      const frameD = 0.3;
      // Top & bottom casing + deep sill
      this._addMesh(wg, this._trackGeo(new THREE.BoxGeometry(width + 0.14, frameT, frameD)), M.darkTimber, {
        pos: [0, height * 0.5 + frameT * 0.5, 0],
      });
      this._addMesh(wg, this._trackGeo(new THREE.BoxGeometry(width + 0.2, frameT * 1.1, frameD + 0.08)), M.darkTimber, {
        pos: [0, -height * 0.5 - frameT * 0.5, 0.02],
      });
      // Left & right casing
      const sideFGeo = this._trackGeo(new THREE.BoxGeometry(frameT, height + 0.16, frameD));
      this._addMesh(wg, sideFGeo, M.darkTimber, { pos: [-width * 0.5 - frameT * 0.5, 0, 0] });
      this._addMesh(wg, sideFGeo, M.darkTimber, { pos: [width * 0.5 + frameT * 0.5, 0, 0] });

      // Interior wooden mullions
      const vMulGeo = this._trackGeo(new THREE.BoxGeometry(0.04, height, 0.06));
      for (let c = 1; c < cols; c++) {
        const mx = -width * 0.5 + (width * c) / cols;
        this._addMesh(wg, vMulGeo, M.darkTimber, { pos: [mx, 0, 0], castShadow: false });
      }
      const hMulGeo = this._trackGeo(new THREE.BoxGeometry(width, 0.04, 0.06));
      for (let r = 1; r < rows; r++) {
        const my = -height * 0.5 + (height * r) / rows;
        this._addMesh(wg, hMulGeo, M.darkTimber, { pos: [0, my, 0], castShadow: false });
      }

      // Translucent glass pane
      const glassGeo = this._trackGeo(new THREE.PlaneGeometry(width, height));
      this._addMesh(wg, glassGeo, M.glass, { castShadow: false, receiveShadow: false });

      // Exterior warm golden glow plane (fades up smoothly at dusk & night)
      const glowMat = this._trackMat(
        new THREE.MeshBasicMaterial({
          map: M.glowTex,
          color: new THREE.Color(0xffb454),
          transparent: true,
          opacity: 0.12,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      this._anim.windowGlowMats.push(glowMat);
      const glowGeo = this._trackGeo(new THREE.PlaneGeometry(width * 1.45, height * 1.45));
      this._addMesh(wg, glowGeo, glowMat, {
        pos: [0, 0, glowOutOffset],
        castShadow: false,
        receiveShadow: false,
      });
    };

    const winCenterY = (winMinY + winMaxY) * 0.5;
    const winH = winMaxY - winMinY;
    buildWindow([-2.0, winCenterY, frontWallZ], 0, 1.04, winH, 2, 2, 0.18);
    buildWindow([2.0, winCenterY, frontWallZ], 0, 1.04, winH, 2, 2, 0.18);
    buildWindow([-halfW, winCenterY, -0.92], -Math.PI * 0.5, 1.32, winH, 3, 2, 0.18);
    buildWindow([halfW, winCenterY, -0.92], Math.PI * 0.5, 1.32, winH, 3, 2, 0.18);

    // Subtle warm doorway spill plane facing onto the porch at dusk/night
    const doorSpillMat = this._trackMat(
      new THREE.MeshBasicMaterial({
        map: M.glowTex,
        color: new THREE.Color(0xffaa48),
        transparent: true,
        opacity: 0.1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this._anim.windowGlowMats.push(doorSpillMat);
    this._addMesh(root, this._trackGeo(new THREE.PlaneGeometry(2.2, 2.3)), doorSpillMat, {
      pos: [0, floorY + 0.02, frontWallZ + 1.15],
      rot: [-Math.PI * 0.5, 0, 0],
      castShadow: false,
      receiveShadow: false,
    });

    // --- F. Porch Corner Posts, Knee Braces & Timber Railings ---
    const postH = eavesY - floorY;
    const postGeo = this._trackGeo(new THREE.CylinderGeometry(0.11, 0.125, postH, 10));
    const bracePostGeo = this._trackGeo(new THREE.BoxGeometry(0.09, 0.09, 0.65));
    for (const px of [-3.08, -1.12, 1.12, 3.08]) {
      this._addMesh(root, postGeo, M.darkTimber, { pos: [px, floorY + postH * 0.5, porchEdgeZ - 0.12] });
      // Diagonal knee brace up to front porch roof beam
      const dir = px < 0 ? 1 : -1;
      this._addMesh(root, bracePostGeo, M.darkTimber, {
        pos: [px + dir * 0.24, eavesY - 0.34, porchEdgeZ - 0.12],
        rot: [0, Math.PI * 0.5, dir * Math.PI * 0.25],
      });
    }

    // Porch front header beam & side plate beams
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(6.6, 0.22, 0.22)), M.darkTimber, {
      pos: [0, eavesY - 0.08, porchEdgeZ - 0.12],
    });
    const sidePlateGeo = this._trackGeo(new THREE.BoxGeometry(0.22, 0.22, 2.15));
    this._addMesh(root, sidePlateGeo, M.darkTimber, { pos: [-3.08, eavesY - 0.08, 2.6] });
    this._addMesh(root, sidePlateGeo, M.darkTimber, { pos: [3.08, eavesY - 0.08, 2.6] });

    // Timber railings along left, right, front-left, front-right (clear 2.24m opening at steps)
    const addRailingSection = (x1, z1, x2, z2) => {
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      const midX = (x1 + x2) * 0.5;
      const midZ = (z1 + z2) * 0.5;
      const ang = Math.atan2(dx, dz);

      const railGeo = this._trackGeo(new THREE.BoxGeometry(0.11, 0.09, len));
      this._addMesh(root, railGeo, M.darkTimber, { pos: [midX, floorY + 0.96, midZ], rot: [0, ang, 0] });
      this._addMesh(root, railGeo, M.darkTimber, { pos: [midX, floorY + 0.2, midZ], rot: [0, ang, 0] });

      const balusterCount = Math.max(2, Math.floor(len / 0.28));
      const balGeo = this._trackGeo(new THREE.BoxGeometry(0.055, 0.74, 0.055));
      for (let b = 1; b < balusterCount; b++) {
        const t = b / balusterCount;
        this._addMesh(root, balGeo, M.log, {
          pos: [lerp(x1, x2, t), floorY + 0.58, lerp(z1, z2, t)],
        });
      }
    };
    addRailingSection(-3.08, frontWallZ + 0.1, -3.08, porchEdgeZ - 0.12);
    addRailingSection(3.08, frontWallZ + 0.1, 3.08, porchEdgeZ - 0.12);
    addRailingSection(-3.08, porchEdgeZ - 0.12, -1.12, porchEdgeZ - 0.12);
    addRailingSection(1.12, porchEdgeZ - 0.12, 3.08, porchEdgeZ - 0.12);

    // --- G. Pitched Overhanging Cedar Shingle Roof, Gable Logs & Interior Rafters ---
    const gableCourses = 6;
    const roofRise = ridgeY - eavesY; // 1.70m
    for (let g = 0; g < gableCourses; g++) {
      const gy = eavesY + logR + g * 0.255;
      const t = clamp((gy - eavesY) / roofRise, 0, 1);
      const spanHalf = halfW * (1.0 - t) + 0.08;
      if (spanHalf > 0.22) {
        addHorizontalLog('x', backZ, -spanHalf, spanHalf, gy);
        addHorizontalLog('x', frontWallZ, -spanHalf, spanHalf, gy);
      }
    }

    // Porch front gable truss
    const trussSpan = 3.2;
    const roofSlopeAngle = Math.atan2(roofRise, halfW); // ~0.488 rad (28 deg)
    const roofRun = halfW + 0.78; // 3.98m horizontal run with generous eaves overhang
    const roofSlopeLen = roofRun / Math.cos(roofSlopeAngle);
    const roofLengthZ = 8.45; // covers back overhang (-4.25) through front porch overhang (+4.20)
    const roofCenterZ = -0.02;

    // Exposed ridge beam & interior rafters
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.22, 0.28, roofLengthZ - 0.2)), M.darkTimber, {
      pos: [0, ridgeY - 0.14, roofCenterZ],
    });
    const rafterGeo = this._trackGeo(new THREE.BoxGeometry(roofSlopeLen - 0.1, 0.14, 0.12));
    for (let rz = -3.4; rz <= 3.6; rz += 1.15) {
      for (const side of [-1, 1]) {
        this._addMesh(root, rafterGeo, M.darkTimber, {
          pos: [side * (roofRun * 0.5), ridgeY - (roofRun * 0.5) * Math.tan(roofSlopeAngle) - 0.12, rz],
          rot: [0, 0, -side * roofSlopeAngle],
        });
      }
    }
    // Horizontal collar ties inside the cabin & porch front
    const tieGeo = this._trackGeo(new THREE.BoxGeometry(trussSpan * 2, 0.14, 0.14));
    for (const tz of [-2.2, -0.4, 1.55, 3.48]) {
      this._addMesh(root, tieGeo, M.darkTimber, { pos: [0, eavesY + 0.06, tz] });
    }

    // Left & right cedar shingle roof slabs
    const roofSlabGeo = this._trackGeo(new THREE.BoxGeometry(roofSlopeLen, 0.16, roofLengthZ));
    for (const side of [-1, 1]) {
      const midX = side * (roofRun * 0.5);
      const midY = ridgeY - (roofRun * 0.5) * Math.tan(roofSlopeAngle) + 0.06;
      this._addMesh(root, roofSlabGeo, M.shingle, {
        pos: [midX, midY, roofCenterZ],
        rot: [0, 0, -side * roofSlopeAngle],
        name: side < 0 ? 'CabinRoofLeft' : 'CabinRoofRight',
      });
    }
    // Cedar ridge cap beam
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.36, 0.2, roofLengthZ + 0.06)), M.darkTimber, {
      pos: [0, ridgeY + 0.14, roofCenterZ],
    });

    // --- H. Detailed Cabin Interior (Unobstructed Center Walking Floor) ---
    // 1. Patterned woven area rug in the center
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(2.45, 0.018, 1.78)), M.rug, {
      pos: [-0.08, floorY + 0.009, -0.78],
      castShadow: false,
      name: 'CabinWovenRug',
    });

    // 2. Cobbled stone hearth & chimney breast along rear wall (lx = 0.2, lz = -3.14)
    const hearthX = 0.2;
    const hearthZ = -3.14;
    // Raised hearth apron slab
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(2.05, 0.16, 1.05)), M.hearthStone, {
      pos: [hearthX, floorY + 0.08, hearthZ + 0.18],
    });
    // Left & right firebox stone cheeks + upper chimney breast tapering through roof
    const cheekGeo = this._trackGeo(new THREE.BoxGeometry(0.46, 1.25, 0.72));
    this._addMesh(root, cheekGeo, M.hearthStone, { pos: [hearthX - 0.68, floorY + 0.76, hearthZ] });
    this._addMesh(root, cheekGeo, M.hearthStone, { pos: [hearthX + 0.68, floorY + 0.76, hearthZ] });
    // Dark soot firebox interior backplate
    const sootMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0x1b1918, roughness: 0.98 }));
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.95, 1.15, 0.22)), sootMat, {
      pos: [hearthX, floorY + 0.72, hearthZ - 0.26],
    });
    // Stacked firewood logs & softly glowing ember bed inside hearth
    const emberMat = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x3b180c,
        emissive: new THREE.Color(0xff5a18),
        emissiveIntensity: 1.5,
        roughness: 0.9,
      })
    );
    this._anim.hearthEmberMat = emberMat;
    this._addMesh(root, this._trackGeo(new THREE.CylinderGeometry(0.32, 0.36, 0.1, 10)), emberMat, {
      pos: [hearthX, floorY + 0.2, hearthZ + 0.02],
      castShadow: false,
    });
    const firewoodGeo = this._trackGeo(new THREE.CylinderGeometry(0.065, 0.07, 0.68, 7));
    this._addMesh(root, firewoodGeo, M.darkTimber, {
      pos: [hearthX, floorY + 0.29, hearthZ + 0.02],
      rot: [0.1, 0.22, Math.PI * 0.5],
    });
    this._addMesh(root, firewoodGeo, M.darkTimber, {
      pos: [hearthX, floorY + 0.34, hearthZ - 0.04],
      rot: [-0.12, -0.35, Math.PI * 0.5],
    });
    // Timber mantelpiece + decorative enamel camp mug
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(2.02, 0.14, 0.42)), M.darkTimber, {
      pos: [hearthX, floorY + 1.44, hearthZ + 0.12],
    });
    const mugMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0x2f5f78, roughness: 0.35, metalness: 0.3 }));
    this._addMesh(root, this._trackGeo(new THREE.CylinderGeometry(0.055, 0.052, 0.12, 10)), mugMat, {
      pos: [hearthX + 0.58, floorY + 1.57, hearthZ + 0.18],
    });
    // Upper stone chimney breast rising cleanly above cedar roof ridge
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(1.56, 2.2, 0.68)), M.hearthStone, {
      pos: [hearthX, floorY + 2.55, hearthZ - 0.04],
    });
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(1.12, 2.25, 0.62)), M.hearthStone, {
      pos: [hearthX, floorY + 4.55, hearthZ - 0.06],
    });
    // Chimney crown cap above roof
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(1.32, 0.16, 0.82)), M.hearthStone, {
      pos: [hearthX, floorY + 5.7, hearthZ - 0.06],
    });

    // 3. Sturdy Timber Table along right side (lx = +2.02, lz = -0.55)
    const tableX = 2.02;
    const tableZ = -0.55;
    const tableTopY = floorY + 0.78;
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(1.18, 0.07, 1.52)), M.plank, {
      pos: [tableX, tableTopY - 0.035, tableZ],
      name: 'CabinTable',
    });
    const tLegGeo = this._trackGeo(new THREE.BoxGeometry(0.09, 0.74, 0.09));
    for (const [dx, dz] of [[-0.48, -0.64], [0.48, -0.64], [-0.48, 0.64], [0.48, 0.64]]) {
      this._addMesh(root, tLegGeo, M.darkTimber, { pos: [tableX + dx, floorY + 0.37, tableZ + dz] });
    }
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.96, 0.06, 0.08)), M.darkTimber, {
      pos: [tableX, floorY + 0.24, tableZ],
    });

    // Open field journal on the table
    const pageMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0xe6dbc2, roughness: 0.9 }));
    const leatherMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0x5c321e, roughness: 0.82 }));
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.36, 0.02, 0.26)), leatherMat, {
      pos: [tableX - 0.18, tableTopY + 0.01, tableZ + 0.32],
      rot: [0, 0.26, 0],
    });
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.33, 0.024, 0.23)), pageMat, {
      pos: [tableX - 0.18, tableTopY + 0.015, tableZ + 0.32],
      rot: [0, 0.26, 0],
    });

    // 4. Flickering Warm Oil Lantern on the Table (Brass base, glass chimney, HDR flame, PointLight + volumetric halo)
    const lxLantern = tableX - 0.08;
    const lzLantern = tableZ - 0.16;
    const lanternGroup = new THREE.Group();
    lanternGroup.name = 'CabinOilLantern';
    lanternGroup.position.set(lxLantern, tableTopY, lzLantern);
    root.add(lanternGroup);

    // Brass oil reservoir + collar + cap
    this._addMesh(lanternGroup, this._trackGeo(new THREE.CylinderGeometry(0.085, 0.115, 0.09, 12)), M.brass, {
      pos: [0, 0.045, 0],
    });
    this._addMesh(lanternGroup, this._trackGeo(new THREE.CylinderGeometry(0.055, 0.065, 0.04, 12)), M.brass, {
      pos: [0, 0.105, 0],
    });
    this._addMesh(lanternGroup, this._trackGeo(new THREE.CylinderGeometry(0.045, 0.085, 0.06, 12)), M.brass, {
      pos: [0, 0.34, 0],
    });
    // Curved clear glass chimney
    const chimneyMat = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xfff0d4,
        emissive: new THREE.Color(0xff9c38),
        emissiveIntensity: 0.55,
        transparent: true,
        opacity: 0.36,
        roughness: 0.1,
        metalness: 0.1,
        depthWrite: false,
      })
    );
    this._addMesh(lanternGroup, this._trackGeo(new THREE.CylinderGeometry(0.058, 0.068, 0.21, 12, 1, true)), chimneyMat, {
      pos: [0, 0.22, 0],
      castShadow: false,
    });
    // Wire bail handle
    this._addMesh(lanternGroup, this._trackGeo(new THREE.TorusGeometry(0.11, 0.008, 6, 16, Math.PI)), M.iron, {
      pos: [0, 0.35, 0],
    });
    // HDR warm flickering flame core
    const flameMat = this._trackMat(
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(0xffd27a),
        toneMapped: false,
      })
    );
    const flameMesh = this._addMesh(lanternGroup, this._trackGeo(new THREE.ConeGeometry(0.024, 0.075, 8)), flameMat, {
      pos: [0, 0.19, 0],
      castShadow: false,
      receiveShadow: false,
    });
    this._anim.lanternFlame = flameMesh;

    // Crossed additive soft volumetric halo planes around the lantern flame
    const haloMat = this._trackMat(
      new THREE.MeshBasicMaterial({
        map: M.glowTex,
        color: new THREE.Color(0xffb44c),
        transparent: true,
        opacity: 0.52,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    const haloGeo = this._trackGeo(new THREE.PlaneGeometry(0.68, 0.68));
    const haloA = this._addMesh(lanternGroup, haloGeo, haloMat, {
      pos: [0, 0.22, 0],
      castShadow: false,
      receiveShadow: false,
    });
    const haloB = this._addMesh(lanternGroup, haloGeo, haloMat, {
      pos: [0, 0.22, 0],
      rot: [0, Math.PI * 0.5, 0],
      castShadow: false,
      receiveShadow: false,
    });
    this._anim.lanternHalos.push(haloA, haloB);

    // Warm interior oil lantern PointLight
    const lanternLight = new THREE.PointLight(0xffb154, 4.8, 14.5, 1.55);
    lanternLight.position.set(0, 0.38, 0);
    lanternLight.castShadow = false;
    lanternGroup.add(lanternLight);
    this._anim.lanternLight = lanternLight;

    // 5. Wooden Cabin Chair tucked beside table (lx = +1.18, lz = -0.55)
    const chairGroup = new THREE.Group();
    chairGroup.position.set(1.18, floorY, -0.55);
    chairGroup.rotation.y = Math.PI * 0.5 - 0.14;
    root.add(chairGroup);
    this._addMesh(chairGroup, this._trackGeo(new THREE.BoxGeometry(0.48, 0.05, 0.46)), M.plank, { pos: [0, 0.46, 0] });
    const cLegGeo = this._trackGeo(new THREE.BoxGeometry(0.05, 0.46, 0.05));
    for (const [dx, dz] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]]) {
      this._addMesh(chairGroup, cLegGeo, M.darkTimber, { pos: [dx, 0.23, dz] });
    }
    const backPostGeo = this._trackGeo(new THREE.BoxGeometry(0.05, 0.54, 0.05));
    this._addMesh(chairGroup, backPostGeo, M.darkTimber, { pos: [-0.19, 0.72, -0.18] });
    this._addMesh(chairGroup, backPostGeo, M.darkTimber, { pos: [0.19, 0.72, -0.18] });
    const slatGeo = this._trackGeo(new THREE.BoxGeometry(0.36, 0.08, 0.03));
    this._addMesh(chairGroup, slatGeo, M.plank, { pos: [0, 0.7, -0.18] });
    this._addMesh(chairGroup, slatGeo, M.plank, { pos: [0, 0.9, -0.18] });

    // 6. Timber-Framed Sleeping Cot along Left Wall (lx = -2.35, lz = -1.65)
    const cotX = -2.35;
    const cotZ = -1.65;
    // Frame rails & corner posts
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.96, 0.1, 2.04)), M.darkTimber, {
      pos: [cotX, floorY + 0.36, cotZ],
    });
    const cotLegGeo = this._trackGeo(new THREE.BoxGeometry(0.09, 0.56, 0.09));
    for (const [dx, dz] of [[-0.43, -0.96], [0.43, -0.96], [-0.43, 0.96], [0.43, 0.96]]) {
      this._addMesh(root, cotLegGeo, M.darkTimber, { pos: [cotX + dx, floorY + 0.28, cotZ + dz] });
    }
    // Canvas mattress
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.88, 0.16, 1.94)), M.canvasCloth, {
      pos: [cotX, floorY + 0.49, cotZ],
    });
    // Plump pillow at head end
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.68, 0.14, 0.4)), M.canvasCloth, {
      pos: [cotX, floorY + 0.62, cotZ - 0.68],
      rot: [0.08, 0.04, 0],
    });
    // Folded crimson wool blanket across lower half
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.92, 0.08, 0.96)), M.blanketWool, {
      pos: [cotX, floorY + 0.6, cotZ + 0.44],
    });

    // 7. Wall Shelf with Colored Hardcover Field Books & Spare Brass Lantern (back-left wall)
    const shelfX = -1.92;
    const shelfY = floorY + 1.56;
    const shelfZ = backZ + 0.32;
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(1.42, 0.06, 0.28)), M.plank, {
      pos: [shelfX, shelfY, shelfZ],
    });
    const corbelGeo = this._trackGeo(new THREE.BoxGeometry(0.06, 0.2, 0.22));
    this._addMesh(root, corbelGeo, M.darkTimber, { pos: [shelfX - 0.54, shelfY - 0.13, shelfZ - 0.02] });
    this._addMesh(root, corbelGeo, M.darkTimber, { pos: [shelfX + 0.54, shelfY - 0.13, shelfZ - 0.02] });

    const bookColors = [0x7a2626, 0x234b34, 0x263b5e, 0xa8762d, 0x5c3424, 0x3b5842, 0x6e2f48, 0x8a5c32, 0x2d4854];
    let bxCursor = shelfX - 0.56;
    for (let b = 0; b < bookColors.length; b++) {
      const bThick = 0.042 + (b % 3) * 0.012;
      const bH = 0.22 + (b % 4) * 0.028;
      const bMat = this._trackMat(new THREE.MeshStandardMaterial({ color: bookColors[b], roughness: 0.78 }));
      const tilt = b === bookColors.length - 1 ? -0.18 : 0;
      this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(bThick, bH, 0.19)), bMat, {
        pos: [bxCursor + (tilt ? 0.03 : 0), shelfY + 0.03 + bH * 0.5, shelfZ],
        rot: [0, 0, tilt],
      });
      bxCursor += bThick + 0.014;
    }
    // Spare brass lantern on right end of shelf
    this._addMesh(root, this._trackGeo(new THREE.CylinderGeometry(0.065, 0.085, 0.07, 10)), M.brass, {
      pos: [shelfX + 0.48, shelfY + 0.065, shelfZ],
    });
    this._addMesh(root, this._trackGeo(new THREE.CylinderGeometry(0.048, 0.055, 0.16, 10)), M.glass, {
      pos: [shelfX + 0.48, shelfY + 0.18, shelfZ],
      castShadow: false,
    });
    this._addMesh(root, this._trackGeo(new THREE.CylinderGeometry(0.04, 0.07, 0.045, 10)), M.brass, {
      pos: [shelfX + 0.48, shelfY + 0.28, shelfZ],
    });

    // --- I. SurfaceSolver Registrations (Floor Deck, Walls, Railings, Furniture, Shelter) ---
    // Walkable cabin + front porch deck (y = 3.20)
    frame.addLocalDeck(this.surfaceSolver, {
      id: 'ranger_cabin_floor',
      lx: 0,
      lz: 0,
      halfW: 3.22,
      halfD: 3.62,
      heightFn: () => floorY,
      surfaceType: 'wood',
    });

    // Outer walls (doorway gap lx in [-0.78, +0.78] = 1.56m clear!)
    const wallMinY = groundY;
    const wallMaxY = eavesY + 0.8;
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_wall_back',
      lx: 0,
      lz: backZ,
      halfW: 3.3,
      halfD: 0.2,
      minY: wallMinY,
      maxY: wallMaxY,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_wall_left',
      lx: -halfW,
      lz: -1.0,
      halfW: 0.2,
      halfD: 2.7,
      minY: wallMinY,
      maxY: wallMaxY,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_wall_right',
      lx: halfW,
      lz: -1.0,
      halfW: 0.2,
      halfD: 2.7,
      minY: wallMinY,
      maxY: wallMaxY,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_wall_front_left',
      lx: -2.04,
      lz: frontWallZ,
      halfW: 1.26,
      halfD: 0.2,
      minY: wallMinY,
      maxY: wallMaxY,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_wall_front_right',
      lx: 2.04,
      lz: frontWallZ,
      halfW: 1.26,
      halfD: 0.2,
      minY: wallMinY,
      maxY: wallMaxY,
    });

    // Front porch railings (clear 2.20m opening at lx in [-1.10, +1.10] aligned with stairs)
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_rail_left',
      lx: -3.12,
      lz: 2.6,
      halfW: 0.12,
      halfD: 1.02,
      minY: floorY - 0.1,
      maxY: floorY + 1.35,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_rail_right',
      lx: 3.12,
      lz: 2.6,
      halfW: 0.12,
      halfD: 1.02,
      minY: floorY - 0.1,
      maxY: floorY + 1.35,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_rail_front_left',
      lx: -2.14,
      lz: porchEdgeZ - 0.12,
      halfW: 1.04,
      halfD: 0.12,
      minY: floorY - 0.1,
      maxY: floorY + 1.35,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_rail_front_right',
      lx: 2.14,
      lz: porchEdgeZ - 0.12,
      halfW: 1.04,
      halfD: 0.12,
      minY: floorY - 0.1,
      maxY: floorY + 1.35,
    });

    // Compact interior furniture OBBs (leaves spacious ~2.7m unobstructed center floor)
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_hearth',
      lx: hearthX,
      lz: hearthZ,
      halfW: 0.96,
      halfD: 0.44,
      minY: floorY,
      maxY: floorY + 3.0,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_cot',
      lx: cotX,
      lz: cotZ,
      halfW: 0.48,
      halfD: 1.0,
      minY: floorY,
      maxY: floorY + 1.1,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cabin_table',
      lx: tableX,
      lz: tableZ,
      halfW: 0.56,
      halfD: 0.72,
      minY: floorY,
      maxY: floorY + 1.2,
    });

    // Indoor cabin shelter + covered porch shelter
    frame.addLocalShelter(this.surfaceSolver, {
      id: 'ranger_cabin',
      type: 'cabin',
      minLx: -3.15,
      maxLx: 3.15,
      minY: floorY - 0.4,
      maxY: ridgeY - 0.2,
      minLz: backZ + 0.05,
      maxLz: frontWallZ - 0.05,
      blocksRain: true,
      windDamping: 0.92,
      acousticZone: 'wood',
    });
    frame.addLocalShelter(this.surfaceSolver, {
      id: 'ranger_cabin_porch',
      type: 'porch',
      minLx: -3.15,
      maxLx: 3.15,
      minY: floorY - 0.4,
      maxY: eavesY + 0.2,
      minLz: frontWallZ - 0.05,
      maxLz: porchEdgeZ + 0.05,
      blocksRain: true,
      windDamping: 0.55,
      acousticZone: 'wood',
    });

    // Exclusion zones (cabin pad + southwest stair approach)
    const stepFrontWorld = frame.toWorldXZ(0, 4.9);
    this.exclusionZones.push(
      { x: cx, z: cz, radius: 6.4 },
      { x: stepFrontWorld.x, z: stepFrontWorld.z, radius: 2.8 }
    );

    // Waypoints
    this.waypoints.cabinPorch = makeWaypoint(
      frame.toWorldVec3(0, floorY, 2.75),
      yaw + Math.PI, // looking straight into the open doorway
      'Ranger Cabin Porch'
    );
    this.waypoints.cabinInterior = makeWaypoint(
      frame.toWorldVec3(-0.08, floorY, -0.55),
      yaw, // facing out through the front doorway onto the clearing
      'Ranger Cabin Interior'
    );
  }

  // ===========================================================================
  // 2. WALK-IN HOLLOW GIANT ANCIENT REDWOOD (-20.5, 13.5)
  // ===========================================================================

  _buildHollowRedwood() {
    const site = STRUCTURE_SITES.redwood;
    const { x: cx, z: cz, gapAngle, gapHalfWidth, innerRadius, outerRadius } = site;
    const M = this._mats;
    const rng = createRng(7421);

    // Sample terrain across interior & entrance threshold so interior floor sits flush with entrance and above all interior ground
    const entX = cx + Math.cos(gapAngle) * (outerRadius + 0.25);
    const entZ = cz + Math.sin(gapAngle) * (outerRadius + 0.25);
    const entranceGroundY = this.terrain.getHeightAt(entX, entZ);
    let maxInteriorH = this.terrain.getHeightAt(cx, cz);
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const h = this.terrain.getHeightAt(cx + Math.cos(ang) * innerRadius, cz + Math.sin(ang) * innerRadius);
      if (h > maxInteriorH) maxInteriorH = h;
    }
    const floorY = Math.max(entranceGroundY, maxInteriorH) + 0.05;

    const root = new THREE.Group();
    root.name = 'HollowGiantRedwood';
    root.position.set(cx, 0, cz);
    this.group.add(root);

    // --- A. Sculpted Lower Hollow Trunk (Thick Fluted Bark Outer + Warm Heartwood Inner + Gothic Archway) ---
    // Built vertically from floorY - 2.4 up to floorY + 5.6
    const buildHollowShell = () => {
      const yMin = floorY - 2.4;
      const yMax = floorY + 5.6;
      const archTopY = floorY + 2.52;
      const vSegs = 24;
      const uSegs = 44;

      const outPos = [];
      const outUvs = [];
      const outIdx = [];

      const inPos = [];
      const inUvs = [];
      const inIdx = [];

      const jambPos = [];
      const jambUvs = [];
      const jambIdx = [];

      const pushQuad = (idxArr, a, b, c, d) => {
        idxArr.push(a, b, c, a, c, d);
      };

      // Each height ring spans angles from [gapAngle + halfGap(y)] around the circle to [gapAngle + 2*PI - halfGap(y)]
      for (let iv = 0; iv <= vSegs; iv++) {
        const vf = iv / vSegs;
        const y = lerp(yMin, yMax, vf);
        const hAboveFloor = y - floorY;

        // Archway narrows organically into a Gothic split apex from h=1.8 to h=2.55, closing cleanly above
        let localHalfGap = 0;
        if (y < archTopY) {
          const archT = smoothstep(floorY + 1.65, archTopY, y);
          localHalfGap = gapHalfWidth * (1.0 - archT * 0.96);
        }

        const startTheta = gapAngle + localHalfGap;
        const sweep = Math.PI * 2 - localHalfGap * 2;

        // Subtle vertical taper & root flare near ground
        const flare = smoothstep(floorY + 2.2, floorY - 1.2, y) * 0.42;
        const taper = smoothstep(floorY + 1.5, yMax, y) * 0.24;

        for (let iu = 0; iu <= uSegs; iu++) {
          const uf = iu / uSegs;
          const theta = startTheta + uf * sweep;
          const cosT = Math.cos(theta);
          const sinT = Math.sin(theta);

          // Deep fluted redwood bark ridges
          const flute =
            Math.sin(theta * 14.0) * 0.14 +
            Math.sin(theta * 23.0 + hAboveFloor * 0.22) * 0.065;
          const rOut = outerRadius + flare - taper + flute;

          // Smooth organic concave heartwood interior (gradually narrows above head height toward skylight flue)
          const innerTaper = smoothstep(floorY + 2.8, yMax, y) * 0.65;
          const innerWave = Math.sin(theta * 9.0 + hAboveFloor * 0.3) * 0.05;
          const rIn = Math.max(0.85, innerRadius - innerTaper + innerWave);

          outPos.push(cosT * rOut, y, sinT * rOut);
          outUvs.push(uf * 4.0, vf * 2.5);

          inPos.push(cosT * rIn, y, sinT * rIn);
          inUvs.push(uf * 3.0, vf * 2.0);
        }
      }

      const rowStride = uSegs + 1;
      for (let iv = 0; iv < vSegs; iv++) {
        for (let iu = 0; iu < uSegs; iu++) {
          const a = iv * rowStride + iu;
          const b = a + 1;
          const c = (iv + 1) * rowStride + iu + 1;
          const d = (iv + 1) * rowStride + iu;
          // Outward-facing bark triangles
          pushQuad(outIdx, a, d, c, b);
          // Inward-facing heartwood triangles
          pushQuad(inIdx, a, b, c, d);
        }
      }

      // Stitch the two organic split-wood archway jamb caps along iu = 0 and iu = uSegs for y < archTopY + 0.35
      for (let iv = 0; iv < vSegs; iv++) {
        const y0 = lerp(yMin, yMax, iv / vSegs);
        if (y0 > archTopY + 0.25) break;

        for (const isRightJamb of [false, true]) {
          const iu = isRightJamb ? 0 : uSegs;
          const idx0 = iv * rowStride + iu;
          const idx1 = (iv + 1) * rowStride + iu;

          const baseV = jambPos.length / 3;
          jambPos.push(
            outPos[idx0 * 3], outPos[idx0 * 3 + 1], outPos[idx0 * 3 + 2],
            inPos[idx0 * 3], inPos[idx0 * 3 + 1], inPos[idx0 * 3 + 2],
            inPos[idx1 * 3], inPos[idx1 * 3 + 1], inPos[idx1 * 3 + 2],
            outPos[idx1 * 3], outPos[idx1 * 3 + 1], outPos[idx1 * 3 + 2]
          );
          const v0 = iv / vSegs;
          const v1 = (iv + 1) / vSegs;
          jambUvs.push(0, v0, 1, v0, 1, v1, 0, v1);

          if (isRightJamb) {
            pushQuad(jambIdx, baseV, baseV + 1, baseV + 2, baseV + 3);
          } else {
            pushQuad(jambIdx, baseV, baseV + 3, baseV + 2, baseV + 1);
          }
        }
      }

      const outerGeo = this._trackGeo(new THREE.BufferGeometry());
      outerGeo.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
      outerGeo.setAttribute('uv', new THREE.Float32BufferAttribute(outUvs, 2));
      outerGeo.setIndex(outIdx);
      outerGeo.computeVertexNormals();

      const innerGeo = this._trackGeo(new THREE.BufferGeometry());
      innerGeo.setAttribute('position', new THREE.Float32BufferAttribute(inPos, 3));
      innerGeo.setAttribute('uv', new THREE.Float32BufferAttribute(inUvs, 2));
      innerGeo.setIndex(inIdx);
      innerGeo.computeVertexNormals();

      const jambGeo = this._trackGeo(new THREE.BufferGeometry());
      jambGeo.setAttribute('position', new THREE.Float32BufferAttribute(jambPos, 3));
      jambGeo.setAttribute('uv', new THREE.Float32BufferAttribute(jambUvs, 2));
      jambGeo.setIndex(jambIdx);
      jambGeo.computeVertexNormals();

      this._addMesh(root, outerGeo, M.redwoodBark, { name: 'RedwoodHollowOuter' });
      this._addMesh(root, innerGeo, M.heartwood, { name: 'RedwoodHollowInner' });
      this._addMesh(root, jambGeo, M.heartwood, { name: 'RedwoodArchJambs' });
    };
    buildHollowShell();

    // --- B. Soaring Upper Fluted Trunk (up to 32m above floor!) ---
    const upperH = 26.8;
    const upperGeo = this._trackGeo(new THREE.CylinderGeometry(0.56, 2.22, upperH, 24, 14, false));
    const uPosAttr = upperGeo.attributes.position;
    for (let i = 0; i < uPosAttr.count; i++) {
      const vx = uPosAttr.getX(i);
      const vy = uPosAttr.getY(i);
      const vz = uPosAttr.getZ(i);
      const r = Math.hypot(vx, vz);
      if (r > 0.05) {
        const theta = Math.atan2(vz, vx);
        const hFrac = (vy + upperH * 0.5) / upperH;
        const flute = (Math.sin(theta * 14.0) * 0.13 + Math.sin(theta * 23.0 + vy * 0.18) * 0.06) * (1.0 - hFrac * 0.65);
        const scale = (r + flute) / r;
        uPosAttr.setX(i, vx * scale);
        uPosAttr.setZ(i, vz * scale);
      }
    }
    upperGeo.computeVertexNormals();
    this._addMesh(root, upperGeo, M.redwoodBark, {
      pos: [0, floorY + 5.2 + upperH * 0.5, 0],
      name: 'RedwoodUpperTrunk',
    });

    // --- C. Towering Upper Redwood Needle Bough Crown (y = floorY + 13..33.5m) ---
    const crownTiers = 9;
    const limbGeo = this._trackGeo(new THREE.CylinderGeometry(0.08, 0.24, 1.0, 7));
    const boughGeo = this._trackGeo(new THREE.ConeGeometry(1.0, 1.45, 7));
    for (let tier = 0; tier < crownTiers; tier++) {
      const tf = tier / (crownTiers - 1);
      const tierY = floorY + lerp(13.8, 31.4, tf);
      const branchCount = Math.round(lerp(7, 4, tf));
      const maxReach = lerp(7.8, 2.2, Math.pow(tf, 0.85));

      for (let b = 0; b < branchCount; b++) {
        const ang = (b / branchCount) * Math.PI * 2 + tier * 0.85 + (rng() - 0.5) * 0.35;
        const reach = maxReach * (0.82 + rng() * 0.32);
        const droop = lerp(0.24, -0.18, tf);

        // Heavy woody limb
        const limbGroup = new THREE.Group();
        limbGroup.position.set(0, tierY, 0);
        limbGroup.rotation.y = ang;
        root.add(limbGroup);

        this._addMesh(limbGroup, limbGeo, M.redwoodBark, {
          pos: [reach * 0.5, -reach * droop * 0.35, 0],
          rot: [0, 0, Math.PI * 0.5 + droop],
          scale: [1, reach, 1],
          receiveShadow: false,
        });

        // Layered redwood needle frond pads along limb
        for (const frac of [0.58, 0.86, 1.05]) {
          const padR = lerp(2.5, 1.15, tf) * (0.75 + frac * 0.32);
          const padH = lerp(1.3, 0.9, tf);
          this._addMesh(limbGroup, boughGeo, M.redwoodFoliage, {
            pos: [reach * frac, -reach * droop * frac * 0.32 + 0.35, (rng() - 0.5) * 0.6],
            rot: [(rng() - 0.5) * 0.16, rng() * Math.PI, (rng() - 0.5) * 0.16],
            scale: [padR, padH, padR * 0.86],
            receiveShadow: false,
          });
        }
      }
    }
    // Soaring spire tip at 33.5m
    this._addMesh(root, this._trackGeo(new THREE.ConeGeometry(2.1, 4.4, 8)), M.redwoodFoliage, {
      pos: [0, floorY + 32.8, 0],
      receiveShadow: false,
    });

    // --- D. 7 Massive Gnarled Flared Buttress Roots (Avoiding Archway Entrance!) ---
    const rootCount = 7;
    const validAngles = [];
    for (let i = 0; i < rootCount; i++) {
      // Distribute cleanly outside [gapAngle - 0.62, gapAngle + 0.62]
      const span = Math.PI * 2 - 1.28;
      const theta = gapAngle + 0.64 + ((i + 0.5) / rootCount) * span + (rng() - 0.5) * 0.12;
      validAngles.push(theta);
    }
    for (let i = 0; i < validAngles.length; i++) {
      const ang = validAngles[i];
      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);
      const reach = 4.2 + rng() * 1.45;
      const pts = [
        new THREE.Vector3(cosA * 1.95, floorY + 2.85 + rng() * 0.6, sinA * 1.95),
        new THREE.Vector3(cosA * 2.75, floorY + 1.05, sinA * 2.75),
        new THREE.Vector3(cosA * (reach * 0.82), floorY - 0.35, sinA * (reach * 0.82)),
        new THREE.Vector3(cosA * reach, floorY - 2.35, sinA * reach),
      ];
      const curve = new THREE.CatmullRomCurve3(pts);
      const rGeo = this._trackGeo(new THREE.TubeGeometry(curve, 12, 0.54, 7, false));
      // Taper root radius gracefully along its length
      const posA = rGeo.attributes.position;
      for (let vi = 0; vi < posA.count; vi++) {
        const ring = Math.floor(vi / 8);
        const tf = ring / 12;
        const cPt = curve.getPoint(clamp(tf, 0, 1));
        const scaleR = lerp(1.18, 0.52, tf);
        posA.setXYZ(
          vi,
          cPt.x + (posA.getX(vi) - cPt.x) * scaleR,
          cPt.y + (posA.getY(vi) - cPt.y) * scaleR,
          cPt.z + (posA.getZ(vi) - cPt.z) * scaleR
        );
      }
      rGeo.computeVertexNormals();
      this._addMesh(root, rGeo, M.redwoodBark, { name: `RedwoodRoot_${i}` });
    }

    // --- E. Mossy Interior Floor Disk + Smooth Threshold Pad ---
    const floorDiskH = 1.6;
    this._addMesh(root, this._trackGeo(new THREE.CylinderGeometry(1.94, 2.25, floorDiskH, 24)), M.mossFloor, {
      pos: [0, floorY - floorDiskH * 0.5, 0],
      name: 'RedwoodMossFloor',
    });

    // Subtle earthy moss threshold ramp bridging the archway thickness (r = 1.50..2.80 along gapAngle)
    const archDirX = Math.cos(gapAngle);
    const archDirZ = Math.sin(gapAngle);
    const archYaw = Math.atan2(archDirX, archDirZ); // local +Z points out of archway
    const threshFrame = createLocalFrame(cx, cz, archYaw);

    const threshGroup = new THREE.Group();
    threshGroup.rotation.y = archYaw;
    root.add(threshGroup);
    const threshSlope = Math.atan2(floorY - entranceGroundY, 1.3);
    const threshLen = Math.hypot(1.3, floorY - entranceGroundY);
    this._addMesh(threshGroup, this._trackGeo(new THREE.BoxGeometry(1.52, 0.55, threshLen)), M.mossFloor, {
      pos: [0, (floorY + entranceGroundY) * 0.5 - 0.275, 2.15],
      rot: [threshSlope, 0, 0],
      name: 'RedwoodThresholdRamp',
    });

    // --- F. 3 Slanted Volumetric Dappled Sunbeams Piercing High Bark Cracks ---
    const sunbeamVert = /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      void main() {
        vUv = uv;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewPos = -mvPos.xyz;
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mvPos;
      }
    `;
    const sunbeamFrag = /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uPhase;
      varying vec2 vUv;
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      void main() {
        float edge = abs(dot(normalize(vNormalView), normalize(vViewPos)));
        edge = pow(clamp(edge, 0.0, 1.0), 1.45);
        float topFade = smoothstep(1.0, 0.72, vUv.y);
        float bottomFade = smoothstep(0.0, 0.22, vUv.y);
        float dapple = 0.82 + 0.18 * sin(vUv.y * 9.0 - uTime * 0.65 + uPhase);
        float alpha = edge * topFade * bottomFade * uOpacity * dapple;
        gl_FragColor = vec4(uColor, alpha);
      }
    `;

    const beamConfigs = [
      { top: [-0.85, floorY + 4.85, -0.55], bot: [0.35, floorY + 0.04, 0.28], rTop: 0.14, rBot: 0.62, phase: 0.4 },
      { top: [0.75, floorY + 5.1, -0.68], bot: [-0.32, floorY + 0.04, 0.48], rTop: 0.12, rBot: 0.56, phase: 2.1 },
      { top: [-0.2, floorY + 4.65, 0.82], bot: [0.18, floorY + 0.04, -0.42], rTop: 0.13, rBot: 0.52, phase: 4.3 },
    ];
    for (let i = 0; i < beamConfigs.length; i++) {
      const cfg = beamConfigs[i];
      const vTop = new THREE.Vector3(...cfg.top);
      const vBot = new THREE.Vector3(...cfg.bot);
      const dir = new THREE.Vector3().subVectors(vBot, vTop);
      const len = dir.length();
      const mid = new THREE.Vector3().addVectors(vTop, vBot).multiplyScalar(0.5);

      const beamGeo = this._trackGeo(new THREE.CylinderGeometry(cfg.rTop, cfg.rBot, len, 14, 1, true));
      const beamMat = this._trackMat(
        new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: new THREE.Color(0xffdfa0) },
            uOpacity: { value: 0.22 },
            uTime: { value: 0 },
            uPhase: { value: cfg.phase },
          },
          vertexShader: sunbeamVert,
          fragmentShader: sunbeamFrag,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      const beamMesh = new THREE.Mesh(beamGeo, beamMat);
      beamMesh.position.copy(mid);
      beamMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
      beamMesh.renderOrder = 4;
      root.add(beamMesh);
      this._anim.redwoodSunbeams.push(beamMat);
    }

    // --- G. Glowing Cyan & Amber Bioluminescent Mushrooms Along Inner Hollow Wall ---
    const cyanMushMat = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x3ef0d8,
        emissive: new THREE.Color(0x22e4cc),
        emissiveIntensity: 1.55,
        roughness: 0.35,
      })
    );
    const amberMushMat = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffb84c,
        emissive: new THREE.Color(0xff9924),
        emissiveIntensity: 1.45,
        roughness: 0.38,
      })
    );
    this._anim.redwoodMushroomMats.push(cyanMushMat, amberMushMat);

    const stemGeo = this._trackGeo(new THREE.CylinderGeometry(0.014, 0.022, 0.14, 6));
    const capGeo = this._trackGeo(new THREE.SphereGeometry(0.075, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55));

    const clusterAngles = [1.05, 1.95, 2.85, 3.65, 4.45, 5.12];
    for (let c = 0; c < clusterAngles.length; c++) {
      const baseAng = clusterAngles[c];
      const capMat = c % 2 === 0 ? cyanMushMat : amberMushMat;
      const count = 4 + (c % 3);
      for (let m = 0; m < count; m++) {
        const ang = baseAng + (rng() - 0.5) * 0.28;
        const rad = innerRadius - 0.18 - rng() * 0.16;
        const sc = 0.65 + rng() * 0.85;
        const mx = Math.cos(ang) * rad;
        const mz = Math.sin(ang) * rad;
        const mh = 0.14 * sc;
        this._addMesh(root, stemGeo, M.mushroomStem, {
          pos: [mx, floorY + mh * 0.45, mz],
          rot: [(rng() - 0.5) * 0.28, 0, (rng() - 0.5) * 0.28],
          scale: [sc, sc, sc],
          castShadow: false,
        });
        this._addMesh(root, capGeo, capMat, {
          pos: [mx, floorY + mh * 0.85, mz],
          rot: [(rng() - 0.5) * 0.24, 0, (rng() - 0.5) * 0.24],
          scale: [sc * 1.1, sc * 0.82, sc * 1.1],
          castShadow: false,
        });
      }
    }

    const redwoodLight = new THREE.PointLight(0x5ae2c8, 1.4, 7.5, 1.6);
    redwoodLight.position.set(0, floorY + 1.25, 0);
    root.add(redwoodLight);
    this._anim.redwoodGlowLight = redwoodLight;

    // --- H. SurfaceSolver Registration ---
    this.surfaceSolver.addCircleFloor({
      id: 'hollow_redwood_floor',
      cx,
      cz,
      radius: 1.92,
      height: floorY,
      surfaceType: 'moss',
    });

    // Smooth entrance archway moss threshold deck bridging ground <-> interior floor
    threshFrame.addLocalDeck(this.surfaceSolver, {
      id: 'hollow_redwood_threshold',
      lx: 0,
      lz: 2.15,
      halfW: 0.85,
      halfD: 0.65,
      heightFn: (_lx, lz) => {
        const t = clamp((lz + 0.65) / 1.3, 0, 1); // -0.65 (inner) -> +0.65 (outer)
        return lerp(floorY, entranceGroundY, t);
      },
      surfaceType: 'moss',
    });

    this.surfaceSolver.addHollowRingWall({
      id: 'hollow_redwood_trunk',
      cx,
      cz,
      innerRadius,
      outerRadius: outerRadius + 0.04,
      gapAngle,
      gapHalfWidth,
      minY: floorY - 2.0,
      maxY: floorY + 28.0,
    });

    this.surfaceSolver.addShelterVolume({
      id: 'hollow_redwood',
      type: 'redwood',
      min: new THREE.Vector3(cx - 1.95, floorY - 0.4, cz - 1.95),
      max: new THREE.Vector3(cx + 1.95, floorY + 5.6, cz + 1.95),
      testFn: (pos) =>
        Math.hypot(pos.x - cx, pos.z - cz) <= 1.96 &&
        pos.y >= floorY - 0.4 &&
        pos.y <= floorY + 5.6,
      blocksRain: true,
      windDamping: 0.82,
      acousticZone: 'wood',
    });

    // Exclusion zones (giant trunk + buttress roots + east entrance path)
    this.exclusionZones.push(
      { x: cx, z: cz, radius: 5.5 },
      { x: cx + archDirX * 4.2, z: cz + archDirZ * 4.2, radius: 2.8 }
    );

    // Waypoint inside the hollow giant redwood looking out the split archway
    this.waypoints.redwoodInterior = makeWaypoint(
      new THREE.Vector3(cx, floorY, cz),
      archYaw,
      'Hollow Giant Redwood'
    );
  }

  // ===========================================================================
  // 3. WALK-IN MOSSY STONE CAVERN (26.8, 14.5)
  // ===========================================================================

  _buildMossyCavern() {
    const site = STRUCTURE_SITES.cavern;
    const { x: cx, z: cz, yaw, floorY } = site;
    const frame = createLocalFrame(cx, cz, yaw);
    const M = this._mats;
    const rng = createRng(9183);
    const rockNoise = createNoise2D(createRng(9189));

    const root = new THREE.Group();
    root.name = 'MossyStoneCavern';
    root.position.set(cx, 0, cz);
    root.rotation.y = yaw;
    this.group.add(root);

    // Chamber local coordinates:
    // Width: 5.6m (lx in [-2.8, +2.8]), Depth: 6.8m (lz in [-3.4, +3.4]), Height: 3.4m (floorY..floorY+3.4)
    // Entrance faces local +Z (+3.4), pointing northwest along (-0.82, -0.57) toward clearing!

    // --- A. Flat Damp Flagstone Cavern Floor (flush over graded 4.20 cove, zero dirt poking through) ---
    this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(6.2, 0.36, 7.8)), M.cavernRock, {
      pos: [0, floorY - 0.18, 0.25],
      name: 'CavernStoneFloor',
    });
    // Organic stepping flagstones fading into the graded entrance ramp
    const stepStoneGeo = this._trackGeo(new THREE.CylinderGeometry(0.65, 0.72, 0.14, 7));
    for (const [sx, sz, sc] of [[-0.65, 4.35, 1.0], [0.55, 4.85, 0.92], [-0.25, 5.55, 0.85]]) {
      const wPt = frame.toWorldXZ(sx, sz);
      const groundH = this.terrain.getHeightAt(wPt.x, wPt.z);
      this._addMesh(root, stepStoneGeo, M.cavernRock, {
        pos: [sx, groundH - 0.04, sz],
        scale: [sc, 1, sc * 0.8],
        castShadow: false,
      });
    }

    // --- B. Sculpted Inner Walkable Granite Vault & Outer Hillside Shell ---
    const buildVaultMesh = (isInner) => {
      const zSegs = 22;
      const aSegs = 22;
      const zBack = isInner ? -3.45 : -5.1;
      const zFront = isInner ? 3.55 : 4.15;

      const positions = [];
      const uvs = [];
      const indices = [];

      for (let iz = 0; iz <= zSegs; iz++) {
        const zf = iz / zSegs; // 0 = rear apse wall, 1 = front entrance arch
        const lz = lerp(zBack, zFront, zf);

        // Close rear wall cleanly into a vaulted stone apse for zf near 0
        const backDome = smoothstep(0.0, 0.22, zf);
        // Entrance arch gently narrows at the doorway (+3.4) from 2.85m half-width down to ~1.88m half-width
        const archPinch = smoothstep(0.76, 1.0, zf);

        const baseHalfW = isInner
          ? lerp(2.92, 1.92, archPinch) * lerp(0.06, 1.0, backDome)
          : lerp(5.2, 4.35, archPinch) * lerp(0.25, 1.0, backDome);
        const baseArchH = isInner
          ? lerp(3.45, 2.95, archPinch) * lerp(0.18, 1.0, backDome)
          : lerp(5.45, 4.85, archPinch) * lerp(0.38, 1.0, backDome);

        for (let ia = 0; ia <= aSegs; ia++) {
          const af = ia / aSegs; // 0 = left floor, 0.5 = crown, 1 = right floor
          const ang = lerp(Math.PI, 0, af);
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);

          // Faceted granite strata displacement
          const n1 = rockNoise(lz * 0.42 + af * 3.2, af * 4.5 + (isInner ? 1.7 : 9.3));
          const n2 = rockNoise(lz * 0.95 - af * 5.0, lz * 0.65);
          const disp = (n1 * 0.24 + n2 * 0.11) * (isInner ? 0.65 : 1.35) * backDome;

          // Keep doorway floor edges tucked cleanly below floorY
          const lx = ca * (baseHalfW + disp);
          const ly = floorY - (isInner ? 0.18 : 0.9) + Math.pow(Math.max(sa, 0), 0.86) * (baseArchH + disp * 0.8);

          positions.push(lx, ly, lz);
          uvs.push(af * 3.0, zf * 2.5);
        }
      }

      const stride = aSegs + 1;
      for (let iz = 0; iz < zSegs; iz++) {
        for (let ia = 0; ia < aSegs; ia++) {
          const a = iz * stride + ia;
          const b = a + 1;
          const c = (iz + 1) * stride + ia + 1;
          const d = (iz + 1) * stride + ia;
          if (isInner) {
            indices.push(a, b, c, a, c, d);
          } else {
            indices.push(a, d, c, a, c, b);
          }
        }
      }

      const geo = this._trackGeo(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      return geo;
    };

    this._addMesh(root, buildVaultMesh(true), M.cavernRockInner, { name: 'CavernInnerVault' });
    this._addMesh(root, buildVaultMesh(false), M.cavernRock, { name: 'CavernOuterMassif' });

    // --- C. Sculpted Granite Arch Brow & Flanking Entrance Cliff Shoulders ---
    const makeRockBoulder = (radius, seedOffset) => {
      const bGeo = this._trackGeo(new THREE.DodecahedronGeometry(radius, 2));
      const bPos = bGeo.attributes.position;
      for (let i = 0; i < bPos.count; i++) {
        const vx = bPos.getX(i);
        const vy = bPos.getY(i);
        const vz = bPos.getZ(i);
        const n = rockNoise(vx * 0.75 + seedOffset, vz * 0.75 + vy * 0.55);
        const sc = 1.0 + n * 0.22;
        bPos.setXYZ(i, vx * sc, vy * sc, vz * sc);
      }
      bGeo.computeVertexNormals();
      return bGeo;
    };

    const archBoulders = [
      // Left & right doorway cheek pillars (clear opening lx in [-1.62, +1.62])
      { pos: [-2.45, floorY + 1.05, 3.65], scale: [1.15, 1.45, 1.15], r: 1.05 },
      { pos: [2.45, floorY + 1.05, 3.65], scale: [1.15, 1.45, 1.15], r: 1.05 },
      // Massive overhanging mossy granite lintel brow
      { pos: [-1.45, floorY + 3.05, 3.72], scale: [1.45, 0.92, 1.2], r: 1.1 },
      { pos: [1.45, floorY + 3.05, 3.72], scale: [1.45, 0.92, 1.2], r: 1.1 },
      { pos: [0.0, floorY + 3.55, 3.85], scale: [2.1, 0.95, 1.35], r: 1.15 },
      // Entrance canyon shoulders blending organically into the graded terrain embankments
      { pos: [-3.55, floorY + 1.1, 4.95], scale: [1.45, 1.35, 1.65], r: 1.1 },
      { pos: [3.55, floorY + 1.1, 4.95], scale: [1.45, 1.35, 1.65], r: 1.1 },
      { pos: [-4.1, floorY + 0.55, 6.35], scale: [1.3, 1.0, 1.4], r: 0.95 },
      { pos: [4.1, floorY + 0.55, 6.35], scale: [1.3, 1.0, 1.4], r: 0.95 },
      // Upper hillside granite brow cap fusing the cavern dome into the steep slope
      { pos: [0.0, floorY + 4.45, 1.85], scale: [3.4, 1.3, 2.2], r: 1.15 },
      { pos: [-2.9, floorY + 3.4, 1.4], scale: [1.9, 1.5, 2.4], r: 1.1 },
      { pos: [2.9, floorY + 3.4, 1.4], scale: [1.9, 1.5, 2.4], r: 1.1 },
    ];
    for (let i = 0; i < archBoulders.length; i++) {
      const b = archBoulders[i];
      this._addMesh(root, makeRockBoulder(b.r, i * 17.3), M.cavernRock, {
        pos: b.pos,
        scale: b.scale,
        rot: [rng() * 0.4, rng() * Math.PI, rng() * 0.4],
      });
    }

    // --- D. Hanging Moss & Ivy Vines Framing the Stone Entrance Arch ---
    const vineGeo = this._trackGeo(new THREE.ConeGeometry(0.11, 1.0, 5));
    for (let v = 0; v < 18; v++) {
      const vf = v / 17;
      const vx = lerp(-2.15, 2.15, vf) + (rng() - 0.5) * 0.14;
      const archCurve = Math.sqrt(Math.max(0.05, 1.0 - Math.pow(vx / 2.35, 2)));
      const vyTop = floorY + 1.65 + archCurve * 1.55;
      // Shorter over central doorway so walking sightline stays clear, longer along arch cheeks
      const vLen = (Math.abs(vx) < 1.05 ? 0.42 + rng() * 0.35 : 0.72 + rng() * 0.78);
      this._addMesh(root, vineGeo, M.vineMoss, {
        pos: [vx, vyTop - vLen * 0.48, 3.85 + (rng() - 0.5) * 0.35],
        rot: [Math.PI, rng() * Math.PI, (rng() - 0.5) * 0.14],
        scale: [0.8 + rng() * 0.65, vLen, 0.65 + rng() * 0.5],
        castShadow: false,
      });
    }

    // --- E. Glowing Cyan & Amber Cave Crystal Clusters + Bioluminescent Mushrooms ---
    const cyanCrystalMat = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x54f0ff,
        emissive: new THREE.Color(0x1cd4ee),
        emissiveIntensity: 2.1,
        roughness: 0.14,
        metalness: 0.18,
      })
    );
    const amberCrystalMat = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffc662,
        emissive: new THREE.Color(0xff9220),
        emissiveIntensity: 1.95,
        roughness: 0.16,
        metalness: 0.16,
      })
    );
    this._anim.cavernCrystalMats.push(cyanCrystalMat, amberCrystalMat);

    // Hexagonal pointed crystal prism geometry
    const makeCrystalSpire = () => {
      const g = new THREE.CylinderGeometry(0.0, 0.11, 0.88, 6, 1);
      g.translate(0, 0.44, 0);
      return this._trackGeo(g);
    };
    const crystalGeo = makeCrystalSpire();

    const crystalClusters = [
      { pos: [-2.28, floorY + 0.05, -0.85], rotY: 0.5, isCyan: true, scale: 1.15 },
      { pos: [2.26, floorY + 0.05, -0.25], rotY: -0.6, isCyan: false, scale: 1.1 },
      { pos: [-1.15, floorY + 0.05, -2.75], rotY: 0.2, isCyan: true, scale: 1.35 },
      { pos: [1.28, floorY + 0.05, -2.65], rotY: -0.35, isCyan: false, scale: 1.2 },
      { pos: [-2.38, floorY + 1.45, 0.95], rotY: 1.3, tiltZ: -0.95, isCyan: true, scale: 0.85 },
      { pos: [2.36, floorY + 1.55, 1.15], rotY: -1.3, tiltZ: 0.92, isCyan: false, scale: 0.82 },
    ];
    for (let c = 0; c < crystalClusters.length; c++) {
      const cl = crystalClusters[c];
      const cg = new THREE.Group();
      cg.position.set(cl.pos[0], cl.pos[1], cl.pos[2]);
      cg.rotation.y = cl.rotY;
      if (cl.tiltZ) cg.rotation.z = cl.tiltZ;
      root.add(cg);

      const mat = cl.isCyan ? cyanCrystalMat : amberCrystalMat;
      const spires = 5;
      for (let s = 0; s < spires; s++) {
        const sAng = (s / spires) * Math.PI * 2 + rng() * 0.4;
        const spread = s === 0 ? 0.04 : 0.24 + rng() * 0.28;
        const hScale = (s === 0 ? 1.15 : 0.52 + rng() * 0.55) * cl.scale;
        const wScale = (s === 0 ? 1.1 : 0.65 + rng() * 0.4) * cl.scale;
        this._addMesh(cg, crystalGeo, mat, {
          pos: [Math.cos(sAng) * 0.14, 0, Math.sin(sAng) * 0.14],
          rot: [Math.sin(sAng) * spread, sAng, -Math.cos(sAng) * spread],
          scale: [wScale, hScale, wScale],
          castShadow: false,
        });
      }
    }

    // Bioluminescent cavern mushrooms nestled near wall bases
    const cavMushCyan = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x48f2e0,
        emissive: new THREE.Color(0x1cd8c8),
        emissiveIntensity: 1.6,
        roughness: 0.35,
      })
    );
    const cavMushAmber = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffbc55,
        emissive: new THREE.Color(0xff9426),
        emissiveIntensity: 1.5,
        roughness: 0.38,
      })
    );
    this._anim.cavernMushroomMats.push(cavMushCyan, cavMushAmber);

    const mStemGeo = this._trackGeo(new THREE.CylinderGeometry(0.014, 0.024, 0.15, 6));
    const mCapGeo = this._trackGeo(new THREE.SphereGeometry(0.08, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.56));
    const mushSpots = [
      [-2.18, 1.65, true], [-2.22, -1.95, false], [2.15, 1.55, false],
      [2.22, -1.85, true], [0.05, -2.92, true],
    ];
    for (let i = 0; i < mushSpots.length; i++) {
      const [bx, bz, isCyan] = mushSpots[i];
      const capMat = isCyan ? cavMushCyan : cavMushAmber;
      for (let k = 0; k < 4; k++) {
        const sc = 0.65 + rng() * 0.78;
        const ox = bx + (rng() - 0.5) * 0.45;
        const oz = bz + (rng() - 0.5) * 0.45;
        this._addMesh(root, mStemGeo, M.mushroomStem, {
          pos: [ox, floorY + 0.07 * sc, oz],
          scale: [sc, sc, sc],
          castShadow: false,
        });
        this._addMesh(root, mCapGeo, capMat, {
          pos: [ox, floorY + 0.135 * sc, oz],
          scale: [sc * 1.1, sc * 0.85, sc * 1.1],
          castShadow: false,
        });
      }
    }

    // Soft glowing cavern interior lights (cyan crystal grotto + warm amber accent)
    const cavCyanLight = new THREE.PointLight(0x46dff2, 3.8, 13.0, 1.5);
    cavCyanLight.position.set(-0.6, floorY + 1.9, -1.65);
    root.add(cavCyanLight);

    const cavAmberLight = new THREE.PointLight(0xffaa4c, 2.5, 10.0, 1.6);
    cavAmberLight.position.set(1.4, floorY + 1.4, -0.45);
    root.add(cavAmberLight);

    this._anim.cavernLights.push(
      { light: cavCyanLight, baseIntensity: 3.8, phase: 0.6 },
      { light: cavAmberLight, baseIntensity: 2.5, phase: 2.8 }
    );

    // --- F. SurfaceSolver Registration ---
    frame.addLocalDeck(this.surfaceSolver, {
      id: 'mossy_cavern_floor',
      lx: 0,
      lz: 0.25,
      halfW: 3.05,
      halfD: 3.85,
      heightFn: () => floorY,
      surfaceType: 'stone',
    });

    const cMinY = floorY - 0.4;
    const cMaxY = floorY + 4.4;
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cavern_wall_back',
      lx: 0,
      lz: -3.45,
      halfW: 3.2,
      halfD: 0.45,
      minY: cMinY,
      maxY: cMaxY,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cavern_wall_left',
      lx: -2.95,
      lz: 0.0,
      halfW: 0.42,
      halfD: 3.55,
      minY: cMinY,
      maxY: cMaxY,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cavern_wall_right',
      lx: 2.95,
      lz: 0.0,
      halfW: 0.42,
      halfD: 3.55,
      minY: cMinY,
      maxY: cMaxY,
    });
    // Entrance arch cheeks leaving crisp 3.14m wide open doorway (lx in [-1.57, +1.57])
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cavern_cheek_left',
      lx: -2.35,
      lz: 3.48,
      halfW: 0.78,
      halfD: 0.48,
      minY: cMinY,
      maxY: cMaxY,
    });
    frame.addLocalWallOBB(this.surfaceSolver, {
      id: 'cavern_cheek_right',
      lx: 2.35,
      lz: 3.48,
      halfW: 0.78,
      halfD: 0.48,
      minY: cMinY,
      maxY: cMaxY,
    });

    // Cave shelter volume (acousticZone: 'cave', blocksRain: true, windDamping: 0.96)
    frame.addLocalShelter(this.surfaceSolver, {
      id: 'mossy_cavern',
      type: 'cave',
      minLx: -3.0,
      maxLx: 3.0,
      minY: floorY - 0.45,
      maxY: floorY + 3.65,
      minLz: -3.5,
      maxLz: 3.45,
      blocksRain: true,
      windDamping: 0.96,
      acousticZone: 'cave',
    });

    // Exclusion zones (cavern massif + northwest graded approach ramp)
    const rampMid = frame.toWorldXZ(0, 5.4);
    const rampLow = frame.toWorldXZ(0, 8.6);
    this.exclusionZones.push(
      { x: cx, z: cz, radius: 6.4 },
      { x: rampMid.x, z: rampMid.z, radius: 3.4 },
      { x: rampLow.x, z: rampLow.z, radius: 2.8 }
    );

    // Waypoint inside the mossy stone cavern looking out toward the clearing
    this.waypoints.cavernInterior = makeWaypoint(
      frame.toWorldVec3(0, floorY, -0.65),
      yaw,
      'Mossy Stone Cavern'
    );
  }

  // ===========================================================================
  // 4. ARCHED WOODEN FOOTBRIDGE (z = 6.5, x = terrain.getStreamCenterX(6.5))
  // ===========================================================================

  _buildArchedFootbridge() {
    const site = STRUCTURE_SITES.bridge;
    const bz = site.z;
    const bx = this.terrain.getStreamCenterX(bz);
    const slope = this.terrain.getStreamSlope(bz);
    const halfLen = site.halfLength; // 8.1m -> 16.2m total length
    const halfW = site.halfWidth;    // 1.3m -> 2.6m total width

    // Local +X spans west->east perpendicular to stream channel; local +Z points downstream
    const yaw = Math.atan2(slope, 1.0);
    const frame = createLocalFrame(bx, bz, yaw);
    const M = this._mats;
    const rng = createRng(5512);

    const root = new THREE.Group();
    root.name = 'ArchedWoodenFootbridge';
    root.position.set(bx, 0, bz);
    root.rotation.y = yaw;
    this.group.add(root);

    // Exact west and east bank terrain heights at bridge abutments
    const westWorld = frame.toWorldXZ(-halfLen, 0);
    const eastWorld = frame.toWorldXZ(halfLen, 0);
    const hWest = this.terrain.getHeightAt(westWorld.x, westWorld.z);
    const hEast = this.terrain.getHeightAt(eastWorld.x, eastWorld.z);

    // Smooth parabolic crown height strictly >= WATER_LEVEL + 0.95m (and gracefully arched above banks)
    const midChordY = (hWest + hEast) * 0.5;
    const crownLift = Math.max(0.58, WATER_LEVEL + 0.95 - midChordY);

    const bridgeDeckY = (lx) => {
      const u = clamp(lx / halfLen, -1, 1);
      const t = (u + 1) * 0.5;
      return lerp(hWest + 0.03, hEast + 0.03, t) + crownLift * (1.0 - u * u);
    };
    const bridgeSlopeX = (lx) => {
      const u = clamp(lx / halfLen, -1, 1);
      return ((hEast - hWest) * 0.5 - 2.0 * crownLift * u) / halfLen;
    };

    // --- A. 2 Curved Laminated Timber Arch Stringer Beams ---
    for (const sz of [-1.02, 1.02]) {
      const pts = [];
      for (let i = 0; i <= 18; i++) {
        const lx = lerp(-halfLen - 0.15, halfLen + 0.15, i / 18);
        pts.push(new THREE.Vector3(lx, bridgeDeckY(lx) - 0.16, sz));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const beamGeo = this._trackGeo(new THREE.TubeGeometry(curve, 32, 0.13, 6, false));
      this._addMesh(root, beamGeo, M.darkTimber, { name: sz < 0 ? 'BridgeStringerN' : 'BridgeStringerS' });
    }

    // --- B. Stone & Timber Bank Abutments (Solidly Anchored Into Both Banks) ---
    for (const [endX, bankH] of [[-halfLen, hWest], [halfLen, hEast]]) {
      const abutH = 1.65;
      this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.95, abutH, halfW * 2 + 0.35)), M.hearthStone, {
        pos: [endX, bankH - abutH * 0.5 + 0.04, 0],
      });
      this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.32, 0.24, halfW * 2 + 0.24)), M.darkTimber, {
        pos: [endX, bankH - 0.04, 0],
      });
    }

    // --- C. 44 Individual Weathered Timber Deck Planks ---
    const plankCount = 44;
    const plankSpan = halfLen * 2.0;
    const plankW = (plankSpan / plankCount) * 0.86;
    const plankGeo = this._trackGeo(new THREE.BoxGeometry(plankW, 0.068, halfW * 2.02));
    for (let i = 0; i < plankCount; i++) {
      const lx = lerp(-halfLen + plankW * 0.5, halfLen - plankW * 0.5, i / (plankCount - 1));
      const py = bridgeDeckY(lx);
      const slopeAng = Math.atan(bridgeSlopeX(lx));
      const jitterY = (rng() - 0.5) * 0.008;
      this._addMesh(root, plankGeo, M.bridgePlank, {
        pos: [lx, py - 0.034 + jitterY, (rng() - 0.5) * 0.025],
        rot: [(rng() - 0.5) * 0.008, (rng() - 0.5) * 0.012, slopeAng],
      });
    }

    // --- D. 8 Submerged Timber Pilings (4 Pairs in the Stream -> Stored in this.bridgePilings) ---
    const pilingRadius = 0.19;
    const pilingXs = [-4.2, -1.4, 1.4, 4.2];
    const pilingZs = [-1.12, 1.12];
    const bandGeo = this._trackGeo(new THREE.CylinderGeometry(pilingRadius + 0.018, pilingRadius + 0.018, 0.1, 10));

    for (let i = 0; i < pilingXs.length; i++) {
      const px = pilingXs[i];
      const topY = bridgeDeckY(px) - 0.1;
      const botY = -1.85; // deeply driven beneath stream bed (-0.76)
      const h = topY - botY;
      const pGeo = this._trackGeo(new THREE.CylinderGeometry(pilingRadius * 0.94, pilingRadius * 1.06, h, 10));

      for (let j = 0; j < pilingZs.length; j++) {
        const pz = pilingZs[j];
        this._addMesh(root, pGeo, M.darkTimber, {
          pos: [px, botY + h * 0.5, pz],
          name: `BridgePiling_${i}_${j}`,
        });
        this._addMesh(root, bandGeo, M.iron, { pos: [px, topY - 0.25, pz], castShadow: false });

        // Store exact world coordinate for stream foam / obstacle colliders
        const wPiling = frame.toWorldXZ(px, pz);
        this.bridgePilings.push({
          x: wPiling.x,
          z: wPiling.z,
          radius: pilingRadius,
        });
      }

      // Transverse cross-brace beam tying each piling pair together above water
      const braceY = Math.max(WATER_LEVEL + 0.45, topY - 0.65);
      this._addMesh(root, this._trackGeo(new THREE.BoxGeometry(0.14, 0.16, 2.42)), M.darkTimber, {
        pos: [px, braceY, 0],
      });
    }

    // --- E. Sturdy Side Posts, Curved Wooden Handrails & Draped Catenary Hemp Rope Cords ---
    const postCount = 9;
    const postXs = [];
    for (let i = 0; i < postCount; i++) {
      postXs.push(lerp(-halfLen + 0.18, halfLen - 0.18, i / (postCount - 1)));
    }

    const postGeo = this._trackGeo(new THREE.BoxGeometry(0.13, 1.18, 0.13));
    const capGeo = this._trackGeo(new THREE.BoxGeometry(0.17, 0.055, 0.17));

    for (const sz of [-1.24, 1.24]) {
      const railPts = [];

      for (let i = 0; i < postXs.length; i++) {
        const px = postXs[i];
        const py = bridgeDeckY(px);
        this._addMesh(root, postGeo, M.darkTimber, { pos: [px, py + 0.46, sz] });
        this._addMesh(root, capGeo, M.plank, { pos: [px, py + 1.07, sz] });
        railPts.push(new THREE.Vector3(px, py + 0.98, sz));
      }

      // Smooth curved top wooden handrail
      const railCurve = new THREE.CatmullRomCurve3(railPts);
      const railGeo = this._trackGeo(new THREE.TubeGeometry(railCurve, 34, 0.055, 7, false));
      this._addMesh(root, railGeo, M.plank, { name: sz < 0 ? 'BridgeHandrailN' : 'BridgeHandrailS' });

      // Draped catenary hemp rope cords (2 tiers between every adjacent pair of side posts)
      for (let i = 0; i < postXs.length - 1; i++) {
        const xA = postXs[i];
        const xB = postXs[i + 1];
        const yA = bridgeDeckY(xA);
        const yB = bridgeDeckY(xB);

        for (const [tierH, sag] of [[0.64, 0.16], [0.32, 0.12]]) {
          const ropePts = [];
          const segs = 6;
          for (let s = 0; s <= segs; s++) {
            const t = s / segs;
            const rx = lerp(xA, xB, t);
            const catenary = 4.0 * t * (1.0 - t) * sag;
            const ry = lerp(yA + tierH, yB + tierH, t) - catenary;
            ropePts.push(new THREE.Vector3(rx, ry, sz));
          }
          const ropeCurve = new THREE.CatmullRomCurve3(ropePts);
          const ropeGeo = this._trackGeo(new THREE.TubeGeometry(ropeCurve, 8, 0.022, 5, false));
          this._addMesh(root, ropeGeo, M.hempRope, { castShadow: false });
        }
      }
    }

    // --- F. SurfaceSolver Registration (Curved Bridge Deck + Segmented Side Rail OBBs) ---
    frame.addLocalDeck(this.surfaceSolver, {
      id: 'wooden_footbridge_deck',
      lx: 0,
      lz: 0,
      halfW: halfLen + 0.16, // generous abutment overlap for silky seamless bank entry
      halfD: halfW + 0.04,
      heightFn: (lx) => bridgeDeckY(lx),
      normalFn: (lx, _lz, out) => {
        const slopeX = bridgeSlopeX(lx);
        // Local normal (-slopeX, 1, 0) rotated into world space
        const inv = 1.0 / Math.hypot(slopeX, 1.0);
        const nlx = -slopeX * inv;
        const nly = inv;
        return out.set(nlx * frame.cosY, nly, -nlx * frame.sinY).normalize();
      },
      surfaceType: 'bridge',
    });

    // Split side railing wall OBBs into 4 longitudinal spans whose minY tracks deckY - 0.18
    // so crossing ON the bridge blocks falling off sides while wading UNDER the bridge stays unobstructed!
    const railSegs = 4;
    const segLen = (halfLen * 2.0) / railSegs;
    for (let s = 0; s < railSegs; s++) {
      const segStart = -halfLen + s * segLen;
      const segEnd = segStart + segLen;
      const segMid = (segStart + segEnd) * 0.5;
      const segMinDeck = Math.min(bridgeDeckY(segStart), bridgeDeckY(segMid), bridgeDeckY(segEnd));
      const segMaxDeck = Math.max(bridgeDeckY(segStart), bridgeDeckY(segMid), bridgeDeckY(segEnd));

      for (const side of [-1, 1]) {
        frame.addLocalWallOBB(this.surfaceSolver, {
          id: `bridge_rail_${side < 0 ? 'n' : 's'}_${s}`,
          lx: segMid,
          lz: side * 1.28,
          halfW: segLen * 0.5 + 0.04,
          halfD: 0.12,
          minY: segMinDeck - 0.15,
          maxY: segMaxDeck + 1.35,
        });
      }
    }

    // Exclusion zones spanning the bridge & both bank landings
    for (const ex of [-8.4, -4.2, 0, 4.2, 8.4]) {
      const wEx = frame.toWorldXZ(ex, 0);
      this.exclusionZones.push({ x: wEx.x, z: wEx.z, radius: 3.1 });
    }

    // Waypoint at center crown of arched footbridge facing east toward the clearing & cabin
    const bridgeMidY = bridgeDeckY(0);
    const eastDirYaw = Math.atan2(frame.cosY, -frame.sinY);
    this.waypoints.bridgeCenter = makeWaypoint(
      frame.toWorldVec3(0, bridgeMidY, 0),
      eastDirYaw,
      'Arched Wooden Footbridge'
    );
  }

  // ===========================================================================
  // Per-Frame Atmospheric Animation (Lantern, Dusk Glow, Sunbeams, Crystals)
  // ===========================================================================

  update(dt, elapsed, { nightFactor = 0, daylight = 1 } = {}) {
    const t = Number.isFinite(elapsed) ? elapsed : 0;
    const night = clamp(Number.isFinite(nightFactor) ? nightFactor : 0, 0, 1);
    const day = clamp(Number.isFinite(daylight) ? daylight : 1, 0, 1);

    // 1. Cabin oil lantern organic flicker + hearth ember breath
    const flicker =
      1.0 +
      Math.sin(t * 9.7) * 0.065 +
      Math.sin(t * 17.3 + 1.4) * 0.045 +
      Math.sin(t * 29.1 + 0.7) * 0.025;

    if (this._anim.lanternLight) {
      const baseLantern = lerp(3.4, 6.2, night);
      this._anim.lanternLight.intensity = baseLantern * flicker;
    }
    if (this._anim.lanternFlame) {
      this._anim.lanternFlame.scale.set(
        0.94 + (flicker - 1.0) * 0.8,
        0.92 + (flicker - 1.0) * 1.4,
        0.94 + (flicker - 1.0) * 0.8
      );
    }
    for (let i = 0; i < this._anim.lanternHalos.length; i++) {
      const halo = this._anim.lanternHalos[i];
      halo.material.opacity = lerp(0.34, 0.62, night) * flicker;
      const hs = 0.96 + (flicker - 1.0) * 0.65;
      halo.scale.set(hs, hs, 1);
    }
    if (this._anim.hearthEmberMat) {
      this._anim.hearthEmberMat.emissiveIntensity =
        lerp(1.15, 2.2, night) * (0.92 + 0.08 * Math.sin(t * 3.8 + 0.5));
    }

    // 2. Cabin exterior golden window & doorway glow spill (dramatic cozy beacon at dusk/night)
    const windowGlowOpacity = lerp(0.05, 0.34, Math.pow(night, 0.78)) * (0.96 + 0.04 * flicker);
    for (let i = 0; i < this._anim.windowGlowMats.length; i++) {
      this._anim.windowGlowMats[i].opacity = windowGlowOpacity;
    }

    // 3. Hollow Redwood dappled sunbeams (driven by daylight) & bioluminescent mushrooms
    const beamOpacity = smoothstep(0.08, 0.75, day) * 0.25;
    for (let i = 0; i < this._anim.redwoodSunbeams.length; i++) {
      const mat = this._anim.redwoodSunbeams[i];
      mat.uniforms.uTime.value = t;
      mat.uniforms.uOpacity.value = beamOpacity;
    }
    const mushPulse = 0.88 + 0.12 * Math.sin(t * 2.1);
    const redwoodMushEmissive = lerp(0.95, 2.2, night) * mushPulse;
    for (let i = 0; i < this._anim.redwoodMushroomMats.length; i++) {
      this._anim.redwoodMushroomMats[i].emissiveIntensity = redwoodMushEmissive;
    }
    if (this._anim.redwoodGlowLight) {
      this._anim.redwoodGlowLight.intensity = lerp(0.85, 2.2, night) * mushPulse;
    }

    // 4. Mossy Stone Cavern crystal & mushroom shimmer + interior lights
    const crystalBoost = lerp(1.0, 1.38, night);
    for (let i = 0; i < this._anim.cavernCrystalMats.length; i++) {
      const shimmer = 0.9 + 0.1 * Math.sin(t * 2.4 + i * 1.9);
      this._anim.cavernCrystalMats[i].emissiveIntensity = 2.0 * crystalBoost * shimmer;
    }
    for (let i = 0; i < this._anim.cavernMushroomMats.length; i++) {
      const shimmer = 0.88 + 0.12 * Math.sin(t * 1.9 + i * 2.3);
      this._anim.cavernMushroomMats[i].emissiveIntensity = 1.55 * crystalBoost * shimmer;
    }
    for (let i = 0; i < this._anim.cavernLights.length; i++) {
      const item = this._anim.cavernLights[i];
      const shimmer = 0.93 + 0.07 * Math.sin(t * 2.1 + item.phase);
      item.light.intensity = item.baseIntensity * lerp(0.92, 1.25, night) * shimmer;
    }
  }

  // ===========================================================================
  // Clean GPU Resource Disposal
  // ===========================================================================

  dispose() {
    if (this.scene && this.group.parent === this.scene) {
      this.scene.remove(this.group);
    }
    for (let i = 0; i < this._geometries.length; i++) {
      this._geometries[i].dispose();
    }
    for (let i = 0; i < this._materials.length; i++) {
      this._materials[i].dispose();
    }
    for (let i = 0; i < this._textures.length; i++) {
      this._textures[i].dispose();
    }
    this._geometries.length = 0;
    this._materials.length = 0;
    this._textures.length = 0;
  }
}
