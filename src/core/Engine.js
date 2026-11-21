import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Core WebGL rendering engine, post-processing pipeline, resize management,
 * and fixed/variable delta animation loop.
 */
export class Engine {
  constructor(container, options = {}) {
    this.container = container;
    this.width = container.clientWidth || window.innerWidth;
    this.height = container.clientHeight || window.innerHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1218);

    this.camera = new THREE.PerspectiveCamera(
      options.fov ?? 58,
      this.width / this.height,
      options.near ?? 0.15,
      options.far ?? 520
    );
    this.camera.position.set(22, 9.5, 22);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    // Three.js r187 merged soft PCF filtering directly into PCFShadowMap
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.container.appendChild(this.renderer.domElement);

    // Post-processing composer (RenderPass -> UnrealBloomPass -> OutputPass)
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height),
      0.42, // strength
      0.48, // radius
      0.92  // high threshold so only sun, embers, fireflies, and glowing mushrooms bloom
    );
    this.composer.addPass(this.bloomPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    // Loop state
    this._running = false;
    this._rafId = null;
    this._lastTime = 0;
    this._elapsed = 0;
    this._accumulator = 0;
    this._fixedDt = 1 / 60;

    this._updateCallbacks = [];
    this._fixedCallbacks = [];
    this._resizeCallbacks = [];
    this._stats = null;

    this._boundLoop = this._loop.bind(this);
    this._boundResize = this._handleResize.bind(this);
    window.addEventListener('resize', this._boundResize);

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._boundResize);
      this._resizeObserver.observe(this.container);
    }
  }

  attachStats(stats) {
    this._stats = stats;
  }

  onUpdate(fn) {
    this._updateCallbacks.push(fn);
    return () => {
      const idx = this._updateCallbacks.indexOf(fn);
      if (idx !== -1) this._updateCallbacks.splice(idx, 1);
    };
  }

  onFixedUpdate(fn) {
    this._fixedCallbacks.push(fn);
    return () => {
      const idx = this._fixedCallbacks.indexOf(fn);
      if (idx !== -1) this._fixedCallbacks.splice(idx, 1);
    };
  }

  onResize(fn) {
    this._resizeCallbacks.push(fn);
    return () => {
      const idx = this._resizeCallbacks.indexOf(fn);
      if (idx !== -1) this._resizeCallbacks.splice(idx, 1);
    };
  }

  setExposure(exposure) {
    this.renderer.toneMappingExposure = exposure;
  }

  setBloomConfig({ threshold, strength, radius } = {}) {
    if (threshold !== undefined) this.bloomPass.threshold = threshold;
    if (strength !== undefined) this.bloomPass.strength = strength;
    if (radius !== undefined) this.bloomPass.radius = radius;
  }

  setMaxPixelRatio(maxRatio) {
    const ratio = Math.min(window.devicePixelRatio || 1, maxRatio);
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    this._handleResize();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    this._rafId = requestAnimationFrame(this._boundLoop);
  }

  stop() {
    this._running = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _handleResize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    if (w <= 0 || h <= 0) return;
    this.width = w;
    this.height = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);
    for (let i = 0; i < this._resizeCallbacks.length; i++) {
      this._resizeCallbacks[i](w, h);
    }
  }

  _loop(now) {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(this._boundLoop);

    if (this._stats) this._stats.begin();

    const rawDt = (now - this._lastTime) * 0.001;
    this._lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0.0001), 0.05);
    this._elapsed += dt;

    // Fixed-step physics/boid updates
    this._accumulator += dt;
    let steps = 0;
    while (this._accumulator >= this._fixedDt && steps < 4) {
      for (let i = 0; i < this._fixedCallbacks.length; i++) {
        this._fixedCallbacks[i](this._fixedDt, this._elapsed);
      }
      this._accumulator -= this._fixedDt;
      steps++;
    }

    // Variable-delta rendering & animation updates
    for (let i = 0; i < this._updateCallbacks.length; i++) {
      this._updateCallbacks[i](dt, this._elapsed);
    }

    this.composer.render();

    if (this._stats) this._stats.end();
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._boundResize);
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
    this.composer.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
