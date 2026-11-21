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

    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this._boneList);
    this.skeleton.calculateInverses();

    // Reusable scratch vectors for zero-allocation queries
    this._tmpFootLocal = new THREE.Vector3();
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
      type === 'leather' ? 1.85 : type === 'skin' ? 0.42 : type === 'hair' ? 1.65 : 1.35;
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

        let r = 236;
        let g = 232;
        let b = 226;

        // Subtle warm sclera shading further back on globe
        const backTint = smoothstep(0.45, 1.35, polarAngle);
        r = lerp(r, 206, backTint);
        g = lerp(g, 184, backTint);
        b = lerp(b, 178, backTint);

        // Limbal ring & hazel-blue iris (polarAngle < 0.44 rad)
        if (polarAngle < 0.46) {
          const irisT = clamp(polarAngle / 0.43, 0, 1);
          const fiber = noise(Math.cos(ang) * 7.5, Math.sin(ang) * 7.5) * 0.5 + 0.5;
          const ring = noise(Math.cos(ang) * 3.0 + irisT * 4.0, Math.sin(ang) * 3.0) * 0.5 + 0.5;

          // Warm amber-hazel inner ring fading to clear forest-slate blue outer iris
          const ir = lerp(136, 56, smoothstep(0.28, 0.78, irisT)) + (fiber - 0.5) * 34;
          const ig = lerp(112, 108, smoothstep(0.25, 0.85, irisT)) + (ring - 0.5) * 28;
          const ib = lerp(66, 134, smoothstep(0.22, 0.76, irisT)) + (fiber - 0.5) * 30;

          // Dark limbal outer edge
          const limbal = smoothstep(0.76, 0.98, irisT);
          const irisEdge = 1.0 - smoothstep(0.92, 1.04, polarAngle / 0.44);

          const fr = lerp(ir, 28, limbal * 0.75);
          const fg = lerp(ig, 44, limbal * 0.75);
          const fb = lerp(ib, 54, limbal * 0.75);

          r = lerp(r, fr, irisEdge);
          g = lerp(g, fg, irisEdge);
          b = lerp(b, fb, irisEdge);

          // Crisp deep pupil
          const pupil = 1.0 - smoothstep(0.155, 0.195, polarAngle);
          r = lerp(r, 12, pupil);
          g = lerp(g, 13, pupil);
          b = lerp(b, 16, pupil);
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
        color: 0xb97264,
        roughness: 0.45,
        metalness: 0.0,
      })
    );
    this._applySkinShader(this.mats.lips);

    this.mats.mouthCavity = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x260d0e,
        roughness: 0.85,
        metalness: 0.0,
      })
    );

    // Expressive glossy eyes
    this.mats.eye = this._trackMat(
      new THREE.MeshStandardMaterial({
        map: eyeMap,
        roughness: 0.08,
        metalness: 0.02,
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

    // Darker olive-slate jacket trim (collar lining, pocket flaps, rolled cuffs)
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

    // Henley undershirt visible at collar V-opening
    this.mats.shirt = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xc2b79f,
        roughness: 0.9,
        metalness: 0.0,
      })
    );

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

    // Darker leather trim (boot padded collar, belt, straps)
    this.mats.darkLeather = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x3b2416,
        normalMap: leatherTex.normalMap,
        normalScale: new THREE.Vector2(0.75, 0.75),
        roughness: 0.62,
        metalness: 0.04,
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

    // Antique brass (zipper, buttons, eyelets, pack buckles)
    this.mats.brass = this._trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xc8a256,
        roughness: 0.32,
        metalness: 0.86,
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

    // Left & Right arm chains (+X = Left, -X = Right)
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? 1 : -1;
      const clav = this._addBone(`clavicle${side}`, chest, s * 0.06, 0.13, 0);
      const upperArm = this._addBone(`upperArm${side}`, clav, s * 0.135, -0.01, 0);
      const forearm = this._addBone(`forearm${side}`, upperArm, 0, -0.28, 0);
      const wrist = this._addBone(`wrist${side}`, forearm, 0, -0.25, 0);
      const hand = this._addBone(`hand${side}`, wrist, 0, -0.01, 0);
      this._addBone(`fingers${side}`, hand, 0, -0.075, 0.006);
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

    // 1. Pelvis / hips base (cargo pants seat & belt)
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

    // Leather utility belt & brass buckle
    const beltGeo = this._createSculptedLoft(
      [
        { y: 0.035, rx: 0.163, rz: 0.115, squareness: 0.24 },
        { y: 0.072, rx: 0.162, rz: 0.114, squareness: 0.24 },
      ],
      20,
      { capBottom: false, capTop: false }
    );
    this._tagCharHeight(beltGeo, 0.94, 1.0);
    hips.add(this._makeMesh(beltGeo, this.mats.darkLeather, { name: 'UtilityBelt' }));

    const buckleGeo = this._trackGeo(new THREE.BoxGeometry(0.048, 0.04, 0.018));
    const buckle = this._makeMesh(buckleGeo, this.mats.brass, { name: 'BeltBuckle' });
    buckle.position.set(0, 0.054, 0.114);
    hips.add(buckle);

    // 2. Lower torso jacket (spine1) - overlaps smoothly down over belt
    const lowerTorsoGeo = this._createSculptedLoft(
      [
        { y: -0.09, rx: 0.168, rz: 0.118, squareness: 0.28 },
        { y: -0.02, rx: 0.162, rz: 0.115, squareness: 0.28 },
        { y: 0.07, rx: 0.164, rz: 0.118, squareness: 0.28 },
        { y: 0.145, rx: 0.172, rz: 0.122, squareness: 0.28 },
      ],
      22
    );
    this._tagCharHeight(lowerTorsoGeo, 1.05, 1.0);
    spine1.add(this._makeMesh(lowerTorsoGeo, this.mats.jacket, { name: 'JacketLowerTorso' }));

    // Waist cinch band on jacket
    const cinchGeo = this._createSculptedLoft(
      [
        { y: -0.045, rx: 0.17, rz: 0.12, squareness: 0.28 },
        { y: -0.018, rx: 0.168, rz: 0.119, squareness: 0.28 },
      ],
      22,
      { capBottom: false, capTop: false }
    );
    spine1.add(this._makeMesh(cinchGeo, this.mats.jacketTrim, { name: 'JacketWaistCinch' }));

    // 3. Articulated lower jacket hem flaps (child of jacketHem at spine1 y = -0.26)
    // Top of hem overlaps waist cinch (local y = +0.23 -> world 1.02) down to upper thigh (local y = -0.03 -> world 0.76)
    const hemGeo = this._createSculptedLoft(
      [
        { y: -0.035, rx: 0.198, rz: 0.142, backScale: 1.08, squareness: 0.3 },
        { y: 0.06, rx: 0.186, rz: 0.132, backScale: 1.04, squareness: 0.28 },
        { y: 0.155, rx: 0.174, rz: 0.123, squareness: 0.28 },
        { y: 0.22, rx: 0.166, rz: 0.117, squareness: 0.26 },
      ],
      22,
      { capBottom: false, capTop: false }
    );
    this._tagCharHeight(hemGeo, 0.79, 1.0);
    jacketHem.add(this._makeMesh(hemGeo, this.mats.jacket, { name: 'JacketHemSkirt' }));

    // Lower front side cargo coat pockets on jacketHem
    for (const s of [1, -1]) {
      const lowPktGeo = this._trackGeo(new THREE.BoxGeometry(0.088, 0.095, 0.026));
      const lowPkt = this._makeMesh(lowPktGeo, this.mats.jacketTrim, {
        name: s > 0 ? 'JacketLowerPocketL' : 'JacketLowerPocketR',
      });
      lowPkt.position.set(s * 0.115, 0.065, 0.105);
      lowPkt.rotation.y = s * 0.42;
      jacketHem.add(lowPkt);
    }

    // 4. Mid torso (spine2)
    const midTorsoGeo = this._createSculptedLoft(
      [
        { y: -0.045, rx: 0.166, rz: 0.118, squareness: 0.28 },
        { y: 0.045, rx: 0.18, rz: 0.126, frontScale: 1.06, squareness: 0.3 },
        { y: 0.145, rx: 0.196, rz: 0.133, frontScale: 1.1, squareness: 0.32 },
        { y: 0.185, rx: 0.198, rz: 0.132, frontScale: 1.08, squareness: 0.3 },
      ],
      22
    );
    this._tagCharHeight(midTorsoGeo, 1.19, 1.0);
    spine2.add(this._makeMesh(midTorsoGeo, this.mats.jacket, { name: 'JacketMidTorso' }));

    // 5. Upper chest & shoulders (chest)
    const chestGeo = this._createSculptedLoft(
      [
        { y: -0.04, rx: 0.19, rz: 0.128, frontScale: 1.08, squareness: 0.32 },
        { y: 0.045, rx: 0.206, rz: 0.134, frontScale: 1.12, squareness: 0.35 },
        { y: 0.125, rx: 0.202, rz: 0.122, frontScale: 1.04, squareness: 0.32 },
        { y: 0.165, rx: 0.135, rz: 0.095, squareness: 0.2 },
        { y: 0.182, rx: 0.072, rz: 0.068 },
      ],
      24
    );
    this._tagCharHeight(chestGeo, 1.35, 1.0);
    chest.add(this._makeMesh(chestGeo, this.mats.jacket, { name: 'JacketChest' }));

    // Front brass zipper placket running down chest & mid-torso
    const placketGeo = this._trackGeo(new THREE.BoxGeometry(0.032, 0.29, 0.018));
    const placket = this._makeMesh(placketGeo, this.mats.jacketTrim, { name: 'ZipperPlacket' });
    placket.position.set(0, 0.01, 0.138);
    placket.rotation.x = -0.06;
    chest.add(placket);

    const zipStripGeo = this._trackGeo(new THREE.BoxGeometry(0.008, 0.28, 0.022));
    const zipStrip = this._makeMesh(zipStripGeo, this.mats.brass, { name: 'BrassZipper' });
    zipStrip.position.set(0, 0.01, 0.14);
    zipStrip.rotation.x = -0.06;
    chest.add(zipStrip);

    // Brass snap buttons along front storm placket
    const btnGeo = this._trackGeo(new THREE.CylinderGeometry(0.0068, 0.0068, 0.007, 10));
    btnGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const btn = this._makeMesh(btnGeo, this.mats.brass, { name: `JacketButton_${i}` });
      btn.position.set(0.011, 0.105 - i * 0.068, 0.146 - i * 0.003);
      chest.add(btn);
    }

    // Chest flap pockets with brass snaps
    const pktBodyGeo = this._trackGeo(new THREE.BoxGeometry(0.088, 0.085, 0.02));
    const pktFlapGeo = this._trackGeo(new THREE.BoxGeometry(0.092, 0.026, 0.024));
    for (const s of [1, -1]) {
      const grp = new THREE.Group();
      grp.position.set(s * 0.095, 0.035, 0.132);
      grp.rotation.y = s * 0.22;
      grp.rotation.x = -0.08;
      grp.add(this._makeMesh(pktBodyGeo, this.mats.jacket, { name: `ChestPocket_${s > 0 ? 'L' : 'R'}` }));
      const flap = this._makeMesh(pktFlapGeo, this.mats.jacketTrim, { name: `ChestPocketFlap_${s > 0 ? 'L' : 'R'}` });
      flap.position.set(0, 0.036, 0.003);
      grp.add(flap);
      const snap = this._makeMesh(btnGeo, this.mats.brass, { name: `ChestPocketSnap_${s > 0 ? 'L' : 'R'}` });
      snap.position.set(0, 0.034, 0.016);
      grp.add(snap);
      chest.add(grp);
    }

    // Henley undershirt V-peek at collarbone
    const shirtGeo = this._createSculptedLoft(
      [
        { y: 0.125, rx: 0.068, rz: 0.072 },
        { y: 0.175, rx: 0.062, rz: 0.066 },
      ],
      16
    );
    chest.add(this._makeMesh(shirtGeo, this.mats.shirt, { name: 'HenleyCollarPeek' }));

    // Folded storm collar wrapping around neck base
    const collarGeo = this._createSculptedLoft(
      [
        { y: 0.142, rx: 0.088, rz: 0.092, frontScale: 0.94, backScale: 1.08 },
        { y: 0.182, rx: 0.098, rz: 0.098, frontScale: 0.88, backScale: 1.15 },
        { y: 0.215, rx: 0.106, rz: 0.102, frontScale: 0.82, backScale: 1.18 },
        { y: 0.205, rx: 0.088, rz: 0.088, frontScale: 0.86, backScale: 1.06 },
      ],
      20,
      { capBottom: false, capTop: false }
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
    // Sculpt subtle eye socket recesses, cheekbone prominence, and temple definition directly in vertices
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

    // Upper lip ridge
    const upperLipGeo = this._trackGeo(new THREE.SphereGeometry(0.024, 12, 8));
    upperLipGeo.scale(1.18, 0.34, 0.58);
    const upperLip = this._makeMesh(upperLipGeo, this.mats.lips, { name: 'UpperLip', isHead: true });
    upperLip.position.set(0, -0.014, 0.098);
    head.add(upperLip);

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

    const lowerLipGeo = this._trackGeo(new THREE.SphereGeometry(0.021, 12, 8));
    lowerLipGeo.scale(1.12, 0.36, 0.56);
    const lowerLip = this._makeMesh(lowerLipGeo, this.mats.lips, { name: 'LowerLip', isHead: true });
    lowerLip.position.set(0, 0.014, 0.063);
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

    // 5. Eyes (white sclera + hazel-blue iris + pupil) & curved articulating eyelids
    const eyeGeo = this._trackGeo(new THREE.SphereGeometry(0.0138, 16, 14));
    // Rotate sphere so +Y UV pole (pupil/iris center) faces straight forward (+Z)
    eyeGeo.rotateX(Math.PI / 2);

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

    // 7. Layered tousled chestnut hair cap & organic sculpted tufts
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

    // 18 layered sculpted chestnut hair tufts swept naturally across crown, forehead, and temples
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

    const tuftSpecs = [
      // Swept forehead fringe tufts (tousled outdoor explorer silhouette)
      { p: [-0.042, 0.132, 0.068], r: [1.18, -0.35, -0.52], s: [1.1, 0.92, 0.9] },
      { p: [-0.012, 0.144, 0.075], r: [1.26, -0.1, -0.32], s: [1.18, 0.98, 0.95] },
      { p: [0.022, 0.142, 0.074], r: [1.22, 0.18, -0.18], s: [1.15, 0.95, 0.9] },
      { p: [0.052, 0.128, 0.062], r: [1.1, 0.45, 0.35], s: [1.0, 0.88, 0.88] },
      // Crown volume tufts (swept sleekly over cranium so crown height rests around ~1.78-1.80m)
      { p: [0.0, 0.145, 0.025], r: [1.05, 0.08, -0.25], s: [1.3, 0.78, 0.95] },
      { p: [-0.038, 0.142, 0.012], r: [0.92, -0.4, -0.58], s: [1.18, 0.75, 0.9] },
      { p: [0.038, 0.14, 0.014], r: [0.94, 0.38, 0.46], s: [1.18, 0.75, 0.9] },
      { p: [0.0, 0.142, -0.028], r: [-1.08, 0.0, 0.12], s: [1.35, 0.82, 0.95] },
      { p: [-0.046, 0.135, -0.035], r: [-1.05, -0.45, -0.55], s: [1.18, 0.82, 0.92] },
      { p: [0.046, 0.135, -0.035], r: [-1.05, 0.45, 0.55], s: [1.18, 0.82, 0.92] },
      // Left & Right side / temple tufts
      { p: [0.076, 0.105, 0.035], r: [0.55, 0.95, 1.55], s: [0.95, 0.88, 0.85] },
      { p: [-0.076, 0.105, 0.035], r: [0.55, -0.95, -1.55], s: [0.95, 0.88, 0.85] },
      { p: [0.082, 0.082, -0.01], r: [-0.35, 1.3, 1.75], s: [0.92, 0.92, 0.85] },
      { p: [-0.082, 0.082, -0.01], r: [-0.35, -1.3, -1.75], s: [0.92, 0.92, 0.85] },
      // Lower rear tousled layers
      { p: [0.0, 0.095, -0.092], r: [-2.15, 0.0, 0.08], s: [1.35, 1.05, 0.95] },
      { p: [0.045, 0.088, -0.082], r: [-2.12, 0.42, 0.25], s: [1.2, 0.98, 0.9] },
      { p: [-0.045, 0.088, -0.082], r: [-2.12, -0.42, -0.25], s: [1.2, 0.98, 0.9] },
      { p: [0.01, 0.052, -0.098], r: [-2.42, 0.1, -0.1], s: [1.25, 0.85, 0.85] },
    ];

    tuftSpecs.forEach((t, idx) => {
      const m = this._makeMesh(tuftGeo, this.mats.hair, { name: `HairTuft_${idx}`, isHead: true });
      m.position.set(t.p[0], t.p[1], t.p[2]);
      m.rotation.set(
        t.r[0] + (tuftRng() - 0.5) * 0.1,
        t.r[1] + (tuftRng() - 0.5) * 0.1,
        t.r[2] + (tuftRng() - 0.5) * 0.1
      );
      m.scale.set(t.s[0], t.s[1], t.s[2]);
      head.add(m);
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

    // Sculpted palm (thinner along X because palm faces inward toward body, wider along Z!)
    const palmGeo = this._createSculptedLoft(
      [
        { y: -0.082, rx: 0.015, rz: 0.04 },
        { y: -0.048, rx: 0.019, rz: 0.044, frontScale: 1.05 },
        { y: -0.015, rx: 0.021, rz: 0.036 },
        { y: 0.008, rx: 0.022, rz: 0.031 },
      ],
      14
    );
    this._tagSweatMask(palmGeo, () => 0.3);

    const fingerGeo = this._createSculptedLoft(
      [
        { y: -0.072, rx: 0.0052, rz: 0.0056 },
        { y: -0.045, rx: 0.0072, rz: 0.0078 },
        { y: -0.015, rx: 0.0084, rz: 0.0088 },
        { y: 0.006, rx: 0.0086, rz: 0.0088 },
      ],
      10
    );
    this._tagSweatMask(fingerGeo, () => 0.25);

    const thumbGeo = this._createSculptedLoft(
      [
        { y: -0.056, rx: 0.0068, rz: 0.0072 },
        { y: -0.028, rx: 0.0092, rz: 0.0098 },
        { y: 0.004, rx: 0.0108, rz: 0.0112 },
      ],
      10
    );
    this._tagSweatMask(thumbGeo, () => 0.25);

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
      const fingers = this.bones[`fingers${side}`];

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

      // Articulated thumb positioned on forward (+Z) inner edge of palm
      const thumb = this._makeMesh(thumbGeo, this.mats.skin, { name: `Thumb${side}` });
      thumb.position.set(-s * 0.006, -0.032, 0.034);
      thumb.rotation.x = -0.52;
      thumb.rotation.z = -s * 0.25;
      hand.add(thumb);

      // 4 sculpted fingers mounted on articulated fingers bone
      const fingerLayouts = [
        { z: 0.028, len: 0.94, splay: 0.08 },   // index
        { z: 0.010, len: 1.04, splay: 0.02 },   // middle
        { z: -0.008, len: 0.96, splay: -0.04 }, // ring
        { z: -0.025, len: 0.78, splay: -0.11 }, // pinky
      ];
      fingerLayouts.forEach((f, idx) => {
        const fMesh = this._makeMesh(fingerGeo, this.mats.skin, { name: `Finger${side}_${idx}` });
        fMesh.position.set(0, 0, f.z);
        fMesh.scale.set(1.0, f.len, 1.0);
        fMesh.rotation.x = -f.splay;
        fingers.add(fMesh);
      });
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

    // Sternum cross-strap with brass clasp
    const sternumGeo = this._trackGeo(new THREE.BoxGeometry(0.285, 0.022, 0.014));
    const sternum = this._makeMesh(sternumGeo, this.mats.darkLeather, { name: 'SternumStrap' });
    sternum.position.set(0, 0.04, 0.145);
    chest.add(sternum);

    const claspGeo = this._trackGeo(new THREE.BoxGeometry(0.032, 0.028, 0.02));
    const clasp = this._makeMesh(claspGeo, this.mats.brass, { name: 'SternumClasp' });
    clasp.position.set(0, 0.04, 0.148);
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
