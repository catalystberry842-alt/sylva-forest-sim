import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';
import { createRng, clamp, lerp, smoothstep } from '../utils/random.js';

const MAX_POLLEN = 1200;
const MAX_LEAVES = 420;
const MAX_FIREFLIES = 360;
const MAX_RAIN = 3400;
const MAX_SHELTER_BOXES = 4;

const QUALITY_COUNTS = {
  medium: {
    pollen: 600,
    leaves: 210,
    fireflies: 180,
    rain: 1700,
  },
  high: {
    pollen: 950,
    leaves: 320,
    fireflies: 280,
    rain: 2600,
  },
  ultra: {
    pollen: MAX_POLLEN,
    leaves: MAX_LEAVES,
    fireflies: MAX_FIREFLIES,
    rain: MAX_RAIN,
  },
};

function getSafePixelRatio() {
  if (typeof window !== 'undefined' && window.devicePixelRatio) {
    return Math.min(window.devicePixelRatio, 2);
  }
  return 1;
}

/**
 * Four atmospheric forest particle systems:
 *  1. Daytime sunlit pollen & dust motes (GPU-wrapped glowing bokeh Points)
 *  2. Wind-carried curled falling leaves (InstancedMesh synced to windSystem gusts)
 *  3. Nocturnal 3D curl-noise fireflies (HDR bioluminescent Points triggering bloom)
 *  4. Forest rain precipitation (GPU-wrapped camera-centered diagonal LineSegments)
 */
export class Particles {
  constructor(scene, terrain, windSystem) {
    this.scene = scene;
    this.terrain = terrain;
    this.windSystem = windSystem;

    this._quality = 'ultra';
    this._limits = { ...QUALITY_COUNTS.ultra };
    this._galeBlend = 0.0;
    this._initialized = false;

    // Reusable scratch math objects (zero per-frame GC allocations)
    this._centerPos = new THREE.Vector3(10.5, 4.0, 6.0);
    this._dummyPos = new THREE.Vector3();
    this._dummyEuler = new THREE.Euler();
    this._dummyQuat = new THREE.Quaternion();
    this._dummyScale = new THREE.Vector3();
    this._dummyMat = new THREE.Matrix4();
    this._windDir2D = new THREE.Vector2(1, 0);

    // Cumulative GPU drift offsets for pollen and rain
    this._pollenDrift = new THREE.Vector3();
    this._rainFallOffset = 0.0;
    this._rainWindOffset = new THREE.Vector2();

    // Build all 4 particle systems
    this._initPollen();
    this._initLeaves();
    this._initFireflies();
    this._initRain();

    this.setQuality('Ultra');
  }

  // ---------------------------------------------------------------------------
  // 1. Daytime Sunlit Pollen & Dust Motes (1,200 GPU-wrapped glowing bokeh)
  // ---------------------------------------------------------------------------
  _initPollen() {
    const rng = createRng(1041);
    const boxX = 46.0;
    const boxY = 14.0;
    const boxZ = 46.0;

    const positions = new Float32Array(MAX_POLLEN * 3);
    const sizes = new Float32Array(MAX_POLLEN);
    const phases = new Float32Array(MAX_POLLEN * 3);
    const tints = new Float32Array(MAX_POLLEN);

    for (let i = 0; i < MAX_POLLEN; i++) {
      const i3 = i * 3;
      positions[i3] = rng() * boxX;
      positions[i3 + 1] = rng() * boxY;
      positions[i3 + 2] = rng() * boxZ;

      sizes[i] = 0.48 + Math.pow(rng(), 1.6) * 1.15;

      phases[i3] = 0.35 + rng() * 0.95; // drift frequency
      phases[i3 + 1] = rng() * Math.PI * 2.0; // X/shimmer phase
      phases[i3 + 2] = rng() * Math.PI * 2.0; // Y/Z phase

      tints[i] = rng();
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 3));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 1));

    this._pollenUniforms = {
      uTime: { value: 0.0 },
      uCenterPos: { value: this._centerPos.clone() },
      uBoxSize: { value: new THREE.Vector3(boxX, boxY, boxZ) },
      uDriftOffset: { value: new THREE.Vector3() },
      uOpacity: { value: 1.0 },
      uPixelRatio: { value: getSafePixelRatio() },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this._pollenUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute vec3 aPhase;
        attribute float aTint;

        uniform float uTime;
        uniform vec3 uCenterPos;
        uniform vec3 uBoxSize;
        uniform vec3 uDriftOffset;
        uniform float uPixelRatio;

        varying float vAlpha;
        varying float vTint;

        void main() {
          vTint = aTint;

          // Organic swirling drift + cumulative wind translation
          float driftWeight = 0.65 + aTint * 0.7;
          vec3 sway = vec3(
            sin( uTime * aPhase.x + aPhase.y ) * 0.85,
            sin( uTime * ( aPhase.x * 0.62 ) + aPhase.z ) * 0.55,
            cos( uTime * ( aPhase.x * 0.84 ) + aPhase.z ) * 0.85
          );
          vec3 rawPos = position + uDriftOffset * driftWeight + sway;

          // Seamless toroidal wrap around active camera / clearing volume
          vec3 halfBox = uBoxSize * 0.5;
          vec3 rel = mod( rawPos - uCenterPos + halfBox, uBoxSize ) - halfBox;
          vec3 worldPos = uCenterPos + rel;
          worldPos.y = max( worldPos.y, 0.35 );

          // Soft fade near outer volume boundaries and near camera lens
          float radialNorm = length( rel.xz ) / max( halfBox.x, 0.001 );
          float vertNorm = abs( rel.y ) / max( halfBox.y, 0.001 );
          float edgeFade = ( 1.0 - smoothstep( 0.62, 1.0, radialNorm ) )
                         * ( 1.0 - smoothstep( 0.58, 1.0, vertNorm ) );

          vec4 mvPosition = viewMatrix * vec4( worldPos, 1.0 );
          float viewDist = max( -mvPosition.z, 0.001 );
          float nearFade = smoothstep( 0.9, 3.4, viewDist );

          float shimmer = 0.62 + 0.38 * sin( uTime * ( 1.2 + aPhase.x * 1.4 ) + aPhase.y );
          vAlpha = edgeFade * nearFade * shimmer;

          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = clamp( aSize * uPixelRatio * ( 175.0 / viewDist ), 2.0, 28.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;

        varying float vAlpha;
        varying float vTint;

        void main() {
          vec2 p = gl_PointCoord - vec2( 0.5 );
          float r = length( p ) * 2.0;
          if ( r >= 1.0 ) {
            discard;
          }

          // Soft sunlit bokeh circle with gentle warm luminous core
          float disc = 1.0 - smoothstep( 0.25, 1.0, r );
          float core = exp( -r * r * 5.2 );
          float bokehRing = smoothstep( 0.35, 0.72, r ) * ( 1.0 - smoothstep( 0.72, 1.0, r ) ) * 0.28;
          float shape = disc * 0.55 + core * 0.65 + bokehRing;

          vec3 warmGold = vec3( 1.22, 1.06, 0.68 );
          vec3 paleCream = vec3( 1.05, 1.12, 0.88 );
          vec3 col = mix( warmGold, paleCream, vTint );

          float alpha = shape * vAlpha * uOpacity * 0.44;
          if ( alpha <= 0.002 ) {
            discard;
          }

          gl_FragColor = vec4( col * alpha, alpha );
        }
      `,
    });

    this.pollenMesh = new THREE.Points(geometry, material);
    this.pollenMesh.name = 'SunlitPollenParticles';
    this.pollenMesh.frustumCulled = false;
    this.pollenMesh.renderOrder = 5;
    this.scene.add(this.pollenMesh);
  }

  // ---------------------------------------------------------------------------
  // 2. Wind-Carried Falling Leaves (420 curled leaf InstancedMesh)
  // ---------------------------------------------------------------------------
  _createCurledLeafGeometry() {
    // Organic pointed leaf blade with gentle transverse cup & longitudinal curl
    const segU = 2; // left edge, midrib, right edge
    const segV = 4; // stem base -> broad belly -> pointed tip
    const cols = segU + 1;
    const rows = segV + 1;

    const positions = new Float32Array(cols * rows * 3);
    const uvs = new Float32Array(cols * rows * 2);

    const leafLen = 0.28;
    const maxHalfW = 0.105;

    let idx = 0;
    for (let iv = 0; iv <= segV; iv++) {
      const v = iv / segV; // 0 = stem, 1 = tip
      // Ovate botanical silhouette: widens cleanly near v=0.38, tapers sharply at tip
      const widthProfile = Math.sin(Math.pow(v, 0.74) * Math.PI);
      const halfW = maxHalfW * widthProfile;

      // Natural longitudinal arch + slight tip recurve
      const curlY = Math.sin(v * Math.PI) * 0.036 - v * v * 0.022;
      const z = (v - 0.5) * leafLen;

      for (let iu = 0; iu <= segU; iu++) {
        const u = iu / segU; // 0..1
        const side = u * 2.0 - 1.0; // -1, 0, +1
        const x = side * halfW;
        // Subtle V-shaped midrib crease so both leaf halves catch light independently
        const cupY = Math.abs(side) * widthProfile * 0.024;
        const twistY = side * (v - 0.5) * 0.018;

        const p3 = idx * 3;
        positions[p3] = x;
        positions[p3 + 1] = curlY + cupY + twistY;
        positions[p3 + 2] = z;

        const p2 = idx * 2;
        uvs[p2] = u;
        uvs[p2 + 1] = v;
        idx++;
      }
    }

    const indices = [];
    for (let iv = 0; iv < segV; iv++) {
      for (let iu = 0; iu < segU; iu++) {
        const a = iv * cols + iu;
        const b = (iv + 1) * cols + iu;
        const c = (iv + 1) * cols + iu + 1;
        const d = iv * cols + iu + 1;
        indices.push(a, b, d, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  _initLeaves() {
    const rng = createRng(2083);
    this._leafRng = rng;

    this._leafGeometry = this._createCurledLeafGeometry();
    this._leafMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.62,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });

    this.leafMesh = new THREE.InstancedMesh(
      this._leafGeometry,
      this._leafMaterial,
      MAX_LEAVES
    );
    this.leafMesh.name = 'WindFallingLeaves';
    this.leafMesh.frustumCulled = false;
    this.leafMesh.castShadow = false;
    this.leafMesh.receiveShadow = true;
    this.leafMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Rich woodland palette: olive, warm amber, deep russet, birch gold
    const leafPalette = [
      new THREE.Color(0x5e7535), // forest olive
      new THREE.Color(0x738a3e), // sunlit olive-moss
      new THREE.Color(0xc9852c), // warm amber
      new THREE.Color(0xda9b37), // golden ochre
      new THREE.Color(0x9e4522), // deep russet
      new THREE.Color(0xb6572b), // copper maple
      new THREE.Color(0xe1bc44), // birch gold
      new THREE.Color(0xc8a33a), // muted autumn gold
    ];

    this._leaves = new Array(MAX_LEAVES);
    const colTmp = new THREE.Color();

    for (let i = 0; i < MAX_LEAVES; i++) {
      const baseCol = leafPalette[Math.floor(rng() * leafPalette.length)];
      colTmp.copy(baseCol).multiplyScalar(0.84 + rng() * 0.32);
      this.leafMesh.setColorAt(i, colTmp);

      const leaf = {
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        rx: rng() * Math.PI * 2,
        ry: rng() * Math.PI * 2,
        rz: rng() * Math.PI * 2,
        vrx: (rng() - 0.5) * 3.0,
        vry: (rng() - 0.5) * 2.5,
        vrz: (rng() - 0.5) * 3.0,
        scale: 0.72 + rng() * 0.78,
        flutterPhase: rng() * Math.PI * 2,
        flutterFreq: 1.8 + rng() * 2.4,
        fallSpeed: 0.62 + rng() * 0.68,
        restTimer: 0.0,
      };
      this._respawnLeaf(leaf, this._centerPos, true);
      this._leaves[i] = leaf;
    }

    if (this.leafMesh.instanceColor) {
      this.leafMesh.instanceColor.needsUpdate = true;
    }

    this.scene.add(this.leafMesh);
  }

  _respawnLeaf(leaf, center, initialScatter = false) {
    const rng = this._leafRng;
    const radius = 34.0;

    // Bias respawns slightly upwind so leaves blow organically across the viewer's field
    const angle = rng() * Math.PI * 2.0;
    const dist = Math.sqrt(rng()) * radius;
    const upwindBias = initialScatter ? 0.0 : 12.0;

    leaf.x = center.x + Math.cos(angle) * dist - this._windDir2D.x * upwindBias;
    leaf.z = center.z + Math.sin(angle) * dist - this._windDir2D.y * upwindBias;

    const groundY = this.terrain?.getHeightAt
      ? Math.max(this.terrain.getHeightAt(leaf.x, leaf.z), this.terrain.waterLevel ?? 0.0)
      : 0.0;

    leaf.y = initialScatter
      ? groundY + 1.0 + rng() * 17.0
      : groundY + 8.5 + rng() * 12.5;

    leaf.vx = this._windDir2D.x * (0.4 + rng() * 0.9);
    leaf.vy = -leaf.fallSpeed * (0.5 + rng() * 0.5);
    leaf.vz = this._windDir2D.y * (0.4 + rng() * 0.9);
    leaf.restTimer = 0.0;
  }

  // ---------------------------------------------------------------------------
  // 3. Nocturnal Fireflies (360 particles navigated by real 3D curl noise)
  // ---------------------------------------------------------------------------
  _initFireflies() {
    const rng = createRng(3097);

    // Three independent 3D Simplex vector potential fields for true divergence-free curl noise
    this._curlNoiseX = createNoise3D(createRng(3101));
    this._curlNoiseY = createNoise3D(createRng(3102));
    this._curlNoiseZ = createNoise3D(createRng(3103));

    const positions = new Float32Array(MAX_FIREFLIES * 3);
    const phases = new Float32Array(MAX_FIREFLIES);
    const speeds = new Float32Array(MAX_FIREFLIES);
    const sizes = new Float32Array(MAX_FIREFLIES);
    const warmths = new Float32Array(MAX_FIREFLIES);

    this._fireflies = new Array(MAX_FIREFLIES);

    const clearingX = this.terrain?.clearingCenter?.x ?? 10.5;
    const clearingZ = this.terrain?.clearingCenter?.y ?? 6.0;

    for (let i = 0; i < MAX_FIREFLIES; i++) {
      // Cluster attractively around clearing, stream banks, and nearby woodland
      let fx;
      let fz;
      const zone = rng();
      if (zone < 0.42) {
        // Near campfire clearing & mossy glade
        const a = rng() * Math.PI * 2.0;
        const r = 2.0 + Math.sqrt(rng()) * 22.0;
        fx = clearingX + Math.cos(a) * r;
        fz = clearingZ + Math.sin(a) * r;
      } else if (zone < 0.76) {
        // Along meandering forest stream corridor
        fz = (rng() - 0.5) * 96.0;
        const cx = this.terrain?.getStreamCenterX
          ? this.terrain.getStreamCenterX(fz)
          : -15.0;
        fx = cx + (rng() - 0.5) * 20.0;
      } else {
        // Surrounding forest floor
        const a = rng() * Math.PI * 2.0;
        const r = 10.0 + Math.sqrt(rng()) * 42.0;
        fx = Math.cos(a) * r;
        fz = Math.sin(a) * r;
      }

      const groundY = this._sampleSafeGroundY(fx, fz);
      const targetAlt = 0.5 + rng() * 3.7; // strictly in 0.5..4.2 above terrain
      const fy = groundY + targetAlt;

      const i3 = i * 3;
      positions[i3] = fx;
      positions[i3 + 1] = fy;
      positions[i3 + 2] = fz;

      phases[i] = rng() * Math.PI * 2.0;
      speeds[i] = 1.35 + rng() * 2.25;
      sizes[i] = 0.72 + rng() * 0.78;
      warmths[i] = rng();

      this._fireflies[i] = {
        x: fx,
        y: fy,
        z: fz,
        homeX: fx,
        homeZ: fz,
        targetAlt,
        speedMult: 0.65 + rng() * 0.75,
        seedOffset: rng() * 40.0,
      };
    }

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aWarmth', new THREE.BufferAttribute(warmths, 1));

    this._fireflyPositions = positions;
    this._fireflyPosAttr = posAttr;

    this._fireflyUniforms = {
      uTime: { value: 0.0 },
      uOpacity: { value: 0.0 },
      uPixelRatio: { value: getSafePixelRatio() },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this._fireflyUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aPhase;
        attribute float aSpeed;
        attribute float aSize;
        attribute float aWarmth;

        uniform float uTime;
        uniform float uPixelRatio;

        varying float vPulse;
        varying float vWarmth;
        varying float vDistFade;

        void main() {
          vWarmth = aWarmth;

          // Asynchronous bioluminescent lantern pulse
          float wave = 0.5 + 0.5 * sin( uTime * aSpeed + aPhase );
          vPulse = 0.14 + 0.86 * pow( wave, 2.3 );

          vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
          float viewDist = max( -mvPosition.z, 0.001 );

          // Softly fade very distant fireflies into nocturnal mist
          vDistFade = ( 1.0 - smoothstep( 46.0, 92.0, viewDist ) ) * smoothstep( 0.4, 1.6, viewDist );

          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = clamp(
            aSize * uPixelRatio * ( 195.0 / viewDist ) * ( 0.75 + 0.45 * vPulse ),
            2.2,
            34.0
          );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;

        varying float vPulse;
        varying float vWarmth;
        varying float vDistFade;

        void main() {
          vec2 c = gl_PointCoord - vec2( 0.5 );
          float r = length( c ) * 2.0;
          if ( r >= 1.0 ) {
            discard;
          }

          float core = exp( -r * r * 11.0 );
          float halo = pow( max( 1.0 - r, 0.0 ), 2.6 ) * 0.55;
          float intensity = ( core + halo ) * vPulse * vDistFade * uOpacity;
          if ( intensity <= 0.002 ) {
            discard;
          }

          // HDR warm yellow-green radiance triggers UnrealBloomPass beautifully at night
          vec3 baseHDR = vec3( 1.85, 2.4, 0.55 );
          vec3 goldenHDR = vec3( 2.15, 1.95, 0.48 );
          vec3 radiance = mix( baseHDR, goldenHDR, vWarmth * 0.35 );

          // Extra white-hot bioluminescent pinpoint center
          vec3 col = radiance * ( 0.78 + core * 0.95 );
          gl_FragColor = vec4( col * intensity, clamp( intensity, 0.0, 1.0 ) );
        }
      `,
    });

    this.fireflyMesh = new THREE.Points(geometry, material);
    this.fireflyMesh.name = 'NocturnalCurlFireflies';
    this.fireflyMesh.frustumCulled = false;
    this.fireflyMesh.renderOrder = 6;
    this.fireflyMesh.visible = false;
    this.scene.add(this.fireflyMesh);
  }

  _sampleSafeGroundY(x, z) {
    const waterY = this.terrain?.waterLevel ?? 0.0;
    if (this.terrain?.getHeightAt) {
      return Math.max(this.terrain.getHeightAt(x, z), waterY);
    }
    return waterY;
  }

  _computeCurl3D(x, y, z, out) {
    const eps = 0.05;
    const inv2Eps = 0.5 / eps;
    const nX = this._curlNoiseX;
    const nY = this._curlNoiseY;
    const nZ = this._curlNoiseZ;

    const dPsiZ_dy = (nZ(x, y + eps, z) - nZ(x, y - eps, z)) * inv2Eps;
    const dPsiY_dz = (nY(x, y, z + eps) - nY(x, y, z - eps)) * inv2Eps;

    const dPsiX_dz = (nX(x, y, z + eps) - nX(x, y, z - eps)) * inv2Eps;
    const dPsiZ_dx = (nZ(x + eps, y, z) - nZ(x - eps, y, z)) * inv2Eps;

    const dPsiY_dx = (nY(x + eps, y, z) - nY(x - eps, y, z)) * inv2Eps;
    const dPsiX_dy = (nX(x, y + eps, z) - nX(x, y - eps, z)) * inv2Eps;

    out.set(dPsiZ_dy - dPsiY_dz, dPsiX_dz - dPsiZ_dx, dPsiY_dx - dPsiX_dy);
    return out;
  }

  // ---------------------------------------------------------------------------
  // 4. Forest Rain Precipitation (3,400 diagonal streaks in 64x36x64 camera box)
  // ---------------------------------------------------------------------------
  _initRain() {
    const rng = createRng(4117);
    const boxX = 64.0;
    const boxY = 36.0;
    const boxZ = 64.0;

    const vertCount = MAX_RAIN * 2;
    const positions = new Float32Array(vertCount * 3);
    const ends = new Float32Array(vertCount);
    const speeds = new Float32Array(vertCount);
    const lengths = new Float32Array(vertCount);

    for (let i = 0; i < MAX_RAIN; i++) {
      const rx = rng() * boxX;
      const ry = rng() * boxY;
      const rz = rng() * boxZ;
      const spd = 0.82 + rng() * 0.42;
      const len = 0.72 + rng() * 0.68;

      const v0 = i * 2;
      const v1 = v0 + 1;

      positions[v0 * 3] = rx;
      positions[v0 * 3 + 1] = ry;
      positions[v0 * 3 + 2] = rz;
      ends[v0] = 0.0; // upper trailing tail
      speeds[v0] = spd;
      lengths[v0] = len;

      positions[v1 * 3] = rx;
      positions[v1 * 3 + 1] = ry;
      positions[v1 * 3 + 2] = rz;
      ends[v1] = 1.0; // lower leading drop tip
      speeds[v1] = spd;
      lengths[v1] = len;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    geometry.setAttribute('aLength', new THREE.BufferAttribute(lengths, 1));

    this._rainUniforms = {
      uCenterPos: { value: this._centerPos.clone() },
      uBoxSize: { value: new THREE.Vector3(boxX, boxY, boxZ) },
      uFallOffset: { value: 0.0 },
      uWindOffset: { value: new THREE.Vector2() },
      uStreakVec: { value: new THREE.Vector3(0.18, -1.0, 0.06) },
      uRainIntensity: { value: 0.0 },
      uRainColor: { value: new THREE.Color(0xbcd0e2) },
      uShelterMin: {
        value: Array.from(
          { length: MAX_SHELTER_BOXES },
          () => new THREE.Vector3(9999, 9999, 9999)
        ),
      },
      uShelterMax: {
        value: Array.from(
          { length: MAX_SHELTER_BOXES },
          () => new THREE.Vector3(-9999, -9999, -9999)
        ),
      },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this._rainUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float aEnd;
        attribute float aSpeed;
        attribute float aLength;

        uniform vec3 uCenterPos;
        uniform vec3 uBoxSize;
        uniform float uFallOffset;
        uniform vec2 uWindOffset;
        uniform vec3 uStreakVec;

        varying float vAlpha;
        varying float vEnd;
        varying vec3 vWorldPos;

        void main() {
          vEnd = aEnd;

          // Seamless toroidal wrap inside 64x36x64 box centered on active camera
          vec3 drift = vec3( uWindOffset.x * aSpeed, -uFallOffset * aSpeed, uWindOffset.y * aSpeed );
          vec3 halfBox = uBoxSize * 0.5;
          vec3 rel = mod( position + drift - uCenterPos + halfBox, uBoxSize ) - halfBox;
          vec3 worldPos = uCenterPos + rel + uStreakVec * ( aEnd * aLength );
          vWorldPos = worldPos;

          // Soft fade near box boundaries & immediate camera near plane
          float xzNorm = length( rel.xz ) / max( halfBox.x, 0.001 );
          float yNorm = abs( rel.y ) / max( halfBox.y, 0.001 );
          float boxFade = ( 1.0 - smoothstep( 0.68, 1.0, xzNorm ) )
                        * ( 1.0 - smoothstep( 0.72, 1.0, yNorm ) );

          vec4 mvPosition = viewMatrix * vec4( worldPos, 1.0 );
          float camDist = max( -mvPosition.z, 0.001 );
          float nearFade = smoothstep( 1.1, 3.2, camDist );

          vAlpha = boxFade * nearFade;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uRainIntensity;
        uniform vec3 uRainColor;
        uniform vec3 uShelterMin[4];
        uniform vec3 uShelterMax[4];

        varying float vAlpha;
        varying float vEnd;
        varying vec3 vWorldPos;

        void main() {
          // Physically clip rain streaks at roof / cave / hollow-trunk shelter volumes
          for ( int i = 0; i < 4; i++ ) {
            vec3 sMin = uShelterMin[i];
            vec3 sMax = uShelterMax[i];
            if ( sMin.x < sMax.x ) {
              if ( all( greaterThanEqual( vWorldPos, sMin ) ) && all( lessThanEqual( vWorldPos, sMax ) ) ) {
                discard;
              }
            }
          }

          // Subtle tapered raindrop streak: whisper-thin tail -> brighter drop head
          float taper = mix( 0.14, 0.95, vEnd );
          float alpha = vAlpha * taper * uRainIntensity * 0.46;
          if ( alpha <= 0.002 ) {
            discard;
          }

          gl_FragColor = vec4( uRainColor, alpha );
        }
      `,
    });

    this.rainMesh = new THREE.LineSegments(geometry, material);
    this.rainMesh.name = 'ForestRainPrecipitation';
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 7;
    this.rainMesh.visible = false;
    this.scene.add(this.rainMesh);
  }

  /**
   * Registers up to 4 world-space axis-aligned shelter volumes (cabin interior/roof,
   * hollow redwood trunk, mossy stone cavern) where rain streaks are clipped cleanly.
   * Accepts THREE.Box3, `{ min, max }`, `{ minX..maxZ }`, or `{ center, size }`.
   */
  setShelterBoxes(boxes = []) {
    if (!this._rainUniforms) return;
    const mins = this._rainUniforms.uShelterMin.value;
    const maxs = this._rainUniforms.uShelterMax.value;
    const list = Array.isArray(boxes) ? boxes : [];

    for (let i = 0; i < MAX_SHELTER_BOXES; i++) {
      const dstMin = mins[i];
      const dstMax = maxs[i];
      const box = i < list.length ? list[i] : null;

      let hasBox = false;
      let minX = 0;
      let minY = 0;
      let minZ = 0;
      let maxX = 0;
      let maxY = 0;
      let maxZ = 0;

      if (box && typeof box === 'object') {
        if (box.min && box.max) {
          minX = Number(box.min.x);
          minY = Number(box.min.y);
          minZ = Number(box.min.z);
          maxX = Number(box.max.x);
          maxY = Number(box.max.y);
          maxZ = Number(box.max.z);
          hasBox = true;
        } else if (box.center && box.size) {
          const hx = Math.abs(Number(box.size.x)) * 0.5;
          const hy = Math.abs(Number(box.size.y)) * 0.5;
          const hz = Math.abs(Number(box.size.z)) * 0.5;
          minX = Number(box.center.x) - hx;
          minY = Number(box.center.y) - hy;
          minZ = Number(box.center.z) - hz;
          maxX = Number(box.center.x) + hx;
          maxY = Number(box.center.y) + hy;
          maxZ = Number(box.center.z) + hz;
          hasBox = true;
        } else if ('minX' in box && 'maxX' in box) {
          minX = Number(box.minX);
          minY = Number(box.minY);
          minZ = Number(box.minZ);
          maxX = Number(box.maxX);
          maxY = Number(box.maxY);
          maxZ = Number(box.maxZ);
          hasBox = true;
        }
      }

      if (
        hasBox &&
        Number.isFinite(minX) &&
        Number.isFinite(minY) &&
        Number.isFinite(minZ) &&
        Number.isFinite(maxX) &&
        Number.isFinite(maxY) &&
        Number.isFinite(maxZ) &&
        minX !== maxX &&
        minY !== maxY &&
        minZ !== maxZ
      ) {
        dstMin.set(Math.min(minX, maxX), Math.min(minY, maxY), Math.min(minZ, maxZ));
        dstMax.set(Math.max(minX, maxX), Math.max(minY, maxY), Math.max(minZ, maxZ));
      } else {
        dstMin.set(9999, 9999, 9999);
        dstMax.set(-9999, -9999, -9999);
      }
    }
  }

  setQuality(preset = 'High') {
    const key = String(preset || 'High').toLowerCase();
    const cfg = QUALITY_COUNTS[key] ?? QUALITY_COUNTS.high;
    this._quality = key;
    this._limits = { ...cfg };

    this.pollenMesh.geometry.setDrawRange(0, cfg.pollen);
    this.fireflyMesh.geometry.setDrawRange(0, cfg.fireflies);
    this.rainMesh.geometry.setDrawRange(0, cfg.rain * 2);
  }

  update(
    dt,
    elapsed,
    {
      cameraPos = null,
      daylight = 1.0,
      nightFactor = 0.0,
      weather = 'Clear',
      rainIntensity = 0.0,
      windSpeed,
    } = {}
  ) {
    const safeDt = Math.min(Math.max(dt || 0, 0), 0.05);

    if (cameraPos) {
      this._centerPos.copy(cameraPos);
    }

    // Read synchronized wind direction & effective wind speed from windSystem
    if (this.windSystem?.uniforms?.uWindDir) {
      this._windDir2D.copy(this.windSystem.uniforms.uWindDir.value).normalize();
    }
    const effectiveWindSpeed =
      windSpeed !== undefined
        ? windSpeed
        : (this.windSystem?.uniforms?.uWindSpeed?.value ?? 1.0);

    const wKey = String(weather || 'Clear').toLowerCase();
    const targetGale = wKey === 'gale' ? 1.0 : 0.0;
    if (!this._initialized || safeDt === 0) {
      this._galeBlend = targetGale;
      this._initialized = true;
    } else {
      this._galeBlend = lerp(this._galeBlend, targetGale, 1.0 - Math.exp(-safeDt * 2.5));
    }
    const gale = this._galeBlend;
    const rain = clamp(rainIntensity, 0.0, 1.0);
    const pixelRatio = getSafePixelRatio();

    // -------------------------------------------------------------------------
    // 1. Update Sunlit Pollen & Dust Motes
    // -------------------------------------------------------------------------
    const pollenOpacity = clamp(daylight * (1.0 - rain * 0.88), 0.0, 1.0);
    this.pollenMesh.visible = pollenOpacity > 0.01 && this._limits.pollen > 0;
    if (this.pollenMesh.visible) {
      const driftSpeed = 0.55 + effectiveWindSpeed * (0.95 + gale * 0.9);
      this._pollenDrift.x += this._windDir2D.x * driftSpeed * safeDt;
      this._pollenDrift.y += Math.sin(elapsed * 0.35) * 0.14 * safeDt;
      this._pollenDrift.z += this._windDir2D.y * driftSpeed * safeDt;

      this._pollenUniforms.uTime.value = elapsed;
      this._pollenUniforms.uCenterPos.value.copy(this._centerPos);
      this._pollenUniforms.uDriftOffset.value.copy(this._pollenDrift);
      this._pollenUniforms.uOpacity.value = pollenOpacity;
      this._pollenUniforms.uPixelRatio.value = pixelRatio;
    }

    // -------------------------------------------------------------------------
    // 2. Update Wind-Carried Falling Leaves
    // -------------------------------------------------------------------------
    const weatherLeafRatio = clamp(
      lerp(0.38, 1.0, gale) + rain * 0.16,
      0.25,
      1.0
    );
    const activeLeaves = Math.min(
      Math.max(Math.round(this._limits.leaves * weatherLeafRatio), 1),
      this._limits.leaves
    );
    this.leafMesh.count = activeLeaves;

    const cx = this._centerPos.x;
    const cz = this._centerPos.z;
    const maxRadiusSq = 38.0 * 38.0;

    for (let i = 0; i < activeLeaves; i++) {
      const leaf = this._leaves[i];

      if (leaf.restTimer > 0.0) {
        leaf.restTimer -= safeDt * (1.0 + gale * 2.2);
        if (leaf.restTimer <= 0.0) {
          this._respawnLeaf(leaf, this._centerPos, false);
        }
      } else {
        const gust = this.windSystem?.sampleGustAt
          ? this.windSystem.sampleGustAt(leaf.x, leaf.z)
          : {
              gust: 0.5,
              turbulence: 0.5,
              intensity: effectiveWindSpeed,
              dirX: this._windDir2D.x,
              dirZ: this._windDir2D.y,
            };

        const windForce = gust.intensity * (1.15 + gale * 1.45);
        const swirl = (gust.turbulence - 0.5) * (1.8 + gale * 4.4);
        const perpX = -gust.dirZ;
        const perpZ = gust.dirX;

        const flutterAngle = elapsed * leaf.flutterFreq + leaf.flutterPhase;
        const flutterSide = Math.sin(flutterAngle) * (0.75 + gale * 0.65);

        // Target velocity driven smoothly by coherent gust field + chaotic gale swirl
        const targetVx = gust.dirX * (0.65 + windForce * 2.15) + perpX * (swirl + flutterSide);
        const targetVz = gust.dirZ * (0.65 + windForce * 2.15) + perpZ * (swirl + flutterSide);

        // Updraft puffs during strong gusts & gale lift leaves temporarily
        const updraft =
          Math.max(gust.gust - 0.52, 0.0) * (1.4 + gale * 3.6) +
          Math.cos(flutterAngle * 0.9) * 0.28;
        const targetVy = -(leaf.fallSpeed * (1.0 + rain * 0.55)) + updraft;

        const accel = 1.0 - Math.exp(-safeDt * (2.6 + gale * 2.2));
        leaf.vx = lerp(leaf.vx, targetVx, accel);
        leaf.vy = lerp(leaf.vy, targetVy, accel);
        leaf.vz = lerp(leaf.vz, targetVz, accel);

        leaf.x += leaf.vx * safeDt;
        leaf.y += leaf.vy * safeDt;
        leaf.z += leaf.vz * safeDt;

        // Tumbling 3D aerodynamic rotation scaled by wind & gale chaos
        const spinMult = 1.0 + gust.intensity * 0.65 + gale * 1.65;
        leaf.rx += (leaf.vrx * spinMult + Math.cos(flutterAngle) * 1.4) * safeDt;
        leaf.ry += (leaf.vry * spinMult + swirl * 0.5) * safeDt;
        leaf.rz += (leaf.vrz * spinMult + Math.sin(flutterAngle) * 1.6) * safeDt;

        // Check ground/water landing or drift outside camera neighborhood
        const dx = leaf.x - cx;
        const dz = leaf.z - cz;
        if (dx * dx + dz * dz > maxRadiusSq) {
          this._respawnLeaf(leaf, this._centerPos, false);
        } else {
          const groundY = this._sampleSafeGroundY(leaf.x, leaf.z);
          if (leaf.y <= groundY + 0.05) {
            leaf.y = groundY + 0.05;
            leaf.rx = 0.08 * Math.sin(leaf.flutterPhase);
            leaf.rz = 0.08 * Math.cos(leaf.flutterPhase);
            leaf.restTimer = 0.45 + this._leafRng() * 1.1;
          }
        }
      }

      this._dummyPos.set(leaf.x, leaf.y, leaf.z);
      this._dummyEuler.set(leaf.rx, leaf.ry, leaf.rz);
      this._dummyQuat.setFromEuler(this._dummyEuler);
      this._dummyScale.setScalar(leaf.scale);
      this._dummyMat.compose(this._dummyPos, this._dummyQuat, this._dummyScale);
      this.leafMesh.setMatrixAt(i, this._dummyMat);
    }

    this.leafMesh.instanceMatrix.needsUpdate = true;

    // -------------------------------------------------------------------------
    // 3. Update Nocturnal 3D Curl-Noise Fireflies
    // -------------------------------------------------------------------------
    const fireflyOpacity =
      smoothstep(0.14, 0.72, nightFactor) * (1.0 - rain * 0.78) * (1.0 - gale * 0.32);
    this.fireflyMesh.visible = fireflyOpacity > 0.006 && this._limits.fireflies > 0;

    if (this.fireflyMesh.visible) {
      const activeFireflies = this._limits.fireflies;
      const noiseScale = 0.085;
      const timeDrift = elapsed * 0.12;
      const curlVec = this._dummyPos; // reuse scratch Vector3

      for (let i = 0; i < activeFireflies; i++) {
        const f = this._fireflies[i];

        // Sample true 3D curl noise for smooth divergence-free wandering flight
        this._computeCurl3D(
          f.x * noiseScale + timeDrift,
          f.y * noiseScale + f.seedOffset,
          f.z * noiseScale - timeDrift * 0.7,
          curlVec
        );

        const moveSpeed = 0.72 * f.speedMult;
        let vx = curlVec.x * moveSpeed;
        let vy = curlVec.y * moveSpeed * 0.55;
        let vz = curlVec.z * moveSpeed;

        // Soft leash toward each firefly's forest home territory so glades stay populated
        const toHomeX = f.homeX - f.x;
        const toHomeZ = f.homeZ - f.z;
        const homeDistSq = toHomeX * toHomeX + toHomeZ * toHomeZ;
        if (homeDistSq > 196.0) {
          vx += toHomeX * 0.06;
          vz += toHomeZ * 0.06;
        }

        f.x += vx * safeDt;
        f.z += vz * safeDt;

        // Smoothly glide strictly within terrain + 0.5..4.2 above hills and stream surface
        const groundY = this._sampleSafeGroundY(f.x, f.z);
        const minY = groundY + 0.5;
        const maxY = groundY + 4.2;
        const desiredY = groundY + f.targetAlt;

        f.y += (vy + (desiredY - f.y) * 0.75) * safeDt;
        f.y = clamp(f.y, minY, maxY);

        const i3 = i * 3;
        this._fireflyPositions[i3] = f.x;
        this._fireflyPositions[i3 + 1] = f.y;
        this._fireflyPositions[i3 + 2] = f.z;
      }

      this._fireflyPosAttr.needsUpdate = true;
      this._fireflyUniforms.uTime.value = elapsed;
      this._fireflyUniforms.uOpacity.value = fireflyOpacity;
      this._fireflyUniforms.uPixelRatio.value = pixelRatio;
    }

    // -------------------------------------------------------------------------
    // 4. Update Forest Rain Precipitation (3,400 camera-centered streaks)
    // -------------------------------------------------------------------------
    this.rainMesh.visible = rain > 0.005 && this._limits.rain > 0;
    if (this.rainMesh.visible) {
      const fallSpeed = 24.0 + rain * 7.5;
      const windPush = effectiveWindSpeed * (3.6 + gale * 4.5);

      this._rainFallOffset += fallSpeed * safeDt;
      this._rainWindOffset.x += this._windDir2D.x * windPush * safeDt;
      this._rainWindOffset.y += this._windDir2D.y * windPush * safeDt;

      // Dynamic diagonal tilt aligned with windSystem direction & speed
      const tilt = clamp(effectiveWindSpeed * (0.22 + gale * 0.18), 0.0, 0.85);
      this._rainUniforms.uStreakVec.value.set(
        this._windDir2D.x * tilt,
        -1.0,
        this._windDir2D.y * tilt
      );

      this._rainUniforms.uCenterPos.value.copy(this._centerPos);
      this._rainUniforms.uFallOffset.value = this._rainFallOffset;
      this._rainUniforms.uWindOffset.value.copy(this._rainWindOffset);
      this._rainUniforms.uRainIntensity.value = rain;

      // Harmonize raindrop brightness between bright daytime mist and silver moonlit drizzle
      const dayTint = clamp(daylight, 0.0, 1.0);
      this._rainUniforms.uRainColor.value.setRGB(
        lerp(0.42, 0.82, dayTint),
        lerp(0.52, 0.88, dayTint),
        lerp(0.68, 0.95, dayTint)
      );

      // Scale active rain streak count smoothly with intensity & quality preset
      const activeRain = Math.max(
        Math.round(this._limits.rain * (0.25 + 0.75 * rain)),
        1
      );
      this.rainMesh.geometry.setDrawRange(0, activeRain * 2);
    }
  }

  dispose() {
    this.scene.remove(this.pollenMesh);
    this.pollenMesh.geometry.dispose();
    this.pollenMesh.material.dispose();

    this.scene.remove(this.leafMesh);
    this._leafGeometry.dispose();
    this._leafMaterial.dispose();

    this.scene.remove(this.fireflyMesh);
    this.fireflyMesh.geometry.dispose();
    this.fireflyMesh.material.dispose();

    this.scene.remove(this.rainMesh);
    this.rainMesh.geometry.dispose();
    this.rainMesh.material.dispose();
  }
}
