import * as THREE from 'three';
import { lerp } from '../utils/random.js';

const STREAM_Z_MIN = -120;
const STREAM_Z_MAX = 120;
const WIDTH_SEGMENTS = 48;
const LENGTH_SEGMENTS = 260;

/**
 * Procedural meandering forest stream ribbon with custom WebGL2-safe GLSL water shader:
 * - Dual-scrolling downstream ripple waves + cross wind chop + concentric raindrop rings
 * - Schlick Fresnel sky reflection + crisp sun/moon specular glints
 * - Exponential depth color absorption (warm emerald shallows -> deep forest teal)
 * - Animated noise-broken shoreline foam + downstream riffle highlights
 * - Shallow projected riverbed caustics + matching FogExp2 atmospheric attenuation
 */
export class StreamWater {
  constructor(terrain, windSystem = null) {
    this.terrain = terrain;
    this.windSystem = windSystem;

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
    };

    this.geometry = this._buildRibbonGeometry();
    this.material = this._buildMaterial();

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'ForestStreamWater';
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
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
    // and extending across any contiguous submerged bank coves so water always tucks under dry ground
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

    // Gentle 5-tap smoothing pass along stream length so cove transitions stay fluid
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
      side: THREE.FrontSide,
      vertexShader: /* glsl */ `
        attribute float aBedHeight;
        attribute vec2 aFlowDir;

        uniform float uTime;
        uniform float uWaterLevel;
        uniform float uWindSpeed;

        varying vec3 vWorldPos;
        varying vec2 vUv;
        varying float vBedHeight;
        varying vec2 vFlowDir;

        void main() {
          vUv = uv;
          vBedHeight = aBedHeight;
          vFlowDir = normalize( aFlowDir + vec2( 1e-5, 0.0 ) );

          vec3 pos = position;

          // Keep shoreline pinned strictly to water level; gently breathe deep mid-stream
          float depth = max( uWaterLevel - aBedHeight, 0.0 );
          float deepMask = smoothstep( 0.08, 0.65, depth );
          float swell = sin( uv.y * 5.2 - uTime * 2.1 + uv.x * 1.4 ) * 0.011
                      + cos( uv.y * 8.6 - uTime * 3.1 - uv.x * 2.6 ) * 0.006;
          pos.y += swell * deepMask * clamp( 0.65 + uWindSpeed * 0.3, 0.65, 1.8 );

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

        varying vec3 vWorldPos;
        varying vec2 vUv;
        varying float vBedHeight;
        varying vec2 vFlowDir;

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

        float fbm3( vec2 p ) {
          float sum = 0.0;
          float amp = 0.5;
          mat2 rot = mat2( 0.80, -0.60, 0.60, 0.80 );
          for ( int i = 0; i < 3; i++ ) {
            sum += amp * valueNoise( p );
            p = rot * p * 2.04 + vec2( 11.7, 23.3 );
            amp *= 0.5;
          }
          return sum;
        }

        // Dual-scrolling downstream ripple field in stream-aligned (u, v) space
        float streamWaveHeight( vec2 suv, float t ) {
          // Layer 1: primary downstream current undulations with gentle domain warp
          vec2 warp = vec2(
            valueNoise( suv * vec2( 2.2, 1.6 ) - vec2( 0.0, t * 0.45 ) ) - 0.5,
            valueNoise( suv * vec2( 2.2, 1.6 ) + vec2( 7.3, -t * 0.52 ) ) - 0.5
          ) * 0.45;

          vec2 p1 = ( suv + warp ) * vec2( 3.2, 2.1 ) - vec2( 0.04 * t, t * 0.88 );
          float w1 = valueNoise( p1 ) * 0.55 + valueNoise( p1 * 2.18 + vec2( 4.1, -t * 0.42 ) ) * 0.28;

          // Layer 2: counter-angled fine capillary ripples flowing slightly faster
          mat2 r2 = mat2( 0.92, -0.39, 0.39, 0.92 );
          vec2 p2 = r2 * ( suv * vec2( 5.4, 4.2 ) ) - vec2( -0.11 * t, t * 1.42 );
          float w2 = valueNoise( p2 ) * 0.48 + valueNoise( p2 * 2.35 + vec2( -5.4, -t * 0.72 ) ) * 0.24;

          // Layer 3: micro sparkle facet detail
          vec2 p3 = suv * vec2( 9.5, 8.2 ) - vec2( 0.08 * t, t * 2.1 );
          float w3 = valueNoise( p3 ) * 0.16;

          return ( w1 + w2 ) * 0.48 + w3;
        }

        // Cross-wind capillary chop driven by windSystem direction & speed
        float windChopHeight( vec2 worldXZ, float t, vec2 wDir, float wSpeed ) {
          vec2 wPerp = vec2( -wDir.y, wDir.x );
          float along = dot( worldXZ, wDir );
          float across = dot( worldXZ, wPerp );
          float speed = 1.6 + wSpeed * 2.4;

          float c1 = valueNoise( vec2( along * 1.45 - t * speed, across * 2.4 ) );
          float c2 = valueNoise( vec2( along * 3.6 - t * ( speed * 1.45 ), across * 4.8 + c1 * 1.6 ) );
          return ( c1 * 0.62 + c2 * 0.38 );
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

        // Flowing shallow caustic interference pattern
        float computeCaustics( vec2 suv, float t ) {
          vec2 p1 = suv * vec2( 4.6, 3.8 ) - vec2( 0.0, t * 0.78 );
          vec2 p2 = suv * vec2( 6.1, 5.2 ) - vec2( t * 0.14, t * 1.05 );
          float n1 = sin( p1.x * 3.2 + sin( p1.y * 2.7 + t * 1.1 ) );
          float n2 = cos( p2.y * 3.5 + sin( p2.x * 3.1 - t * 1.3 ) );
          float web = 1.0 - abs( n1 + n2 ) * 0.5;
          return pow( clamp( web, 0.0, 1.0 ), 4.4 );
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

          // Finite-difference gradient of dual-scrolling downstream waves
          float eps = 0.032;
          float hC = streamWaveHeight( vUv, uTime );
          float hU = streamWaveHeight( vUv + vec2( eps, 0.0 ), uTime );
          float hV = streamWaveHeight( vUv + vec2( 0.0, eps ), uTime );

          float dU = ( hU - hC ) / eps;
          float dV = ( hV - hC ) / eps;

          // Subtle stronger chop over shallow riffles
          float shallowRiffle = 1.0 + ( 1.0 - smoothstep( 0.05, 0.48, depth ) ) * 0.45;
          float streamBump = 0.068 * shallowRiffle;
          vec2 worldSlope = ( rightDir * dU + flowDir * dV ) * streamBump;

          // Cross-wind chop perturbation
          vec2 wDir = normalize( uWindDir + vec2( 1e-5, 0.0 ) );
          float wScale = clamp( uWindSpeed, 0.0, 3.2 );
          float wEps = 0.09;
          float wcC = windChopHeight( vWorldPos.xz, uTime, wDir, wScale );
          float wcX = windChopHeight( vWorldPos.xz + vec2( wEps, 0.0 ), uTime, wDir, wScale );
          float wcZ = windChopHeight( vWorldPos.xz + vec2( 0.0, wEps ), uTime, wDir, wScale );
          float windAmp = ( 0.022 + wScale * 0.038 ) * smoothstep( 0.02, 0.24, depth );
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

          vec3 N = normalize( vec3( -worldSlope.x, 1.0, -worldSlope.y ) );
          vec3 V = normalize( cameraPosition - vWorldPos );
          vec3 L = normalize( uSunDir );

          // Schlick Fresnel reflection (F0 = 0.02)
          float NdotV = max( dot( N, V ), 0.0 );
          float fresnel = 0.02 + 0.98 * pow( max( 1.0 - NdotV, 0.0 ), 5.0 );

          // Reflected sky gradient with forest-canopy reflection tint near low grazing angles
          vec3 R = reflect( -V, N );
          float skyGrad = pow( clamp( R.y, 0.0, 1.0 ), 0.55 );
          vec3 skyRefl = mix( uSkyHorizonColor, uSkyZenithColor, skyGrad );
          float canopyDarken = smoothstep( 0.02, 0.36, R.y );
          vec3 canopyTint = mix( uSkyHorizonColor * vec3( 0.18, 0.28, 0.20 ), skyRefl, canopyDarken );
          vec3 reflectionColor = mix( canopyTint, skyRefl, 0.52 ) * 0.85;

          // Crisp dual-lobe specular sun/moon glints
          vec3 H = normalize( L + V + vec3( 0.0, 1e-5, 0.0 ) );
          float NdotH = max( dot( N, H ), 0.0 );
          float rainSpecDamp = mix( 1.0, 0.32, uRainIntensity );
          float specSharp = pow( NdotH, 340.0 ) * 2.65;
          float specBroad = pow( NdotH, 46.0 ) * 0.20;
          float grazingBoost = mix( 0.65, 1.35, pow( max( 1.0 - NdotV, 0.0 ), 2.0 ) );
          float lightElevFade = smoothstep( -0.02, 0.16, L.y );
          vec3 specular = uSunColor * ( specSharp + specBroad ) * ( 0.26 + uSunIntensity * 1.15 )
                        * rainSpecDamp * grazingBoost * lightElevFade;

          // Exponential depth color absorption (warm emerald shallows -> deep forest teal)
          vec3 absorption = exp( -depth * vec3( 0.58, 0.22, 0.14 ) );
          vec3 shallowTint = vec3( 0.14, 0.32, 0.22 );
          vec3 deepTint = vec3( 0.010, 0.052, 0.068 );
          vec3 waterScatter = mix( deepTint, shallowTint, clamp( absorption.g, 0.0, 1.0 ) );

          // Harmonize water body brightness cleanly between sunlit emerald day & moody moonlit night
          float skyLuma = dot( uSkyHorizonColor, vec3( 0.299, 0.587, 0.114 ) );
          vec3 irradiance = uSkyHorizonColor * 0.34 + uSkyZenithColor * 0.20
                          + uSunColor * max( L.y, 0.04 ) * ( 0.06 + uSunIntensity * 0.52 );
          vec3 bodyColor = waterScatter * irradiance * mix( 0.65, 1.18, clamp( skyLuma * 2.2, 0.0, 1.0 ) );

          // Subtle projected riverbed caustics visible through shallow transparent water in daylight
          vec2 refractedUv = vUv - vec2( dot( N.xz, rightDir ), dot( N.xz, flowDir ) ) * min( depth, 1.0 ) * 0.16;
          float caustics = computeCaustics( refractedUv, uTime );
          float causticMask = smoothstep( 0.04, 0.18, depth ) * exp( -depth * 1.75 );
          float dayCausticVis = smoothstep( 0.12, 0.65, uSunIntensity ) * ( 1.0 - uRainIntensity * 0.7 );
          vec3 causticLight = uSunColor * vec3( 0.72, 1.0, 0.88 ) * caustics * causticMask
                            * absorption * dayCausticVis * 0.38;
          bodyColor += causticLight;

          // Combine refracted stream body with Fresnel sky reflection + specular sparkle
          vec3 waterColor = mix( bodyColor, reflectionColor, clamp( fresnel * 0.90, 0.0, 0.90 ) ) + specular;

          // Organic noise-broken shoreline foam where depth < 0.25 + subtle downstream riffle highlights
          float foamMacro = fbm3( vUv * vec2( 2.8, 2.2 ) - vec2( 0.0, uTime * 0.36 ) );
          float foamLace = fbm3( vUv * vec2( 8.5, 6.8 ) - vec2( 0.06 * uTime, uTime * 0.82 ) );
          float foamFine = valueNoise( vUv * vec2( 18.0, 15.0 ) - vec2( -0.09 * uTime, uTime * 1.25 ) );

          // Break shore zone organically so foam forms delicate patchy wisps rather than a solid stripe
          float wavyDepthLimit = 0.25 * ( 0.35 + foamMacro * 0.95 );
          float shoreZone = ( 1.0 - smoothstep( 0.02, max( wavyDepthLimit, 0.05 ), depth ) )
                          * smoothstep( 0.008, 0.055, depth );
          float frothMask = smoothstep( 0.44, 0.76, foamLace * 0.72 + foamFine * 0.42 ) * smoothstep( 0.36, 0.68, foamMacro );
          float foamEdge = shoreZone * frothMask * 0.75;

          // Subtle downstream riffle crests over shallow-medium water
          float waveSteepness = length( worldSlope );
          float riffleMask = smoothstep( 0.08, 0.24, depth ) * ( 1.0 - smoothstep( 0.26, 0.72, depth ) );
          float riffleFoam = smoothstep( 0.16, 0.36, waveSteepness ) * riffleMask * smoothstep( 0.48, 0.78, foamFine ) * 0.36;

          float foamAmount = clamp( foamEdge + riffleFoam, 0.0, 0.72 );
          vec3 foamAlbedo = vec3( 0.91, 0.94, 0.90 );
          vec3 foamLit = foamAlbedo * ( uSkyHorizonColor * 0.42 + uSunColor * max( L.y, 0.06 ) * ( 0.08 + uSunIntensity * 0.56 ) );
          waterColor = mix( waterColor, foamLit, foamAmount );

          // Physically inspired opacity: crystal-clear shallows -> rich deep teal, boosted by Fresnel & foam
          float depthAlpha = 1.0 - exp( -depth * 1.75 );
          float alpha = clamp( max( depthAlpha, max( fresnel * 0.85, foamAmount * 0.88 ) ), 0.0, 0.96 ) * edgeAlpha;

          // Match Three.js FogExp2 atmospheric distance fog
          float dist = length( cameraPosition - vWorldPos );
          float fogFactor = 1.0 - exp( -uFogDensity * uFogDensity * dist * dist );
          waterColor = mix( waterColor, uFogColor, clamp( fogFactor, 0.0, 1.0 ) );

          gl_FragColor = vec4( waterColor, alpha );

          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
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
    this.uniforms.uTime.value = elapsed;

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
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
