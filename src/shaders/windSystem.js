import * as THREE from 'three';
import { createNoise4D } from 'simplex-noise';
import { createRng, clamp, fract } from '../utils/random.js';

/**
 * Unified GPU wind uniform manager and onBeforeCompile shader injection helpers.
 * Uses a seamless toroidal 4D-Simplex gust field texture so coherent wind waves
 * sweep simultaneously across tree trunks, branches, leaves, grass, ferns, and audio.
 */
export class WindSystem {
  constructor(options = {}) {
    this.gustTexSize = 256;
    this.gustWorldScale = 0.0115; // ~87 world units per gust tile

    this._gustData = new Uint8Array(this.gustTexSize * this.gustTexSize * 4);
    this.gustTexture = this._buildSeamlessGustTexture();

    this._windAngleDeg = options.windDirection ?? 25;
    this._windSpeed = options.windSpeed ?? 1.0;
    this._gustStrength = options.gustStrength ?? 0.65;
    this._gustTurbulence = options.gustTurbulence ?? 0.55;
    this._weatherWindMult = 1.0;
    this._weatherGustMult = 1.0;

    // Smoothed interactor position for organic foliage parting & spring-back
    this._targetInteractorPos = new THREE.Vector3(0, -100, 0);
    this._currentInteractorPos = new THREE.Vector3(0, -100, 0);
    this._targetInteractorStrength = 0.0;
    this._currentInteractorStrength = 0.0;

    // Shared GPU uniforms referenced directly by every vegetation material
    this.uniforms = {
      uTime: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uWindSpeed: { value: this._windSpeed },
      uGustStrength: { value: this._gustStrength },
      uGustTurbulence: { value: this._gustTurbulence },
      uGustMap: { value: this.gustTexture },
      uGustScale: { value: this.gustWorldScale },
      uInteractorPos: { value: this._currentInteractorPos },
      uInteractorRadius: { value: 2.5 },
      uInteractorStrength: { value: 0.0 },
      uWetness: { value: 0.0 },
    };

    this.setWindDirection(this._windAngleDeg);
  }

  _buildSeamlessGustTexture() {
    const size = this.gustTexSize;
    const rng = createRng(90210);
    const noise4D = createNoise4D(rng);
    const data = this._gustData;
    const TWO_PI = Math.PI * 2;

    for (let y = 0; y < size; y++) {
      const v = y / size;
      const ay = v * TWO_PI;
      const cy = Math.cos(ay);
      const sy = Math.sin(ay);

      for (let x = 0; x < size; x++) {
        const u = x / size;
        const ax = u * TWO_PI;
        const cx = Math.cos(ax);
        const sx = Math.sin(ax);

        // Seamless periodic 2D FBM by sampling 4D simplex noise on a torus
        const n1 =
          noise4D(cx * 1.15, sx * 1.15, cy * 1.15, sy * 1.15) * 0.65 +
          noise4D(cx * 2.3 + 4.1, sx * 2.3 + 4.1, cy * 2.3 - 1.7, sy * 2.3 - 1.7) * 0.35;

        const n2 =
          noise4D(cx * 1.8 - 7.3, sx * 1.8 + 2.4, cy * 1.8 + 5.1, sy * 1.8 - 3.2) * 0.6 +
          noise4D(cx * 3.6 + 1.2, sx * 3.6 - 5.4, cy * 3.6 + 2.8, sy * 3.6 + 6.1) * 0.4;

        const n3 = noise4D(cx * 4.2 + 12.1, sx * 4.2 - 9.4, cy * 4.2 + 3.7, sy * 4.2 - 8.2);
        const phase = noise4D(cx * 2.1 - 15.0, sx * 2.1 + 11.0, cy * 2.1 - 6.0, sy * 2.1 + 4.0);

        const idx = (y * size + x) * 4;
        data[idx] = Math.round(clamp(n1 * 0.5 + 0.5, 0, 1) * 255);     // R: primary gust wave
        data[idx + 1] = Math.round(clamp(n2 * 0.5 + 0.5, 0, 1) * 255); // G: cross turbulence
        data[idx + 2] = Math.round(clamp(n3 * 0.5 + 0.5, 0, 1) * 255); // B: fine flutter
        data[idx + 3] = Math.round(clamp(phase * 0.5 + 0.5, 0, 1) * 255); // A: spatial phase
      }
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  setWindDirection(degrees) {
    this._windAngleDeg = degrees;
    const rad = (degrees * Math.PI) / 180;
    this.uniforms.uWindDir.value.set(Math.cos(rad), Math.sin(rad)).normalize();
  }

  setWindSpeed(speed) {
    this._windSpeed = speed;
    this._syncEffectiveUniforms();
  }

  setGustTurbulence(turbulence) {
    this._gustTurbulence = turbulence;
    this._syncEffectiveUniforms();
  }

  setGustStrength(strength) {
    this._gustStrength = strength;
    this._syncEffectiveUniforms();
  }

  setWeatherModifiers({ windMult = 1.0, gustMult = 1.0, wetness = 0.0 } = {}) {
    this._weatherWindMult = windMult;
    this._weatherGustMult = gustMult;
    this.uniforms.uWetness.value = wetness;
    this._syncEffectiveUniforms();
  }

  _syncEffectiveUniforms() {
    this.uniforms.uWindSpeed.value = this._windSpeed * this._weatherWindMult;
    this.uniforms.uGustStrength.value = this._gustStrength * this._weatherGustMult;
    this.uniforms.uGustTurbulence.value = this._gustTurbulence * Math.max(1.0, this._weatherGustMult * 0.85);
  }

  /**
   * Update active player foot position or orbit-mode mouse terrain raycast hit.
   * Passing active=false lets displaced foliage spring back smoothly.
   */
  setInteractorTarget(pos, active = true) {
    if (active && pos) {
      this._targetInteractorPos.copy(pos);
      this._targetInteractorStrength = 1.0;
    } else {
      this._targetInteractorStrength = 0.0;
    }
  }

  update(dt, elapsed) {
    this.uniforms.uTime.value = elapsed;

    // Smoothly track interactor position & spring-back strength
    const posFollow = 1.0 - Math.exp(-dt * 14.0);
    const strFollow = 1.0 - Math.exp(-dt * (this._targetInteractorStrength > 0.5 ? 12.0 : 5.5));
    this._currentInteractorPos.lerp(this._targetInteractorPos, posFollow);
    this._currentInteractorStrength +=
      (this._targetInteractorStrength - this._currentInteractorStrength) * strFollow;
    this.uniforms.uInteractorStrength.value = this._currentInteractorStrength;
  }

  /**
   * CPU mirror of the scrolling gust field texture so Particles and ProceduralAudio
   * stay synchronized with visible canopy & grass wind waves at (x, z).
   */
  sampleGustAt(x, z) {
    const dir = this.uniforms.uWindDir.value;
    const speed = this.uniforms.uWindSpeed.value;
    const time = this.uniforms.uTime.value;
    const scroll = time * (0.045 + speed * 0.052);

    const u = fract(x * this.gustWorldScale - dir.x * scroll);
    const v = fract(z * this.gustWorldScale - dir.y * scroll);

    const size = this.gustTexSize;
    const fx = u * size;
    const fy = v * size;
    const x0 = Math.floor(fx) % size;
    const y0 = Math.floor(fy) % size;
    const x1 = (x0 + 1) % size;
    const y1 = (y0 + 1) % size;
    const tx = fx - Math.floor(fx);
    const ty = fy - Math.floor(fy);

    const readChannel = (ix, iy, ch) => this._gustData[(iy * size + ix) * 4 + ch] / 255;

    const r00 = readChannel(x0, y0, 0);
    const r10 = readChannel(x1, y0, 0);
    const r01 = readChannel(x0, y1, 0);
    const r11 = readChannel(x1, y1, 0);
    const r = (r00 * (1 - tx) + r10 * tx) * (1 - ty) + (r01 * (1 - tx) + r11 * tx) * ty;

    const g00 = readChannel(x0, y0, 1);
    const g10 = readChannel(x1, y0, 1);
    const g01 = readChannel(x0, y1, 1);
    const g11 = readChannel(x1, y1, 1);
    const g = (g00 * (1 - tx) + g10 * tx) * (1 - ty) + (g01 * (1 - tx) + g11 * tx) * ty;

    const gustPeak = Math.pow(clamp(r, 0, 1), 1.35) * this.uniforms.uGustStrength.value;
    const intensity = clamp(speed * (0.35 + gustPeak * 1.15) + (g - 0.5) * 0.25 * this.uniforms.uGustTurbulence.value, 0, 4.5);

    return {
      gust: r,
      turbulence: g,
      intensity,
      dirX: dir.x,
      dirZ: dir.y,
    };
  }

  /**
   * Shared GLSL helper block for 3-tier hierarchical tree sway.
   * Reads geometry vertex `color` attribute:
   *   color.r = primary trunk flex (anchored at y = 0)
   *   color.g = secondary branch sway
   *   color.b = leaf cluster edge flutter
   */
  _buildTreeWindVertexCode(options) {
    const trunkFlex = (options.trunkFlex ?? 1.0).toFixed(3);
    const branchFlex = (options.branchFlex ?? 1.0).toFixed(3);
    const leafFlutter = (options.leafFlutter ?? 1.0).toFixed(3);

    const header = /* glsl */ `
      #if !defined( USE_COLOR ) && !defined( USE_COLOR_ALPHA )
        attribute vec3 color;
      #endif
      uniform float uTime;
      uniform vec2 uWindDir;
      uniform float uWindSpeed;
      uniform float uGustStrength;
      uniform float uGustTurbulence;
      uniform sampler2D uGustMap;
      uniform float uGustScale;
    `;

    const displace = /* glsl */ `
      {
        vec4 windInstOrigin = vec4( 0.0, 0.0, 0.0, 1.0 );
        vec4 windWorldPos = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          windInstOrigin = instanceMatrix * windInstOrigin;
          windWorldPos = instanceMatrix * windWorldPos;
        #endif
        windInstOrigin = modelMatrix * windInstOrigin;
        windWorldPos = modelMatrix * windWorldPos;

        float windScroll = uTime * ( 0.045 + uWindSpeed * 0.052 );
        vec2 gustUv = windWorldPos.xz * uGustScale - uWindDir * windScroll;
        vec4 gustSample = texture2D( uGustMap, gustUv );

        vec2 gustUvRoot = windInstOrigin.xz * uGustScale - uWindDir * windScroll;
        vec4 gustRoot = texture2D( uGustMap, gustUvRoot );

        // Transform world wind vector into local space (handles per-instance yaw/scale cleanly)
        mat3 instWorldRot = mat3( modelMatrix );
        #ifdef USE_INSTANCING
          instWorldRot = instWorldRot * mat3( instanceMatrix );
        #endif
        vec3 windDirWorld3 = vec3( uWindDir.x, 0.0, uWindDir.y );
        vec3 perpDirWorld3 = vec3( -uWindDir.y, 0.0, uWindDir.x );
        // Transpose works for orthonormal rotation + uniform scale; normalize removes scale distortion
        vec3 localWindDir = normalize( transpose( instWorldRot ) * windDirWorld3 + vec3( 1e-5 ) );
        vec3 localPerpDir = normalize( transpose( instWorldRot ) * perpDirWorld3 + vec3( 1e-5 ) );

        float speedFactor = uWindSpeed;
        float gustWave = pow( gustRoot.r, 1.35 ) * uGustStrength;
        float localGust = pow( gustSample.r, 1.3 ) * uGustStrength;
        float treePhase = gustRoot.a * 6.28318 + dot( windInstOrigin.xz, vec2( 0.17, 0.23 ) );

        // Tier 1: Primary Trunk Sway (anchored at y = 0, slow low-frequency wave)
        float trunkWeight = color.r * ${trunkFlex};
        float trunkOsc = sin( uTime * ( 0.72 + speedFactor * 0.36 ) + treePhase ) * 0.42
                       + sin( uTime * ( 1.28 + speedFactor * 0.55 ) + treePhase * 1.7 ) * 0.16;
        float trunkPush = ( 0.28 + gustWave * 1.35 + trunkOsc * ( 0.42 + uGustTurbulence * 0.55 ) ) * speedFactor;
        vec3 trunkDisp = localWindDir * ( trunkPush * trunkWeight * 0.92 )
                       + localPerpDir * ( sin( uTime * 0.95 + treePhase * 1.3 ) * trunkWeight * speedFactor * ( 0.14 + uGustTurbulence * 0.22 ) );
        // Subtle arc-length vertical dip so tall trunks bend in an arc rather than stretching
        trunkDisp.y -= abs( trunkPush ) * trunkWeight * 0.085;

        // Tier 2: Secondary Branch Sway (out of phase per world position & extension)
        float branchWeight = color.g * ${branchFlex};
        float branchPhase = treePhase + dot( windWorldPos.xyz, vec3( 0.38, 0.52, 0.41 ) ) + gustSample.g * 4.5;
        float branchOsc = sin( uTime * ( 1.85 + speedFactor * 0.85 ) + branchPhase );
        float branchCross = cos( uTime * ( 1.45 + speedFactor * 0.7 ) + branchPhase * 1.15 );
        vec3 branchDisp = localWindDir * ( ( branchOsc * 0.34 + localGust * 0.52 ) * branchWeight * speedFactor )
                        + localPerpDir * ( branchCross * 0.22 * branchWeight * speedFactor * ( 0.5 + uGustTurbulence ) );
        branchDisp.y += sin( uTime * ( 2.1 + speedFactor * 0.9 ) + branchPhase ) * 0.16 * branchWeight * speedFactor;

        // Tier 3: Leaf Cluster Edge Flutter (high-frequency ripple scaled by gust peaks)
        float leafWeight = color.b * ${leafFlutter};
        float flutterFreq = 5.4 + speedFactor * 3.8;
        float flutterPhase = dot( windWorldPos.xyz, vec3( 2.3, 3.1, 2.7 ) ) + gustSample.b * 9.0;
        float flutterAmp = leafWeight * ( 0.055 + speedFactor * ( 0.095 + localGust * 0.24 + uGustTurbulence * 0.08 ) );
        vec3 leafDisp = vec3(
          sin( uTime * flutterFreq + flutterPhase ),
          cos( uTime * ( flutterFreq * 1.19 ) + flutterPhase * 1.3 ) * 0.75,
          sin( uTime * ( flutterFreq * 0.87 ) + flutterPhase * 0.9 + 1.57 )
        ) * flutterAmp;

        transformed += trunkDisp + branchDisp + leafDisp;
      }
    `;

    return { header, displace };
  }

  /**
   * Injects 3-tier hierarchical wind sway + canopy ambient occlusion + rain wetness
   * into a tree bark or foliage MeshStandardMaterial.
   * Also creates a synchronized customDepthMaterial for swaying real-time shadows.
   */
  applyTreeWindShader(material, options = {}) {
    const { header, displace } = this._buildTreeWindVertexCode(options);
    const isFoliage = Boolean(options.isFoliage);
    const uniforms = this.uniforms;
    const keySuffix = `treeWind_${isFoliage ? 'leaf' : 'bark'}_${options.trunkFlex ?? 1}_${options.branchFlex ?? 1}_${options.leafFlutter ?? 1}`;

    material.customProgramCacheKey = () => keySuffix;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        ${header}
        attribute float aCanopyAO;
        varying float vCanopyAO;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vCanopyAO = aCanopyAO;
        ${displace}`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uWetness;
        varying float vCanopyAO;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= mix( 1.0, clamp( vCanopyAO, 0.35, 1.15 ), ${isFoliage ? '0.92' : '0.65'} );
        // Darken bark & foliage subtly when rain-soaked
        diffuseColor.rgb *= mix( 1.0, ${isFoliage ? '0.84' : '0.72'}, uWetness );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, ${isFoliage ? '0.32' : '0.38'}, uWetness * 0.82 );`
      );
    };

    // Matching animated depth material so cast shadows sway with branches & leaves
    const depthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: isFoliage ? material.map : null,
      alphaTest: isFoliage ? material.alphaTest : 0.0,
      side: material.side,
    });
    depthMaterial.customProgramCacheKey = () => `${keySuffix}_depth`;
    depthMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        ${header}`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        ${displace}`
      );
    };

    return depthMaterial;
  }

  /**
   * Injects gust-field wind bending, turbulent flutter, root-to-tip AO,
   * and 2.5-unit player/cursor parting displacement into grass, fern, and wildflower materials.
   * Geometry must have `aBend` (0 at root -> 1 at tip) or falls back to `uv.y`.
   */
  applyFoliageWindShader(material, options = {}) {
    const uniforms = this.uniforms;
    const bendStrength = (options.bendStrength ?? 0.55).toFixed(3);
    const flutterStrength = (options.flutterStrength ?? 0.14).toFixed(3);
    const partStrength = (options.partStrength ?? 1.15).toFixed(3);
    const useRootAO = options.useRootAO !== false;
    const useBendAttr = options.useBendAttr !== false;
    const keySuffix = `foliageWind_${bendStrength}_${flutterStrength}_${partStrength}_${useRootAO ? 1 : 0}_${useBendAttr ? 1 : 0}`;

    material.customProgramCacheKey = () => keySuffix;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        ${useBendAttr ? 'attribute float aBend;' : ''}
        uniform float uTime;
        uniform vec2 uWindDir;
        uniform float uWindSpeed;
        uniform float uGustStrength;
        uniform float uGustTurbulence;
        uniform sampler2D uGustMap;
        uniform float uGustScale;
        uniform vec3 uInteractorPos;
        uniform float uInteractorRadius;
        uniform float uInteractorStrength;
        varying float vFoliageTip;
        varying float vGustHighlight;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float bendFactor = ${useBendAttr ? 'aBend' : 'uv.y'};
        vFoliageTip = bendFactor;
        float bendCurve = bendFactor * bendFactor;

        vec4 fInstOrigin = vec4( 0.0, 0.0, 0.0, 1.0 );
        vec4 fWorldPos = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          fInstOrigin = instanceMatrix * fInstOrigin;
          fWorldPos = instanceMatrix * fWorldPos;
        #endif
        fInstOrigin = modelMatrix * fInstOrigin;
        fWorldPos = modelMatrix * fWorldPos;

        float fScroll = uTime * ( 0.05 + uWindSpeed * 0.06 );
        vec2 fGustUv = fInstOrigin.xz * uGustScale - uWindDir * fScroll;
        vec4 fGust = texture2D( uGustMap, fGustUv );

        float gustPeak = pow( fGust.r, 1.35 ) * uGustStrength;
        vGustHighlight = gustPeak * bendFactor;

        // Convert world wind and interactor repulsion into local blade coordinates
        mat3 fRot = mat3( modelMatrix );
        #ifdef USE_INSTANCING
          fRot = fRot * mat3( instanceMatrix );
        #endif
        mat3 fInvRot = transpose( fRot );

        vec3 fWindLocal = normalize( fInvRot * vec3( uWindDir.x, 0.0, uWindDir.y ) + vec3( 1e-5 ) );
        vec3 fPerpLocal = normalize( fInvRot * vec3( -uWindDir.y, 0.0, uWindDir.x ) + vec3( 1e-5 ) );

        float phase = fGust.a * 6.28318 + dot( fInstOrigin.xz, vec2( 0.73, 0.91 ) );
        float sway = sin( uTime * ( 2.2 + uWindSpeed * 1.45 ) + phase ) * 0.34
                   + sin( uTime * ( 4.6 + uWindSpeed * 2.4 ) + phase * 1.7 + fGust.b * 5.0 ) * 0.14 * ( 0.4 + uGustTurbulence );

        float pushMag = ( ( 0.24 + gustPeak * 1.45 + sway * ( 0.45 + uGustTurbulence * 0.55 ) ) * uWindSpeed ) * ${bendStrength} * bendCurve;
        float crossMag = cos( uTime * ( 2.8 + uWindSpeed * 1.3 ) + phase * 1.3 ) * ${flutterStrength} * uWindSpeed * ( 0.4 + uGustTurbulence ) * bendCurve;

        vec3 windOffset = fWindLocal * pushMag + fPerpLocal * crossMag;
        windOffset.y -= min( abs( pushMag ) * 0.32, 0.35 * bendCurve );

        // Interactive player/cursor parting within uInteractorRadius (2.5 units)
        vec2 toPlant = fInstOrigin.xz - uInteractorPos.xz;
        float distSq = dot( toPlant, toPlant );
        float rad = uInteractorRadius;
        float heightDiff = abs( fInstOrigin.y - uInteractorPos.y );
        if ( uInteractorStrength > 0.001 && distSq < rad * rad && heightDiff < 3.5 ) {
          float dist = sqrt( distSq );
          float falloff = smoothstep( rad, 0.0, dist );
          falloff = falloff * falloff * uInteractorStrength;
          vec2 pushDir2D = dist > 0.001 ? ( toPlant / dist ) : vec2( 1.0, 0.0 );
          vec3 pushLocal = normalize( fInvRot * vec3( pushDir2D.x, 0.0, pushDir2D.y ) + vec3( 1e-5 ) );
          float bendOut = falloff * ${partStrength} * bendFactor;
          windOffset += pushLocal * bendOut;
          windOffset.y -= falloff * 0.42 * bendFactor;
        }

        transformed += windOffset;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uWetness;
        varying float vFoliageTip;
        varying float vGustHighlight;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        ${
          useRootAO
            ? `float rootAO = mix( 0.32, 1.08, smoothstep( 0.0, 0.85, vFoliageTip ) );
               diffuseColor.rgb *= rootAO;
               // Subtle sunlit silver/warm sheen as gust waves flatten blade tips
               diffuseColor.rgb *= ( 1.0 + vGustHighlight * 0.14 );`
            : `diffuseColor.rgb *= mix( 0.72, 1.05, vFoliageTip );`
        }
        diffuseColor.rgb *= mix( 1.0, 0.84, uWetness );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.28, uWetness * 0.8 );`
      );
    };
  }

  dispose() {
    this.gustTexture.dispose();
  }
}
