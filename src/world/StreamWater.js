import * as THREE from 'three';
import { lerp, clamp } from '../utils/random.js';

const STREAM_Z_MIN = -120;
const STREAM_Z_MAX = 120;
const WIDTH_SEGMENTS = 64;
const LENGTH_SEGMENTS = 300;
const MAX_IMPACT_RIPPLES = 10;
const MAX_BRIDGE_PILINGS = 8;
const SPLASH_POOL_SIZE = 240;
const SPLASH_GRAVITY = -13.5;

/**
 * Procedural meandering forest stream & deep swimming lagoon water mesh with custom WebGL2-safe GLSL shader:
 * - Multi-directional 4-wave Gerstner vertex swell + 4-octave animated fBm capillary normal perturbation
 * - Physically inspired Beer-Lambert depth absorption (crystal turquoise shallows -> deep emerald-sapphire lagoon)
 * - Dual-layer animated Voronoi riverbed caustics clearly illuminating shallow pebbles & fading into lagoon depth
 * - Schlick Fresnel sky + drifted-cloud reflection & crisp dual-lobe sun/moon specular sparkles
 * - DoubleSide underwater Snell's window, total internal reflection & ripple refraction when viewed from below
 * - Dynamic expanding impact ripples, pooled glistening splash droplet bursts, bridge-piling white-water V-wakes,
 *   and live swimmer wake collar + trailing Kelvin V-wake froth
 */
export class StreamWater {
  constructor(terrain, windSystem = null) {
    this.terrain = terrain;
    this.windSystem = windSystem;
    this.maxImpactRipples = MAX_IMPACT_RIPPLES;
    this.maxBridgePilings = MAX_BRIDGE_PILINGS;

    this._impactRippleCursor = 0;
    this._lastElapsed = 0.0;
    this._splashCursor = 0;
    this._activeSplashCount = 0;
    this._splashDirty = false;

    // Pre-allocated swimmer tracking scratch state (zero per-frame allocations)
    this._prevSwimmerPos = new THREE.Vector3(9999, 0, 9999);
    this._hasPrevSwimmer = false;
    this._swimmerIsSwimming = false;

    this.uniforms = {
      uTime: { value: 0.0 },
      uWaterLevel: { value: terrain.waterLevel ?? 0.0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.4).normalize() },
      uSunColor: { value: new THREE.Color(0xfff1d6) },
      uSkyZenithColor: { value: new THREE.Color(0x2862b4) },
      uSkyHorizonColor: { value: new THREE.Color(0x9ec4e4) },
      uSunIntensity: { value: 1.0 },
      uFogColor: { value: new THREE.Color(0x9cb8cc) },
      uFogDensity: { value: 0.007 },
      uRainIntensity: { value: 0.0 },
      uWindSpeed: { value: windSystem?.uniforms?.uWindSpeed?.value ?? 1.0 },
      uWindDir: {
        value: windSystem?.uniforms?.uWindDir?.value
          ? windSystem.uniforms.uWindDir.value.clone()
          : new THREE.Vector2(1.0, 0.0),
      },
      uSwimmerPos: { value: new THREE.Vector3(9999, 0, 9999) },
      uSwimmerSpeed: { value: 0.0 },
      uSwimmerDir: { value: new THREE.Vector2(0.0, 1.0) },
      uSwimmerActive: { value: 0.0 },
      uImpactRipples: {
        value: Array.from(
          { length: MAX_IMPACT_RIPPLES },
          () => new THREE.Vector4(0, 0, -100, 0)
        ),
      },
      uBridgePilings: {
        value: Array.from(
          { length: MAX_BRIDGE_PILINGS },
          () => new THREE.Vector3(9999, 9999, 0)
        ),
      },
    };

    this.geometry = this._buildRibbonGeometry();
    this.material = this._buildMaterial();

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'ForestStreamWater';
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;

    // Pooled sparkling water splash droplet system attached to the stream mesh
    this.splashPoints = this._buildSplashParticles();
    this.mesh.add(this.splashPoints);
  }

  _buildRibbonGeometry() {
    const wSegs = WIDTH_SEGMENTS;
    const lSegs = LENGTH_SEGMENTS;
    const cols = wSegs + 1;
    const rows = lSegs + 1;
    const vertexCount = cols * rows;

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const bedHeights = new Float32Array(vertexCount);
    const flowDirs = new Float32Array(vertexCount * 2);

    const waterY = this.terrain.waterLevel ?? 0.0;
    const flowVec = new THREE.Vector2();

    // Precompute smooth lateral left/right spans starting from the standard ribbon half-width
    // and extending across any contiguous submerged bank coves & lagoon shelves so water always tucks under dry ground
    const zs = new Float32Array(rows);
    const cxs = new Float32Array(rows);
    const leftSpans = new Float32Array(rows);
    const rightSpans = new Float32Array(rows);

    for (let iz = 0; iz <= lSegs; iz++) {
      const z = lerp(STREAM_Z_MIN, STREAM_Z_MAX, iz / lSegs);
      const cx = this.terrain.getStreamCenterX(z);
      const slope = this.terrain.getStreamSlope ? this.terrain.getStreamSlope(z) : 0.0;
      const baseHalf = (this.terrain.getStreamHalfWidth(z) * 1.55 + 2.6) * Math.sqrt(1.0 + slope * slope * 0.35);

      let lSpan = baseHalf;
      while (lSpan < baseHalf + 26.0 && this.terrain.getHeightAt(cx - lSpan, z) < waterY + 0.12) {
        lSpan += 1.5;
      }

      let rSpan = baseHalf;
      while (rSpan < baseHalf + 26.0 && this.terrain.getHeightAt(cx + rSpan, z) < waterY + 0.12) {
        rSpan += 1.5;
      }

      zs[iz] = z;
      cxs[iz] = cx;
      leftSpans[iz] = lSpan;
      rightSpans[iz] = rSpan;
    }

    // Gentle 5-tap smoothing pass along stream length so cove & lagoon transitions stay fluid
    const smoothLeft = new Float32Array(rows);
    const smoothRight = new Float32Array(rows);
    for (let iz = 0; iz <= lSegs; iz++) {
      let lMax = leftSpans[iz];
      let rMax = rightSpans[iz];
      let lSum = 0.0;
      let rSum = 0.0;
      let count = 0;
      for (let k = -2; k <= 2; k++) {
        const j = Math.max(0, Math.min(lSegs, iz + k));
        lSum += leftSpans[j];
        rSum += rightSpans[j];
        lMax = Math.max(lMax, leftSpans[j]);
        rMax = Math.max(rMax, rightSpans[j]);
        count++;
      }
      smoothLeft[iz] = Math.max(lSum / count, lMax * 0.94);
      smoothRight[iz] = Math.max(rSum / count, rMax * 0.94);
    }

    let prevCx = cxs[0];
    let prevZ = zs[0];
    let arcLen = 0.0;

    let vIdx = 0;
    for (let iz = 0; iz <= lSegs; iz++) {
      const z = zs[iz];
      const cx = cxs[iz];
      const lSpan = smoothLeft[iz];
      const rSpan = smoothRight[iz];

      if (iz > 0) {
        arcLen += Math.hypot(cx - prevCx, z - prevZ);
      }
      prevCx = cx;
      prevZ = z;

      this.terrain.getStreamFlowDir(z, flowVec);

      for (let ix = 0; ix <= wSegs; ix++) {
        const tx = ix / wSegs;
        const offset = lerp(-lSpan, rSpan, tx);
        const x = cx + offset;
        const bedH = this.terrain.getHeightAt(x, z);

        const p3 = vIdx * 3;
        positions[p3] = x;
        positions[p3 + 1] = waterY;
        positions[p3 + 2] = z;

        normals[p3] = 0.0;
        normals[p3 + 1] = 1.0;
        normals[p3 + 2] = 0.0;

        // World-proportional UVs aligned along the winding stream (v advances downstream)
        const p2 = vIdx * 2;
        uvs[p2] = offset * 0.14;
        uvs[p2 + 1] = arcLen * 0.14;

        bedHeights[vIdx] = bedH;

        flowDirs[p2] = flowVec.x;
        flowDirs[p2 + 1] = flowVec.y;

        vIdx++;
      }
    }

    const quadCount = wSegs * lSegs;
    const indices = new Uint32Array(quadCount * 6);
    let iIdx = 0;
    for (let iz = 0; iz < lSegs; iz++) {
      const rowA = iz * cols;
      const rowB = (iz + 1) * cols;
      for (let ix = 0; ix < wSegs; ix++) {
        const a = rowA + ix;
        const b = rowB + ix;
        const c = rowB + ix + 1;
        const d = rowA + ix + 1;

        // Counter-clockwise when viewed from +Y so front face points upward
        indices[iIdx++] = a;
        indices[iIdx++] = b;
        indices[iIdx++] = d;

        indices[iIdx++] = b;
        indices[iIdx++] = c;
        indices[iIdx++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aBedHeight', new THREE.BufferAttribute(bedHeights, 1));
    geo.setAttribute('aFlowDir', new THREE.BufferAttribute(flowDirs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    return geo;
  }

  _buildMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aBedHeight;
        attribute vec2 aFlowDir;

        uniform float uTime;
        uniform float uWaterLevel;
        uniform float uWindSpeed;
        uniform vec2 uWindDir;

        varying vec3 vWorldPos;
        varying vec2 vUv;
        varying float vBedHeight;
        varying vec2 vFlowDir;
        varying vec2 vGerstnerSlope;
        varying float vWaveCrest;

        // Accumulates a physically inspired directional Gerstner wave displacement & tangent basis
        void addGerstnerWave(
          vec2 xz,
          vec2 dir,
          float wavelength,
          float steepness,
          float amp,
          float speed,
          float t,
          inout vec3 disp,
          inout vec3 tangent,
          inout vec3 binormal
        ) {
          float k = 6.2831853 / wavelength;
          float c = sqrt( 9.81 / k ) * speed;
          vec2 d = normalize( dir );
          float f = k * ( dot( d, xz ) - c * t );
          float s = sin( f );
          float co = cos( f );

          float qa = steepness / max( k * amp * 4.0, 0.001 );
          float qAmp = min( qa * amp, amp * 1.45 );

          disp.x += d.x * qAmp * co;
          disp.y += amp * s;
          disp.z += d.y * qAmp * co;

          float wa = k * amp;
          float wq = k * qAmp;

          tangent += vec3(
            -d.x * d.x * wq * s,
            d.x * wa * co,
            -d.x * d.y * wq * s
          );
          binormal += vec3(
            -d.x * d.y * wq * s,
            d.y * wa * co,
            -d.y * d.y * wq * s
          );
        }

        void main() {
          vUv = uv;
          vBedHeight = aBedHeight;
          vec2 flowDir = normalize( aFlowDir + vec2( 1e-5, 0.0 ) );
          vFlowDir = flowDir;

          vec3 pos = position;
          vec2 windDir = normalize( uWindDir + vec2( 1e-5, 0.0 ) );

          // Keep shoreline pinned strictly to water level; build multi-directional Gerstner swell across deeper stream & lagoon fetch
          float depth = max( uWaterLevel - aBedHeight, 0.0 );
          float deepMask = smoothstep( 0.06, 0.72, depth );
          float lagoonFetch = 1.0 + smoothstep( 0.80, 2.85, depth ) * 1.25;
          float windGain = clamp( 0.68 + uWindSpeed * 0.42, 0.68, 2.25 );
          float ampScale = deepMask * lagoonFetch * windGain;

          vec3 disp = vec3( 0.0 );
          vec3 tangent = vec3( 1.0, 0.0, 0.0 );
          vec3 binormal = vec3( 0.0, 0.0, 1.0 );

          if ( ampScale > 0.001 ) {
            vec2 d0 = normalize( mix( flowDir, windDir, 0.38 ) );
            vec2 d1 = normalize( vec2( 0.76, -0.65 ) + windDir * 0.25 );
            vec2 d2 = normalize( vec2( -0.58, 0.81 ) + flowDir * 0.20 );
            vec2 d3 = normalize( vec2( -0.86, -0.51 ) );

            addGerstnerWave( pos.xz, d0, 5.6, 0.24, 0.017 * ampScale, 0.56, uTime, disp, tangent, binormal );
            addGerstnerWave( pos.xz, d1, 3.5, 0.22, 0.011 * ampScale, 0.68, uTime, disp, tangent, binormal );
            addGerstnerWave( pos.xz, d2, 2.2, 0.18, 0.0075 * ampScale, 0.82, uTime, disp, tangent, binormal );
            addGerstnerWave( pos.xz, d3, 1.35, 0.14, 0.0045 * ampScale, 0.96, uTime, disp, tangent, binormal );
          }

          pos += disp;

          // Right-handed analytical Gerstner normal (binormal x tangent points +Y)
          vec3 gNorm = normalize( cross( binormal, tangent ) );
          vGerstnerSlope = -gNorm.xz / max( gNorm.y, 0.28 );
          vWaveCrest = clamp( disp.y / max( 0.032 * windGain, 0.01 ), 0.0, 1.0 ) * deepMask;

          vec4 worldPos = modelMatrix * vec4( pos, 1.0 );
          vWorldPos = worldPos.xyz;

          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uWaterLevel;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uSkyZenithColor;
        uniform vec3 uSkyHorizonColor;
        uniform float uSunIntensity;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uRainIntensity;
        uniform float uWindSpeed;
        uniform vec2 uWindDir;
        uniform vec3 uSwimmerPos;
        uniform float uSwimmerSpeed;
        uniform vec2 uSwimmerDir;
        uniform float uSwimmerActive;
        uniform vec4 uImpactRipples[10];
        uniform vec3 uBridgePilings[8];

        varying vec3 vWorldPos;
        varying vec2 vUv;
        varying float vBedHeight;
        varying vec2 vFlowDir;
        varying vec2 vGerstnerSlope;
        varying float vWaveCrest;

        float hash21( vec2 p ) {
          vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
          p3 += dot( p3, p3.yzx + 33.33 );
          return fract( ( p3.x + p3.y ) * p3.z );
        }

        vec2 hash22( vec2 p ) {
          vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
          p3 += dot( p3, p3.yzx + 33.33 );
          return fract( ( p3.xx + p3.yz ) * p3.zy );
        }

        float valueNoise( vec2 p ) {
          vec2 i = floor( p );
          vec2 f = fract( p );
          vec2 u = f * f * ( 3.0 - 2.0 * f );
          float a = hash21( i );
          float b = hash21( i + vec2( 1.0, 0.0 ) );
          float c = hash21( i + vec2( 0.0, 1.0 ) );
          float d = hash21( i + vec2( 1.0, 1.0 ) );
          return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
        }

        // 4-octave rotated fBm for rich water surface micro-waves, reflections & foam detail
        float fbm4( vec2 p ) {
          float sum = 0.0;
          float amp = 0.5;
          mat2 rot = mat2( 0.80, -0.60, 0.60, 0.80 );
          for ( int i = 0; i < 4; i++ ) {
            sum += amp * valueNoise( p );
            p = rot * p * 2.04 + vec2( 11.7, 23.3 );
            amp *= 0.5;
          }
          return sum;
        }

        // Animated 4-octave dual-scrolling capillary & current wave field in stream-aligned space
        float streamWaveHeight( vec2 suv, float t ) {
          vec2 warp = vec2(
            valueNoise( suv * vec2( 2.2, 1.6 ) - vec2( 0.0, t * 0.45 ) ) - 0.5,
            valueNoise( suv * vec2( 2.2, 1.6 ) + vec2( 7.3, -t * 0.52 ) ) - 0.5
          ) * 0.44;

          vec2 p1 = ( suv + warp ) * vec2( 2.9, 2.0 ) - vec2( 0.05 * t, t * 0.82 );
          float w1 = fbm4( p1 );

          mat2 r2 = mat2( 0.90, -0.43, 0.43, 0.90 );
          vec2 p2 = r2 * ( suv * vec2( 4.8, 3.8 ) ) - vec2( -0.14 * t, t * 1.32 );
          float w2 = fbm4( p2 );

          return w1 * 0.58 + w2 * 0.42;
        }

        // 4-octave cross-wind capillary chop driven by wind direction & speed
        float windChopHeight( vec2 worldXZ, float t, vec2 wDir, float wSpeed ) {
          vec2 wPerp = vec2( -wDir.y, wDir.x );
          float along = dot( worldXZ, wDir );
          float across = dot( worldXZ, wPerp );
          float speed = 1.45 + wSpeed * 2.25;

          vec2 wp1 = vec2( along * 1.15 - t * speed, across * 1.85 );
          vec2 wp2 = vec2( along * 2.75 - t * ( speed * 1.42 ), across * 3.6 + 6.3 );
          return fbm4( wp1 ) * 0.62 + valueNoise( wp2 ) * 0.38;
        }

        // Concentric expanding raindrop ripple rings in world XZ
        float rainRippleLayer( vec2 xz, float t, float scale ) {
          vec2 p = xz * scale;
          vec2 cell = floor( p );
          vec2 fracP = fract( p );

          float accum = 0.0;
          for ( int oy = -1; oy <= 1; oy++ ) {
            for ( int ox = -1; ox <= 1; ox++ ) {
              vec2 neighbor = vec2( float( ox ), float( oy ) );
              vec2 id = cell + neighbor;
              vec2 rnd = hash22( id );
              float period = 0.75 + rnd.x * 0.65;
              float phase = fract( t * ( 0.85 / period ) + rnd.y );
              vec2 dropPos = neighbor + 0.18 + 0.64 * hash22( id + floor( t * ( 0.85 / period ) + rnd.y ) * 17.3 );
              float dist = length( fracP - dropPos );

              float maxRadius = 0.58;
              float radius = phase * maxRadius;
              float ring = dist - radius;
              float envelope = exp( -ring * ring * 95.0 ) * ( 1.0 - phase ) * smoothstep( 0.0, 0.08, phase );
              accum += sin( ring * 38.0 ) * envelope;
            }
          }
          return accum;
        }

        // Crisp Voronoi cellular filament caustic layer using F2 - F1 ridge distance
        float voronoiCausticLayer( vec2 p, float t ) {
          vec2 n = floor( p );
          vec2 f = fract( p );
          float d1 = 8.0;
          float d2 = 8.0;

          for ( int j = -1; j <= 1; j++ ) {
            for ( int i = -1; i <= 1; i++ ) {
              vec2 g = vec2( float( i ), float( j ) );
              vec2 o = hash22( n + g );
              o = 0.5 + 0.42 * sin( t * 1.2 + 6.2831853 * o );
              vec2 r = g + o - f;
              float d = dot( r, r );
              if ( d < d1 ) {
                d2 = d1;
                d1 = d;
              } else if ( d < d2 ) {
                d2 = d;
              }
            }
          }

          float edgeDist = sqrt( d2 ) - sqrt( d1 );
          return pow( clamp( 1.0 - smoothstep( 0.0, 0.34, edgeDist ), 0.0, 1.0 ), 2.6 );
        }

        // Dual-layer counter-drifting animated Voronoi riverbed caustics
        float computeVoronoiCaustics( vec2 suv, float t ) {
          vec2 p1 = suv * vec2( 2.85, 2.45 ) - vec2( 0.04 * t, t * 0.46 );
          mat2 rot = mat2( 0.84, -0.54, 0.54, 0.84 );
          vec2 p2 = rot * ( suv * vec2( 4.15, 3.65 ) ) - vec2( -0.11 * t, t * 0.68 );

          float c1 = voronoiCausticLayer( p1, t * 0.95 );
          float c2 = voronoiCausticLayer( p2, t * 1.28 + 2.35 );
          return clamp( c1 * 0.62 + c2 * 0.48 + c1 * c2 * 0.88, 0.0, 1.75 );
        }

        // Lightweight reflected drifted-cloud lookup in sky reflection direction R
        vec3 sampleSkyAndClouds( vec3 dir, vec3 sunDir, vec2 wDir, float t ) {
          float up = clamp( dir.y, 0.0, 1.0 );
          float skyGrad = pow( up, 0.52 );
          vec3 skyCol = mix( uSkyHorizonColor, uSkyZenithColor, skyGrad );

          if ( dir.y > 0.02 ) {
            vec2 cUv = dir.xz / ( dir.y + 0.18 );
            vec2 drift = wDir * ( t * ( 0.018 + uWindSpeed * 0.014 ) );
            float cField = fbm4( cUv * 0.46 + drift );
            float cMask = smoothstep( 0.44 - uRainIntensity * 0.16, 0.78 - uRainIntensity * 0.10, cField )
                        * smoothstep( 0.02, 0.22, dir.y );

            float sunAlign = pow( max( dot( dir, sunDir ), 0.0 ), 6.0 );
            vec3 brightCloud = mix( vec3( 0.88, 0.92, 0.98 ), uSunColor * 1.08, 0.42 )
                             * ( 0.35 + uSunIntensity * 0.72 );
            brightCloud += uSunColor * sunAlign * 0.42 * ( 1.0 - uRainIntensity * 0.8 );
            vec3 rainCloud = uSkyHorizonColor * 0.62;
            vec3 cloudCol = mix( brightCloud, rainCloud, uRainIntensity * 0.85 );

            skyCol = mix( skyCol, cloudCol, cMask * 0.74 );
          }

          return skyCol;
        }

        void main() {
          float depth = uWaterLevel - vBedHeight;
          if ( depth <= 0.0 ) {
            discard;
          }

          // Smooth shoreline edge feather over 0.0..0.055 to eliminate any bank z-fighting
          float edgeAlpha = smoothstep( 0.0, 0.055, depth );

          vec2 flowDir = normalize( vFlowDir );
          vec2 rightDir = vec2( flowDir.y, -flowDir.x );
          vec2 wDir = normalize( uWindDir + vec2( 1e-5, 0.0 ) );
          float wScale = clamp( uWindSpeed, 0.0, 3.2 );
          float lagoonFetch = 1.0 + smoothstep( 0.75, 2.75, depth ) * 0.45;

          // Finite-difference gradient of 4-octave dual-scrolling animated waves
          float eps = 0.032;
          float hC = streamWaveHeight( vUv, uTime );
          float hU = streamWaveHeight( vUv + vec2( eps, 0.0 ), uTime );
          float hV = streamWaveHeight( vUv + vec2( 0.0, eps ), uTime );

          float dU = ( hU - hC ) / eps;
          float dV = ( hV - hC ) / eps;

          // Subtle stronger chop over shallow riffles + rolling lagoon fetch
          float shallowRiffle = 1.0 + ( 1.0 - smoothstep( 0.05, 0.52, depth ) ) * 0.42;
          float streamBump = 0.072 * shallowRiffle * ( 0.88 + 0.12 * lagoonFetch );
          vec2 worldSlope = vGerstnerSlope * 0.95 + ( rightDir * dU + flowDir * dV ) * streamBump;

          // Cross-wind 4-octave capillary chop perturbation scaling with uWindSpeed & lagoon fetch
          float wEps = 0.085;
          float wcC = windChopHeight( vWorldPos.xz, uTime, wDir, wScale );
          float wcX = windChopHeight( vWorldPos.xz + vec2( wEps, 0.0 ), uTime, wDir, wScale );
          float wcZ = windChopHeight( vWorldPos.xz + vec2( 0.0, wEps ), uTime, wDir, wScale );
          float windAmp = ( 0.024 + wScale * 0.042 ) * lagoonFetch * smoothstep( 0.02, 0.24, depth );
          worldSlope += vec2( ( wcX - wcC ) / wEps, ( wcZ - wcC ) / wEps ) * windAmp;

          // Concentric raindrop impact ripples when raining
          if ( uRainIntensity > 0.005 ) {
            float rEps = 0.045;
            float rC = rainRippleLayer( vWorldPos.xz, uTime, 0.62 )
                     + rainRippleLayer( vWorldPos.xz + vec2( 13.7, 7.3 ), uTime * 1.18, 0.95 ) * 0.65;
            float rX = rainRippleLayer( vWorldPos.xz + vec2( rEps, 0.0 ), uTime, 0.62 )
                     + rainRippleLayer( vWorldPos.xz + vec2( 13.7 + rEps, 7.3 ), uTime * 1.18, 0.95 ) * 0.65;
            float rZ = rainRippleLayer( vWorldPos.xz + vec2( 0.0, rEps ), uTime, 0.62 )
                     + rainRippleLayer( vWorldPos.xz + vec2( 13.7, 7.3 + rEps ), uTime * 1.18, 0.95 ) * 0.65;
            float rainBump = 0.046 * uRainIntensity * smoothstep( 0.01, 0.16, depth );
            worldSlope += vec2( ( rX - rC ) / rEps, ( rZ - rC ) / rEps ) * rainBump;
          }

          // Dynamic expanding concentric impact ripples (wading, running, jumping, diving, slipping)
          float impactFoam = 0.0;
          float rippleDepthMask = smoothstep( 0.01, 0.10, depth );
          for ( int i = 0; i < 10; i++ ) {
            vec4 r = uImpactRipples[i];
            float rStrength = r.w;
            float age = uTime - r.z;
            if ( rStrength > 0.001 && age >= 0.0 && age < 2.8 ) {
              vec2 dVec = vWorldPos.xz - r.xy;
              float dist = length( dVec );
              float ringRadius = age * 2.45;
              float radialDiff = dist - ringRadius;

              float bandWidth = 0.34 + age * 0.22;
              float spatialEnv = exp( -( radialDiff * radialDiff ) / ( bandWidth * bandWidth ) );

              // Secondary trailing concentric ring slightly behind the main wavefront
              float trailRadius = max( ringRadius - 0.56, 0.0 );
              float trailDiff = dist - trailRadius;
              float trailWidth = bandWidth * 1.15;
              float trailEnv = exp( -( trailDiff * trailDiff ) / ( trailWidth * trailWidth ) )
                             * 0.54 * smoothstep( 0.14, 0.42, age );

              float timeFade = smoothstep( 0.0, 0.06, age ) * ( 1.0 - smoothstep( 1.65, 2.8, age ) );
              float distAtten = 1.0 / ( 1.0 + dist * 0.42 );
              float amp = rStrength * timeFade * distAtten * rippleDepthMask;

              float waveK = 12.5;
              float waveSlope = cos( radialDiff * waveK ) * spatialEnv
                              + cos( trailDiff * ( waveK * 1.24 ) ) * trailEnv;
              float waveCrest = max( sin( radialDiff * waveK ), 0.0 ) * spatialEnv
                              + max( sin( trailDiff * ( waveK * 1.24 ) ), 0.0 ) * trailEnv * 0.62;

              vec2 radialDir = dist > 0.001 ? ( dVec / dist ) : vec2( 0.0 );
              worldSlope += radialDir * ( waveSlope * amp * 0.42 );

              float earlyFroth = 0.48 + 0.34 * ( 1.0 - smoothstep( 0.0, 1.2, age ) );
              impactFoam += waveCrest * amp * earlyFroth;

              // Brief white splash-entry boil right at the impact epicenter
              float centerSplash = exp( -( dist * dist ) / ( 0.16 + age * 0.36 ) )
                                 * ( 1.0 - smoothstep( 0.05, 0.65, age ) )
                                 * rStrength * rippleDepthMask;
              impactFoam += centerSplash * 0.54;
            }
          }

          // Animated turbulent white-water foam collars & downstream V-wakes around bridge pilings
          float pilingFoam = 0.0;
          float pilingDepthMask = smoothstep( 0.015, 0.11, depth );
          for ( int i = 0; i < 8; i++ ) {
            vec3 pil = uBridgePilings[i];
            if ( pil.z > 0.001 ) {
              vec2 relP = vWorldPos.xz - pil.xy;
              float pDist = length( relP );
              if ( pDist < pil.z + 4.8 ) {
                float rPad = pil.z;
                float along = dot( relP, flowDir );
                float across = dot( relP, rightDir );
                float invDist = 1.0 / max( pDist, 0.001 );

                // 1. Swirling white-water collar & upstream bow wave pile-up around piling timber
                float ringDist = max( pDist - rPad, 0.0 );
                float angleP = atan( across, along );
                float bowBias = 1.0 - smoothstep( -0.78, 0.28, along * invDist );
                float swirlPulse = sin( angleP * 4.0 - uTime * 3.6 + ringDist * 11.0 ) * 0.5 + 0.5;
                float collarWidth = 0.24 + rPad * 0.42 + bowBias * 0.22;
                float collarRing = exp( -( ringDist * ringDist ) / max( collarWidth * collarWidth, 0.02 ) )
                                 * ( 0.70 + 0.30 * swirlPulse ) * ( 0.82 + 0.38 * bowBias );

                // Concentric eddy chop radiating off the piling surface
                float eddyWave = sin( ringDist * 16.5 - uTime * 5.2 + angleP * 2.0 );
                float eddyEnv = exp( -ringDist * 2.3 ) * smoothstep( 0.0, 0.06, ringDist );
                worldSlope += ( relP * invDist ) * ( eddyWave * eddyEnv * 0.22 * pilingDepthMask );

                // 2. Diverging downstream V-wake arms & trailing Kármán vortex froth
                float dn = max( along + rPad * 0.24, 0.0 );
                float spread = rPad * 0.92 + dn * 0.42;
                float absAcross = abs( across );
                float armDist = abs( absAcross - spread );
                float armWidth = 0.13 + dn * 0.095;
                float armEnv = exp( -( armDist * armDist ) / max( armWidth * armWidth, 0.015 ) );
                float dnFade = smoothstep( 0.0, 0.24, dn ) * ( 1.0 - smoothstep( 1.25, 4.35, dn ) );
                float armNoise = valueNoise( vec2( armDist * 5.2, dn * 3.6 - uTime * 3.5 ) );
                float armFoam = armEnv * dnFade * ( 0.58 + 0.56 * armNoise );

                // Perturb wake normals so sunlit specular streaks shimmer along the V-arms
                float wakeSign = across >= 0.0 ? 1.0 : -1.0;
                float wakeRidge = sin( ( absAcross - spread ) * 11.5 - uTime * 4.6 ) * armEnv * dnFade;
                worldSlope += rightDir * ( wakeSign * wakeRidge * 0.19 * pilingDepthMask );

                // Bubbly swirling eddy pocket directly in the piling's lee
                float coreWidth = rPad * 0.82 + dn * 0.25;
                float coreMask = exp( -( across * across ) / max( coreWidth * coreWidth, 0.025 ) );
                float vortexSway = sin( dn * 5.4 - uTime * 4.8 + across * 3.4 ) * 0.5 + 0.5;
                float coreFade = smoothstep( 0.0, 0.14, dn ) * ( 1.0 - smoothstep( 0.62, 2.45, dn ) );
                float coreFoam = coreMask * coreFade * ( 0.44 + 0.56 * vortexSway ) * 0.74;

                pilingFoam += ( collarRing * 0.95 + armFoam * 0.85 + coreFoam ) * pilingDepthMask;
              }
            }
          }

          // Live swimmer frothy wake collar, treading rings & trailing Kelvin V-wake ripples
          float swimmerFoam = 0.0;
          float swimPresence = max( uSwimmerActive, smoothstep( 0.05, 0.25, uSwimmerSpeed ) );
          if ( swimPresence > 0.005 ) {
            vec2 relS = vWorldPos.xz - uSwimmerPos.xz;
            float sDist = length( relS );
            if ( sDist < 7.5 ) {
              float sSpeedNorm = clamp( uSwimmerSpeed / 3.6, 0.0, 1.35 );
              vec2 sDir = normalize( uSwimmerDir + vec2( 0.0, 1e-5 ) );
              vec2 sRight = vec2( sDir.y, -sDir.x );
              float invSDist = 1.0 / max( sDist, 0.001 );

              // 1. Frothy white swimmer torso collar & concentric treading ripples
              float collarRadius = 0.40 + sSpeedNorm * 0.14;
              float collarDelta = sDist - collarRadius;
              float collarBand = 0.26 + sSpeedNorm * 0.12;
              float collarPulse = sin( sDist * 16.0 - uTime * ( 5.5 + sSpeedNorm * 3.5 ) ) * 0.5 + 0.5;
              float collarFroth = exp( -( collarDelta * collarDelta ) / ( collarBand * collarBand ) )
                                * ( 0.62 + 0.38 * collarPulse ) * ( 0.72 + sSpeedNorm * 0.55 );

              // Outward radiating concentric treading ripples
              float ringWave = sin( sDist * 13.5 - uTime * ( 5.8 + sSpeedNorm * 2.8 ) );
              float ringEnv = exp( -sDist * 0.82 ) * smoothstep( 0.18, 0.48, sDist );
              worldSlope += ( relS * invSDist ) * ( ringWave * ringEnv * ( 0.20 + sSpeedNorm * 0.22 ) * swimPresence );
              swimmerFoam += max( ringWave, 0.0 ) * ringEnv * ( 0.28 + sSpeedNorm * 0.26 );

              // 2. Trailing Kelvin V-wake arms & bubbly flutter-kick trail behind swimmer
              float moveMask = smoothstep( 0.12, 0.95, uSwimmerSpeed );
              if ( moveMask > 0.005 ) {
                float behind = dot( relS, -sDir );
                float side = dot( relS, sRight );
                if ( behind > -0.35 && behind < 6.8 ) {
                  float bPos = max( behind + 0.15, 0.0 );
                  float wakeSpread = 0.36 + bPos * 0.43;
                  float absSide = abs( side );
                  float armDist = abs( absSide - wakeSpread );
                  float armW = 0.15 + bPos * 0.095;
                  float armEnv = exp( -( armDist * armDist ) / max( armW * armW, 0.02 ) );
                  float bFade = smoothstep( 0.0, 0.32, bPos ) * ( 1.0 - smoothstep( 2.2, 6.4, bPos ) );
                  float armNoise = valueNoise( vec2( armDist * 4.8, bPos * 3.2 - uTime * 4.4 ) );

                  float wakeArmFoam = armEnv * bFade * ( 0.55 + 0.55 * armNoise ) * ( 0.65 + sSpeedNorm * 0.60 );
                  float sSign = side >= 0.0 ? 1.0 : -1.0;
                  float wakeRidge = sin( ( absSide - wakeSpread ) * 11.0 - uTime * 5.2 ) * armEnv * bFade;
                  worldSlope += sRight * ( sSign * wakeRidge * ( 0.22 + sSpeedNorm * 0.20 ) * moveMask );

                  // Churning central kick froth directly behind the swimmer
                  float kickW = 0.32 + bPos * 0.18;
                  float kickEnv = exp( -( side * side ) / max( kickW * kickW, 0.04 ) );
                  float kickFade = smoothstep( 0.0, 0.16, bPos ) * ( 1.0 - smoothstep( 1.2, 3.9, bPos ) );
                  float kickChurn = valueNoise( vec2( side * 5.2, bPos * 4.6 - uTime * 6.5 ) );
                  float kickFoam = kickEnv * kickFade * ( 0.45 + 0.65 * kickChurn ) * ( 0.65 + sSpeedNorm * 0.55 );

                  swimmerFoam += ( wakeArmFoam + kickFoam ) * moveMask;
                }
              }

              swimmerFoam = ( swimmerFoam + collarFroth ) * swimPresence * rippleDepthMask;
            }
          }

          vec3 N = normalize( vec3( -worldSlope.x, 1.0, -worldSlope.y ) );
          vec3 V = normalize( cameraPosition - vWorldPos );
          vec3 L = normalize( uSunDir );
          float dist = length( cameraPosition - vWorldPos );

          // ------------------------------------------------------------------
          // UNDERWATER BRANCH: Looking UP from below water surface (!gl_FrontFacing)
          // Renders physical Snell's Window, rippling sky/sun refraction & TIR mirror
          // ------------------------------------------------------------------
          if ( !gl_FrontFacing ) {
            vec3 Nunder = -N;
            float cosUnder = clamp( dot( Nunder, V ), 0.0, 1.0 );

            // Critical angle for water->air (~48.6 deg, cos ~ 0.661) perturbed by animated wave ripples
            float snellWindow = smoothstep( 0.55, 0.72, cosUnder );
            float rimRing = exp( -pow( ( cosUnder - 0.64 ) / 0.055, 2.0 ) );

            // Refracted sky & drifting clouds visible through Snell's window
            vec3 refrDir = normalize( mix( vec3( 0.0, 1.0, 0.0 ), normalize( -V + N * 0.45 ), 0.65 ) );
            refrDir.y = max( refrDir.y, 0.06 );
            vec3 aboveSky = sampleSkyAndClouds( refrDir, L, wDir, uTime );

            // Blazing refracted solar disc & shimmering caustic glints overhead
            float sunRefract = pow( max( dot( refrDir, L ), 0.0 ), 36.0 ) * 1.45
                             + pow( max( dot( refrDir, L ), 0.0 ), 240.0 ) * 2.8;
            float sunElevVis = smoothstep( -0.02, 0.16, L.y ) * ( 1.0 - uRainIntensity * 0.72 );
            vec3 windowColor = aboveSky * ( 0.82 + 0.35 * uSunIntensity )
                             + uSunColor * sunRefract * ( 0.35 + uSunIntensity * 1.15 ) * sunElevVis;

            // Outside Snell's Window: Total Internal Reflection silvery-emerald liquid mirror
            vec3 tirDeepCol = vec3( 0.015, 0.11, 0.14 ) * ( 0.45 + uSunIntensity * 0.85 );
            float underCaust = computeVoronoiCaustics( vUv + N.xz * 0.24, uTime );
            vec3 tirColor = tirDeepCol
                          + vec3( 0.10, 0.38, 0.40 ) * underCaust * ( 0.25 + uSunIntensity * 0.55 )
                          + uSkyHorizonColor * 0.14 * ( 1.0 - cosUnder );

            // Chromatic cyan-gold dispersion sparkle along Snell's critical ring
            vec3 rimDispersion = vec3( 0.35, 0.88, 0.96 ) * rimRing * ( 0.28 + uSunIntensity * 0.45 );

            vec3 underColor = mix( tirColor, windowColor, snellWindow ) + rimDispersion;

            // Subtle foam shadows visible from underneath (shoreline / swimmer / pilings)
            float underFoam = clamp( impactFoam * 0.55 + pilingFoam * 0.55 + swimmerFoam * 0.72, 0.0, 0.85 );
            vec3 foamUnderCol = mix( vec3( 0.38, 0.62, 0.66 ), uSunColor * 0.72, 0.35 );
            underColor = mix( underColor, foamUnderCol, underFoam * 0.55 );

            // Underwater blue-emerald distance attenuation (replaces dry air fog underwater)
            vec3 underwaterFogCol = vec3( 0.012, 0.085, 0.115 ) * ( 0.35 + uSunIntensity * 0.95 );
            float underFog = 1.0 - exp( -dist * 0.115 );
            underColor = mix( underColor, underwaterFogCol, clamp( underFog, 0.0, 0.94 ) );

            float underAlpha = clamp( mix( 0.88, 0.72, snellWindow ) + underFoam * 0.14, 0.62, 0.96 ) * edgeAlpha;
            gl_FragColor = vec4( underColor, underAlpha );

            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            return;
          }

          // ------------------------------------------------------------------
          // SURFACE BRANCH: Looking DOWN at stream & deep swimming lagoon
          // ------------------------------------------------------------------
          // Schlick Fresnel reflection (F0 = 0.02)
          float NdotV = max( dot( N, V ), 0.0 );
          float fresnel = 0.02 + 0.98 * pow( max( 1.0 - NdotV, 0.0 ), 5.0 );

          // Crisp reflected sky & drifted clouds with forest-canopy tint near tight stream banks
          vec3 R = reflect( -V, N );
          vec3 skyCloudRefl = sampleSkyAndClouds( R, L, wDir, uTime );
          float canopyDarken = smoothstep( 0.02, 0.36, R.y );
          float openLagoonFactor = smoothstep( 0.85, 2.5, depth );
          vec3 canopyTint = mix( uSkyHorizonColor * vec3( 0.18, 0.28, 0.20 ), skyCloudRefl, canopyDarken );
          vec3 reflectionColor = mix( canopyTint, skyCloudRefl, mix( 0.54, 0.82, openLagoonFactor ) ) * 0.92;

          // Crisp dual-lobe specular sun/moon sparkles
          vec3 H = normalize( L + V + vec3( 0.0, 1e-5, 0.0 ) );
          float NdotH = max( dot( N, H ), 0.0 );
          float rainSpecDamp = mix( 1.0, 0.32, uRainIntensity );
          float specSharp = pow( NdotH, 420.0 ) * 3.15;
          float specBroad = pow( NdotH, 52.0 ) * 0.22;
          float grazingBoost = mix( 0.68, 1.40, pow( max( 1.0 - NdotV, 0.0 ), 2.0 ) );
          float lightElevFade = smoothstep( -0.02, 0.16, L.y );
          vec3 specular = uSunColor * ( specSharp + specBroad ) * ( 0.26 + uSunIntensity * 1.22 )
                        * rainSpecDamp * grazingBoost * lightElevFade;

          // Physically inspired Beer-Lambert depth absorption:
          // Crystal-clear sunlit turquoise over shallow river pebbles (< 0.85m)
          // -> lush vibrant aquamarine -> deep emerald-sapphire across the 3.25m swimming lagoon!
          vec3 absorption = exp( -depth * vec3( 0.54, 0.16, 0.085 ) );
          vec3 shallowTurquoise = vec3( 0.15, 0.46, 0.44 );
          vec3 midEmerald = vec3( 0.028, 0.21, 0.24 );
          vec3 deepSapphire = vec3( 0.007, 0.052, 0.118 );

          float shallowBand = smoothstep( 0.28, 0.88, absorption.r );
          float midBand = smoothstep( 0.16, 0.62, absorption.r );
          vec3 waterScatter = mix( deepSapphire, midEmerald, midBand );
          waterScatter = mix( waterScatter, shallowTurquoise, shallowBand );

          // Subsurface emerald-turquoise forward scatter glow through deep sunlit lagoon waves
          float sssAngle = pow( clamp( dot( -L, V ) * 0.5 + 0.5, 0.0, 1.0 ), 2.2 );
          float sssMask = smoothstep( 0.30, 2.2, depth ) * ( 0.22 + uSunIntensity * 0.85 ) * ( 1.0 - uRainIntensity * 0.65 );
          waterScatter += vec3( 0.018, 0.15, 0.17 ) * sssAngle * sssMask * absorption.g * 0.58;

          // Harmonize water body brightness cleanly between sunlit emerald-turquoise day & moonlit night
          float skyLuma = dot( uSkyHorizonColor, vec3( 0.299, 0.587, 0.114 ) );
          vec3 irradiance = uSkyHorizonColor * 0.34 + uSkyZenithColor * 0.22
                          + uSunColor * max( L.y, 0.04 ) * ( 0.06 + uSunIntensity * 0.56 );
          vec3 bodyColor = waterScatter * irradiance * mix( 0.66, 1.22, clamp( skyLuma * 2.2, 0.0, 1.0 ) );

          // Dual-layer animated Voronoi riverbed caustics:
          // Crisp & luminous over shallow river pebbles (< 0.85m), fading softly into deep lagoon waters
          vec2 refractedUv = vUv - vec2( dot( N.xz, rightDir ), dot( N.xz, flowDir ) ) * min( depth, 1.4 ) * 0.18;
          float caustics = computeVoronoiCaustics( refractedUv, uTime );
          float shallowCaustic = smoothstep( 0.02, 0.12, depth ) * ( 1.0 - smoothstep( 0.55, 0.92, depth ) );
          float lagoonCaustic = smoothstep( 0.12, 0.55, depth ) * exp( -depth * 0.88 ) * 0.52;
          float causticMask = shallowCaustic * exp( -depth * 0.72 ) + lagoonCaustic;
          float dayCausticVis = smoothstep( 0.08, 0.56, uSunIntensity ) * ( 1.0 - uRainIntensity * 0.64 );
          vec3 causticTint = mix( vec3( 0.78, 1.0, 0.94 ), vec3( 0.32, 0.82, 0.92 ), smoothstep( 0.75, 2.6, depth ) );
          vec3 causticLight = uSunColor * causticTint * caustics * causticMask
                            * absorption * dayCausticVis * 0.94;
          bodyColor += causticLight;

          // Combine refracted stream/lagoon body with Fresnel sky+cloud reflection + crisp specular & caustics
          float shallowReflFade = mix( 0.62, 0.92, smoothstep( 0.16, 1.15, depth ) );
          vec3 waterColor = mix( bodyColor, reflectionColor, clamp( fresnel * shallowReflFade, 0.0, 0.92 ) )
                          + specular
                          + causticLight * 0.26;

          // Organic noise-broken shoreline foam where depth < 0.26 + riffles + subtle windy lagoon wave caps
          float foamMacro = fbm4( vUv * vec2( 2.8, 2.2 ) - vec2( 0.0, uTime * 0.36 ) );
          float foamLace = fbm4( vUv * vec2( 8.5, 6.8 ) - vec2( 0.06 * uTime, uTime * 0.82 ) );
          float foamFine = valueNoise( vUv * vec2( 18.0, 15.0 ) - vec2( -0.09 * uTime, uTime * 1.25 ) );

          // Break shore zone organically so foam forms delicate patchy wisps rather than a solid stripe
          float wavyDepthLimit = 0.26 * ( 0.35 + foamMacro * 0.95 );
          float shoreZone = ( 1.0 - smoothstep( 0.02, max( wavyDepthLimit, 0.05 ), depth ) )
                          * smoothstep( 0.008, 0.055, depth );
          float frothMask = smoothstep( 0.44, 0.76, foamLace * 0.72 + foamFine * 0.42 ) * smoothstep( 0.36, 0.68, foamMacro );
          float foamEdge = shoreZone * frothMask * 0.75;

          // Subtle downstream riffle crests + breezy lagoon Gerstner whitecap micro-froth
          float waveSteepness = length( worldSlope );
          float riffleMask = smoothstep( 0.08, 0.24, depth ) * ( 1.0 - smoothstep( 0.28, 0.78, depth ) );
          float riffleFoam = smoothstep( 0.16, 0.36, waveSteepness ) * riffleMask * smoothstep( 0.48, 0.78, foamFine ) * 0.36;
          float crestFoam = smoothstep( 0.62, 0.95, vWaveCrest ) * smoothstep( 1.2, 2.4, wScale )
                          * smoothstep( 0.45, 0.78, foamLace ) * 0.32;

          float impactCrestFoam = clamp( impactFoam * ( 0.72 + foamFine * 0.38 ), 0.0, 0.86 );
          float pilingCrestFoam = clamp( pilingFoam * ( 0.64 + foamLace * 0.34 + foamFine * 0.28 ), 0.0, 0.94 );
          float swimmerCrestFoam = clamp( swimmerFoam * ( 0.68 + foamLace * 0.32 + foamFine * 0.30 ), 0.0, 0.94 );
          float foamAmount = clamp(
            foamEdge + riffleFoam + crestFoam + impactCrestFoam + pilingCrestFoam + swimmerCrestFoam,
            0.0,
            0.95
          );
          vec3 foamAlbedo = vec3( 0.93, 0.96, 0.95 );
          vec3 foamLit = foamAlbedo * ( uSkyHorizonColor * 0.44 + uSunColor * max( L.y, 0.06 ) * ( 0.10 + uSunIntensity * 0.60 ) );
          waterColor = mix( waterColor, foamLit, foamAmount );

          // Physically inspired opacity:
          // Crystal-clear sunlit shallows (< 0.85m) reveal pebbles & Voronoi caustics -> lush deep sapphire lagoon
          float shallowClarity = mix( 0.68, 1.0, smoothstep( 0.14, 0.95, depth ) );
          float depthAlpha = ( 1.0 - exp( -depth * 1.28 ) ) * shallowClarity;
          float causticBoostAlpha = clamp( caustics * causticMask * dayCausticVis * 0.20, 0.0, 0.24 );
          float alpha = clamp( max( depthAlpha + causticBoostAlpha, max( fresnel * 0.84, foamAmount * 0.92 ) ), 0.0, 0.97 ) * edgeAlpha;

          // Match Three.js FogExp2 atmospheric distance fog
          float fogFactor = 1.0 - exp( -uFogDensity * uFogDensity * dist * dist );
          waterColor = mix( waterColor, uFogColor, clamp( fogFactor, 0.0, 1.0 ) );

          gl_FragColor = vec4( waterColor, alpha );

          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
  }

  _buildSplashParticles() {
    this._splashPositions = new Float32Array(SPLASH_POOL_SIZE * 3);
    this._splashVelocities = new Float32Array(SPLASH_POOL_SIZE * 3);
    this._splashSizes = new Float32Array(SPLASH_POOL_SIZE);
    this._splashAlphas = new Float32Array(SPLASH_POOL_SIZE);
    this._splashAges = new Float32Array(SPLASH_POOL_SIZE);
    this._splashLifetimes = new Float32Array(SPLASH_POOL_SIZE);
    this._splashActive = new Uint8Array(SPLASH_POOL_SIZE);

    for (let i = 0; i < SPLASH_POOL_SIZE; i++) {
      this._splashPositions[i * 3 + 1] = -100.0;
    }

    const posAttr = new THREE.BufferAttribute(this._splashPositions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const sizeAttr = new THREE.BufferAttribute(this._splashSizes, 1);
    sizeAttr.setUsage(THREE.DynamicDrawUsage);
    const alphaAttr = new THREE.BufferAttribute(this._splashAlphas, 1);
    alphaAttr.setUsage(THREE.DynamicDrawUsage);

    this._splashGeometry = new THREE.BufferGeometry();
    this._splashGeometry.setAttribute('position', posAttr);
    this._splashGeometry.setAttribute('aSize', sizeAttr);
    this._splashGeometry.setAttribute('aAlpha', alphaAttr);

    this._splashMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunColor: this.uniforms.uSunColor,
        uSkyHorizonColor: this.uniforms.uSkyHorizonColor,
        uSunIntensity: this.uniforms.uSunIntensity,
        uFogColor: this.uniforms.uFogColor,
        uFogDensity: this.uniforms.uFogDensity,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;

        varying float vAlpha;
        varying float vDist;

        void main() {
          vAlpha = aAlpha;
          vec4 worldPos = modelMatrix * vec4( position, 1.0 );
          vec4 mvPosition = viewMatrix * worldPos;
          vDist = length( cameraPosition - worldPos.xyz );
          gl_Position = projectionMatrix * mvPosition;

          if ( aAlpha <= 0.002 ) {
            gl_PointSize = 0.0;
          } else {
            gl_PointSize = clamp( aSize * ( 290.0 / max( -mvPosition.z, 0.5 ) ), 1.5, 42.0 );
          }
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunColor;
        uniform vec3 uSkyHorizonColor;
        uniform float uSunIntensity;
        uniform vec3 uFogColor;
        uniform float uFogDensity;

        varying float vAlpha;
        varying float vDist;

        void main() {
          if ( vAlpha <= 0.002 ) {
            discard;
          }

          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot( p, p );
          if ( r2 > 1.0 ) {
            discard;
          }

          float r = sqrt( r2 );
          float softBody = pow( max( 1.0 - r, 0.0 ), 1.45 );
          vec2 glintDelta = p - vec2( -0.25, -0.25 );
          float glint = exp( -dot( glintDelta, glintDelta ) * 11.5 );

          vec3 aquaCore = mix(
            vec3( 0.72, 0.91, 0.94 ),
            vec3( 0.97, 0.995, 1.0 ),
            clamp( softBody * 0.65 + glint * 0.65, 0.0, 1.0 )
          );
          vec3 envLit = max(
            uSkyHorizonColor * 0.52 + uSunColor * ( 0.20 + uSunIntensity * 0.72 ),
            vec3( 0.18, 0.25, 0.30 )
          );
          vec3 col = aquaCore * envLit + uSunColor * glint * ( 0.22 + uSunIntensity * 0.62 );

          float fogFactor = 1.0 - exp( -uFogDensity * uFogDensity * vDist * vDist );
          col = mix( col, uFogColor, clamp( fogFactor, 0.0, 1.0 ) );

          float alpha = clamp( ( softBody * 0.84 + glint * 0.42 ) * vAlpha, 0.0, 0.95 );
          gl_FragColor = vec4( col, alpha );

          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    const points = new THREE.Points(this._splashGeometry, this._splashMaterial);
    points.name = 'StreamSplashDroplets';
    points.frustumCulled = false;
    points.renderOrder = 3;
    return points;
  }

  /**
   * Registers up to 8 submerged bridge piling footprints `(x, z, radius)` for animated
   * white-water collar foam & downstream V-wake generation in the stream shader.
   */
  setBridgePilings(pilings = []) {
    const slots = this.uniforms.uBridgePilings.value;
    const list = Array.isArray(pilings) ? pilings : [];

    for (let i = 0; i < MAX_BRIDGE_PILINGS; i++) {
      const slot = slots[i];
      if (i < list.length && list[i]) {
        const p = list[i];
        let x = 9999;
        let z = 9999;
        let r = 0;

        if (Array.isArray(p) && p.length >= 3) {
          x = Number(p[0]);
          z = Number(p[1]);
          r = Number(p[2]);
        } else if (typeof p === 'object') {
          if ('radius' in p) {
            x = Number(p.position ? p.position.x : p.x);
            z = Number(p.position ? p.position.z : p.z);
            r = Number(p.radius);
          } else if (p.isVector3 || ('x' in p && 'y' in p && 'z' in p)) {
            x = Number(p.x);
            z = Number(p.y);
            r = Number(p.z);
          }
        }

        if (Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(r) && r > 0.001) {
          slot.set(x, z, r);
          continue;
        }
      }
      slot.set(9999, 9999, 0);
    }
  }

  /**
   * Updates live swimmer wake shader uniforms (`uSwimmerPos`, `uSwimmerSpeed`, `uSwimmerDir`,
   * `uSwimmerActive`) for frothy torso wake collar, treading rings & trailing Kelvin V-wake ripples.
   */
  setSwimmerState(pos, speed = 0.0, isSwimming = false) {
    const active = Boolean(isSwimming) && Boolean(pos);
    this._swimmerIsSwimming = active;

    if (!active) {
      this.uniforms.uSwimmerSpeed.value = 0.0;
      this.uniforms.uSwimmerActive.value = 0.0;
      this._hasPrevSwimmer = false;
      return;
    }

    const px = Array.isArray(pos) ? Number(pos[0]) : Number(pos.x);
    const py = Array.isArray(pos) ? Number(pos[1] ?? 0) : Number(pos.y ?? 0);
    const pz = Array.isArray(pos) ? Number(pos[2]) : Number(pos.z);

    if (!Number.isFinite(px) || !Number.isFinite(pz)) {
      this.uniforms.uSwimmerSpeed.value = 0.0;
      this.uniforms.uSwimmerActive.value = 0.0;
      return;
    }

    if (this._hasPrevSwimmer) {
      const dx = px - this._prevSwimmerPos.x;
      const dz = pz - this._prevSwimmerPos.z;
      const moveLen = Math.hypot(dx, dz);
      if (moveLen > 0.002 && moveLen < 12.0) {
        const dirU = this.uniforms.uSwimmerDir.value;
        const nx = dx / moveLen;
        const nz = dz / moveLen;
        const blend = clamp(moveLen * 2.4, 0.12, 0.55);
        dirU.set(lerp(dirU.x, nx, blend), lerp(dirU.y, nz, blend));
        const dLen = Math.hypot(dirU.x, dirU.y);
        if (dLen > 1e-4) {
          dirU.multiplyScalar(1.0 / dLen);
        }
      }
    } else if (this.terrain?.getStreamFlowDir) {
      this.terrain.getStreamFlowDir(pz, this.uniforms.uSwimmerDir.value);
    }

    this._prevSwimmerPos.set(px, Number.isFinite(py) ? py : 0.0, pz);
    this._hasPrevSwimmer = true;

    this.uniforms.uSwimmerPos.value.set(px, Number.isFinite(py) ? py : 0.0, pz);
    this.uniforms.uSwimmerSpeed.value = clamp(Number.isFinite(speed) ? speed : 0.0, 0.0, 12.0);
    this.uniforms.uSwimmerActive.value = 1.0;
  }

  /**
   * Spawns an expanding concentric surface impact ripple in uImpactRipples
   * and emits a glistening upward/outward splash droplet burst from the pool.
   */
  spawnImpact(worldPos, strength = 1.0) {
    if (!worldPos) return;

    const s = clamp(Number.isFinite(strength) ? strength : 1.0, 0.1, 2.5);
    const waterY = this.uniforms.uWaterLevel.value;
    const wx = worldPos.x;
    const wz = worldPos.z;

    // 1. Ring-buffer record expanding ripple (x, z, startTime, strength)
    const slot = this.uniforms.uImpactRipples.value[this._impactRippleCursor];
    slot.set(wx, wz, this.uniforms.uTime.value, s);
    this._impactRippleCursor = (this._impactRippleCursor + 1) % MAX_IMPACT_RIPPLES;

    // 2. Emit 14–36 sparkling upward/outward splash droplets scaled by impact strength
    const strNorm = clamp((s - 0.35) / 1.45, 0.0, 1.0);
    const emitCount = Math.round(lerp(14, 36, strNorm));

    for (let k = 0; k < emitCount; k++) {
      const idx = this._splashCursor;
      this._splashCursor = (this._splashCursor + 1) % SPLASH_POOL_SIZE;

      const angle = Math.random() * Math.PI * 2.0;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const spawnRad = (0.04 + Math.random() * 0.24) * (0.65 + s * 0.35);

      const isFineMist = Math.random() < 0.35;
      const horizSpeed = (0.75 + Math.random() * 1.95) * (0.65 + s * 0.45) * (isFineMist ? 1.15 : 0.9);
      const vertSpeed = (2.1 + Math.random() * 3.1) * (0.65 + s * 0.42) * (isFineMist ? 1.12 : 0.95);

      const p3 = idx * 3;
      this._splashPositions[p3] = wx + cosA * spawnRad;
      this._splashPositions[p3 + 1] = waterY + 0.03 + Math.random() * 0.08;
      this._splashPositions[p3 + 2] = wz + sinA * spawnRad;

      this._splashVelocities[p3] = cosA * horizSpeed;
      this._splashVelocities[p3 + 1] = vertSpeed;
      this._splashVelocities[p3 + 2] = sinA * horizSpeed;

      this._splashSizes[idx] = (isFineMist ? 0.048 : 0.085) + Math.random() * 0.095 * (0.75 + s * 0.25);
      this._splashAlphas[idx] = isFineMist ? 0.72 + Math.random() * 0.2 : 0.86 + Math.random() * 0.14;
      this._splashAges[idx] = 0.0;
      this._splashLifetimes[idx] = 0.42 + Math.random() * 0.48;
      this._splashActive[idx] = 1;
    }

    this._splashDirty = true;
    this._activeSplashCount = Math.min(SPLASH_POOL_SIZE, this._activeSplashCount + emitCount);
    this._splashGeometry.attributes.position.needsUpdate = true;
    this._splashGeometry.attributes.aSize.needsUpdate = true;
    this._splashGeometry.attributes.aAlpha.needsUpdate = true;
  }

  _updateSplashParticles(dt) {
    if (!this._splashDirty && this._activeSplashCount === 0) return;

    const waterY = this.uniforms.uWaterLevel.value;
    const horizDrag = dt > 0 ? Math.exp(-dt * 1.6) : 1.0;
    let activeCount = 0;

    for (let i = 0; i < SPLASH_POOL_SIZE; i++) {
      if (!this._splashActive[i]) continue;

      const age = this._splashAges[i] + dt;
      const lifetime = this._splashLifetimes[i];
      const p3 = i * 3;

      let vx = this._splashVelocities[p3] * horizDrag;
      let vy = this._splashVelocities[p3 + 1] + SPLASH_GRAVITY * dt;
      let vz = this._splashVelocities[p3 + 2] * horizDrag;

      const px = this._splashPositions[p3] + vx * dt;
      const py = this._splashPositions[p3 + 1] + vy * dt;
      const pz = this._splashPositions[p3 + 2] + vz * dt;

      this._splashVelocities[p3] = vx;
      this._splashVelocities[p3 + 1] = vy;
      this._splashVelocities[p3 + 2] = vz;

      const lifeT = clamp(age / Math.max(lifetime, 0.001), 0.0, 1.0);
      const lifeFade = 1.0 - lifeT;

      // Fade alpha smoothly as droplets plunge back into the stream surface
      let splashdownFade = 1.0;
      if (vy < 0.0 && py < waterY + 0.08) {
        splashdownFade = clamp((py - (waterY - 0.05)) / 0.13, 0.0, 1.0);
      }

      const alpha = lifeFade * lifeFade * splashdownFade * 0.92;

      if (age >= lifetime || (vy < 0.0 && py <= waterY - 0.05) || alpha <= 0.005) {
        this._splashActive[i] = 0;
        this._splashAlphas[i] = 0.0;
        this._splashPositions[p3 + 1] = -100.0;
      } else {
        this._splashAges[i] = age;
        this._splashPositions[p3] = px;
        this._splashPositions[p3 + 1] = py;
        this._splashPositions[p3 + 2] = pz;
        this._splashAlphas[i] = alpha;
        activeCount++;
      }
    }

    this._activeSplashCount = activeCount;
    this._splashDirty = activeCount > 0;
    this._splashGeometry.attributes.position.needsUpdate = true;
    this._splashGeometry.attributes.aSize.needsUpdate = true;
    this._splashGeometry.attributes.aAlpha.needsUpdate = true;
  }

  update(
    elapsed,
    {
      sunDir,
      sunColor,
      skyZenithColor,
      skyHorizonColor,
      sunIntensity,
      fogColor,
      fogDensity,
      rainIntensity,
      windSpeed,
    } = {}
  ) {
    const safeElapsed = Number.isFinite(elapsed) ? elapsed : 0.0;
    const dt = clamp(safeElapsed - this._lastElapsed, 0.0, 0.05);
    this._lastElapsed = safeElapsed;

    this.uniforms.uTime.value = safeElapsed;

    if (sunDir) {
      this.uniforms.uSunDir.value.copy(sunDir).normalize();
    }
    if (sunColor) {
      this.uniforms.uSunColor.value.copy(sunColor);
    }
    if (skyZenithColor) {
      this.uniforms.uSkyZenithColor.value.copy(skyZenithColor);
    }
    if (skyHorizonColor) {
      this.uniforms.uSkyHorizonColor.value.copy(skyHorizonColor);
    }
    if (sunIntensity !== undefined) {
      this.uniforms.uSunIntensity.value = sunIntensity;
    }
    if (fogColor) {
      this.uniforms.uFogColor.value.copy(fogColor);
    }
    if (fogDensity !== undefined) {
      this.uniforms.uFogDensity.value = fogDensity;
    }
    if (rainIntensity !== undefined) {
      this.uniforms.uRainIntensity.value = rainIntensity;
    }

    if (windSpeed !== undefined) {
      this.uniforms.uWindSpeed.value = windSpeed;
    } else if (this.windSystem?.uniforms?.uWindSpeed) {
      this.uniforms.uWindSpeed.value = this.windSystem.uniforms.uWindSpeed.value;
    }

    if (this.windSystem?.uniforms?.uWindDir) {
      this.uniforms.uWindDir.value.copy(this.windSystem.uniforms.uWindDir.value);
    }

    this._updateSplashParticles(dt);
  }

  dispose() {
    if (this.splashPoints) {
      this.mesh.remove(this.splashPoints);
    }
    if (this._splashGeometry) {
      this._splashGeometry.dispose();
    }
    if (this._splashMaterial) {
      this._splashMaterial.dispose();
    }
    this.geometry.dispose();
    this.material.dispose();
  }
}
