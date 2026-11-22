import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { createRng, clamp, lerp, smoothstep } from '../utils/random.js';

/**
 * Procedural articulated human explorer character rig built 100% from sculpted
 * Three.js geometries, procedural canvas PBR maps (diffuse, Sobel normal, roughness),
 * a real THREE.Skeleton / THREE.Bone hierarchy, and custom Three.js r187 shaders
 * (skin subsurface rim + sweat sheen + flush, height-blended leg wetness, rain wetness).
 *
 * Local coordinate conventions:
 *   +Z = forward, +Y = up, +X = character's LEFT
 *   Standing bind pose: boot soles at y = 0.0, hips at y = 0.94, head crown at ~1.78
 */
export class HumanMeshBuilder {
  constructor(options = {}) {
    this._seed = options.seed ?? 7319;
    this._geometries = [];
    this._materials = [];
    this._textures = [];

    this.root = new THREE.Group();
    this.root.name = 'HumanExplorerRig';

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

    // Shared reactive shader uniforms across skin, clothing, boots, and backpack
    this.shaderUniforms = {
      uSweatLevel: { value: 0.0 },
      uLegWetness: { value: 0.0 },
      uRainWetness: { value: 0.0 },
      uFaceFlush: { value: 0.0 },
    };

    this.headMeshes = [];
    this.bones = {};
    this._boneList = [];

    this._buildMaterials();
    this._buildSkeletonHierarchy();
    this._buildSculptedBodyAndGear();
    this._buildContactShadows();

    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this._boneList);
    this.skeleton.calculateInverses();

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
  // Resource tracking helpers
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

  /**
   * Adds a per-vertex `aLegHeight` attribute representing approximate bind-pose height
   * above the boot sole (0.0 at sole bottom -> ~1.78 at crown) so dynamic creek/mud
   * wetness creeps smoothly from boots up the lower pant cuffs at any terrain elevation.
   */
  _tagCharHeight(geo, baseHeightY, scaleY = 1.0) {
    const pos = geo.attributes.position;
    const heights = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      heights[i] = Math.max(0.0, baseHeightY + pos.getY(i) * scaleY);
    }
    geo.setAttribute('aLegHeight', new THREE.BufferAttribute(heights, 1));
    return geo;
  }

  /**
   * Adds a per-vertex `aSweatMask` attribute controlling where sweat sheen and face flush
   * concentrate most visibly (brow, temples, cheeks, bridge of nose, neck).
   */
  _tagSweatMask(geo, maskFn) {
    const pos = geo.attributes.position;
    const mask = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      mask[i] = clamp(maskFn(pos.getX(i), pos.getY(i), pos.getZ(i)), 0.0, 1.0);
    }
    geo.setAttribute('aSweatMask', new THREE.BufferAttribute(mask, 1));
    return geo;
  }

  _makeMesh(geo, mat, { name = '', castShadow = true, receiveShadow = true, isHead = false } = {}) {
    if (!geo.attributes.aLegHeight) {
      this._tagCharHeight(geo, 1.2, 1.0);
    }
    if (!geo.attributes.aSweatMask) {
      this._tagSweatMask(geo, () => 0.35);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    if (isHead) {
      this.headMeshes.push(mesh);
    }
    return mesh;
  }

  // ---------------------------------------------------------------------------
  // Procedural sculpted organic geometry builder
  // ---------------------------------------------------------------------------

  /**
   * Builds a closed or open organic lofted tube from anatomically profiled cross-section rings.
   * Each ring: { y, rx, rz, ox = 0, oz = 0, frontScale = 1, backScale = 1, squareness = 0 }
   */
  _createSculptedLoft(rings, radialSegments = 18, options = {}) {
    const { capBottom = true, capTop = true, uvRepeatU = 1, uvRepeatV = 1 } = options;
    const ringCount = rings.length;
    const cols = radialSegments + 1;

    const positions = [];
    const uvs = [];
    const indices = [];

    // Estimate arc-length along V for uniform texture mapping
    const vCoords = new Float32Array(ringCount);
    let totalLen = 0;
    for (let r = 1; r < ringCount; r++) {
      const dy = rings[r].y - rings[r - 1].y;
      const dr = ((rings[r].rx - rings[r - 1].rx) + (rings[r].rz - rings[r - 1].rz)) * 0.5;
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

      for (let c = 0; c <= radialSegments; c++) {
        const uFrac = c / radialSegments;
        const theta = uFrac * Math.PI * 2;
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);

        // Optional slight superellipse shaping for structured garments / boots / torso
        let sx = sinT;
        let sz = cosT;
        if (sq > 0) {
          const p = 1.0 - sq * 0.35;
          sx = Math.sign(sinT) * Math.pow(Math.abs(sinT), p);
          sz = Math.sign(cosT) * Math.pow(Math.abs(cosT), p);
        }

        const zMult = sz >= 0 ? frontScale : backScale;
        const x = ox + sx * ring.rx;
        const z = oz + sz * ring.rz * zMult;

        positions.push(x, ring.y, z);
        uvs.push(uFrac * uvRepeatU, v);
      }
    }

    for (let r = 0; r < ringCount - 1; r++) {
      const rowA = r * cols;
      const rowB = (r + 1) * cols;
      for (let c = 0; c < radialSegments; c++) {
        const a = rowA + c;
        const b = rowA + c + 1;
        const d = rowB + c;
        const e = rowB + c + 1;
        // Outward CCW winding when rings ascend in +Y
        if (rings[ringCount - 1].y >= rings[0].y) {
          indices.push(a, b, e, a, e, d);
        } else {
          indices.push(a, e, b, a, d, e);
        }
      }
    }

    const ascending = rings[ringCount - 1].y >= rings[0].y;

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
   * Builds a thickened open-front C-shell (for open waxed-canvas field jacket panels)
   * sweeping cleanly from +gapHalfAngle around the left side, back, and right side
   * to 2*PI - gapHalfAngle, leaving the front center (+Z) cleanly open to reveal the
   * plaid flannel shirt & leather belt underneath.
   */
  _createOpenSculptedShell(rings, radialSegments = 20, options = {}) {
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
      const dr = ((rings[r].rx - rings[r - 1].rx) + (rings[r].rz - rings[r - 1].rz)) * 0.5;
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

    const thetaStart = gapHalfAngle;
    const thetaSpan = Math.PI * 2 - gapHalfAngle * 2;
    const ascending = rings[ringCount - 1].y >= rings[0].y;

    // 1. Outer wall vertices (0 .. ringCount * cols - 1)
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

    // 2. Inner wall vertices (ringCount * cols .. 2 * ringCount * cols - 1)
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

    // Outer & inner faces
    for (let r = 0; r < ringCount - 1; r++) {
      const rowA = r * cols;
      const rowB = (r + 1) * cols;
      const iRowA = innerBase + rowA;
      const iRowB = innerBase + rowB;
      for (let c = 0; c < radialSegments; c++) {
        // Outer wall (CCW outward)
        const a = rowA + c;
        const b = rowA + c + 1;
        const d = rowB + c;
        const e = rowB + c + 1;
        if (ascending) {
          indices.push(a, b, e, a, e, d);
        } else {
          indices.push(a, e, b, a, d, e);
        }
        // Inner wall (reversed winding, facing inward)
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

    // 3. Left & Right open front edge thickness strips (c = 0 and c = radialSegments)
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

    // c = 0 is +gapHalfAngle (character's left front edge); c = radialSegments is right front edge
    addEdgeStrip(0, true);
    addEdgeStrip(radialSegments, false);

    // 4. Bottom & Top thickness rim caps so jacket hem & neckline show solid canvas edge
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

    // Silence unused-variable lint while keeping signature clear
    void thetaStart;
    void thetaSpan;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return this._trackGeo(geo);
  }

  // ---------------------------------------------------------------------------
  // Procedural Canvas PBR Texture + Sobel Normal Map Generator
  // ---------------------------------------------------------------------------

  _bufferToTexture(data, size, { isSRGB = false, repeatX = 1, repeatY = 1 } = {}) {
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

    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
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

    // Periodic tileable 2D noise blend
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
          // Olive / forest-slate waxed canvas weave + cloth creases
          const warp = Math.sin(u * size * Math.PI * 0.65) * 0.5 + 0.5;
          const weft = Math.sin(v * size * Math.PI * 0.65) * 0.5 + 0.5;
          const weave = ((x + y) & 1) ? warp * 0.65 + weft * 0.35 : weft * 0.65 + warp * 0.35;
          const crease = Math.sin((u * 3.0 + v * 2.0 + nf * 1.1) * Math.PI * 2) * 0.5 + 0.5;
          const wax = clamp(nf * 0.55 + crease * 0.25 + weave * 0.2, 0, 1);

          r = lerp(52, 82, wax) + (fine - 0.5) * 8;
          g = lerp(66, 98, wax) + (fine - 0.5) * 8;
          b = lerp(52, 76, wax) + (fine - 0.5) * 6;
          rough = lerp(0.86, 0.58, wax);
          h = weave * 0.45 + crease * 0.35 + nf * 0.2;
        } else if (type === 'pants') {
          // Khaki-charcoal diagonal twill canvas
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
          // Full-grain warm chestnut brown leather with natural pebble grain & creases
          const pebble = tileNoise(u, v, 28.0, n1) * 0.5 + 0.5;
          const crease = 1.0 - Math.abs(tileNoise(u, v, 7.0, n2));
          const grain = clamp(pebble * 0.5 + nf * 0.3 + crease * 0.2, 0, 1);

          r = lerp(68, 128, grain);
          g = lerp(40, 78, grain);
          b = lerp(24, 48, grain);
          rough = lerp(0.68, 0.36, grain);
          h = pebble * 0.48 + crease * 0.32 + nf * 0.2;
        } else if (type === 'pack') {
          // Rugged weathered tan-olive duck canvas
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
          // Warm outdoor explorer complexion with subtle micro-pore variation
          const pore = tileNoise(u, v, 34.0, n2) * 0.5 + 0.5;
          const warmth = clamp(nf * 0.65 + fine * 0.2 + pore * 0.15, 0, 1);

          r = lerp(196, 228, warmth);
          g = lerp(146, 178, warmth);
          b = lerp(118, 146, warmth);
          rough = lerp(0.62, 0.44, warmth);
          h = pore * 0.55 + fine * 0.25 + nf * 0.2;
        } else if (type === 'blanket') {
          // Rustic ochre / forest-burgundy striped wool camp blanket
          const stripeA = Math.abs(Math.sin(v * Math.PI * 6));
          const stripeB = smoothstep(0.75, 0.92, Math.sin(v * Math.PI * 3) * 0.5 + 0.5);
          const fuzz = fine * 0.6 + nf * 0.4;
          r = lerp(128, 172, stripeA) * (1 - stripeB * 0.25) + (fuzz - 0.5) * 18;
          g = lerp(64, 118, stripeA) * (1 - stripeB * 0.42) + (fuzz - 0.5) * 14;
          b = lerp(42, 62, stripeA) * (1 - stripeB * 0.2) + (fuzz - 0.5) * 10;
          rough = lerp(0.96, 0.85, fuzz);
          h = fuzz * 0.7 + stripeA * 0.3;
        } else if (type === 'hair') {
          // Layered tousled chestnut hair strands
          const strand = Math.sin((u * 48 + nf * 2.4) * Math.PI) * 0.5 + 0.5;
          const sheen = clamp(strand * 0.62 + nf * 0.28 + fine * 0.1, 0, 1);
          r = lerp(54, 112, sheen);
          g = lerp(34, 72, sheen);
          b = lerp(22, 46, sheen);
          rough = lerp(0.76, 0.42, strand);
          h = strand * 0.75 + nf * 0.25;
        } else if (type === 'flannel') {
          // Rich crimson-navy/forest plaid flannel tartan weave with brushed wool micro-fuzz
          const pu = (u * 3.0) % 1.0;
          const pv = (v * 3.0) % 1.0;
          const weave = (((x + y) & 1) ? 0.58 : 0.42) + (fine - 0.5) * 0.16;

          const inNavyU = pu < 0.24 || pu > 0.88;
          const inNavyV = pv < 0.24 || pv > 0.88;
          const inForestU = pu >= 0.46 && pu <= 0.66;
          const inForestV = pv >= 0.46 && pv <= 0.66;
          const inCreamU = Math.abs(pu - 0.35) < 0.022 || Math.abs(pu - 0.77) < 0.018;
          const inCreamV = Math.abs(pv - 0.35) < 0.022 || Math.abs(pv - 0.77) < 0.018;

          // Base deep crimson wool flannel
          let cr = 136;
          let cg = 30;
          let cb = 34;

          // Intersecting navy & forest tartan bands (classic Pacific Northwest woodsman plaid)
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

          // Fine warm cream/gold tartan overcheck pinstripes
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
      type === 'leather'
        ? 1.85
        : type === 'skin'
          ? 0.42
          : type === 'hair'
            ? 1.65
            : type === 'flannel'
              ? 1.15
              : 1.35;
    const normBuf = this._buildSobelNormalBuffer(heightBuf, size, normStrength);

    return {
      map: this._bufferToTexture(diffBuf, size, { isSRGB: true, repeatX, repeatY }),
      normalMap: this._bufferToTexture(normBuf, size, { isSRGB: false, repeatX, repeatY }),
      roughnessMap: this._bufferToTexture(roughBuf, size, { isSRGB: false, repeatX, repeatY }),
    };
  }

  /**
   * High-detail procedural eyeball texture (UV sphere rotated so iris centers on +Z pole).
   */
  _generateEyeTexture(size = 128) {
    const rng = createRng(this._seed + 888);
    const noise = createNoise2D(rng);
    const buf = new Uint8Array(size * size * 4);

    // SphereGeometry UV: v = 1 at +Y pole, v = 0 at -Y pole.
    // We rotate eye sphere +PI/2 around X so the +Y pole points directly +Z (forward)!
    // Thus v near 1.0 is center of pupil/iris.
    for (let y = 0; y < size; y++) {
      const v = 1.0 - y / (size - 1); // 1 at top (+Y -> +Z pole), 0 at bottom
      const polarAngle = (1.0 - v) * Math.PI; // 0 at center of pupil
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const ang = u * Math.PI * 2;
        const idx = (y * size + x) * 4;

        let r = 238;
        let g = 234;
        let b = 228;

        // Subtle warm sclera shading further back on globe
        const backTint = smoothstep(0.45, 1.35, polarAngle);
        r = lerp(r, 206, backTint);
        g = lerp(g, 184, backTint);
        b = lerp(b, 178, backTint);

        // Limbal ring & hazel-blue iris (polarAngle < 0.44 rad)
        if (polarAngle < 0.47) {
          const irisT = clamp(polarAngle / 0.43, 0, 1);
          const fiber = noise(Math.cos(ang) * 9.5, Math.sin(ang) * 9.5) * 0.5 + 0.5;
          const radialStreak = Math.sin(ang * 24.0 + fiber * 3.5) * 0.5 + 0.5;
          const ring = noise(Math.cos(ang) * 3.2 + irisT * 4.2, Math.sin(ang) * 3.2) * 0.5 + 0.5;

          // Warm amber-hazel inner ring fading to vivid forest-slate blue outer iris
          const ir = lerp(144, 52, smoothstep(0.26, 0.78, irisT)) + (fiber - 0.5) * 36 + (radialStreak - 0.5) * 14;
          const ig = lerp(118, 114, smoothstep(0.24, 0.85, irisT)) + (ring - 0.5) * 30 + (radialStreak - 0.5) * 12;
          const ib = lerp(64, 144, smoothstep(0.20, 0.76, irisT)) + (fiber - 0.5) * 34;

          // Crisp dark limbal outer edge
          const limbal = smoothstep(0.74, 0.98, irisT);
          const irisEdge = 1.0 - smoothstep(0.92, 1.04, polarAngle / 0.44);

          const fr = lerp(ir, 20, limbal * 0.82);
          const fg = lerp(ig, 34, limbal * 0.82);
          const fb = lerp(ib, 44, limbal * 0.82);

          r = lerp(r, fr, irisEdge);
          g = lerp(g, fg, irisEdge);
          b = lerp(b, fb, irisEdge);

          // Crisp deep pupil
          const pupil = 1.0 - smoothstep(0.15, 0.188, polarAngle);
          r = lerp(r, 8, pupil);
          g = lerp(g, 9, pupil);
          b = lerp(b, 12, pupil);

          // Baked subtle corneal sky-catchlight glint on upper-left & micro fill glint lower-right
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

  // ---------------------------------------------------------------------------
  // Custom Three.js r187 onBeforeCompile Shader Injections
  // ---------------------------------------------------------------------------

  _applySkinShader(material) {
    const uniforms = this.shaderUniforms;
    material.customProgramCacheKey = () => 'humanSkinSSS_Sweat_v2';
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
        // Warm rosy flush on cheeks, nose bridge, and brow during sprinting or panic
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
          // Warm subsurface-scattering rim glow modulated by incoming light so night remains natural
          float ndotv = saturate( dot( geometryNormal, geometryViewDir ) );
          float rimSSS = pow( 1.0 - ndotv, 2.35 );
          vec3 lightEnergy = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
          float lum = clamp( dot( lightEnergy, vec3( 0.299, 0.587, 0.114 ) ), 0.0, 1.6 );
          vec3 sssTint = vec3( 0.52, 0.17, 0.085 );
          reflectedLight.indirectDiffuse += sssTint * rimSSS * ( 0.18 + lum * 0.45 );

          // Crisp sweat / rain specular bead sheen on brow and cheeks (seamless 3D local coords)
          float sheenAmt = clamp( max( uSweatLevel * vSweatMask, uRainWetness * 0.55 ), 0.0, 1.0 );
          float bead = 0.75 + 0.25 * sin( vSkinLocalPos.x * 420.0 + vSkinLocalPos.z * 310.0 ) * cos( vSkinLocalPos.y * 420.0 );
          float fresnel = pow( 1.0 - ndotv, 3.2 );
          reflectedLight.indirectSpecular += vec3( 0.14, 0.135, 0.13 ) * fresnel * sheenAmt * bead * ( 0.25 + lum * 0.75 );
        }`
      );
    };
  }

  /**
   * Injects dynamic creek/puddle height-blended leg wetness (`uLegWetness`) and
   * directional rain-darkened wetness (`uRainWetness`) on clothing, boots, and gear.
   */
  _applyWetnessShader(material, { useLegHeight = true, rainWeight = 1.0, darken = 0.52, wetRoughness = 0.16, keyTag = 'cloth' } = {}) {
    const uniforms = this.shaderUniforms;
    const rwStr = rainWeight.toFixed(3);
    const dkStr = darken.toFixed(3);
    const wrStr = wetRoughness.toFixed(3);

    material.customProgramCacheKey = () => `humanWetness_v2_${keyTag}_${useLegHeight ? 1 : 0}_${rwStr}`;
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

  _buildMaterials() {
    const jacketTex = this._generatePBRTextureSet('jacket', 128, 11, 2.2, 2.2);
    const pantsTex = this._generatePBRTextureSet('pants', 128, 22, 2.4, 2.8);
    const leatherTex = this._generatePBRTextureSet('leather', 128, 33, 1.8, 1.8);
    const packTex = this._generatePBRTextureSet('pack', 128, 44, 2.0, 2.0);
    const skinTex = this._generatePBRTextureSet('skin', 128, 55, 1.6, 1.6);
    const blanketTex = this._generatePBRTextureSet('blanket', 128, 66, 2.0, 1.4);
    const hairTex = this._generatePBRTextureSet('hair', 128, 77, 2.0, 1.6);
    const flannelTex = this._generatePBRTextureSet('flannel', 128, 88, 1.8, 1.8);
    const eyeMap = this._generateEyeTexture(128);

    this.mats = {};

    // Skin with SSS rim + sweat + flush
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

    // Subtle lip & inner mouth materials
    this.mats.lips = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xbd7164,
        roughness: 0.38,
        metalness: 0.0,
      })
    );
    this._applySkinShader(this.mats.lips);

    this.mats.mouthCrease = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x6f3932,
        roughness: 0.72,
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

    // Expressive ultra-glossy eyes + crisp specular catchlight highlights
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

    // Chestnut hair & eyebrows
    this.mats.hair = this._trackMat(
      new THREE.MeshStandardMaterial({
        map: hairTex.map,
        normalMap: hairTex.normalMap,
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughnessMap: hairTex.roughnessMap,
        roughness: 0.82,
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
        color: 0x241710,
        roughness: 0.72,
        metalness: 0.0,
      })
    );

    // Waxed olive/forest-slate explorer field jacket
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

    // Darker olive-slate jacket trim (collar lining, lapels, pocket flaps, rolled cuffs)
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

    // Subtle tan contrast topstitching along jacket lapels & flap pockets
    this.mats.stitching = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x9b865c,
        roughness: 0.85,
        metalness: 0.0,
      })
    );

    // Textured procedural crimson-navy/forest plaid flannel shirt visible through open jacket front
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

    // Preserve this.mats.shirt reference pointing to the plaid flannel shirt
    this.mats.shirt = this.mats.flannel;

    // Khaki-charcoal twill cargo pants (with height-blended leg wetness!)
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

    // Reinforced dark khaki knee/pocket panels
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

    // Full-grain brown leather (boots, backpack straps, belt)
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

    // Darker leather trim (boot padded collar, waist belt, straps)
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

    // Chunky dark rubber lugged boot soles
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

    // Boot laces
    this.mats.laces = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xb89662,
        roughness: 0.86,
        metalness: 0.0,
      })
    );

    // Weathered canvas backpack
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

    // Rolled wool blanket
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

    // Polished antique brass (belt buckle, jacket buttons, eyelets, pack buckles)
    this.mats.brass = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xd4ad5a,
        roughness: 0.22,
        metalness: 0.9,
      })
    );

    // Brushed aluminum canteen
    this.mats.aluminum = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xcbd2d8,
        roughness: 0.28,
        metalness: 0.88,
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Real THREE.Bone + THREE.Skeleton Hierarchy
  // ---------------------------------------------------------------------------

  _addBone(name, parent, x, y, z) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    parent.add(bone);
    this.bones[name] = bone;
    this._boneList.push(bone);
    return bone;
  }

  _buildSkeletonHierarchy() {
    // Core torso chain
    const hips = this._addBone('hips', this.root, 0, 0.94, 0);
    const spine1 = this._addBone('spine1', hips, 0, 0.11, 0);
    const spine2 = this._addBone('spine2', spine1, 0, 0.14, 0);
    const chest = this._addBone('chest', spine2, 0, 0.16, 0);

    // Secondary physics pivots
    const backpack = this._addBone('backpack', chest, 0, 0.04, -0.17);
    this._addBone('canteen', backpack, -0.17, -0.14, -0.02);
    this._addBone('jacketHem', spine1, 0, -0.26, 0);

    // Neck & expressive head hierarchy
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

    // Swaying front/crown hair locks spring bone (added to headMeshes for First-Person Body-Cam)
    const hairLocks = this._addBone('hairLocks', head, 0, 0.135, 0.038);
    this.headMeshes.push(hairLocks);

    // Left & Right arm chains (+X = Left, -X = Right) with 5-finger articulated hands
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const clav = this._addBone(`clavicle${side}`, chest, s * 0.06, 0.13, 0);
      const upperArm = this._addBone(`upperArm${side}`, clav, s * 0.135, -0.01, 0);
      const forearm = this._addBone(`forearm${side}`, upperArm, 0, -0.28, 0);
      const wrist = this._addBone(`wrist${side}`, forearm, 0, -0.25, 0);
      const hand = this._addBone(`hand${side}`, wrist, 0, -0.01, 0);

      // Articulated 2-segment thumb mounted on forward inner palm edge
      const thumb = this._addBone(`thumb${side}`, hand, -s * 0.008, -0.028, 0.032);
      this._addBone(`thumbTip${side}`, thumb, 0, -0.033, 0.002);

      // 4 distinct articulated fingers mounted under fingersL/R
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

    // Left & Right leg chains (+X = Left, -X = Right)
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const thigh = this._addBone(`thigh${side}`, hips, s * 0.105, -0.02, 0);
      // Use ZXY rotation order on thighs so analytical 2-bone IK roll + pitch is exact
      thigh.rotation.order = 'ZXY';
      const shin = this._addBone(`shin${side}`, thigh, 0, -0.44, 0);
      const ankle = this._addBone(`ankle${side}`, shin, 0, -0.42, 0);
      this._addBone(`toe${side}`, ankle, 0, -0.045, 0.115);
    }
  }

  // ---------------------------------------------------------------------------
  // Sculpted Anatomy & Layered Explorer Gear Construction
  // ---------------------------------------------------------------------------

  _buildSculptedBodyAndGear() {
    this._buildTorsoAndJacket();
    this._buildHeadAndFace();
    this._buildArmsAndHands();
    this._buildLegsAndBoots();
    this._buildBackpackAndCanteen();
  }

  _buildTorsoAndJacket() {
    const { hips, spine1, spine2, chest, jacketHem, neck } = this.bones;

    // 1. Pelvis / hips base (pleated cargo pants waist, fly seam, belt loops, sculpted leather belt & brass buckle)
    const pelvisGeo = this._createSculptedLoft(
      [
        { y: -0.095, rx: 0.145, rz: 0.108, backScale: 1.12 },
        { y: -0.04, rx: 0.168, rz: 0.118, backScale: 1.15, squareness: 0.25 },
        { y: 0.03, rx: 0.164, rz: 0.114, backScale: 1.08, squareness: 0.25 },
        { y: 0.085, rx: 0.154, rz: 0.108, squareness: 0.2 },
      ],
      20
    );
    this._tagCharHeight(pelvisGeo, 0.94, 1.0);
    hips.add(this._makeMesh(pelvisGeo, this.mats.pants, { name: 'PelvisPants' }));

    // Sculpted front cargo pant pleats & fly seam clearly visible beneath open jacket waist
    const pleatGeo = this._trackGeo(new THREE.BoxGeometry(0.011, 0.088, 0.012));
    this._tagCharHeight(pleatGeo, 0.92, 1.0);
    for (const s of [1, -1]) {
      const outerPleat = this._makeMesh(pleatGeo, this.mats.pantsReinforced, {
        name: s > 0 ? 'PantsPleatOuterL' : 'PantsPleatOuterR',
      });
      outerPleat.position.set(s * 0.056, -0.016, 0.109);
      outerPleat.rotation.y = s * 0.24;
      outerPleat.rotation.z = s * -0.04;
      hips.add(outerPleat);

      const innerPleat = this._makeMesh(pleatGeo, this.mats.pants, {
        name: s > 0 ? 'PantsPleatInnerL' : 'PantsPleatInnerR',
      });
      innerPleat.position.set(s * 0.034, -0.015, 0.113);
      innerPleat.rotation.y = s * 0.12;
      hips.add(innerPleat);
    }

    const flyGeo = this._trackGeo(new THREE.BoxGeometry(0.014, 0.095, 0.009));
    this._tagCharHeight(flyGeo, 0.91, 1.0);
    const flySeam = this._makeMesh(flyGeo, this.mats.pantsReinforced, { name: 'PantsFlySeam' });
    flySeam.position.set(0.004, -0.02, 0.116);
    hips.add(flySeam);

    // Sculpted dark leather utility belt & polished brass frame buckle
    const beltGeo = this._createSculptedLoft(
      [
        { y: 0.035, rx: 0.165, rz: 0.117, squareness: 0.24 },
        { y: 0.075, rx: 0.164, rz: 0.116, squareness: 0.24 },
      ],
      22,
      { capBottom: false, capTop: false }
    );
    this._tagCharHeight(beltGeo, 0.94, 1.0);
    hips.add(this._makeMesh(beltGeo, this.mats.darkLeather, { name: 'UtilityBelt' }));

    // Cargo pant belt loops anchoring the leather belt cleanly
    const beltLoopGeo = this._trackGeo(new THREE.BoxGeometry(0.011, 0.046, 0.01));
    this._tagCharHeight(beltLoopGeo, 0.99, 1.0);
    for (const ang of [-0.42, 0.42, 1.48, -1.48, Math.PI]) {
      const loop = this._makeMesh(beltLoopGeo, this.mats.pantsReinforced, { name: 'PantsBeltLoop' });
      loop.position.set(Math.sin(ang) * 0.165, 0.055, Math.cos(ang) * 0.118);
      loop.rotation.y = ang;
      hips.add(loop);
    }

    // Polished brass frame belt buckle (4-bar hollow rectangular frame + central tongue pin + leather keeper)
    const buckleGroup = new THREE.Group();
    buckleGroup.name = 'BeltBuckleGroup';
    buckleGroup.position.set(0, 0.055, 0.12);

    const frameBarHGeo = this._trackGeo(new THREE.BoxGeometry(0.056, 0.008, 0.012));
    const frameBarVGeo = this._trackGeo(new THREE.BoxGeometry(0.008, 0.044, 0.012));
    const topBar = this._makeMesh(frameBarHGeo, this.mats.brass, { name: 'BeltBuckleTop' });
    topBar.position.set(0, 0.018, 0);
    const botBar = this._makeMesh(frameBarHGeo, this.mats.brass, { name: 'BeltBuckleBottom' });
    botBar.position.set(0, -0.018, 0);
    const leftBar = this._makeMesh(frameBarVGeo, this.mats.brass, { name: 'BeltBuckleLeft' });
    leftBar.position.set(0.024, 0, 0);
    const rightBar = this._makeMesh(frameBarVGeo, this.mats.brass, { name: 'BeltBuckleRight' });
    rightBar.position.set(-0.024, 0, 0);

    const prongGeo = this._trackGeo(new THREE.CylinderGeometry(0.0024, 0.0024, 0.036, 8));
    prongGeo.rotateZ(Math.PI / 2);
    const prong = this._makeMesh(prongGeo, this.mats.brass, { name: 'BeltBuckleProng' });
    prong.position.set(0.003, 0, 0.004);

    const keeperGeo = this._trackGeo(new THREE.BoxGeometry(0.014, 0.046, 0.014));
    const keeper = this._makeMesh(keeperGeo, this.mats.darkLeather, { name: 'BeltLeatherKeeper' });
    keeper.position.set(-0.042, 0, -0.002);

    buckleGroup.add(topBar, botBar, leftBar, rightBar, prong, keeper);
    hips.add(buckleGroup);

    // 2. Inner Textured Crimson-Navy/Forest Plaid Flannel Shirt (spanning spine1 -> spine2 -> chest)
    const flannelLowerGeo = this._createSculptedLoft(
      [
        { y: -0.068, rx: 0.151, rz: 0.106, squareness: 0.24 },
        { y: 0.01, rx: 0.152, rz: 0.107, squareness: 0.24 },
        { y: 0.085, rx: 0.155, rz: 0.11, squareness: 0.24 },
        { y: 0.148, rx: 0.161, rz: 0.114, squareness: 0.25 },
      ],
      20,
      { uvRepeatU: 1.5, uvRepeatV: 0.9 }
    );
    this._tagCharHeight(flannelLowerGeo, 1.05, 1.0);
    spine1.add(this._makeMesh(flannelLowerGeo, this.mats.flannel, { name: 'FlannelLowerTorso' }));

    const flannelMidGeo = this._createSculptedLoft(
      [
        { y: -0.045, rx: 0.156, rz: 0.11, squareness: 0.25 },
        { y: 0.045, rx: 0.168, rz: 0.117, frontScale: 1.06, squareness: 0.27 },
        { y: 0.145, rx: 0.181, rz: 0.123, frontScale: 1.09, squareness: 0.28 },
        { y: 0.185, rx: 0.182, rz: 0.122, frontScale: 1.08, squareness: 0.28 },
      ],
      20,
      { uvRepeatU: 1.6, uvRepeatV: 1.0 }
    );
    this._tagCharHeight(flannelMidGeo, 1.19, 1.0);
    spine2.add(this._makeMesh(flannelMidGeo, this.mats.flannel, { name: 'FlannelMidTorso' }));

    const flannelChestGeo = this._createSculptedLoft(
      [
        { y: -0.042, rx: 0.178, rz: 0.119, frontScale: 1.08, squareness: 0.28 },
        { y: 0.045, rx: 0.188, rz: 0.123, frontScale: 1.1, squareness: 0.3 },
        { y: 0.125, rx: 0.178, rz: 0.112, frontScale: 1.04, squareness: 0.26 },
        { y: 0.165, rx: 0.116, rz: 0.086, squareness: 0.18 },
        { y: 0.182, rx: 0.064, rz: 0.066 },
      ],
      22,
      { uvRepeatU: 1.6, uvRepeatV: 1.0 }
    );
    this._tagCharHeight(flannelChestGeo, 1.35, 1.0);
    chest.add(this._makeMesh(flannelChestGeo, this.mats.flannel, { name: 'FlannelChest' }));

    // Center buttoned flannel shirt placket + horn buttons visible down open front
    const shirtPlacketGeo = this._trackGeo(new THREE.BoxGeometry(0.022, 0.27, 0.008));
    const shirtPlacket = this._makeMesh(shirtPlacketGeo, this.mats.flannel, { name: 'FlannelFrontPlacket' });
    shirtPlacket.position.set(0, -0.005, 0.132);
    shirtPlacket.rotation.x = -0.05;
    chest.add(shirtPlacket);

    const shirtBtnGeo = this._trackGeo(new THREE.CylinderGeometry(0.0042, 0.0042, 0.0045, 8));
    shirtBtnGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const sBtn = this._makeMesh(shirtBtnGeo, this.mats.darkLeather, {
        name: `FlannelButton_${i}`,
        castShadow: false,
      });
      sBtn.position.set(0, 0.105 - i * 0.068, 0.137 - i * 0.003);
      chest.add(sBtn);
    }

    // Folded plaid flannel shirt collar points framing the collarbone
    const shirtCollarPtGeo = this._trackGeo(new THREE.BoxGeometry(0.044, 0.036, 0.01));
    for (const s of [1, -1]) {
      const colPt = this._makeMesh(shirtCollarPtGeo, this.mats.flannel, {
        name: s > 0 ? 'FlannelCollarL' : 'FlannelCollarR',
      });
      colPt.position.set(s * 0.042, 0.162, 0.078);
      colPt.rotation.set(-0.22, s * 0.42, s * -0.28);
      chest.add(colPt);
    }

    // 3. Open-Front Weathered Olive Waxed Canvas Field Jacket (wrapping sides & back around flannel)
    const lowerJacketGeo = this._createOpenSculptedShell(
      [
        { y: -0.052, rx: 0.172, rz: 0.123, squareness: 0.28, gapHalfAngle: 0.56 },
        { y: 0.01, rx: 0.168, rz: 0.121, squareness: 0.28, gapHalfAngle: 0.52 },
        { y: 0.08, rx: 0.171, rz: 0.124, squareness: 0.28, gapHalfAngle: 0.49 },
        { y: 0.148, rx: 0.178, rz: 0.128, squareness: 0.28, gapHalfAngle: 0.47 },
      ],
      22,
      { thickness: 0.012, uvRepeatU: 1.4, uvRepeatV: 0.9 }
    );
    this._tagCharHeight(lowerJacketGeo, 1.05, 1.0);
    spine1.add(this._makeMesh(lowerJacketGeo, this.mats.jacket, { name: 'JacketLowerTorso' }));

    // Side/back waist cinch trim band on open jacket
    const cinchGeo = this._createOpenSculptedShell(
      [
        { y: -0.045, rx: 0.174, rz: 0.125, squareness: 0.28, gapHalfAngle: 0.56 },
        { y: -0.018, rx: 0.172, rz: 0.124, squareness: 0.28, gapHalfAngle: 0.54 },
      ],
      22,
      { thickness: 0.008, uvRepeatU: 1.4, uvRepeatV: 0.2 }
    );
    spine1.add(this._makeMesh(cinchGeo, this.mats.jacketTrim, { name: 'JacketWaistCinch' }));

    // Articulated open-front lower jacket hem flaps (child of jacketHem at spine1 y = -0.26)
    // Open across center front so belt, polished brass buckle & pleated cargo pants read clearly!
    const hemGeo = this._createOpenSculptedShell(
      [
        { y: -0.035, rx: 0.202, rz: 0.146, backScale: 1.08, squareness: 0.3, gapHalfAngle: 0.64 },
        { y: 0.06, rx: 0.19, rz: 0.136, backScale: 1.04, squareness: 0.28, gapHalfAngle: 0.60 },
        { y: 0.155, rx: 0.178, rz: 0.127, squareness: 0.28, gapHalfAngle: 0.57 },
        { y: 0.22, rx: 0.172, rz: 0.123, squareness: 0.26, gapHalfAngle: 0.55 },
      ],
      22,
      { thickness: 0.011, uvRepeatU: 1.5, uvRepeatV: 1.0 }
    );
    this._tagCharHeight(hemGeo, 0.79, 1.0);
    jacketHem.add(this._makeMesh(hemGeo, this.mats.jacket, { name: 'JacketHemSkirt' }));

    // Lower side cargo coat flap pockets with topstitching & brass snap on open jacketHem
    const btnGeo = this._trackGeo(new THREE.CylinderGeometry(0.0068, 0.0068, 0.007, 10));
    btnGeo.rotateX(Math.PI / 2);
    const lowPktGeo = this._trackGeo(new THREE.BoxGeometry(0.088, 0.092, 0.024));
    const lowFlapGeo = this._trackGeo(new THREE.BoxGeometry(0.092, 0.026, 0.028));
    const lowStitchGeo = this._trackGeo(new THREE.BoxGeometry(0.082, 0.004, 0.029));
    for (const s of [1, -1]) {
      const lpGrp = new THREE.Group();
      lpGrp.position.set(s * 0.146, 0.072, 0.086);
      lpGrp.rotation.y = s * 0.68;
      lpGrp.add(this._makeMesh(lowPktGeo, this.mats.jacket, { name: `JacketLowerPocket${s > 0 ? 'L' : 'R'}` }));
      const lFlap = this._makeMesh(lowFlapGeo, this.mats.jacketTrim, {
        name: `JacketLowerPocketFlap${s > 0 ? 'L' : 'R'}`,
      });
      lFlap.position.set(0, 0.036, 0.002);
      lpGrp.add(lFlap);
      const lStitch = this._makeMesh(lowStitchGeo, this.mats.stitching, {
        name: `JacketLowerPocketStitch${s > 0 ? 'L' : 'R'}`,
        castShadow: false,
      });
      lStitch.position.set(0, 0.027, 0.003);
      lpGrp.add(lStitch);
      const lSnap = this._makeMesh(btnGeo, this.mats.brass, {
        name: `JacketLowerPocketSnap${s > 0 ? 'L' : 'R'}`,
        castShadow: false,
      });
      lSnap.position.set(0, 0.035, 0.017);
      lpGrp.add(lSnap);
      jacketHem.add(lpGrp);
    }

    // 4. Mid torso open jacket shell (spine2)
    const midTorsoGeo = this._createOpenSculptedShell(
      [
        { y: -0.045, rx: 0.174, rz: 0.125, squareness: 0.28, gapHalfAngle: 0.48 },
        { y: 0.045, rx: 0.186, rz: 0.132, frontScale: 1.06, squareness: 0.3, gapHalfAngle: 0.46 },
        { y: 0.145, rx: 0.201, rz: 0.138, frontScale: 1.1, squareness: 0.32, gapHalfAngle: 0.45 },
        { y: 0.185, rx: 0.202, rz: 0.137, frontScale: 1.08, squareness: 0.3, gapHalfAngle: 0.45 },
      ],
      22,
      { thickness: 0.012, uvRepeatU: 1.5, uvRepeatV: 1.0 }
    );
    this._tagCharHeight(midTorsoGeo, 1.19, 1.0);
    spine2.add(this._makeMesh(midTorsoGeo, this.mats.jacket, { name: 'JacketMidTorso' }));

    // 5. Upper chest & shoulders open jacket shell (chest)
    const chestGeo = this._createOpenSculptedShell(
      [
        { y: -0.04, rx: 0.197, rz: 0.135, frontScale: 1.08, squareness: 0.32, gapHalfAngle: 0.45 },
        { y: 0.045, rx: 0.21, rz: 0.14, frontScale: 1.12, squareness: 0.35, gapHalfAngle: 0.44 },
        { y: 0.125, rx: 0.205, rz: 0.127, frontScale: 1.04, squareness: 0.32, gapHalfAngle: 0.48 },
        { y: 0.165, rx: 0.142, rz: 0.099, squareness: 0.2, gapHalfAngle: 0.56 },
        { y: 0.182, rx: 0.088, rz: 0.078, gapHalfAngle: 0.62 },
      ],
      24,
      { thickness: 0.012, uvRepeatU: 1.6, uvRepeatV: 1.0 }
    );
    this._tagCharHeight(chestGeo, 1.35, 1.0);
    chest.add(this._makeMesh(chestGeo, this.mats.jacket, { name: 'JacketChest' }));

    // Sculpted left/right open jacket front plackets, folded lapels, brass buttons & stitched tabs
    const edgePlacketGeo = this._trackGeo(new THREE.BoxGeometry(0.026, 0.295, 0.016));
    const lapelGeo = this._trackGeo(new THREE.BoxGeometry(0.048, 0.112, 0.013));
    const lapelStitchGeo = this._trackGeo(new THREE.BoxGeometry(0.004, 0.104, 0.015));
    const tabGeo = this._trackGeo(new THREE.BoxGeometry(0.016, 0.0055, 0.006));

    for (const s of [1, -1]) {
      // Stitched vertical jacket front edge facing strip
      const edgePlacket = this._makeMesh(edgePlacketGeo, this.mats.jacketTrim, {
        name: s > 0 ? 'JacketFrontEdgeL' : 'JacketFrontEdgeR',
      });
      edgePlacket.position.set(s * 0.084, -0.02, 0.132);
      edgePlacket.rotation.set(-0.05, s * 0.34, s * 0.03);
      chest.add(edgePlacket);

      // Folded open upper jacket lapel flaring cleanly outward from storm collar
      const lapelGrp = new THREE.Group();
      lapelGrp.position.set(s * 0.082, 0.118, 0.122);
      lapelGrp.rotation.set(-0.14, s * 0.42, s * -0.26);
      const lapelMesh = this._makeMesh(lapelGeo, this.mats.jacketTrim, {
        name: s > 0 ? 'JacketLapelL' : 'JacketLapelR',
      });
      lapelGrp.add(lapelMesh);
      const lapelStitch = this._makeMesh(lapelStitchGeo, this.mats.stitching, {
        name: s > 0 ? 'JacketLapelStitchL' : 'JacketLapelStitchR',
        castShadow: false,
      });
      lapelStitch.position.set(s * 0.017, 0, 0.002);
      lapelGrp.add(lapelStitch);
      chest.add(lapelGrp);
    }

    // Polished brass front jacket buttons down right open edge + stitched buttonhole tabs on left edge
    for (let i = 0; i < 4; i++) {
      const by = 0.072 - i * 0.068;
      const bz = 0.142 - i * 0.004;
      const btn = this._makeMesh(btnGeo, this.mats.brass, { name: `JacketButton_${i}` });
      btn.position.set(-0.082, by, bz);
      btn.rotation.y = -0.34;
      chest.add(btn);

      const holeTab = this._makeMesh(tabGeo, this.mats.stitching, {
        name: `JacketButtonHole_${i}`,
        castShadow: false,
      });
      holeTab.position.set(0.083, by, bz);
      holeTab.rotation.y = 0.34;
      chest.add(holeTab);
    }

    // Stitched chest flap pockets with contrast topstitching & polished brass snaps
    const pktBodyGeo = this._trackGeo(new THREE.BoxGeometry(0.084, 0.082, 0.02));
    const pktFlapGeo = this._trackGeo(new THREE.BoxGeometry(0.088, 0.026, 0.024));
    const pktStitchHGeo = this._trackGeo(new THREE.BoxGeometry(0.078, 0.004, 0.025));
    const pktStitchVGeo = this._trackGeo(new THREE.BoxGeometry(0.004, 0.074, 0.022));
    for (const s of [1, -1]) {
      const grp = new THREE.Group();
      grp.position.set(s * 0.136, 0.024, 0.106);
      grp.rotation.y = s * 0.56;
      grp.rotation.x = -0.06;
      grp.add(this._makeMesh(pktBodyGeo, this.mats.jacket, { name: `ChestPocket_${s > 0 ? 'L' : 'R'}` }));
      const flap = this._makeMesh(pktFlapGeo, this.mats.jacketTrim, {
        name: `ChestPocketFlap_${s > 0 ? 'L' : 'R'}`,
      });
      flap.position.set(0, 0.034, 0.003);
      grp.add(flap);

      const flapStitch = this._makeMesh(pktStitchHGeo, this.mats.stitching, {
        name: `ChestPocketStitch_${s > 0 ? 'L' : 'R'}`,
        castShadow: false,
      });
      flapStitch.position.set(0, 0.025, 0.003);
      grp.add(flapStitch);

      for (const sx of [-0.036, 0.036]) {
        const vStitch = this._makeMesh(pktStitchVGeo, this.mats.stitching, {
          name: `ChestPocketSideStitch_${s > 0 ? 'L' : 'R'}`,
          castShadow: false,
        });
        vStitch.position.set(sx, -0.002, 0.001);
        grp.add(vStitch);
      }

      const snap = this._makeMesh(btnGeo, this.mats.brass, { name: `ChestPocketSnap_${s > 0 ? 'L' : 'R'}` });
      snap.position.set(0, 0.034, 0.016);
      grp.add(snap);
      chest.add(grp);
    }

    // Open folded storm collar wrapping around back & sides of neck, leaving plaid collar open in front
    const collarGeo = this._createOpenSculptedShell(
      [
        { y: 0.144, rx: 0.092, rz: 0.095, frontScale: 0.94, backScale: 1.08, gapHalfAngle: 0.62 },
        { y: 0.184, rx: 0.102, rz: 0.101, frontScale: 0.88, backScale: 1.15, gapHalfAngle: 0.66 },
        { y: 0.216, rx: 0.109, rz: 0.104, frontScale: 0.82, backScale: 1.18, gapHalfAngle: 0.72 },
      ],
      20,
      { thickness: 0.013, uvRepeatU: 1.0, uvRepeatV: 0.4 }
    );
    chest.add(this._makeMesh(collarGeo, this.mats.jacketTrim, { name: 'StormCollar' }));

    // 6. Sculpted neck cylinder (skin)
    const neckGeo = this._createSculptedLoft(
      [
        { y: -0.025, rx: 0.062, rz: 0.062 },
        { y: 0.035, rx: 0.056, rz: 0.057, oz: 0.004 },
        { y: 0.095, rx: 0.058, rz: 0.061, oz: 0.008 },
      ],
      16
    );
    this._tagSweatMask(neckGeo, (_x, y, z) => 0.45 + smoothstep(-0.02, 0.08, y) * 0.25 + (z > 0 ? 0.15 : 0));
    neck.add(this._makeMesh(neckGeo, this.mats.skin, { name: 'NeckSkin' }));
  }

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

    // 1. Sculpted cranium + cheekbones + orbital planes (head bone at y = 1.61, crown ~1.78 => +0.168 local)
    const craniumGeo = this._createSculptedLoft(
      [
        { y: -0.048, rx: 0.062, rz: 0.072, oz: -0.006, frontScale: 0.85, backScale: 1.05 },
        { y: -0.015, rx: 0.078, rz: 0.095, oz: 0.005, frontScale: 1.05, backScale: 1.02 },
        { y: 0.028, rx: 0.084, rz: 0.104, oz: 0.008, frontScale: 1.04, backScale: 1.04 },
        { y: 0.068, rx: 0.086, rz: 0.107, oz: 0.006, frontScale: 1.02, backScale: 1.05 },
        { y: 0.112, rx: 0.082, rz: 0.102, oz: -0.004, frontScale: 0.96, backScale: 1.04 },
        { y: 0.148, rx: 0.062, rz: 0.078, oz: -0.008 },
        { y: 0.166, rx: 0.024, rz: 0.03, oz: -0.008 },
      ],
      24
    );
    // Sculpt subtle eye socket recesses, cheekbone prominence, philtrum, and temple definition directly in vertices
    const cPos = craniumGeo.attributes.position;
    for (let i = 0; i < cPos.count; i++) {
      let x = cPos.getX(i);
      let y = cPos.getY(i);
      let z = cPos.getZ(i);

      if (z > 0.055) {
        // Gentle orbital eye-socket recess around (±0.034, 0.048)
        const dEyeL = Math.hypot(x - 0.034, (y - 0.048) * 1.25);
        const dEyeR = Math.hypot(x + 0.034, (y - 0.048) * 1.25);
        const dEye = Math.min(dEyeL, dEyeR);
        const socket = Math.exp(-(dEye * dEye) / 0.00055);
        z -= socket * 0.015;

        // Cheekbone fullness below outer eyes
        const dCheekL = Math.hypot(x - 0.048, y - 0.014);
        const dCheekR = Math.hypot(x + 0.048, y - 0.014);
        const dCheek = Math.min(dCheekL, dCheekR);
        const cheek = Math.exp(-(dCheek * dCheek) / 0.00085);
        z += cheek * 0.008;
        x += Math.sign(x) * cheek * 0.004;

        // Subtle brow ridge shelf
        const browBand = Math.exp(-((y - 0.072) ** 2) / 0.00022) * smoothstep(0.075, 0.01, Math.abs(x));
        z += browBand * 0.007;

        // Subtle philtrum dimple & nasolabial contour above upper lip
        const philtrum = Math.exp(-((x * x) / 0.000045 + ((y + 0.003) ** 2) / 0.00009));
        z -= philtrum * 0.0025;
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

    // Dark oral cavity interior tucked behind upper lip & jaw so wide-open terror jaw looks real
    const cavityGeo = this._trackGeo(new THREE.SphereGeometry(0.038, 12, 10));
    cavityGeo.scale(1.05, 0.85, 1.15);
    const cavity = this._makeMesh(cavityGeo, this.mats.mouthCavity, {
      name: 'OralCavity',
      castShadow: false,
      isHead: true,
    });
    cavity.position.set(0, -0.028, 0.068);
    head.add(cavity);

    // Sculpted upper lip with cupid's-bow arch + natural mouth-line contour & subtle mouth corners
    const upperLipGeo = this._createSculptedLoft(
      [
        { y: -0.027, rx: 0.0022, rz: 0.0042, oz: -0.008 },
        { y: -0.015, rx: 0.0052, rz: 0.0092, oz: -0.002 },
        { y: -0.006, rx: 0.0068, rz: 0.0112, oz: 0.0018, frontScale: 1.12 },
        { y: 0.0, rx: 0.0060, rz: 0.0108, oz: 0.0022, frontScale: 1.06 },
        { y: 0.006, rx: 0.0068, rz: 0.0112, oz: 0.0018, frontScale: 1.12 },
        { y: 0.015, rx: 0.0052, rz: 0.0092, oz: -0.002 },
        { y: 0.027, rx: 0.0022, rz: 0.0042, oz: -0.008 },
      ],
      10
    );
    upperLipGeo.rotateZ(Math.PI / 2);
    const upperLip = this._makeMesh(upperLipGeo, this.mats.lips, {
      name: 'UpperLip',
      castShadow: false,
      isHead: true,
    });
    upperLip.position.set(0, -0.0145, 0.097);
    head.add(upperLip);

    // Subtle shadowed mouth-line crease & lateral lip corners framing expression cleanly
    const mouthLineGeo = this._createSculptedLoft(
      [
        { y: -0.026, rx: 0.0014, rz: 0.0026, oz: -0.007 },
        { y: -0.012, rx: 0.0018, rz: 0.0036, oz: -0.001 },
        { y: 0.0, rx: 0.0020, rz: 0.0042, oz: 0.001 },
        { y: 0.012, rx: 0.0018, rz: 0.0036, oz: -0.001 },
        { y: 0.026, rx: 0.0014, rz: 0.0026, oz: -0.007 },
      ],
      8
    );
    mouthLineGeo.rotateZ(Math.PI / 2);
    const mouthLine = this._makeMesh(mouthLineGeo, this.mats.mouthCrease, {
      name: 'MouthContourLine',
      castShadow: false,
      isHead: true,
    });
    mouthLine.position.set(0, -0.0195, 0.0942);
    mouthLine.scale.set(0.86, 0.55, 0.65);
    head.add(mouthLine);

    const cornerGeo = this._trackGeo(new THREE.SphereGeometry(0.0024, 8, 6));
    cornerGeo.scale(1.0, 0.6, 0.55);
    for (const s of [1, -1]) {
      const corner = this._makeMesh(cornerGeo, this.mats.mouthCrease, {
        name: s > 0 ? 'OralCornerL' : 'OralCornerR',
        castShadow: false,
        isHead: true,
      });
      corner.position.set(s * 0.0235, -0.019, 0.0885);
      head.add(corner);
    }

    // 2. Sculpted nose bridge, tip, and nostrils
    const noseBridgeGeo = this._createSculptedLoft(
      [
        { y: -0.016, rx: 0.0145, rz: 0.016, frontScale: 1.2 },
        { y: -0.005, rx: 0.012, rz: 0.019, oz: 0.008, frontScale: 1.25 },
        { y: 0.025, rx: 0.0085, rz: 0.012, oz: 0.002 },
        { y: 0.052, rx: 0.0095, rz: 0.009, oz: -0.004 },
      ],
      12
    );
    this._tagSweatMask(noseBridgeGeo, () => 0.92);
    const nose = this._makeMesh(noseBridgeGeo, this.mats.skin, { name: 'NoseBridge', isHead: true });
    nose.position.set(0, 0.014, 0.104);
    head.add(nose);

    const nostrilGeo = this._trackGeo(new THREE.SphereGeometry(0.0072, 10, 8));
    nostrilGeo.scale(1.05, 0.78, 1.1);
    for (const s of [1, -1]) {
      const nostril = this._makeMesh(nostrilGeo, this.mats.skin, {
        name: s > 0 ? 'NostrilL' : 'NostrilR',
        isHead: true,
      });
      nostril.position.set(s * 0.0115, 0.004, 0.107);
      head.add(nostril);
    }

    // 3. Articulated lower jaw & sculpted chin (rotates +X to drop open in shock / panting!)
    const jawGeo = this._createSculptedLoft(
      [
        { y: -0.054, rx: 0.032, rz: 0.044, oz: 0.024, frontScale: 1.15 },
        { y: -0.032, rx: 0.052, rz: 0.062, oz: 0.018, frontScale: 1.12 },
        { y: -0.004, rx: 0.062, rz: 0.068, oz: 0.008, frontScale: 1.04 },
        { y: 0.016, rx: 0.064, rz: 0.064, oz: 0.002 },
      ],
      18
    );
    this._tagSweatMask(jawGeo, () => 0.55);
    jaw.add(this._makeMesh(jawGeo, this.mats.skin, { name: 'LowerJaw', isHead: true }));

    // Sculpted fuller pillowed lower lip contour mounted cleanly on articulated jaw
    const lowerLipGeo = this._createSculptedLoft(
      [
        { y: -0.024, rx: 0.0022, rz: 0.0042, oz: -0.007 },
        { y: -0.012, rx: 0.0060, rz: 0.0098, oz: -0.001, frontScale: 1.12 },
        { y: 0.0, rx: 0.0072, rz: 0.0114, oz: 0.0022, frontScale: 1.16 },
        { y: 0.012, rx: 0.0060, rz: 0.0098, oz: -0.001, frontScale: 1.12 },
        { y: 0.024, rx: 0.0022, rz: 0.0042, oz: -0.007 },
      ],
      10
    );
    lowerLipGeo.rotateZ(Math.PI / 2);
    const lowerLip = this._makeMesh(lowerLipGeo, this.mats.lips, {
      name: 'LowerLip',
      castShadow: false,
      isHead: true,
    });
    lowerLip.position.set(0, 0.0165, 0.062);
    jaw.add(lowerLip);

    // 4. Curved anatomical ears (helix rim + lobe)
    const earGeo = this._trackGeo(new THREE.TorusGeometry(0.018, 0.0068, 8, 14, Math.PI * 1.45));
    const earBowlGeo = this._trackGeo(new THREE.SphereGeometry(0.015, 10, 8));
    earBowlGeo.scale(0.42, 1.18, 0.85);
    for (const s of [1, -1]) {
      const earGrp = new THREE.Group();
      earGrp.position.set(s * 0.083, 0.032, -0.004);
      earGrp.rotation.y = s * -0.22;
      earGrp.rotation.z = s * -0.1;

      const bowl = this._makeMesh(earBowlGeo, this.mats.skin, {
        name: s > 0 ? 'EarBowlL' : 'EarBowlR',
        isHead: true,
      });
      earGrp.add(bowl);

      const helix = this._makeMesh(earGeo, this.mats.skin, {
        name: s > 0 ? 'EarHelixL' : 'EarHelixR',
        isHead: true,
      });
      helix.rotation.y = Math.PI / 2;
      helix.rotation.z = -0.35;
      helix.scale.set(0.82, 1.18, 0.72);
      earGrp.add(helix);

      head.add(earGrp);
    }

    // 5. Eyes (white sclera + hazel-blue iris + pupil + crisp dual specular catchlights) & articulating eyelids
    const eyeGeo = this._trackGeo(new THREE.SphereGeometry(0.0138, 16, 14));
    // Rotate sphere so +Y UV pole (pupil/iris center) faces straight forward (+Z)
    eyeGeo.rotateX(Math.PI / 2);

    const catchlightMainGeo = this._trackGeo(new THREE.SphereGeometry(0.0019, 8, 6));
    catchlightMainGeo.scale(1.15, 1.0, 0.35);
    const catchlightSubGeo = this._trackGeo(new THREE.SphereGeometry(0.00095, 8, 6));
    catchlightSubGeo.scale(1.0, 1.0, 0.35);

    const upperLidGeo = this._trackGeo(
      new THREE.SphereGeometry(0.0154, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.37)
    );
    // Covers top cap down to upper iris edge (theta = 0.37*PI); +X rotation closes downward over pupil!
    upperLidGeo.scale(1.04, 1.0, 1.04);

    const lowerLidGeo = this._trackGeo(
      new THREE.SphereGeometry(0.0151, 14, 8, 0, Math.PI * 2, Math.PI * 0.64, Math.PI * 0.36)
    );
    // Covers bottom cap up to lower iris edge; +X rotation drops lower lid further open in terror!
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
      const eyeMesh = this._makeMesh(eyeGeo, this.mats.eye, {
        name: `Eyeball${side}`,
        castShadow: false,
        receiveShadow: false,
        isHead: true,
      });
      eyeBone.add(eyeMesh);

      // Sharp dual specular catchlight highlights perched flush on the corneal dome
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

      const uLidMesh = this._makeMesh(upperLidGeo, this.mats.skin, {
        name: `UpperLid${side}`,
        castShadow: false,
        isHead: true,
      });
      uLidBone.add(uLidMesh);

      const lashMesh = this._makeMesh(lashGeo, this.mats.lash, {
        name: `Eyelash${side}`,
        castShadow: false,
        isHead: true,
      });
      lashMesh.position.set(0, lashY, 0.0008);
      uLidBone.add(lashMesh);

      const lLidMesh = this._makeMesh(lowerLidGeo, this.mats.skin, {
        name: `LowerLid${side}`,
        castShadow: false,
        isHead: true,
      });
      lLidBone.add(lLidMesh);
    }

    // 6. Sculpted expressive eyebrows
    const browGeo = this._createSculptedLoft(
      [
        { y: -0.019, rx: 0.0032, rz: 0.0042 },
        { y: -0.006, rx: 0.0052, rz: 0.006 },
        { y: 0.008, rx: 0.0058, rz: 0.0064 },
        { y: 0.019, rx: 0.003, rz: 0.0038 },
      ],
      10
    );
    browGeo.rotateZ(Math.PI / 2);

    for (const [side, browBone] of [
      ['L', browL],
      ['R', browR],
    ]) {
      const s = side === 'L' ? 1 : -1;
      const bMesh = this._makeMesh(browGeo, this.mats.hair, {
        name: `Eyebrow${side}`,
        castShadow: false,
        isHead: true,
      });
      bMesh.rotation.y = s * 0.24;
      bMesh.rotation.z = s * -0.08;
      browBone.add(bMesh);
    }

    // 7. Layered tousled chestnut hair cap & organic sculpted tufts (upper/front locks on swaying hairLocks bone!)
    const hairCapGeo = this._trackGeo(
      new THREE.SphereGeometry(0.094, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.62)
    );
    hairCapGeo.scale(0.97, 1.04, 1.15);
    const hairCap = this._makeMesh(hairCapGeo, this.mats.hair, { name: 'HairBaseCap', isHead: true });
    hairCap.position.set(0, 0.076, -0.008);
    hairCap.rotation.x = -0.22;
    head.add(hairCap);

    // Back/nape hair volume
    const napeGeo = this._trackGeo(new THREE.SphereGeometry(0.082, 16, 12));
    napeGeo.scale(0.98, 1.08, 0.92);
    const nape = this._makeMesh(napeGeo, this.mats.hair, { name: 'HairNape', isHead: true });
    nape.position.set(0, 0.036, -0.036);
    head.add(nape);

    // Layered sculpted chestnut hair tufts: upper/front locks parented to spring bone `hairLocks`!
    const tuftRng = createRng(this._seed + 404);
    const tuftGeo = this._createSculptedLoft(
      [
        { y: 0.0, rx: 0.018, rz: 0.011 },
        { y: 0.025, rx: 0.02, rz: 0.012, oz: 0.006 },
        { y: 0.056, rx: 0.014, rz: 0.009, oz: 0.012 },
        { y: 0.082, rx: 0.004, rz: 0.003, oz: 0.016 },
      ],
      8
    );

    const hairPivotX = hairLocks.position.x;
    const hairPivotY = hairLocks.position.y;
    const hairPivotZ = hairLocks.position.z;

    const tuftSpecs = [
      // Swept forehead fringe locks (spring-animated via hairLocks!)
      { p: [-0.044, 0.132, 0.068], r: [1.18, -0.35, -0.52], s: [1.12, 0.95, 0.92], dynamic: true },
      { p: [-0.014, 0.144, 0.076], r: [1.26, -0.1, -0.32], s: [1.2, 1.02, 0.96], dynamic: true },
      { p: [0.02, 0.143, 0.075], r: [1.22, 0.18, -0.18], s: [1.16, 0.98, 0.92], dynamic: true },
      { p: [0.052, 0.128, 0.063], r: [1.1, 0.45, 0.35], s: [1.02, 0.9, 0.88], dynamic: true },
      // Upper crown sweeping locks (spring-animated via hairLocks!)
      { p: [0.0, 0.145, 0.026], r: [1.05, 0.08, -0.25], s: [1.32, 0.82, 0.95], dynamic: true },
      { p: [-0.038, 0.142, 0.014], r: [0.92, -0.4, -0.58], s: [1.2, 0.8, 0.9], dynamic: true },
      { p: [0.038, 0.14, 0.016], r: [0.94, 0.38, 0.46], s: [1.2, 0.8, 0.9], dynamic: true },
      { p: [0.074, 0.108, 0.038], r: [0.58, 0.95, 1.52], s: [0.96, 0.9, 0.86], dynamic: true },
      { p: [-0.074, 0.108, 0.038], r: [0.58, -0.95, -1.52], s: [0.96, 0.9, 0.86], dynamic: true },
      // Scalp-anchored crown/rear/temple base tufts (stay flush on head)
      { p: [0.0, 0.142, -0.028], r: [-1.08, 0.0, 0.12], s: [1.35, 0.82, 0.95], dynamic: false },
      { p: [-0.046, 0.135, -0.035], r: [-1.05, -0.45, -0.55], s: [1.18, 0.82, 0.92], dynamic: false },
      { p: [0.046, 0.135, -0.035], r: [-1.05, 0.45, 0.55], s: [1.18, 0.82, 0.92], dynamic: false },
      { p: [0.082, 0.082, -0.01], r: [-0.35, 1.3, 1.75], s: [0.92, 0.92, 0.85], dynamic: false },
      { p: [-0.082, 0.082, -0.01], r: [-0.35, -1.3, -1.75], s: [0.92, 0.92, 0.85], dynamic: false },
      { p: [0.0, 0.095, -0.092], r: [-2.15, 0.0, 0.08], s: [1.35, 1.05, 0.95], dynamic: false },
      { p: [0.045, 0.088, -0.082], r: [-2.12, 0.42, 0.25], s: [1.2, 0.98, 0.9], dynamic: false },
      { p: [-0.045, 0.088, -0.082], r: [-2.12, -0.42, -0.25], s: [1.2, 0.98, 0.9], dynamic: false },
      { p: [0.01, 0.052, -0.098], r: [-2.42, 0.1, -0.1], s: [1.25, 0.85, 0.85], dynamic: false },
    ];

    tuftSpecs.forEach((t, idx) => {
      const m = this._makeMesh(tuftGeo, this.mats.hair, {
        name: t.dynamic ? `HairLock_${idx}` : `HairTuft_${idx}`,
        isHead: true,
      });
      if (t.dynamic) {
        m.position.set(t.p[0] - hairPivotX, t.p[1] - hairPivotY, t.p[2] - hairPivotZ);
      } else {
        m.position.set(t.p[0], t.p[1], t.p[2]);
      }
      m.rotation.set(
        t.r[0] + (tuftRng() - 0.5) * 0.1,
        t.r[1] + (tuftRng() - 0.5) * 0.1,
        t.r[2] + (tuftRng() - 0.5) * 0.1
      );
      m.scale.set(t.s[0], t.s[1], t.s[2]);
      (t.dynamic ? hairLocks : head).add(m);
    });
  }

  _buildArmsAndHands() {
    // Shared joint caps & limb geometries
    const shoulderCapGeo = this._trackGeo(new THREE.SphereGeometry(0.068, 16, 14));
    const upperArmGeo = this._createSculptedLoft(
      [
        { y: -0.285, rx: 0.046, rz: 0.046 },
        { y: -0.17, rx: 0.054, rz: 0.056, frontScale: 1.08 },
        { y: -0.06, rx: 0.064, rz: 0.065 },
        { y: 0.015, rx: 0.062, rz: 0.062 },
      ],
      16
    );
    const elbowCapGeo = this._trackGeo(new THREE.SphereGeometry(0.047, 14, 12));

    // Rolled jacket cuff at upper forearm exposing bare skin lower forearm
    const rolledCuffGeo = this._createSculptedLoft(
      [
        { y: -0.095, rx: 0.052, rz: 0.052 },
        { y: -0.062, rx: 0.054, rz: 0.054 },
        { y: -0.025, rx: 0.048, rz: 0.048 },
        { y: 0.012, rx: 0.046, rz: 0.046 },
      ],
      16
    );

    const forearmSkinGeo = this._createSculptedLoft(
      [
        { y: -0.252, rx: 0.029, rz: 0.034 },
        { y: -0.18, rx: 0.035, rz: 0.039 },
        { y: -0.105, rx: 0.043, rz: 0.045 },
        { y: -0.055, rx: 0.044, rz: 0.045 },
      ],
      16
    );
    this._tagSweatMask(forearmSkinGeo, () => 0.45);

    const wristCapGeo = this._trackGeo(new THREE.SphereGeometry(0.029, 12, 10));
    wristCapGeo.scale(0.95, 0.9, 1.12);
    this._tagSweatMask(wristCapGeo, () => 0.35);

    // Sculpted anatomical palm (thinner along X because palm faces inward, wider along Z)
    const palmGeo = this._createSculptedLoft(
      [
        { y: -0.08, rx: 0.0145, rz: 0.041, squareness: 0.25 },
        { y: -0.048, rx: 0.019, rz: 0.044, frontScale: 1.06, squareness: 0.22 },
        { y: -0.015, rx: 0.0205, rz: 0.036 },
        { y: 0.008, rx: 0.0215, rz: 0.031 },
      ],
      14
    );
    this._tagSweatMask(palmGeo, () => 0.3);

    // Sculpted palm thenar thumb-pad cushion & knuckle ridge
    const thenarGeo = this._trackGeo(new THREE.SphereGeometry(0.016, 10, 8));
    thenarGeo.scale(0.85, 1.35, 0.95);
    this._tagSweatMask(thenarGeo, () => 0.28);

    const knuckleGeo = this._trackGeo(new THREE.SphereGeometry(0.0082, 8, 6));
    this._tagSweatMask(knuckleGeo, () => 0.25);

    // 2-segment articulated finger geometries (proximal phalanx + tapered mid/distal phalanx)
    const fingerProxGeo = this._createSculptedLoft(
      [
        { y: -0.04, rx: 0.0072, rz: 0.0076 },
        { y: -0.02, rx: 0.0080, rz: 0.0084 },
        { y: 0.004, rx: 0.0086, rz: 0.0088 },
      ],
      10
    );
    this._tagSweatMask(fingerProxGeo, () => 0.25);

    const fingerDistGeo = this._createSculptedLoft(
      [
        { y: -0.036, rx: 0.0048, rz: 0.0052 },
        { y: -0.020, rx: 0.0066, rz: 0.0070 },
        { y: 0.004, rx: 0.0072, rz: 0.0075 },
      ],
      10
    );
    this._tagSweatMask(fingerDistGeo, () => 0.25);

    // 2-segment articulated thumb geometries (proximal + distal)
    const thumbProxGeo = this._createSculptedLoft(
      [
        { y: -0.035, rx: 0.0086, rz: 0.0092 },
        { y: -0.016, rx: 0.0098, rz: 0.0104 },
        { y: 0.005, rx: 0.0112, rz: 0.0116 },
      ],
      10
    );
    this._tagSweatMask(thumbProxGeo, () => 0.25);

    const thumbDistGeo = this._createSculptedLoft(
      [
        { y: -0.028, rx: 0.0062, rz: 0.0068 },
        { y: -0.014, rx: 0.0082, rz: 0.0088 },
        { y: 0.004, rx: 0.0086, rz: 0.0092 },
      ],
      10
    );
    this._tagSweatMask(thumbDistGeo, () => 0.25);

    // Shoulder bridge dome on clavicle so shrugging up to ears stays seamless
    const clavBridgeGeo = this._trackGeo(new THREE.SphereGeometry(0.072, 14, 12));
    clavBridgeGeo.scale(1.45, 0.85, 1.05);

    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const clav = this.bones[`clavicle${side}`];
      const upperArm = this.bones[`upperArm${side}`];
      const forearm = this.bones[`forearm${side}`];
      const wrist = this.bones[`wrist${side}`];
      const hand = this.bones[`hand${side}`];
      const thumbBone = this.bones[`thumb${side}`];
      const thumbTipBone = this.bones[`thumbTip${side}`];

      const clavBridge = this._makeMesh(clavBridgeGeo, this.mats.jacket, { name: `ClavicleBridge${side}` });
      clavBridge.position.set(s * 0.07, -0.01, 0);
      clav.add(clavBridge);

      const sCap = this._makeMesh(shoulderCapGeo, this.mats.jacket, { name: `ShoulderCap${side}` });
      upperArm.add(sCap);

      const uArm = this._makeMesh(upperArmGeo, this.mats.jacket, { name: `UpperArmSleeve${side}` });
      upperArm.add(uArm);

      const eCap = this._makeMesh(elbowCapGeo, this.mats.jacket, { name: `ElbowCap${side}` });
      forearm.add(eCap);

      const cuff = this._makeMesh(rolledCuffGeo, this.mats.jacketTrim, { name: `RolledCuff${side}` });
      forearm.add(cuff);

      const fSkin = this._makeMesh(forearmSkinGeo, this.mats.skin, { name: `ForearmSkin${side}` });
      forearm.add(fSkin);

      // Subtle explorer field watch / leather cuff on left wrist
      if (side === 'L') {
        const strapGeo = this._trackGeo(new THREE.CylinderGeometry(0.032, 0.031, 0.022, 14));
        const strap = this._makeMesh(strapGeo, this.mats.darkLeather, { name: 'FieldWatchStrap' });
        strap.position.set(0, -0.228, 0);
        forearm.add(strap);

        const dialGeo = this._trackGeo(new THREE.CylinderGeometry(0.014, 0.014, 0.008, 12));
        dialGeo.rotateZ(Math.PI / 2);
        const dial = this._makeMesh(dialGeo, this.mats.brass, { name: 'FieldWatchCase' });
        dial.position.set(0.03, -0.228, 0.005);
        forearm.add(dial);
      }

      const wCap = this._makeMesh(wristCapGeo, this.mats.skin, { name: `WristCap${side}` });
      wrist.add(wCap);

      const palm = this._makeMesh(palmGeo, this.mats.skin, { name: `HandPalm${side}` });
      hand.add(palm);

      const thenar = this._makeMesh(thenarGeo, this.mats.skin, {
        name: `HandThenar${side}`,
        castShadow: false,
      });
      thenar.position.set(-s * 0.009, -0.034, 0.026);
      hand.add(thenar);

      // Articulated 2-segment Thumb (Digit 1 of 5)
      const thumbProx = this._makeMesh(thumbProxGeo, this.mats.skin, { name: `ThumbProx${side}` });
      thumbBone.add(thumbProx);
      const thumbKnuckle = this._makeMesh(knuckleGeo, this.mats.skin, {
        name: `ThumbKnuckle${side}`,
        castShadow: false,
      });
      thumbKnuckle.scale.setScalar(1.06);
      thumbTipBone.add(thumbKnuckle);
      const thumbDist = this._makeMesh(thumbDistGeo, this.mats.skin, { name: `ThumbDist${side}` });
      thumbTipBone.add(thumbDist);

      // 4 Distinct Articulated Fingers (Index, Middle, Ring, Pinky — Digits 2..5 of 5!)
      const fingerLayouts = [
        { key: 'index', scaleX: 0.96, scaleY: 0.92, tipScaleY: 0.92, splay: 0.06 },
        { key: 'middle', scaleX: 1.0, scaleY: 1.04, tipScaleY: 1.04, splay: 0.01 },
        { key: 'ring', scaleX: 0.94, scaleY: 0.96, tipScaleY: 0.95, splay: -0.04 },
        { key: 'pinky', scaleX: 0.82, scaleY: 0.76, tipScaleY: 0.76, splay: -0.10 },
      ];
      for (const f of fingerLayouts) {
        const proxBone = this.bones[`${f.key}${side}`];
        const tipBone = this.bones[`${f.key}Tip${side}`];

        // Metacarpal knuckle joint cap at base
        const mcpCap = this._makeMesh(knuckleGeo, this.mats.skin, {
          name: `KnuckleMCP_${f.key}${side}`,
          castShadow: false,
        });
        mcpCap.scale.setScalar(f.scaleX);
        proxBone.add(mcpCap);

        const proxMesh = this._makeMesh(fingerProxGeo, this.mats.skin, {
          name: `FingerProx_${f.key}${side}`,
        });
        proxMesh.scale.set(f.scaleX, f.scaleY, f.scaleX);
        proxBone.add(proxMesh);

        // Middle PIP knuckle cap
        const pipCap = this._makeMesh(knuckleGeo, this.mats.skin, {
          name: `KnucklePIP_${f.key}${side}`,
          castShadow: false,
        });
        pipCap.scale.setScalar(f.scaleX * 0.88);
        tipBone.add(pipCap);

        const distMesh = this._makeMesh(fingerDistGeo, this.mats.skin, {
          name: `FingerDist_${f.key}${side}`,
        });
        distMesh.scale.set(f.scaleX * 0.94, f.tipScaleY, f.scaleX * 0.94);
        tipBone.add(distMesh);
      }

      // Apply natural relaxed idle default pose to all 5 digits immediately
      this.setHandPose(side, 0.22, 0.0);
    }
  }

  _buildLegsAndBoots() {
    // Smooth spherical hip & knee joint caps prevent any visible crease gaps during high sprints or crouches
    const hipCapGeo = this._trackGeo(new THREE.SphereGeometry(0.088, 16, 14));
    this._tagCharHeight(hipCapGeo, 0.92, 1.0);

    const thighGeo = this._createSculptedLoft(
      [
        { y: -0.445, rx: 0.064, rz: 0.068 },
        { y: -0.32, rx: 0.074, rz: 0.08, frontScale: 1.1 },
        { y: -0.16, rx: 0.088, rz: 0.094, frontScale: 1.12, backScale: 1.08 },
        { y: -0.01, rx: 0.092, rz: 0.096 },
        { y: 0.035, rx: 0.084, rz: 0.086 },
      ],
      18
    );
    this._tagCharHeight(thighGeo, 0.92, 1.0);

    const kneeCapGeo = this._trackGeo(new THREE.SphereGeometry(0.064, 14, 12));
    this._tagCharHeight(kneeCapGeo, 0.48, 1.0);

    // Knee reinforcement patch (front of lower thigh / knee)
    const kneePadGeo = this._trackGeo(new THREE.SphereGeometry(0.066, 14, 10, -Math.PI * 0.35, Math.PI * 0.7, Math.PI * 0.25, Math.PI * 0.5));
    kneePadGeo.rotateY(Math.PI / 2);
    this._tagCharHeight(kneePadGeo, 0.48, 1.0);

    // Thigh cargo bellows pocket
    const cargoPocketGeo = this._trackGeo(new THREE.BoxGeometry(0.026, 0.135, 0.105));
    this._tagCharHeight(cargoPocketGeo, 0.72, 1.0);
    const cargoFlapGeo = this._trackGeo(new THREE.BoxGeometry(0.03, 0.032, 0.11));
    this._tagCharHeight(cargoFlapGeo, 0.78, 1.0);

    // Lower pants / shin tapering cleanly into the hiking boot collar (ankle at -0.42 -> world 0.06)
    const shinGeo = this._createSculptedLoft(
      [
        { y: -0.375, rx: 0.056, rz: 0.058 },
        { y: -0.28, rx: 0.059, rz: 0.064, backScale: 1.08 },
        { y: -0.15, rx: 0.068, rz: 0.075, backScale: 1.2 },
        { y: -0.03, rx: 0.066, rz: 0.07 },
        { y: 0.02, rx: 0.063, rz: 0.065 },
      ],
      18
    );
    this._tagCharHeight(shinGeo, 0.48, 1.0);

    // Hiking boot upper cuff & heel/midfoot vamp (attached to ankle at world y = 0.06)
    // Sole bottom rests cleanly at local y = -0.06 (world y = 0.000!)
    const bootShaftGeo = this._createSculptedLoft(
      [
        { y: -0.038, rx: 0.054, rz: 0.078, oz: 0.015, frontScale: 1.32, backScale: 0.92, squareness: 0.35 },
        { y: -0.005, rx: 0.052, rz: 0.068, oz: 0.006, frontScale: 1.18, squareness: 0.25 },
        { y: 0.045, rx: 0.053, rz: 0.06, oz: -0.002, squareness: 0.2 },
        { y: 0.088, rx: 0.056, rz: 0.062, oz: -0.004, squareness: 0.18 },
      ],
      18
    );
    this._tagCharHeight(bootShaftGeo, 0.06, 1.0);

    // Padded dark-leather ankle collar ring at top of boot
    const bootCollarGeo = this._trackGeo(new THREE.TorusGeometry(0.056, 0.013, 10, 18));
    bootCollarGeo.rotateX(Math.PI / 2);
    bootCollarGeo.scale(1.0, 1.0, 1.08);
    this._tagCharHeight(bootCollarGeo, 0.145, 1.0);

    // Rear & midfoot chunky rubber lugged sole (y = -0.060 to -0.032)
    const rearSoleGeo = this._createSculptedLoft(
      [
        { y: -0.06, rx: 0.057, rz: 0.082, oz: 0.018, frontScale: 1.28, backScale: 0.95, squareness: 0.45 },
        { y: -0.034, rx: 0.058, rz: 0.084, oz: 0.018, frontScale: 1.28, backScale: 0.95, squareness: 0.45 },
      ],
      16
    );
    this._tagCharHeight(rearSoleGeo, 0.06, 1.0);

    // Lug tread blocks under heel/midfoot (bottom cleanly flush at y = -0.060)
    const lugGeo = this._trackGeo(new THREE.BoxGeometry(0.095, 0.008, 0.018));
    this._tagCharHeight(lugGeo, 0.004, 1.0);

    // Metal lace eyelets & crisscrossed laces
    const eyeletGeo = this._trackGeo(new THREE.TorusGeometry(0.0038, 0.0014, 6, 10));
    const laceGeo = this._trackGeo(new THREE.CylinderGeometry(0.0022, 0.0022, 0.058, 6));

    // Articulated forefoot / toe box (attached to toe bone at (0, -0.045, 0.115), world y = 0.015)
    // Sole bottom rests cleanly at local y = -0.015 (world y = 0.000!)
    const toeSoleGeo = this._createSculptedLoft(
      [
        { y: -0.015, rx: 0.054, rz: 0.056, oz: 0.012, frontScale: 1.12, backScale: 0.85, squareness: 0.42 },
        { y: 0.009, rx: 0.055, rz: 0.058, oz: 0.012, frontScale: 1.12, backScale: 0.85, squareness: 0.42 },
      ],
      16
    );
    this._tagCharHeight(toeSoleGeo, 0.015, 1.0);

    const toeUpperGeo = this._createSculptedLoft(
      [
        { y: 0.006, rx: 0.052, rz: 0.055, oz: 0.01, frontScale: 1.1, backScale: 0.95, squareness: 0.35 },
        { y: 0.028, rx: 0.046, rz: 0.048, oz: 0.004, frontScale: 1.04, backScale: 0.98, squareness: 0.25 },
        { y: 0.045, rx: 0.032, rz: 0.032, oz: -0.008 },
      ],
      16
    );
    this._tagCharHeight(toeUpperGeo, 0.015, 1.0);

    // Reinforced stitched rubber/dark-leather toe cap bumper
    const toeCapGeo = this._trackGeo(
      new THREE.SphereGeometry(0.049, 14, 10, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.28, Math.PI * 0.42)
    );
    toeCapGeo.rotateY(Math.PI / 2);
    toeCapGeo.scale(1.06, 0.85, 1.15);
    this._tagCharHeight(toeCapGeo, 0.02, 1.0);

    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const thigh = this.bones[`thigh${side}`];
      const shin = this.bones[`shin${side}`];
      const ankle = this.bones[`ankle${side}`];
      const toe = this.bones[`toe${side}`];

      thigh.add(this._makeMesh(hipCapGeo, this.mats.pants, { name: `HipCap${side}` }));
      thigh.add(this._makeMesh(thighGeo, this.mats.pants, { name: `ThighPants${side}` }));

      // Side cargo bellows pocket on outer thigh
      const cPkt = this._makeMesh(cargoPocketGeo, this.mats.pantsReinforced, { name: `CargoPocket${side}` });
      cPkt.position.set(s * 0.086, -0.21, 0.004);
      cPkt.rotation.z = s * 0.06;
      thigh.add(cPkt);

      const cFlap = this._makeMesh(cargoFlapGeo, this.mats.pants, { name: `CargoPocketFlap${side}` });
      cFlap.position.set(s * 0.09, -0.145, 0.004);
      thigh.add(cFlap);

      // Knee spherical cap + reinforced knee panel
      shin.add(this._makeMesh(kneeCapGeo, this.mats.pants, { name: `KneeCap${side}` }));
      const kPad = this._makeMesh(kneePadGeo, this.mats.pantsReinforced, { name: `KneePanel${side}` });
      kPad.position.set(0, -0.004, 0.01);
      shin.add(kPad);

      shin.add(this._makeMesh(shinGeo, this.mats.pants, { name: `ShinPants${side}` }));

      // Hiking boot (rear/ankle section)
      ankle.add(this._makeMesh(bootShaftGeo, this.mats.leather, { name: `BootShaft${side}` }));
      const bCollar = this._makeMesh(bootCollarGeo, this.mats.darkLeather, { name: `BootCollar${side}` });
      bCollar.position.set(0, 0.088, -0.004);
      ankle.add(bCollar);

      ankle.add(this._makeMesh(rearSoleGeo, this.mats.rubber, { name: `BootRearSole${side}` }));
      for (const lz of [-0.042, -0.006, 0.038, 0.076]) {
        const lug = this._makeMesh(lugGeo, this.mats.rubber, { name: `BootLug${side}` });
        lug.position.set(0, -0.056, lz);
        ankle.add(lug);
      }

      // Metal eyelets + crisscrossed laces up front tongue
      for (let i = 0; i < 4; i++) {
        const ly = 0.002 + i * 0.022;
        const lz = 0.082 - i * 0.008;
        for (const es of [1, -1]) {
          const eye = this._makeMesh(eyeletGeo, this.mats.brass, {
            name: `BootEyelet${side}_${i}_${es}`,
            castShadow: false,
          });
          eye.position.set(es * 0.024, ly, lz);
          eye.rotation.y = es * 0.35;
          ankle.add(eye);
        }
        // Crisscross pair
        for (const cs of [1, -1]) {
          const lace = this._makeMesh(laceGeo, this.mats.laces, {
            name: `BootLace${side}_${i}_${cs}`,
            castShadow: false,
          });
          lace.position.set(0, ly + 0.008, lz + 0.004);
          lace.rotation.z = Math.PI / 2 + cs * 0.34;
          ankle.add(lace);
        }
      }

      // Articulated forefoot toe section
      toe.add(this._makeMesh(toeSoleGeo, this.mats.rubber, { name: `BootToeSole${side}` }));
      toe.add(this._makeMesh(toeUpperGeo, this.mats.leather, { name: `BootToeUpper${side}` }));
      const tCap = this._makeMesh(toeCapGeo, this.mats.darkLeather, { name: `BootToeCap${side}` });
      tCap.position.set(0, 0.012, 0.026);
      toe.add(tCap);
    }
  }

  _buildBackpackAndCanteen() {
    const { chest, backpack, canteen } = this.bones;

    // 1. Main contoured weathered canvas rucksack body
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

    // Top overhanging canvas lid flap
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

    // Rear lower outer utility pouch
    const pouchGeo = this._trackGeo(new THREE.BoxGeometry(0.18, 0.14, 0.058));
    const pouch = this._makeMesh(pouchGeo, this.mats.pack, { name: 'BackpackRearPouch' });
    pouch.position.set(0, -0.085, -0.155);
    backpack.add(pouch);

    // Left-side pack pocket
    const sidePktGeo = this._trackGeo(new THREE.BoxGeometry(0.052, 0.15, 0.092));
    const sidePkt = this._makeMesh(sidePktGeo, this.mats.pack, { name: 'BackpackSidePocket' });
    sidePkt.position.set(0.165, -0.07, -0.055);
    backpack.add(sidePkt);

    // Twin leather closure straps & brass buckles down back of pack
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

    // Rolled camp blanket / sleeping pad lashed horizontally across top of pack
    const rollGeo = this._trackGeo(new THREE.CylinderGeometry(0.062, 0.062, 0.34, 18));
    rollGeo.rotateZ(Math.PI / 2);
    const blanketRoll = this._makeMesh(rollGeo, this.mats.blanket, { name: 'RolledBlanket' });
    blanketRoll.position.set(0, 0.222, -0.055);
    backpack.add(blanketRoll);

    // Leather lash straps & brass rings holding blanket roll
    const lashRingGeo = this._trackGeo(new THREE.TorusGeometry(0.065, 0.0085, 8, 18));
    lashRingGeo.rotateY(Math.PI / 2);
    for (const lx of [-0.095, 0.095]) {
      const lash = this._makeMesh(lashRingGeo, this.mats.darkLeather, { name: 'BlanketLashStrap' });
      lash.position.set(lx, 0.222, -0.055);
      backpack.add(lash);
    }

    // Contoured backpack shoulder straps hugging chest/clavicles + sternum clasp
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
      const strapMesh = this._makeMesh(strapTubeGeo, this.mats.darkLeather, {
        name: s > 0 ? 'ShoulderStrapL' : 'ShoulderStrapR',
      });
      chest.add(strapMesh);

      // Brass D-ring on front of shoulder strap
      const dRingGeo = this._trackGeo(new THREE.TorusGeometry(0.012, 0.0028, 6, 12));
      const dRing = this._makeMesh(dRingGeo, this.mats.brass, { name: `StrapRing_${s > 0 ? 'L' : 'R'}` });
      dRing.position.set(s * 0.148, 0.055, 0.118);
      chest.add(dRing);
    }

    // Sleek upper sternum cross-strap with brass clasp (positioned high so plaid flannel & brass belt buckle show clearly)
    const sternumGeo = this._trackGeo(new THREE.BoxGeometry(0.28, 0.016, 0.012));
    const sternum = this._makeMesh(sternumGeo, this.mats.darkLeather, { name: 'SternumStrap' });
    sternum.position.set(0, 0.086, 0.144);
    chest.add(sternum);

    const claspGeo = this._trackGeo(new THREE.BoxGeometry(0.028, 0.022, 0.018));
    const clasp = this._makeMesh(claspGeo, this.mats.brass, { name: 'SternumClasp' });
    clasp.position.set(0, 0.086, 0.147);
    chest.add(clasp);

    // 2. Hanging brushed-aluminum metal canteen (child of canteen bone pendulum pivot!)
    // Leather hang strap from pivot (0, 0, 0) down to canteen neck
    const hangStrapGeo = this._trackGeo(new THREE.BoxGeometry(0.016, 0.075, 0.01));
    const hangStrap = this._makeMesh(hangStrapGeo, this.mats.darkLeather, { name: 'CanteenHangStrap' });
    hangStrap.position.set(0, -0.036, 0);
    canteen.add(hangStrap);

    const hangRingGeo = this._trackGeo(new THREE.TorusGeometry(0.012, 0.0028, 6, 12));
    const hangRing = this._makeMesh(hangRingGeo, this.mats.brass, { name: 'CanteenHangRing' });
    hangRing.position.set(0, -0.005, 0);
    canteen.add(hangRing);

    // Screw cap & bottle neck
    const capGeo = this._trackGeo(new THREE.CylinderGeometry(0.015, 0.015, 0.022, 12));
    const cap = this._makeMesh(capGeo, this.mats.aluminum, { name: 'CanteenCap' });
    cap.position.set(0, -0.072, 0);
    canteen.add(cap);

    // Flattened round brushed-aluminum flask body
    const flaskGeo = this._trackGeo(new THREE.SphereGeometry(0.062, 16, 14));
    flaskGeo.scale(0.56, 1.08, 0.94);
    const flask = this._makeMesh(flaskGeo, this.mats.aluminum, { name: 'CanteenFlask' });
    flask.position.set(0, -0.142, 0);
    canteen.add(flask);

    // Lower canvas protective carrier sleeve on canteen
    const sleeveGeo = this._trackGeo(
      new THREE.SphereGeometry(0.065, 16, 10, 0, Math.PI * 2, Math.PI * 0.48, Math.PI * 0.52)
    );
    sleeveGeo.scale(0.58, 1.06, 0.96);
    const sleeve = this._makeMesh(sleeveGeo, this.mats.pack, { name: 'CanteenSleeve' });
    sleeve.position.set(0, -0.142, 0);
    canteen.add(sleeve);
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
        // Soft boot-shaped elliptical falloff (slightly fuller under heel & forefoot)
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
    // Orient plane face upward along +Y so normal alignment matches ground surface normal cleanly
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

  /**
   * Positions and fades both soft boot contact-shadow decals cleanly onto grass,
   * cabin floorboards, curved bridge planks, or cavern stone beneath each sole.
   */
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

      // Convert world normal into character-root local space
      if (worldNorm && Number.isFinite(worldNorm.x) && Number.isFinite(worldNorm.y) && Number.isFinite(worldNorm.z) && worldNorm.lengthSq() > 1e-6) {
        this._shadowLocalNorm.copy(worldNorm).normalize().applyQuaternion(this._shadowInvRootQuat).normalize();
      } else {
        this._shadowLocalNorm.set(0, 1, 0);
      }

      // Place shadow decal in root-local coordinates hovering +0.012m off the surface along its normal
      this._shadowLocalPos.copy(worldPos).applyMatrix4(this._shadowInvRootMat);
      this._shadowLocalPos.addScaledVector(this._shadowLocalNorm, 0.012);
      mesh.position.copy(this._shadowLocalPos);

      // Build tangent-aligned basis preserving boot forward (+Z) orientation on slopes & bridge arches
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

      // Softly widen contact shadow footprint as boot lifts off ground
      const spread = 1.0 + clamp(lift / 0.34, 0, 1) * 0.28;
      mesh.scale.set(spread, 1.0, spread);
    };

    applyDecal(this.contactShadowL, leftWorldPos, leftNormal, leftLift);
    applyDecal(this.contactShadowR, rightWorldPos, rightNormal, rightLift);
  }

  /**
   * Articulates all 5 digits (thumb + index, middle, ring, pinky) on left ('L') or right ('R') hand:
   * - curl ~0.22: natural anatomical relaxed idle finger cascade
   * - curl ~1.25..1.4: tight clenched sprinting fist with thumb wrapped over index/middle
   * - curl < 0 / splay > 0: wide-splayed startled panic fingers & flared thumb
   */
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

    // Natural anatomical cascade strongest at relaxed idle, converging cleanly on fist clench & panic splay
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

    // Articulated 2-segment thumb: relaxed opposition at idle, locked across fist on sprint, flared wide in panic
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
  // Public Control & Query API
  // ---------------------------------------------------------------------------

  /**
   * Hides or shows head/hair/face meshes for seamless First-Person Body-Cam
   * while preserving the torso, jacket, arms, hands, legs, and boots.
   */
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

  getBoneWorldPosition(name, target = new THREE.Vector3()) {
    const bone = this.bones[name];
    if (!bone) {
      return target.set(0, 0, 0);
    }
    bone.updateWorldMatrix(true, false);
    return bone.getWorldPosition(target);
  }

  /**
   * Computes exact world positions of the boot soles beneath ankleL and ankleR.
   */
  getFootWorldPositions(leftOut = new THREE.Vector3(), rightOut = new THREE.Vector3()) {
    const ankleL = this.bones.ankleL;
    const ankleR = this.bones.ankleR;

    ankleL.updateWorldMatrix(true, false);
    ankleR.updateWorldMatrix(true, false);

    // Center of boot sole bottom in ankle local space (y = -0.06 -> world y = 0.0 in bind pose)
    this._tmpFootLocal.set(0, -this._soleOffsetBelowAnkle, 0.035);
    leftOut.copy(this._tmpFootLocal).applyMatrix4(ankleL.matrixWorld);
    rightOut.copy(this._tmpFootLocal).applyMatrix4(ankleR.matrixWorld);

    return { left: leftOut, right: rightOut };
  }

  dispose() {
    for (const geo of this._geometries) {
      geo.dispose();
    }
    for (const mat of this._materials) {
      mat.dispose();
    }
    for (const tex of this._textures) {
      tex.dispose();
    }
    this._geometries.length = 0;
    this._materials.length = 0;
    this._textures.length = 0;
    this.headMeshes.length = 0;
  }
}
