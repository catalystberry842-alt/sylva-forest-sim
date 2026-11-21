import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { createRng, clamp, lerp, smoothstep } from '../utils/random.js';

const UP = new THREE.Vector3(0, 1, 0);

const QUALITY_SHADOW_MAP = {
  medium: 1024,
  high: 2048,
  ultra: 4096,
};

// Reusable color palette anchors (sRGB hex converted cleanly by Three.js ColorManagement)
const PALETTE = {
  // Sun / Moon directional light colors
  sunNoon: new THREE.Color(0xfff4de),
  sunDawn: new THREE.Color(0xffb974),
  sunSunset: new THREE.Color(0xff7e3e),
  sunTwilight: new THREE.Color(0x7c8db8),
  moonNight: new THREE.Color(0x9abbf0),
  sunRainTint: new THREE.Color(0x9cb0bf),

  // Sky zenith colors
  zenithNoon: new THREE.Color(0x1f5db0),
  zenithDawn: new THREE.Color(0x2a5290),
  zenithSunset: new THREE.Color(0x233468),
  zenithTwilight: new THREE.Color(0x0c1733),
  zenithNight: new THREE.Color(0x050a18),
  zenithRainDay: new THREE.Color(0x364552),
  zenithRainNight: new THREE.Color(0x050a14),

  // Sky horizon colors
  horizonNoon: new THREE.Color(0x8bbde0),
  horizonDawn: new THREE.Color(0xeba97b),
  horizonSunset: new THREE.Color(0xe67c4a),
  horizonTwilight: new THREE.Color(0x2d385c),
  horizonNight: new THREE.Color(0x101d34),
  horizonRainDay: new THREE.Color(0x526473),
  horizonRainNight: new THREE.Color(0x09111e),

  // Exponential fog colors
  fogNoon: new THREE.Color(0x80a9c4),
  fogDawn: new THREE.Color(0xc29882),
  fogSunset: new THREE.Color(0xb26e5a),
  fogTwilight: new THREE.Color(0x1b2740),
  fogNight: new THREE.Color(0x0a1322),
  fogRainDay: new THREE.Color(0x4b5c69),
  fogRainNight: new THREE.Color(0x08101b),

  // Hemisphere ground bounce colors
  groundNoon: new THREE.Color(0x3a4d2c),
  groundGolden: new THREE.Color(0x453528),
  groundNight: new THREE.Color(0x0d1726),
  groundRain: new THREE.Color(0x26312d),

  // God ray shaft tint colors
  rayNoon: new THREE.Color(0xfff1cc),
  rayDawn: new THREE.Color(0xffc985),
  raySunset: new THREE.Color(0xff9a58),
};

/**
 * Full 24-hour atmospheric sky, dynamic sun/moon lighting, shadow management,
 * twinkling starfield dome, luminous cratered moon + halo, dynamic FogExp2,
 * and 22 volumetric canopy god-ray sunbeam shafts.
 */
export class SkyLighting {
  constructor(scene, renderer, terrain) {
    this.scene = scene;
    this.renderer = renderer;
    this.terrain = terrain;

    // Public dynamic atmosphere state
    this.sunDir = new THREE.Vector3(0.4, 0.7, -0.4).normalize();
    this.sunColor = new THREE.Color(0xfff4de);
    this.skyZenithColor = new THREE.Color(0x1f5db0);
    this.skyHorizonColor = new THREE.Color(0x9cc6e6);
    this.fogColor = new THREE.Color(0x9abbd0);
    this.fogDensity = 0.007;
    this.daylight = 1.0;
    this.nightFactor = 0.0;
    this.sunIntensity = 1.0;

    // Internal celestial vectors & smoothed weather blend state
    this._trueSunDir = new THREE.Vector3(0.4, 0.7, -0.4).normalize();
    this._moonDir = new THREE.Vector3(-0.4, -0.7, 0.4).normalize();
    this._shadowLightDir = new THREE.Vector3(0.4, 0.7, -0.4).normalize();
    this._rayAlignDir = new THREE.Vector3(0.4, 0.7, -0.4).normalize();
    this._tempColorA = new THREE.Color();
    this._tempColorB = new THREE.Color();
    this._tempVec = new THREE.Vector3();
    this._tempQuat = new THREE.Quaternion();
    this._shadowTargetPos = new THREE.Vector3();

    this._rainBlend = 0.0;
    this._galeBlend = 0.0;
    this._initialized = false;
    this._shadowMapSize = 2048;

    // 1. Procedural Preetham Sky dome (scaled to 450)
    this.sky = new Sky();
    this.sky.scale.setScalar(450);
    this.sky.frustumCulled = false;
    this.sky.name = 'AtmosphericSky';
    this.sky.material.uniforms.cloudScale.value = 0.00022;
    this.sky.material.uniforms.cloudElevation.value = 0.48;
    this._patchSkyMaterial(this.sky.material);
    this.scene.add(this.sky);

    // 2. Twinkling nocturnal starfield dome (~1,200 stars on hemisphere r = 220)
    this.starDome = this._buildStarfield();
    this.scene.add(this.starDome);

    // 3. Luminous Moon disc + concentric atmospheric halo opposite the sun
    const { group, disc, halo } = this._buildMoon();
    this.moonGroup = group;
    this._moonDisc = disc;
    this._moonHalo = halo;
    this.scene.add(this.moonGroup);

    // 4. Shadow-casting directional Sun / Moon light
    this.sunLight = new THREE.DirectionalLight(0xfff4de, 2.8);
    this.sunLight.name = 'PrimaryCelestialLight';
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(this._shadowMapSize, this._shadowMapSize);
    this.sunLight.shadow.camera.left = -62;
    this.sunLight.shadow.camera.right = 62;
    this.sunLight.shadow.camera.top = 62;
    this.sunLight.shadow.camera.bottom = -62;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 220;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.038;
    this.sunLight.shadow.camera.updateProjectionMatrix();
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // 5. Sky/ground HemisphereLight + subtle ambient fill light
    this.hemiLight = new THREE.HemisphereLight(0x9cc6e6, 0x3a4d2c, 0.85);
    this.hemiLight.name = 'ForestHemisphereLight';
    this.scene.add(this.hemiLight);

    this.ambientLight = new THREE.AmbientLight(0x28384a, 0.18);
    this.ambientLight.name = 'ForestAmbientFill';
    this.scene.add(this.ambientLight);

    // 6. Dynamic exponential distance fog
    this.fog = new THREE.FogExp2(this.fogColor.getHex(), this.fogDensity);
    this.scene.fog = this.fog;
    this.scene.background = this.fogColor.clone();

    // 7. 22 Volumetric Sunbeams (God Rays) placed across clearing, stream valley & glades
    this.godRayGroup = this._buildGodRays();
    this.scene.add(this.godRayGroup);

    // Initialize state to pleasant golden late-morning default
    this.update(0, 0, {
      timeOfDay: 10.5,
      weather: 'Clear',
      fogDensityMultiplier: 1.0,
      godRayIntensity: 1.0,
    });
  }

  /**
   * Calibrates Three.js Preetham Sky linear HDR output so bright daytime sky & clouds
   * stay richly colored below the UnrealBloomPass threshold (0.92) while the solar disc
   * retains cinematic HDR bloom, Rain shifts clouds to moody storm slate, and Night
   * gains a deep indigo atmospheric gradient behind the stars and moon.
   */
  _patchSkyMaterial(material) {
    material.uniforms.uSkyExposure = { value: 0.24 };
    material.uniforms.uRainOvercast = { value: 0.0 };
    material.uniforms.uNightMix = { value: 0.0 };
    material.uniforms.uNightZenith = { value: new THREE.Color(0x040814) };
    material.uniforms.uNightHorizon = { value: new THREE.Color(0x0e1a30) };

    material.fragmentShader = material.fragmentShader.replace(
      'uniform float time;',
      `uniform float time;
      uniform float uSkyExposure;
      uniform float uRainOvercast;
      uniform float uNightMix;
      uniform vec3 uNightZenith;
      uniform vec3 uNightHorizon;`
    );

    material.fragmentShader = material.fragmentShader.replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      `vec3 calibrated = texColor * uSkyExposure;
      float isDisc = smoothstep( 0.05, 0.5, sundisc ) * ( 1.0 - uRainOvercast * 0.92 );
      vec3 skyCompressed = ( calibrated / ( 1.0 + calibrated * 1.18 ) ) * 0.84;
      vec3 discHDR = min( calibrated * 0.45, vec3( 3.2 ) );
      vec3 finalSky = mix( skyCompressed, max( skyCompressed, discHDR ), isDisc );

      float skyLuma = dot( finalSky, vec3( 0.2126, 0.7152, 0.0722 ) );
      vec3 rainSkyCol = vec3( skyLuma * 0.72, skyLuma * 0.80, skyLuma * 0.90 ) * 0.52;
      finalSky = mix( finalSky, rainSkyCol, uRainOvercast * 0.86 );

      float nightGrad = pow( clamp( direction.y, 0.0, 1.0 ), 0.52 );
      vec3 nightSky = mix( uNightHorizon, uNightZenith, nightGrad );
      finalSky = mix( finalSky, max( finalSky, nightSky ), uNightMix );

      gl_FragColor = vec4( finalSky, 1.0 );`
    );
    material.needsUpdate = true;
  }

  _buildStarfield() {
    const starCount = 1200;
    const radius = 220;
    const rng = createRng(7771);

    const positions = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);
    const phases = new Float32Array(starCount);
    const speeds = new Float32Array(starCount);
    const colors = new Float32Array(starCount * 3);

    // Realistic blackbody stellar hues (blue-white, pure ivory, soft warm gold)
    const starPalette = [
      new THREE.Color(0xc8dcff),
      new THREE.Color(0xeef4ff),
      new THREE.Color(0xffffff),
      new THREE.Color(0xfff1d6),
      new THREE.Color(0xffd7a8),
    ];

    for (let i = 0; i < starCount; i++) {
      // Uniform solid-angle sampling over upper hemisphere above horizon band
      const cosTheta = 0.03 + rng() * 0.97;
      const sinTheta = Math.sqrt(Math.max(1.0 - cosTheta * cosTheta, 0.0));
      const phi = rng() * Math.PI * 2.0;

      const x = radius * sinTheta * Math.cos(phi);
      const y = radius * cosTheta;
      const z = radius * sinTheta * Math.sin(phi);

      const i3 = i * 3;
      positions[i3] = x;
      positions[i3 + 1] = y;
      positions[i3 + 2] = z;

      // Power-law star magnitude distribution (mostly delicate pinpoints, ~10% prominent)
      const mag = Math.pow(rng(), 2.8);
      sizes[i] = 1.45 + mag * 3.8;
      phases[i] = rng() * Math.PI * 2.0;
      speeds[i] = 1.1 + rng() * 3.6;

      const col = starPalette[Math.floor(rng() * starPalette.length)];
      const brightness = 0.62 + mag * 0.65;
      colors[i3] = col.r * brightness;
      colors[i3 + 1] = col.g * brightness;
      colors[i3 + 2] = col.b * brightness;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uOpacity: { value: 0.0 },
        uPixelRatio: { value: this.renderer?.getPixelRatio?.() ?? 1.0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aPhase;
        attribute float aSpeed;
        attribute vec3 aColor;

        uniform float uTime;
        uniform float uPixelRatio;

        varying vec3 vColor;
        varying float vTwinkle;
        varying float vHorizonFade;

        void main() {
          vColor = aColor;

          // Multi-harmonic scintillation twinkle
          float t1 = sin( uTime * aSpeed + aPhase );
          float t2 = sin( uTime * ( aSpeed * 1.73 ) + aPhase * 2.1 );
          vTwinkle = 0.58 + 0.30 * t1 + 0.12 * t2;

          // Atmospheric extinction near horizon
          float elev = clamp( normalize( position ).y, 0.0, 1.0 );
          vHorizonFade = smoothstep( 0.03, 0.24, elev );

          vec4 clipPos = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          // Sit cleanly behind all world terrain/trees and over the Sky dome
          clipPos.z = clipPos.w * 0.99999;
          gl_Position = clipPos;

          gl_PointSize = aSize * uPixelRatio * ( 0.85 + 0.25 * vTwinkle );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;

        varying vec3 vColor;
        varying float vTwinkle;
        varying float vHorizonFade;

        void main() {
          vec2 c = gl_PointCoord - vec2( 0.5 );
          float d = length( c ) * 2.0;
          if ( d > 1.0 ) {
            discard;
          }

          float core = exp( -d * d * 8.5 );
          float glow = pow( max( 1.0 - d, 0.0 ), 2.6 ) * 0.45;
          float alpha = ( core + glow ) * vTwinkle * vHorizonFade * uOpacity;

          gl_FragColor = vec4( vColor * ( 1.0 + core * 0.6 ), alpha );
        }
      `,
    });

    const points = new THREE.Points(geometry, material);
    points.name = 'NightStarfieldDome';
    points.frustumCulled = false;
    points.renderOrder = 1;
    points.visible = false;
    return points;
  }

  _buildMoon() {
    const group = new THREE.Group();
    group.name = 'CinematicMoonGroup';
    group.frustumCulled = false;

    // Soft wide atmospheric halo glow behind the lunar disc
    const haloGeo = new THREE.PlaneGeometry(72, 72);
    const haloMat = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0.0 },
        uHaloColor: { value: new THREE.Color(0x6b94d6) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 clipPos = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          clipPos.z = clipPos.w * 0.999985;
          gl_Position = clipPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform vec3 uHaloColor;
        varying vec2 vUv;

        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length( p );
          if ( r >= 1.0 ) {
            discard;
          }

          // Smooth outer edge mask guarantees zero visible quad boundary
          float edgeMask = 1.0 - smoothstep( 0.65, 1.0, r );
          float innerCorona = exp( -r * 7.5 ) * 0.72;
          float outerMist = exp( -r * 2.8 ) * 0.24;
          float intensity = ( innerCorona + outerMist ) * edgeMask * uOpacity;

          vec3 col = mix( uHaloColor, vec3( 0.88, 0.94, 1.0 ), innerCorona );
          gl_FragColor = vec4( col * intensity, intensity );
        }
      `,
    });

    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.name = 'MoonAtmosphericHalo';
    halo.frustumCulled = false;
    halo.renderOrder = 1;
    group.add(halo);

    // Crisp luminous cratered Moon disc (normal alpha blending so it occludes stars behind it)
    const discGeo = new THREE.PlaneGeometry(14.5, 14.5);
    const discMat = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0.0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 clipPos = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          clipPos.z = clipPos.w * 0.99998;
          gl_Position = clipPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying vec2 vUv;

        float mHash( vec2 p ) {
          vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
          p3 += dot( p3, p3.yzx + 33.33 );
          return fract( ( p3.x + p3.y ) * p3.z );
        }

        float mNoise( vec2 p ) {
          vec2 i = floor( p );
          vec2 f = fract( p );
          vec2 u = f * f * ( 3.0 - 2.0 * f );
          return mix(
            mix( mHash( i ), mHash( i + vec2( 1.0, 0.0 ) ), u.x ),
            mix( mHash( i + vec2( 0.0, 1.0 ) ), mHash( i + vec2( 1.0, 1.0 ) ), u.x ),
            u.y
          );
        }

        float mFbm( vec2 p ) {
          float v = 0.0;
          float a = 0.5;
          for ( int i = 0; i < 4; i++ ) {
            v += a * mNoise( p );
            p = p * 2.07 + vec2( 7.3, 13.1 );
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec2 p = ( vUv * 2.0 - 1.0 ) / 0.86;
          float r2 = dot( p, p );
          if ( r2 > 1.0 ) {
            discard;
          }

          float r = sqrt( r2 );
          float edgeAA = 1.0 - smoothstep( 0.93, 1.0, r );

          // Spherical surface projection for realistic lunar maria & subtle limb darkening
          float z = sqrt( max( 1.0 - r2, 0.0 ) );
          vec2 sphereUv = p / ( 0.65 + z * 0.65 );

          float maria = mFbm( sphereUv * 2.8 + vec2( 1.4, -0.8 ) );
          float craters = mFbm( sphereUv * 7.2 + vec2( -3.1, 2.5 ) );
          float mariaMask = smoothstep( 0.42, 0.72, maria );

          // Subtle waxing-full directional relief shading
          vec3 n = normalize( vec3( p.x, p.y, z ) );
          float phaseShade = clamp( dot( n, normalize( vec3( 0.25, 0.18, 0.95 ) ) ) * 0.32 + 0.76, 0.55, 1.08 );
          float limb = mix( 0.78, 1.04, pow( z, 0.35 ) );

          vec3 highland = vec3( 1.24, 1.28, 1.38 );
          vec3 mare = vec3( 0.76, 0.82, 0.94 );
          vec3 moonCol = mix( highland, mare, mariaMask * 0.62 );
          moonCol *= ( 0.92 + craters * 0.16 ) * phaseShade * limb;

          // Delicate outer lunar rim glow
          float rimGlow = ( 1.0 - smoothstep( 0.86, 1.0, r ) ) * 0.12;
          moonCol += vec3( 0.75, 0.88, 1.0 ) * rimGlow;

          gl_FragColor = vec4( moonCol, edgeAA * uOpacity );
        }
      `,
    });

    const disc = new THREE.Mesh(discGeo, discMat);
    disc.name = 'MoonEmissiveDisc';
    disc.frustumCulled = false;
    disc.renderOrder = 2;
    group.add(disc);

    group.visible = false;
    return { group, disc, halo };
  }

  _buildGodRays() {
    const group = new THREE.Group();
    group.name = 'VolumetricGodRays';

    // Tapered open-ended shaft pivoted cleanly at bottom ground anchor (y = 0 -> +36)
    const shaftGeo = new THREE.CylinderGeometry(1.1, 3.8, 36, 12, 1, true);
    shaftGeo.translate(0, 18, 0);
    shaftGeo.computeBoundingSphere();

    this._godRayUniforms = {
      uTime: { value: 0.0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.4).normalize() },
      uRayColor: { value: new THREE.Color(0xffe7b8) },
      uIntensity: { value: 0.22 },
      uFogDensity: { value: 0.007 },
    };

    this._godRayMaterial = new THREE.ShaderMaterial({
      uniforms: this._godRayUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        varying vec3 vViewDir;

        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4( position, 1.0 );
          vWorldPos = worldPos.xyz;
          vWorldNormal = normalize( mat3( modelMatrix ) * normal );
          vViewDir = cameraPosition - worldPos.xyz;

          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uSunDir;
        uniform vec3 uRayColor;
        uniform float uIntensity;
        uniform float uFogDensity;

        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        varying vec3 vViewDir;

        float gHash( vec2 p ) {
          vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
          p3 += dot( p3, p3.yzx + 33.33 );
          return fract( ( p3.x + p3.y ) * p3.z );
        }

        float gNoise( vec2 p ) {
          vec2 i = floor( p );
          vec2 f = fract( p );
          vec2 u = f * f * ( 3.0 - 2.0 * f );
          return mix(
            mix( gHash( i ), gHash( i + vec2( 1.0, 0.0 ) ), u.x ),
            mix( gHash( i + vec2( 0.0, 1.0 ) ), gHash( i + vec2( 1.0, 1.0 ) ), u.x ),
            u.y
          );
        }

        void main() {
          vec3 viewDir = normalize( vViewDir + vec3( 1e-5 ) );
          vec3 worldNorm = normalize( vWorldNormal + vec3( 1e-5 ) );

          // Silky Fresnel edge falloff eliminating any hard cylinder silhouette
          float fresnelEdge = pow( abs( dot( viewDir, worldNorm ) ), 1.75 );

          // Smooth top & bottom vertical fade (strict GLSL edge0 < edge1)
          float vertFade = smoothstep( 0.0, 0.25, vUv.y ) * ( 1.0 - smoothstep( 0.7, 1.0, vUv.y ) );

          // Subtle scrolling volumetric shaft streak noise (periodic around cylinder angle)
          float ang = vUv.x * 6.2831853;
          vec2 streakCoordA = vec2( sin( ang ) * 2.1 + cos( ang ) * 1.3 + vWorldPos.x * 0.03, vUv.y * 2.4 - uTime * 0.06 );
          vec2 streakCoordB = vec2( cos( ang ) * 3.4 - sin( ang ) * 2.2 + vWorldPos.z * 0.03, vUv.y * 4.2 - uTime * 0.095 );
          float streakNoise = gNoise( streakCoordA ) * 0.62 + gNoise( streakCoordB ) * 0.38;
          float shaftStreaks = mix( 0.52, 1.28, streakNoise );

          // Camera-angle Mie forward-scattering boost when looking toward the sun
          vec3 viewToRay = normalize( vWorldPos - cameraPosition + vec3( 1e-5 ) );
          float forwardScatter = mix( 0.38, 1.0, pow( max( dot( viewToRay, normalize( uSunDir ) ), 0.0 ), 2.2 ) );

          // Avoid lens blow-out when walking right through a light shaft + subtle distance mist fade
          float camDist = length( vWorldPos - cameraPosition );
          float nearFade = smoothstep( 2.8, 10.0, camDist );
          float distFogAtten = exp( -uFogDensity * uFogDensity * camDist * camDist * 0.65 );

          float alpha = fresnelEdge * vertFade * shaftStreaks * forwardScatter * nearFade * distFogAtten * uIntensity;
          if ( alpha <= 0.0005 ) {
            discard;
          }

          gl_FragColor = vec4( uRayColor * alpha, alpha );
        }
      `,
    });

    this._godRayGeometry = shaftGeo;
    this._godRayMeshes = [];

    const rng = createRng(31415);
    const clearingX = this.terrain?.clearingCenter?.x ?? 10.5;
    const clearingZ = this.terrain?.clearingCenter?.y ?? 6.0;

    // 22 hand-curated & procedurally jittered canopy openings:
    //  - 8 around clearing perimeter & campfire canopy gap
    //  - 8 along the winding stream valley corridor
    //  - 6 in surrounding forest glades
    const placements = [];

    // Clearing perimeter & canopy opening shafts (8)
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2.0 + (rng() - 0.5) * 0.32;
      const dist = i < 2 ? 3.5 + rng() * 3.2 : 9.0 + rng() * 9.5;
      placements.push({
        x: clearingX + Math.cos(ang) * dist,
        z: clearingZ + Math.sin(ang) * dist,
        widthScale: 0.85 + rng() * 0.45,
        heightScale: 0.92 + rng() * 0.28,
      });
    }

    // Stream valley sunlit openings (8)
    const streamZs = [-48, -32, -18, -5, 9, 24, 39, 54];
    for (let i = 0; i < streamZs.length; i++) {
      const z = streamZs[i] + (rng() - 0.5) * 5.0;
      const cx = this.terrain?.getStreamCenterX ? this.terrain.getStreamCenterX(z) : -15.0;
      const bankOffset = (rng() - 0.5) * 9.5;
      placements.push({
        x: cx + bankOffset,
        z,
        widthScale: 0.95 + rng() * 0.48,
        heightScale: 0.95 + rng() * 0.32,
      });
    }

    // Outer forest canopy glades (6)
    const gladeCoords = [
      [34, -18],
      [28, 28],
      [-4, 34],
      [-34, -12],
      [-32, 22],
      [14, -34],
    ];
    for (let i = 0; i < gladeCoords.length; i++) {
      const [gx, gz] = gladeCoords[i];
      placements.push({
        x: gx + (rng() - 0.5) * 6.0,
        z: gz + (rng() - 0.5) * 6.0,
        widthScale: 1.0 + rng() * 0.5,
        heightScale: 0.95 + rng() * 0.3,
      });
    }

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      const groundY = this.terrain?.getHeightAt ? this.terrain.getHeightAt(p.x, p.z) : 0.0;
      const mesh = new THREE.Mesh(shaftGeo, this._godRayMaterial);
      mesh.name = `GodRayShaft_${i}`;
      mesh.position.set(p.x, Math.max(groundY, 0.0) - 1.4, p.z);
      mesh.scale.set(p.widthScale, p.heightScale, p.widthScale);
      mesh.renderOrder = 4;
      group.add(mesh);
      this._godRayMeshes.push(mesh);
    }

    return group;
  }

  setQuality(preset = 'High') {
    const key = String(preset || 'High').toLowerCase();
    const size = QUALITY_SHADOW_MAP[key] ?? 2048;
    if (size === this._shadowMapSize) return;

    this._shadowMapSize = size;
    this.sunLight.shadow.mapSize.set(size, size);
    if (this.sunLight.shadow.map) {
      this.sunLight.shadow.map.dispose();
      this.sunLight.shadow.map = null;
    }
    this.sunLight.shadow.needsUpdate = true;
  }

  update(
    dt,
    elapsed,
    {
      timeOfDay = 10.5,
      weather = 'Clear',
      fogDensityMultiplier = 1.0,
      godRayIntensity = 1.0,
      camera = null,
    } = {}
  ) {
    const safeDt = Math.max(dt || 0, 0);
    const tod = ((timeOfDay % 24) + 24) % 24;

    // Smooth weather transition (snaps on very first update call)
    const wKey = String(weather || 'Clear').toLowerCase();
    const targetRain = wKey === 'rain' ? 1.0 : 0.0;
    const targetGale = wKey === 'gale' ? 1.0 : 0.0;
    if (!this._initialized || safeDt === 0) {
      this._rainBlend = targetRain;
      this._galeBlend = targetGale;
      this._initialized = true;
    } else {
      const blendRate = 1.0 - Math.exp(-safeDt * 2.4);
      this._rainBlend = lerp(this._rainBlend, targetRain, blendRate);
      this._galeBlend = lerp(this._galeBlend, targetGale, blendRate);
    }

    const rain = this._rainBlend;
    const gale = this._galeBlend;

    // 1. 24-hour orbital sun/moon geometry
    // Sunrise ~6:15, Solar Noon ~12:15 (66 deg elevation), Sunset ~18:15, Midnight ~0:15
    const solarAngle = ((tod - 6.25) / 24.0) * Math.PI * 2.0;
    const orbitalTilt = 0.42;
    const cosA = Math.cos(solarAngle);
    const sinA = Math.sin(solarAngle);

    this._trueSunDir
      .set(
        cosA,
        sinA * Math.cos(orbitalTilt),
        -sinA * Math.sin(orbitalTilt) - 0.18 * cosA
      )
      .normalize();

    // Moon orbits strictly opposite the Sun
    this._moonDir.copy(this._trueSunDir).negate();

    const sunElev = this._trueSunDir.y;
    const isMorning = smoothstep(-0.25, 0.25, cosA); // 1 at dawn, 0 at sunset

    // Key atmospheric phase envelopes
    const daylight = smoothstep(-0.08, 0.22, sunElev);
    const nightFactor = 1.0 - smoothstep(-0.18, 0.06, sunElev);
    const goldenFactor =
      smoothstep(-0.12, 0.04, sunElev) * (1.0 - smoothstep(0.08, 0.36, sunElev));
    const twilightFactor =
      smoothstep(-0.26, -0.05, sunElev) * (1.0 - smoothstep(-0.01, 0.12, sunElev));

    this.daylight = daylight;
    this.nightFactor = nightFactor;

    // 2. Active celestial light handoff (Sun by day -> Moon by night, positive elevation for stable shadows)
    const moonHandoff = smoothstep(0.02, -0.09, sunElev); // 0 during day, 1 during night
    const activeBaseDir = moonHandoff < 0.5 ? this._trueSunDir : this._moonDir;

    // Keep shadow caster above ~11 deg elevation so shadows stay smooth without disappearing
    this._shadowLightDir.copy(activeBaseDir);
    if (this._shadowLightDir.y < 0.19) {
      const horizLen = Math.hypot(this._shadowLightDir.x, this._shadowLightDir.z) || 1.0;
      const targetHoriz = Math.sqrt(1.0 - 0.19 * 0.19);
      this._shadowLightDir.x = (this._shadowLightDir.x / horizLen) * targetHoriz;
      this._shadowLightDir.z = (this._shadowLightDir.z / horizLen) * targetHoriz;
      this._shadowLightDir.y = 0.19;
    }

    // Exposed sunDir tracks true sun by day (for exact god-rays/glints) and moon at night
    this.sunDir.copy(moonHandoff < 0.5 ? this._trueSunDir : this._moonDir);

    // 3. Update Three.js Preetham Sky dome uniforms
    const skyUniforms = this.sky.material.uniforms;
    skyUniforms.sunPosition.value.copy(this._trueSunDir);
    skyUniforms.turbidity.value =
      lerp(2.8, 8.6, goldenFactor) + rain * 4.6 + gale * 2.0;
    skyUniforms.rayleigh.value = lerp(
      lerp(0.85, lerp(1.55, 3.25, goldenFactor), daylight),
      0.62,
      rain * 0.72
    );
    skyUniforms.mieCoefficient.value =
      lerp(0.0045, 0.0145, goldenFactor) + rain * 0.01 + gale * 0.004;
    skyUniforms.mieDirectionalG.value = lerp(
      lerp(0.78, 0.88, goldenFactor),
      0.64,
      rain * 0.65
    );

    // Three.js r187 Sky built-in dynamic clouds
    if (skyUniforms.time) skyUniforms.time.value = elapsed;
    if (skyUniforms.cloudCoverage) {
      skyUniforms.cloudCoverage.value = clamp(
        0.26 + gale * 0.34 + rain * 0.62,
        0.0,
        0.96
      );
    }
    if (skyUniforms.cloudDensity) {
      skyUniforms.cloudDensity.value = clamp(
        0.30 + gale * 0.24 + rain * 0.50,
        0.0,
        0.95
      );
    }
    if (skyUniforms.cloudSpeed) {
      skyUniforms.cloudSpeed.value = 0.000018 + gale * 0.000075 + rain * 0.000032;
    }
    if (skyUniforms.cloudElevation) {
      skyUniforms.cloudElevation.value = lerp(0.52, 0.28, Math.max(rain, gale * 0.5));
    }
    if (skyUniforms.showSunDisc) {
      skyUniforms.showSunDisc.value =
        smoothstep(-0.02, 0.14, sunElev) * (1.0 - rain * 0.86);
    }

    // 4. Harmonized atmospheric colors (Zenith, Horizon, Fog, Sun/Moon, Ground Bounce)
    // Golden-hour dawn vs sunset blends
    const goldenSun = this._tempColorA.lerpColors(PALETTE.sunSunset, PALETTE.sunDawn, isMorning);
    const goldenZenith = this._tempColorB.lerpColors(PALETTE.zenithSunset, PALETTE.zenithDawn, isMorning);

    // Sun/Moon directional color
    this.sunColor.copy(PALETTE.sunNoon);
    this.sunColor.lerp(goldenSun, goldenFactor * 0.92);
    this.sunColor.lerp(PALETTE.sunTwilight, twilightFactor * 0.72);
    this.sunColor.lerp(PALETTE.moonNight, nightFactor);
    this.sunColor.lerp(PALETTE.sunRainTint, rain * (0.55 * daylight + 0.25 * nightFactor));

    // Sky zenith color
    this.skyZenithColor.copy(PALETTE.zenithNoon);
    this.skyZenithColor.lerp(goldenZenith, goldenFactor * 0.85);
    this.skyZenithColor.lerp(PALETTE.zenithTwilight, twilightFactor * 0.85);
    this.skyZenithColor.lerp(PALETTE.zenithNight, nightFactor);
    const rainZenith = this._tempColorA.lerpColors(
      PALETTE.zenithRainDay,
      PALETTE.zenithRainNight,
      nightFactor
    );
    this.skyZenithColor.lerp(rainZenith, rain * 0.82 + gale * 0.22);

    // Sky horizon color
    const goldenHorizon = this._tempColorA.lerpColors(
      PALETTE.horizonSunset,
      PALETTE.horizonDawn,
      isMorning
    );
    this.skyHorizonColor.copy(PALETTE.horizonNoon);
    this.skyHorizonColor.lerp(goldenHorizon, goldenFactor * 0.9);
    this.skyHorizonColor.lerp(PALETTE.horizonTwilight, twilightFactor * 0.82);
    this.skyHorizonColor.lerp(PALETTE.horizonNight, nightFactor);
    const rainHorizon = this._tempColorB.lerpColors(
      PALETTE.horizonRainDay,
      PALETTE.horizonRainNight,
      nightFactor
    );
    this.skyHorizonColor.lerp(rainHorizon, rain * 0.82 + gale * 0.24);

    // Fog color harmonized to horizon
    const goldenFog = this._tempColorA.lerpColors(
      PALETTE.fogSunset,
      PALETTE.fogDawn,
      isMorning
    );
    this.fogColor.copy(PALETTE.fogNoon);
    this.fogColor.lerp(goldenFog, goldenFactor * 0.88);
    this.fogColor.lerp(PALETTE.fogTwilight, twilightFactor * 0.85);
    this.fogColor.lerp(PALETTE.fogNight, nightFactor);
    const rainFog = this._tempColorB.lerpColors(
      PALETTE.fogRainDay,
      PALETTE.fogRainNight,
      nightFactor
    );
    this.fogColor.lerp(rainFog, rain * 0.84 + gale * 0.26);

    // Sync calibrated Sky HDR exposure, overcast storm tint, and indigo night sky gradient
    if (skyUniforms.uSkyExposure) {
      skyUniforms.uSkyExposure.value = lerp(
        lerp(0.22, 0.44, goldenFactor),
        0.16,
        rain * 0.7
      );
    }
    if (skyUniforms.uRainOvercast) {
      skyUniforms.uRainOvercast.value = rain;
    }
    if (skyUniforms.uNightMix) {
      skyUniforms.uNightMix.value = clamp(nightFactor + twilightFactor * 0.4, 0.0, 1.0);
    }
    if (skyUniforms.uNightZenith) {
      skyUniforms.uNightZenith.value.copy(this.skyZenithColor);
    }
    if (skyUniforms.uNightHorizon) {
      skyUniforms.uNightHorizon.value.copy(this.fogColor);
    }

    // 5. Light intensities with seamless twilight dip during sun <-> moon handoff
    const handoffDip = 1.0 - 0.62 * Math.exp(-Math.pow((sunElev + 0.035) / 0.055, 2.0));
    const dayDirect = lerp(1.65, 3.15, smoothstep(0.06, 0.55, sunElev));
    const moonDirect = 0.68 * smoothstep(-0.04, 0.28, this._moonDir.y) + 0.14;
    const rawDirect = lerp(dayDirect, moonDirect, moonHandoff) * handoffDip;
    const weatherDirectMult = (1.0 - rain * 0.64) * (1.0 - gale * 0.16);
    const finalDirectIntensity = rawDirect * weatherDirectMult;

    this.sunLight.color.copy(this.sunColor);
    this.sunLight.intensity = finalDirectIntensity;

    // Normalized solar intensity (0..1) for shaders (water caustics, terrain caustics, glints)
    this.sunIntensity = clamp(
      (daylight * (0.45 + 0.55 * smoothstep(0.05, 0.55, sunElev)) * (1.0 - rain * 0.65) +
        nightFactor * 0.06 * (1.0 - rain * 0.5)) *
        (1.0 - gale * 0.12),
      0.02,
      1.0
    );

    // Hemisphere & Ambient fill harmonized with weather & time of day
    const groundCol = this._tempColorA.copy(PALETTE.groundNoon);
    groundCol.lerp(PALETTE.groundGolden, goldenFactor * 0.72);
    groundCol.lerp(PALETTE.groundNight, nightFactor);
    groundCol.lerp(PALETTE.groundRain, rain * 0.6);

    this.hemiLight.color.copy(this.skyHorizonColor).lerp(this.skyZenithColor, 0.35);
    this.hemiLight.groundColor.copy(groundCol);
    this.hemiLight.intensity =
      lerp(0.95, 0.36, nightFactor) * (1.0 - rain * 0.18) * (1.0 - gale * 0.06) +
      rain * 0.18 * daylight;

    this.ambientLight.color.copy(this.skyZenithColor).lerp(this.fogColor, 0.45);
    this.ambientLight.intensity = lerp(0.14, 0.26, nightFactor) + rain * 0.12;

    // 6. Position shadow light & center sky/stars/moon on camera
    const camPos = camera?.position;
    if (camPos) {
      this.sky.position.copy(camPos);
      this.starDome.position.copy(camPos);
      this.moonGroup.position.copy(camPos);

      // Loosely follow camera within forest bounds, snapped to 2-unit grid to prevent shadow crawl
      const snap = 2.0;
      const tx = Math.round(clamp(camPos.x, -44, 44) / snap) * snap;
      const tz = Math.round(clamp(camPos.z, -44, 44) / snap) * snap;
      this._shadowTargetPos.set(tx, 0, tz);
    } else {
      this._shadowTargetPos.set(0, 0, 0);
    }

    this.sunLight.target.position.copy(this._shadowTargetPos);
    this.sunLight.target.updateMatrixWorld();
    this.sunLight.position
      .copy(this._shadowTargetPos)
      .addScaledVector(this._shadowLightDir, 96.0);

    // 7. Update twinkling stars & luminous Moon disc + halo
    const starOpacity =
      smoothstep(0.08, 0.78, nightFactor + twilightFactor * 0.32) * (1.0 - rain * 0.88);
    this.starDome.visible = starOpacity > 0.005;
    if (this.starDome.visible) {
      this.starDome.material.uniforms.uTime.value = elapsed;
      this.starDome.material.uniforms.uOpacity.value = starOpacity;
      if (this.renderer?.getPixelRatio) {
        this.starDome.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
      }
      // Gentle sidereal rotation across the night sky
      this.starDome.rotation.y = tod * 0.045;
    }

    const moonElevationVis = smoothstep(-0.04, 0.14, this._moonDir.y);
    const moonNightVis = smoothstep(0.06, 0.62, nightFactor + twilightFactor * 0.45);
    const moonOpacity = moonElevationVis * moonNightVis * (1.0 - rain * 0.76);
    this.moonGroup.visible = moonOpacity > 0.005;
    if (this.moonGroup.visible) {
      this.moonGroup.updateMatrixWorld();
      const moonDist = 208.0;
      const localMoonPos = this._tempVec.copy(this._moonDir).multiplyScalar(moonDist);
      this._moonDisc.position.copy(localMoonPos);
      this._moonHalo.position.copy(localMoonPos);
      this._moonDisc.lookAt(this.moonGroup.position);
      this._moonHalo.lookAt(this.moonGroup.position);
      this._moonDisc.material.uniforms.uOpacity.value = moonOpacity;
      this._moonHalo.material.uniforms.uOpacity.value = moonOpacity * (1.0 + gale * 0.15);
    }

    // 8. Dynamic FogExp2 scaled by weather & multiplier
    const baseFog = lerp(0.0066, 0.0086, Math.max(goldenFactor * 0.8, nightFactor * 0.9));
    const weatherFogBoost = 1.0 + gale * 0.38 + rain * 1.12;
    this.fogDensity = baseFog * weatherFogBoost * Math.max(fogDensityMultiplier, 0.0);
    this.fog.color.copy(this.fogColor);
    this.fog.density = this.fogDensity;
    if (this.scene.background && this.scene.background.isColor) {
      this.scene.background.copy(this.fogColor);
    }

    // 9. Update Volumetric Sunbeams (God Rays)
    const sunAboveHorizon = smoothstep(-0.02, 0.12, sunElev);
    const goldenRayBoost = lerp(1.0, 1.55, goldenFactor);
    const weatherRayFade = (1.0 - rain * 0.9) * (1.0 - gale * 0.25);
    const rayOpacity =
      0.22 * sunAboveHorizon * goldenRayBoost * weatherRayFade * Math.max(godRayIntensity, 0.0);

    this.godRayGroup.visible = rayOpacity > 0.002;
    if (this.godRayGroup.visible) {
      // Clamp shaft elevation >= 0.24 so low golden-hour rays pierce diagonally through canopy
      this._rayAlignDir.copy(this._trueSunDir);
      if (this._rayAlignDir.y < 0.24) {
        const horizLen = Math.hypot(this._rayAlignDir.x, this._rayAlignDir.z) || 1.0;
        const targetHoriz = Math.sqrt(1.0 - 0.24 * 0.24);
        this._rayAlignDir.x = (this._rayAlignDir.x / horizLen) * targetHoriz;
        this._rayAlignDir.z = (this._rayAlignDir.z / horizLen) * targetHoriz;
        this._rayAlignDir.y = 0.24;
      }

      this._tempQuat.setFromUnitVectors(UP, this._rayAlignDir);
      for (let i = 0; i < this._godRayMeshes.length; i++) {
        this._godRayMeshes[i].quaternion.copy(this._tempQuat);
      }

      const goldenRayTint = this._tempColorA.lerpColors(
        PALETTE.raySunset,
        PALETTE.rayDawn,
        isMorning
      );
      this._godRayUniforms.uRayColor.value
        .copy(PALETTE.rayNoon)
        .lerp(goldenRayTint, goldenFactor * 0.9);
      this._godRayUniforms.uTime.value = elapsed;
      this._godRayUniforms.uSunDir.value.copy(this._trueSunDir);
      this._godRayUniforms.uIntensity.value = rayOpacity;
      this._godRayUniforms.uFogDensity.value = this.fogDensity;
    }

    // 10. Dynamic recommended tone-mapping exposure & bloom strength
    const recommendedExposure =
      lerp(1.02, 1.24, nightFactor) + goldenFactor * 0.06 + rain * 0.08;
    const recommendedBloomStrength =
      lerp(0.34, 0.68, nightFactor) + goldenFactor * 0.14 - rain * 0.08;

    return {
      sunDir: this.sunDir,
      sunColor: this.sunColor,
      skyZenithColor: this.skyZenithColor,
      skyHorizonColor: this.skyHorizonColor,
      fogColor: this.fogColor,
      fogDensity: this.fogDensity,
      daylight: this.daylight,
      nightFactor: this.nightFactor,
      sunIntensity: this.sunIntensity,
      recommendedExposure,
      recommendedBloomStrength: clamp(recommendedBloomStrength, 0.18, 0.85),
    };
  }

  dispose() {
    this.scene.remove(this.sky);
    this.sky.geometry.dispose();
    this.sky.material.dispose();

    this.scene.remove(this.starDome);
    this.starDome.geometry.dispose();
    this.starDome.material.dispose();

    this.scene.remove(this.moonGroup);
    this._moonDisc.geometry.dispose();
    this._moonDisc.material.dispose();
    this._moonHalo.geometry.dispose();
    this._moonHalo.material.dispose();

    this.scene.remove(this.godRayGroup);
    this._godRayGeometry.dispose();
    this._godRayMaterial.dispose();

    if (this.sunLight.shadow.map) {
      this.sunLight.shadow.map.dispose();
    }
    this.scene.remove(this.sunLight);
    this.scene.remove(this.sunLight.target);
    this.scene.remove(this.hemiLight);
    this.scene.remove(this.ambientLight);
  }
}
