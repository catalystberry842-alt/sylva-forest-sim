import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { createRng, clamp, lerp, smoothstep, smootherstep } from '../utils/random.js';

export const TERRAIN_SIZE = 240;
export const TERRAIN_SEGMENTS = 256;
export const WATER_LEVEL = 0.0;
export const CLEARING_CENTER = new THREE.Vector2(10.5, 6.0);
export const CLEARING_RADIUS = 11.5;

/**
 * Procedural 240x240 terrain with 5-octave Simplex hills, a smooth sinusoidal
 * meandering stream valley below y = 0, a flat mossy central campfire clearing,
 * and a custom PBR 4-biome splat-blended shader with procedural diffuse, roughness,
 * normal maps, wetness sheen, and shallow riverbed caustics.
 */
export class Terrain {
  constructor(seed = 4242) {
    this.size = TERRAIN_SIZE;
    this.segments = TERRAIN_SEGMENTS;
    this.waterLevel = WATER_LEVEL;
    this.clearingCenter = CLEARING_CENTER.clone();
    this.clearingRadius = CLEARING_RADIUS;

    const rng = createRng(seed);
    this._noise2D = createNoise2D(rng);
    this._noiseDetail = createNoise2D(createRng(seed + 77));

    this.uniforms = {
      uTime: { value: 0 },
      uWetness: { value: 0 },
      uWaterLevel: { value: WATER_LEVEL },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.4).normalize() },
      uSunIntensity: { value: 1.0 },
      uClearingCenter: { value: this.clearingCenter.clone() },
      uClearingRadius: { value: this.clearingRadius },
      uTileScale: { value: 0.16 },
    };

    this._textures = this._generateBiomeTextures();
    this.geometry = this._buildGeometry();
    this.material = this._buildMaterial();

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.name = 'ForestTerrain';
  }

  /**
   * Smooth meandering stream centerline X as a function of Z.
   */
  getStreamCenterX(z) {
    return (
      -15.0 +
      Math.sin(z * 0.032) * 18.5 +
      Math.sin(z * 0.078 + 1.15) * 5.2 +
      Math.cos(z * 0.017 - 0.6) * 4.0
    );
  }

  /**
   * Derivative dX/dZ of the stream centerline for uniform perpendicular width and flow direction.
   */
  getStreamSlope(z) {
    return (
      Math.cos(z * 0.032) * 18.5 * 0.032 +
      Math.cos(z * 0.078 + 1.15) * 5.2 * 0.078 -
      Math.sin(z * 0.017 - 0.6) * 4.0 * 0.017
    );
  }

  /**
   * Stream half-width varies gently along its length for organic pools and narrows.
   */
  getStreamHalfWidth(z) {
    return 4.3 + Math.sin(z * 0.055 + 0.5) * 0.95 + Math.cos(z * 0.12) * 0.35;
  }

  /**
   * Approximate perpendicular distance from (x, z) to the meandering stream centerline.
   */
  getStreamDistance(x, z) {
    const cx = this.getStreamCenterX(z);
    const slope = this.getStreamSlope(z);
    return Math.abs(x - cx) / Math.sqrt(1 + slope * slope);
  }

  /**
   * Normalized downstream flow vector (flowing from -Z toward +Z).
   */
  getStreamFlowDir(z, target = new THREE.Vector2()) {
    const slope = this.getStreamSlope(z);
    return target.set(slope, 1.0).normalize();
  }

  getClearingDistance(x, z) {
    const dx = x - this.clearingCenter.x;
    const dz = z - this.clearingCenter.y;
    return Math.sqrt(dx * dx + dz * dz);
  }

  getClearingCenter3D(target = new THREE.Vector3()) {
    const y = this.getHeightAt(this.clearingCenter.x, this.clearingCenter.y);
    return target.set(this.clearingCenter.x, y, this.clearingCenter.y);
  }

  /**
   * Multi-octave 5-layer Simplex noise heightfield with meandering stream channel carving
   * and flat central mossy campfire clearing.
   */
  getHeightAt(x, z) {
    // 5 octaves of Simplex noise for rolling forest hills and ridges
    let amp = 6.6;
    let freq = 0.0085;
    let elevation = 0;
    for (let o = 0; o < 5; o++) {
      elevation += this._noise2D(x * freq + o * 19.3, z * freq - o * 13.7) * amp;
      amp *= 0.48;
      freq *= 2.08;
    }

    // Subtle ridge sharpness on higher hills
    const ridgeNoise = 1.0 - Math.abs(this._noiseDetail(x * 0.012 + 4.2, z * 0.012 - 2.8));
    const ridgeBoost = ridgeNoise * ridgeNoise * 3.4;

    // Gentle valley amphitheater rise toward forest edges so distant treeline frames the horizon
    const radial = Math.sqrt(x * x + z * z) / (this.size * 0.5);
    const rimRise = smoothstep(0.48, 1.08, radial) * 11.5;

    let h = 2.6 + elevation + ridgeBoost + rimRise;

    // Flatten a natural mossy clearing for the campfire (smoothly elevated above stream)
    const distClearing = this.getClearingDistance(x, z);
    if (distClearing < this.clearingRadius * 1.65) {
      const clearBlend = 1.0 - smootherstep(5.8, this.clearingRadius * 1.55, distClearing);
      const subtleUndulation = this._noiseDetail(x * 0.11, z * 0.11) * 0.09;
      const clearingTargetY = 2.15 + subtleUndulation;
      h = lerp(h, clearingTargetY, clearBlend);
    }

    // Carve meandering valley & stream bed smoothly below y = 0
    const distStream = this.getStreamDistance(x, z);
    const halfW = this.getStreamHalfWidth(z);
    const valleyWidth = halfW + 13.5;

    if (distStream < valleyWidth) {
      // Gentle outer valley bank slope bringing surrounding hills down toward the stream
      const bankT = smootherstep(halfW * 0.85, valleyWidth, distStream);
      const bankTarget = 0.35 + (distStream - halfW) * 0.14;
      const valleyBlend = (1.0 - bankT) * 0.86;
      h = lerp(h, Math.min(h, Math.max(bankTarget, -0.2)), valleyBlend);

      // Inner river channel carving below WATER_LEVEL (y = 0) to a realistic knee-to-thigh wading depth
      if (distStream < halfW * 1.45) {
        const channelT = smootherstep(0.0, halfW * 1.38, distStream);
        const bedRipples = this._noiseDetail(x * 0.28, z * 0.28) * 0.11;
        const bedDepth = -0.76 + bedRipples;
        const carved = lerp(bedDepth, 0.42, channelT);
        const carveMask = 1.0 - smootherstep(halfW * 0.92, halfW * 1.45, distStream);
        h = lerp(h, Math.min(h, carved), carveMask);
      }
    }

    return h;
  }

  getNormalAt(x, z, target = new THREE.Vector3()) {
    const eps = 0.35;
    const hL = this.getHeightAt(x - eps, z);
    const hR = this.getHeightAt(x + eps, z);
    const hD = this.getHeightAt(x, z - eps);
    const hU = this.getHeightAt(x, z + eps);
    return target.set(hL - hR, 2.0 * eps, hD - hU).normalize();
  }

  getSlopeAt(x, z) {
    const n = this.getNormalAt(x, z);
    return clamp(1.0 - n.y, 0, 1);
  }

  _buildGeometry() {
    const geo = new THREE.PlaneGeometry(this.size, this.size, this.segments, this.segments);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, this.getHeightAt(x, z));
    }

    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Generates seamless procedural RGBA (albedo + roughness in alpha) and tangent normal
   * textures for all 4 biomes:
   *   0: Rich forest soil & fallen pine needle litter
   *   1: Lush forest moss
   *   2: Wet dark river pebbles & mud
   *   3: Steep cliff rock (layered granite/slate)
   */
  _generateBiomeTextures() {
    const size = 256;
    const biomes = [
      this._createBiomePair(size, 'soil', 101),
      this._createBiomePair(size, 'moss', 202),
      this._createBiomePair(size, 'pebbles', 303),
      this._createBiomePair(size, 'rock', 404),
    ];
    return {
      soil: biomes[0],
      moss: biomes[1],
      pebbles: biomes[2],
      rock: biomes[3],
    };
  }

  _createBiomePair(size, type, seed) {
    const rng = createRng(seed);
    const noise = createNoise2D(rng);
    const noise2 = createNoise2D(createRng(seed + 55));

    // Periodic tiling helper via 2D blend across borders
    const tileNoise = (nx, ny, freq, fn) => {
      const s = freq;
      const a = fn(nx * s, ny * s);
      const b = fn((nx - 1) * s, ny * s);
      const c = fn(nx * s, (ny - 1) * s);
      const d = fn((nx - 1) * s, (ny - 1) * s);
      const wx = smoothstep(0.0, 1.0, nx);
      const wy = smoothstep(0.0, 1.0, ny);
      return lerp(lerp(a, b, wx), lerp(c, d, wx), wy);
    };

    const heightBuf = new Float32Array(size * size);
    const albedoCanvas = document.createElement('canvas');
    albedoCanvas.width = size;
    albedoCanvas.height = size;
    const actx = albedoCanvas.getContext('2d');
    const aImg = actx.createImageData(size, size);
    const ad = aImg.data;

    // Pre-generate pebbles/needles data for rich detail
    const pebbles = [];
    if (type === 'pebbles') {
      for (let i = 0; i < 190; i++) {
        pebbles.push({
          x: rng() * size,
          y: rng() * size,
          rx: 4 + rng() * 11,
          ry: 3 + rng() * 8,
          ang: rng() * Math.PI,
          tone: 0.65 + rng() * 0.55,
          warm: rng() * 0.16 - 0.06,
        });
      }
    }

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const idx = y * size + x;
        const pIdx = idx * 4;

        const fbm =
          tileNoise(u, v, 5.0, noise) * 0.55 +
          tileNoise(u, v, 11.0, noise2) * 0.3 +
          tileNoise(u, v, 23.0, noise) * 0.15;
        const n = fbm * 0.5 + 0.5;
        const fine = tileNoise(u, v, 36.0, noise2) * 0.5 + 0.5;

        let r = 80;
        let g = 70;
        let b = 55;
        let rough = 0.85;
        let hVal = n;

        if (type === 'soil') {
          // Rich dark humus soil with reddish-brown fallen pine needles & organic flecks
          const humus = clamp(n * 0.8 + fine * 0.25, 0, 1);
          r = lerp(42, 86, humus);
          g = lerp(31, 61, humus);
          b = lerp(22, 38, humus);
          rough = lerp(0.95, 0.78, fine);
          hVal = humus * 0.7 + fine * 0.3;
        } else if (type === 'moss') {
          // Velvety emerald & chartreuse moss tufts
          const tuft = clamp(Math.pow(n, 0.9) * 0.8 + fine * 0.2, 0, 1);
          r = lerp(28, 78, tuft);
          g = lerp(62, 118, tuft);
          b = lerp(22, 42, tuft);
          rough = lerp(0.95, 0.82, tuft);
          hVal = n * 0.86 + fine * 0.14;
        } else if (type === 'pebbles') {
          // Dark wet river silt base (pebbles overlaid right after)
          const mud = clamp(n * 0.65 + fine * 0.35, 0, 1);
          r = lerp(28, 52, mud);
          g = lerp(27, 49, mud);
          b = lerp(24, 44, mud);
          rough = lerp(0.45, 0.28, mud);
          hVal = mud * 0.35;
        } else if (type === 'rock') {
          // Layered cliff granite/slate with crisp strata & subtle lichen
          const strata = Math.sin((v * 8.0 + n * 1.8) * Math.PI) * 0.5 + 0.5;
          const crack = 1.0 - Math.abs(tileNoise(u, v, 9.0, noise2));
          const rockVal = clamp(n * 0.45 + strata * 0.32 + crack * crack * 0.28, 0, 1);
          r = lerp(52, 118, rockVal);
          g = lerp(54, 118, rockVal);
          b = lerp(56, 115, rockVal);
          // Occasional pale sage lichen speck
          if (fine > 0.78 && n > 0.55) {
            r = lerp(r, 86, 0.45);
            g = lerp(g, 102, 0.45);
            b = lerp(b, 72, 0.45);
          }
          rough = lerp(0.92, 0.66, rockVal);
          hVal = rockVal;
        }

        ad[pIdx] = clamp(Math.round(r), 0, 255);
        ad[pIdx + 1] = clamp(Math.round(g), 0, 255);
        ad[pIdx + 2] = clamp(Math.round(b), 0, 255);
        ad[pIdx + 3] = clamp(Math.round(rough * 255), 0, 255); // Alpha packs roughness!
        heightBuf[idx] = hVal;
      }
    }

    // Add procedural pine needle litter strokes for soil
    if (type === 'soil') {
      for (let i = 0; i < 650; i++) {
        const sx = rng() * size;
        const sy = rng() * size;
        const len = 5 + rng() * 11;
        const ang = rng() * Math.PI * 2;
        const dx = Math.cos(ang);
        const dy = Math.sin(ang);
        const nr = Math.round(92 + rng() * 44);
        const ng = Math.round(58 + rng() * 30);
        const nb = Math.round(28 + rng() * 18);
        const steps = Math.ceil(len);
        for (let s = 0; s <= steps; s++) {
          const px = ((Math.round(sx + dx * s) % size) + size) % size;
          const py = ((Math.round(sy + dy * s) % size) + size) % size;
          const idx = py * size + px;
          const pIdx = idx * 4;
          ad[pIdx] = Math.round(lerp(ad[pIdx], nr, 0.65));
          ad[pIdx + 1] = Math.round(lerp(ad[pIdx + 1], ng, 0.65));
          ad[pIdx + 2] = Math.round(lerp(ad[pIdx + 2], nb, 0.65));
          heightBuf[idx] = Math.min(1.0, heightBuf[idx] + 0.16);
        }
      }
    }

    // Stamp smooth tile-wrapped wet river pebbles onto pebbles biome
    if (type === 'pebbles') {
      for (const p of pebbles) {
        const cosA = Math.cos(p.ang);
        const sinA = Math.sin(p.ang);
        const rad = Math.ceil(Math.max(p.rx, p.ry)) + 1;
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            const lx = (dx * cosA + dy * sinA) / p.rx;
            const ly = (-dx * sinA + dy * cosA) / p.ry;
            const d2 = lx * lx + ly * ly;
            if (d2 < 1.0) {
              const dome = Math.sqrt(1.0 - d2);
              const px = ((Math.round(p.x + dx) % size) + size) % size;
              const py = ((Math.round(p.y + dy) % size) + size) % size;
              const idx = py * size + px;
              const hNew = 0.35 + dome * 0.65;
              if (hNew > heightBuf[idx]) {
                heightBuf[idx] = hNew;
                const pIdx = idx * 4;
                const shade = (0.55 + dome * 0.45) * p.tone;
                ad[pIdx] = clamp(Math.round((66 + p.warm * 80) * shade), 0, 255);
                ad[pIdx + 1] = clamp(Math.round((64 + p.warm * 40) * shade), 0, 255);
                ad[pIdx + 2] = clamp(Math.round((60 - p.warm * 40) * shade), 0, 255);
                ad[pIdx + 3] = clamp(Math.round((0.24 + (1 - dome) * 0.22) * 255), 0, 255);
              }
            }
          }
        }
      }
    }

    // Build albedo+roughness texture (preserve raw alpha roughness without premultiply distortion)
    const albedoRoughTex = new THREE.DataTexture(
      new Uint8Array(ad),
      size,
      size,
      THREE.RGBAFormat
    );
    albedoRoughTex.wrapS = THREE.RepeatWrapping;
    albedoRoughTex.wrapT = THREE.RepeatWrapping;
    albedoRoughTex.magFilter = THREE.LinearFilter;
    albedoRoughTex.minFilter = THREE.LinearMipmapLinearFilter;
    albedoRoughTex.generateMipmaps = true;
    albedoRoughTex.colorSpace = THREE.NoColorSpace; // manual sRGB->linear on .rgb in shader so .a stays exact linear roughness!
    albedoRoughTex.needsUpdate = true;

    // Sobel height-to-tangent-normal map
    const normalData = new Uint8Array(size * size * 4);
    const strength =
      type === 'rock' ? 2.2 : type === 'pebbles' ? 1.85 : type === 'soil' ? 0.95 : 0.48;
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

        const pIdx = (y * size + x) * 4;
        normalData[pIdx] = Math.round((nx * 0.5 + 0.5) * 255);
        normalData[pIdx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        normalData[pIdx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        normalData[pIdx + 3] = 255;
      }
    }

    const normalTex = new THREE.DataTexture(normalData, size, size, THREE.RGBAFormat);
    normalTex.wrapS = THREE.RepeatWrapping;
    normalTex.wrapT = THREE.RepeatWrapping;
    normalTex.magFilter = THREE.LinearFilter;
    normalTex.minFilter = THREE.LinearMipmapLinearFilter;
    normalTex.generateMipmaps = true;
    normalTex.colorSpace = THREE.NoColorSpace;
    normalTex.needsUpdate = true;

    return { albedoRough: albedoRoughTex, normal: normalTex };
  }

  _buildMaterial() {
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.0,
    });

    const tex = this._textures;
    const sharedUniforms = this.uniforms;

    material.customProgramCacheKey = () => 'forestTerrainSplatPBR_v1';
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uSoilTex = { value: tex.soil.albedoRough };
      shader.uniforms.uSoilNorm = { value: tex.soil.normal };
      shader.uniforms.uMossTex = { value: tex.moss.albedoRough };
      shader.uniforms.uMossNorm = { value: tex.moss.normal };
      shader.uniforms.uPebbleTex = { value: tex.pebbles.albedoRough };
      shader.uniforms.uPebbleNorm = { value: tex.pebbles.normal };
      shader.uniforms.uRockTex = { value: tex.rock.albedoRough };
      shader.uniforms.uRockNorm = { value: tex.rock.normal };

      Object.assign(shader.uniforms, sharedUniforms);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTerrainWorldPos;
        varying vec3 vTerrainWorldNormal;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 twp = modelMatrix * vec4( transformed, 1.0 );
        vTerrainWorldPos = twp.xyz;
        vTerrainWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uSoilTex;
        uniform sampler2D uSoilNorm;
        uniform sampler2D uMossTex;
        uniform sampler2D uMossNorm;
        uniform sampler2D uPebbleTex;
        uniform sampler2D uPebbleNorm;
        uniform sampler2D uRockTex;
        uniform sampler2D uRockNorm;
        uniform float uTime;
        uniform float uWetness;
        uniform float uWaterLevel;
        uniform vec3 uSunDir;
        uniform float uSunIntensity;
        uniform vec2 uClearingCenter;
        uniform float uClearingRadius;
        uniform float uTileScale;

        varying vec3 vTerrainWorldPos;
        varying vec3 vTerrainWorldNormal;

        float tHash( vec2 p ) {
          return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
        }

        float tNoise( vec2 p ) {
          vec2 i = floor( p );
          vec2 f = fract( p );
          vec2 u = f * f * ( 3.0 - 2.0 * f );
          return mix(
            mix( tHash( i ), tHash( i + vec2( 1.0, 0.0 ) ), u.x ),
            mix( tHash( i + vec2( 0.0, 1.0 ) ), tHash( i + vec2( 1.0, 1.0 ) ), u.x ),
            u.y
          );
        }

        float tFbm( vec2 p ) {
          float v = 0.0;
          float a = 0.5;
          for ( int i = 0; i < 3; i++ ) {
            v += a * tNoise( p );
            p = p * 2.03 + vec2( 17.1, 31.7 );
            a *= 0.5;
          }
          return v;
        }

        vec3 srgbToLinearApprox( vec3 c ) {
          return pow( max( c, vec3( 0.0 ) ), vec3( 2.2 ) );
        }

        // Shallow riverbed caustic shimmer
        float riverbedCaustics( vec2 xz, float time ) {
          vec2 p1 = xz * 0.95 + vec2( time * 0.22, -time * 0.55 );
          vec2 p2 = xz * 1.35 + vec2( -time * 0.18, -time * 0.42 );
          float w1 = sin( p1.x * 2.7 + sin( p1.y * 2.1 + time * 0.9 ) );
          float w2 = sin( p2.y * 3.1 + cos( p2.x * 2.4 - time * 1.1 ) );
          float c = pow( clamp( ( w1 * w2 ) * 0.5 + 0.5, 0.0, 1.0 ), 3.2 );
          return c;
        }`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec3 wNormal = normalize( vTerrainWorldNormal );
        float slope = 1.0 - clamp( wNormal.y, 0.0, 1.0 );
        vec2 worldUv = vTerrainWorldPos.xz * uTileScale;
        vec2 macroUv = vTerrainWorldPos.xz * 0.045;

        float macroPatch = tFbm( macroUv );
        float microPatch = tNoise( vTerrainWorldPos.xz * 0.24 );

        // Sample all 4 biome diffuse+roughness textures (rgb=sRGB albedo, a=linear roughness)
        vec4 sSoil = texture2D( uSoilTex, worldUv * 1.15 );
        vec4 sMoss = texture2D( uMossTex, worldUv * 1.05 );
        vec4 sPebble = texture2D( uPebbleTex, worldUv * 1.45 );
        vec4 sRock = texture2D( uRockTex, worldUv * 0.72 );

        // Dynamic biome splat weights
        // 1. Steep cliff rock driven by world normal slope
        float wRock = smoothstep( 0.17, 0.44, slope + ( macroPatch - 0.5 ) * 0.08 );

        // 2. Wet pebbles & mud near and below water level (y < 0.4)
        float wPebble = 1.0 - smoothstep( uWaterLevel + 0.05, uWaterLevel + 0.58 + ( microPatch - 0.5 ) * 0.22, vTerrainWorldPos.y );
        wPebble *= ( 1.0 - wRock * 0.75 );

        // 3. Lush moss vs rich forest soil/pine litter (richer moss in clearing & moist banks)
        float distClear = length( vTerrainWorldPos.xz - uClearingCenter );
        float clearingMossBoost = ( 1.0 - smoothstep( 4.0, uClearingRadius * 1.2, distClear ) ) * 0.38;
        float bankMossBoost = ( 1.0 - smoothstep( 0.4, 2.6, vTerrainWorldPos.y ) ) * 0.25;
        float mossMask = smoothstep( 0.34, 0.68, macroPatch + clearingMossBoost + bankMossBoost - slope * 0.65 );

        float rem = max( 1.0 - wRock - wPebble, 0.0 );
        float wMoss = rem * mossMask;
        float wSoil = rem * ( 1.0 - mossMask );

        // Normalize weights
        float wSum = max( wSoil + wMoss + wPebble + wRock, 0.0001 );
        wSoil /= wSum;
        wMoss /= wSum;
        wPebble /= wSum;
        wRock /= wSum;

        // Macro tonal variation to prevent visible tiling over 240x240 units
        float macroTint = mix( 0.84, 1.14, macroPatch );

        vec3 blendedAlbedo =
          srgbToLinearApprox( sSoil.rgb ) * wSoil +
          srgbToLinearApprox( sMoss.rgb ) * wMoss +
          srgbToLinearApprox( sPebble.rgb ) * wPebble +
          srgbToLinearApprox( sRock.rgb ) * wRock;

        blendedAlbedo *= macroTint;

        // Shoreline wet band + weather rain wetness darkening
        float shoreWet = 1.0 - smoothstep( uWaterLevel - 0.05, uWaterLevel + 0.52, vTerrainWorldPos.y );
        float localWet = clamp( max( shoreWet, uWetness ), 0.0, 1.0 );
        blendedAlbedo *= mix( 1.0, 0.58, localWet * 0.85 );

        // Subtle projected caustics on shallow riverbed below water surface
        if ( vTerrainWorldPos.y < uWaterLevel + 0.03 ) {
          float waterDepth = max( uWaterLevel - vTerrainWorldPos.y, 0.0 );
          float depthFade = exp( -waterDepth * 1.15 ) * smoothstep( 0.0, 0.08, waterDepth + 0.02 );
          float caust = riverbedCaustics( vTerrainWorldPos.xz, uTime );
          blendedAlbedo += vec3( 0.28, 0.42, 0.36 ) * caust * depthFade * max( uSunIntensity, 0.12 ) * 0.65;
        }

        diffuseColor.rgb *= blendedAlbedo;
        float splatRoughness = sSoil.a * wSoil + sMoss.a * wMoss + sPebble.a * wPebble + sRock.a * wRock;
        splatRoughness = mix( splatRoughness, 0.16, localWet * 0.82 );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor *= clamp( splatRoughness, 0.12, 0.98 );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec3 nSoil = texture2D( uSoilNorm, worldUv * 1.15 ).xyz * 2.0 - 1.0;
          vec3 nMoss = texture2D( uMossNorm, worldUv * 1.05 ).xyz * 2.0 - 1.0;
          vec3 nPebble = texture2D( uPebbleNorm, worldUv * 1.45 ).xyz * 2.0 - 1.0;
          vec3 nRock = texture2D( uRockNorm, worldUv * 0.72 ).xyz * 2.0 - 1.0;

          vec3 blendedMapN = normalize( nSoil * wSoil + nMoss * wMoss + nPebble * wPebble + nRock * wRock );
          blendedMapN.xy *= 0.62;
          blendedMapN = normalize( blendedMapN );

          // Construct analytical tangent frame on the heightfield in world space
          vec3 wn = normalize( vTerrainWorldNormal );
          vec3 wt = normalize( vec3( wn.y, -wn.x, 0.0 ) );
          vec3 wb = normalize( cross( wn, wt ) );
          vec3 perturbedWorldN = normalize( wt * blendedMapN.x + wb * blendedMapN.y + wn * blendedMapN.z );

          // Convert world perturbed normal into view space for PBR lighting
          normal = normalize( ( viewMatrix * vec4( perturbedWorldN, 0.0 ) ).xyz );
        }`
      );
    };

    return material;
  }

  update(elapsed, { sunDir, sunIntensity = 1.0, wetness = 0.0 } = {}) {
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uWetness.value = wetness;
    this.uniforms.uSunIntensity.value = sunIntensity;
    if (sunDir) {
      this.uniforms.uSunDir.value.copy(sunDir);
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    for (const biome of Object.values(this._textures)) {
      biome.albedoRough.dispose();
      biome.normal.dispose();
    }
  }
}
