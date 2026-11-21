import * as THREE from 'three';
import { HumanMeshBuilder } from './HumanMeshBuilder.js';
import { HumanAnimatorIK } from './HumanAnimatorIK.js';
import { SpatialHash2D } from '../interaction/ControlsAndRaycast.js';
import { WATER_LEVEL } from '../world/Terrain.js';
import { clamp, lerp } from '../utils/random.js';

const CAMERA_MODES = ['Third-Person', 'First-Person Body', 'Free Orbit'];
const MAP_BOUND = 104;
const PLAYER_RADIUS = 0.44;
const GRAVITY = -16.2;
const JUMP_VELOCITY = 5.75;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _footL = new THREE.Vector3();
const _footR = new THREE.Vector3();
const _eyeWorld = new THREE.Vector3();
const _camGoal = new THREE.Vector3();
const _lookGoal = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Playable human character controller with full locomotion physics (walk, jog,
 * full sprint, stamina/exhaustion, momentum skids, jumping, crouching, stream
 * wading & slippery rock stumbles), kicked-up footstep dust, SpatialHash2D
 * collision sliding, Foot IK + wildlife hooks, and 3 switchable cameras (V key).
 */
export class HumanController {
  constructor(engine, terrain, windSystem, streamWater, audio, callbacks = {}) {
    this.engine = engine;
    this.scene = engine.scene;
    this.camera = engine.camera;
    this.domElement = engine.renderer.domElement;
    this.terrain = terrain;
    this.windSystem = windSystem;
    this.streamWater = streamWater;
    this.audio = audio;
    this.callbacks = callbacks;

    // 1. Build hyper-detailed procedural articulated human & IK animator
    this.rig = new HumanMeshBuilder();
    this.animator = new HumanAnimatorIK(this.rig, terrain);
    this.scene.add(this.rig.root);

    // 2. Spatial-hash 2D collision against trees, boulders, logs, and campfire
    this.spatialHash = new SpatialHash2D(4.0);

    // Spawn cleanly in the mossy campfire glade right beside the fire overlooking the stream
    const clearing = terrain.getClearingCenter3D(new THREE.Vector3());
    const spawnX = clearing.x + 3.9;
    const spawnZ = clearing.z + 1.8;
    const spawnY = terrain.getHeightAt(spawnX, spawnZ);

    this.position = new THREE.Vector3(spawnX, spawnY, spawnZ);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.facingYaw = Math.atan2(-0.84, -0.54); // faces campfire & winding stream

    // Camera state (Third-Person default)
    this._cameraMode = 'Third-Person';
    this._camYaw = this.facingYaw; // camera looks along +sin(yaw), +cos(yaw)
    this._camPitch = 0.24; // slight downward gaze over shoulder
    this._fpPitch = -0.06;
    this._camPosSmooth = new THREE.Vector3();
    this._camTargetSmooth = new THREE.Vector3();
    this._currentFov = 58;
    this._baseFov = 58;
    this._isDraggingCam = false;
    this._isPointerLocked = false;
    this._dragStart = { x: 0, y: 0 };
    this._lastPointer = { x: 0, y: 0 };
    this._cameraShake = 0;

    // Locomotion & stamina state
    this.sprintMultiplier = 1.0;
    this.infiniteStamina = false;
    this.stamina = 100.0;
    this.exhausted = false;
    this._sweatLevel = 0.0;
    this._legWetness = 0.0;
    this._rainWetness = 0.0;
    this._faceFlush = 0.0;

    this._grounded = true;
    this._crouchToggled = false;
    this._crouchHeld = false;
    this._skidTimer = 0;
    this._skidDir = new THREE.Vector2(0, 1);
    this._peakRecentSpeed = 0;
    this._slipCooldown = 0;
    this._slipTimer = 0;
    this._wadeRippleTimer = 0;
    this._lastPanicStage = 0;
    this._lastBrushTime = -1;

    // Input state
    this._keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      sprint: false,
      jump: false,
    };

    // Cached foot world coordinates for wildlife & foliage parting
    this._footWorldL = new THREE.Vector3();
    this._footWorldR = new THREE.Vector3();

    // Kicked-up dirt/leaf footstep dust pool
    this._dust = this._initDustParticles();

    // Sync initial rig transform and camera placement
    this._applyRigTransform();
    this.rig.root.updateMatrixWorld(true);
    this.rig.getFootWorldPositions(this._footWorldL, this._footWorldR);
    this._snapThirdPersonCamera();

    this._bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Footstep Dust & Skid Debris Pool
  // ---------------------------------------------------------------------------

  _initDustParticles() {
    const count = 180;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const ages = new Float32Array(count);
    const lifetimes = new Float32Array(count);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      ages[i] = 99;
      lifetimes[i] = 1;
      positions[i * 3 + 1] = -999;
      sizes[i] = 0;
      alphas[i] = 0;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x8e795c) },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          vec4 mvPos = modelViewMatrix * vec4( position, 1.0 );
          gl_PointSize = aSize * ( 260.0 / max( -mvPos.z, 1.0 ) );
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if ( vAlpha <= 0.005 ) discard;
          vec2 c = gl_PointCoord - 0.5;
          float r2 = dot( c, c );
          if ( r2 > 0.25 ) discard;
          float soft = pow( 1.0 - r2 * 4.0, 1.8 );
          gl_FragColor = vec4( uColor, soft * vAlpha * 0.52 );
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 3;
    this.scene.add(points);

    return {
      points,
      geo,
      mat,
      count,
      cursor: 0,
      positions,
      velocities,
      ages,
      lifetimes,
      sizes,
      alphas,
    };
  }

  _spawnDustBurst(worldPos, count = 7, spread = 0.9, lift = 1.35) {
    const d = this._dust;
    for (let k = 0; k < count; k++) {
      const i = d.cursor;
      d.cursor = (d.cursor + 1) % d.count;

      const ang = Math.random() * Math.PI * 2;
      const spd = (0.35 + Math.random() * 0.75) * spread;
      d.positions[i * 3] = worldPos.x + (Math.random() - 0.5) * 0.22;
      d.positions[i * 3 + 1] = worldPos.y + 0.06 + Math.random() * 0.08;
      d.positions[i * 3 + 2] = worldPos.z + (Math.random() - 0.5) * 0.22;

      d.velocities[i * 3] = Math.cos(ang) * spd - this.velocity.x * 0.22;
      d.velocities[i * 3 + 1] = (0.45 + Math.random() * 0.75) * lift;
      d.velocities[i * 3 + 2] = Math.sin(ang) * spd - this.velocity.z * 0.22;

      d.ages[i] = 0;
      d.lifetimes[i] = 0.45 + Math.random() * 0.48;
      d.sizes[i] = 0.22 + Math.random() * 0.28;
      d.alphas[i] = 0.75;
    }
  }

  _updateDust(dt) {
    const d = this._dust;
    let activeAny = false;
    for (let i = 0; i < d.count; i++) {
      if (d.ages[i] >= d.lifetimes[i]) continue;
      activeAny = true;
      d.ages[i] += dt;
      const t = d.ages[i] / d.lifetimes[i];
      if (t >= 1) {
        d.alphas[i] = 0;
        d.positions[i * 3 + 1] = -999;
        continue;
      }
      d.velocities[i * 3] *= 1 - dt * 2.4;
      d.velocities[i * 3 + 1] -= 2.2 * dt;
      d.velocities[i * 3 + 2] *= 1 - dt * 2.4;

      d.positions[i * 3] += d.velocities[i * 3] * dt;
      d.positions[i * 3 + 1] += d.velocities[i * 3 + 1] * dt;
      d.positions[i * 3 + 2] += d.velocities[i * 3 + 2] * dt;

      d.sizes[i] += dt * 0.55;
      d.alphas[i] = Math.sin(t * Math.PI) * (1 - t * 0.45);
    }

    if (activeAny) {
      d.geo.attributes.position.needsUpdate = true;
      d.geo.attributes.aSize.needsUpdate = true;
      d.geo.attributes.aAlpha.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API & External Triggers
  // ---------------------------------------------------------------------------

  setColliders(colliders = []) {
    const clearing = this.terrain.getClearingCenter3D(new THREE.Vector3());
    const list = colliders.slice();
    list.push({ x: clearing.x, z: clearing.z, radius: 1.72 });
    this.spatialHash.setColliders(list);
  }

  setSprintMultiplier(v) {
    this.sprintMultiplier = clamp(Number(v) || 1.0, 0.5, 2.2);
  }

  setInfiniteStamina(enabled) {
    this.infiniteStamina = Boolean(enabled);
    if (this.infiniteStamina) {
      this.stamina = 100;
      this.exhausted = false;
    }
  }

  setRainWetness(wetness) {
    this._rainWetness = clamp(wetness || 0, 0, 1);
    this.rig.setRainWetness(this._rainWetness);
  }

  getCameraMode() {
    return this._cameraMode;
  }

  cycleCameraMode() {
    const idx = CAMERA_MODES.indexOf(this._cameraMode);
    const next = CAMERA_MODES[(idx + 1) % CAMERA_MODES.length];
    this.setCameraMode(next);
    return next;
  }

  setCameraMode(mode) {
    const normalized = CAMERA_MODES.includes(mode) ? mode : 'Third-Person';
    if (this._cameraMode === normalized) return;

    // Release pointer lock when leaving First-Person Body
    if (this._cameraMode === 'First-Person Body' && document.pointerLockElement === this.domElement) {
      document.exitPointerLock?.();
    }

    this._cameraMode = normalized;
    this.rig.setHeadVisible(normalized !== 'First-Person Body');

    if (normalized === 'Third-Person') {
      this._camYaw = this.facingYaw;
      this._camPitch = 0.24;
      this._snapThirdPersonCamera();
    } else if (normalized === 'First-Person Body') {
      this._camYaw = this.facingYaw;
      this._fpPitch = -0.06;
    }

    this.callbacks.onCameraModeChange?.(normalized);
  }

  resetPositionAndCamera() {
    const clearing = this.terrain.getClearingCenter3D(new THREE.Vector3());
    const x = clearing.x + 3.9;
    const z = clearing.z + 1.8;
    this.position.set(x, this.terrain.getHeightAt(x, z), z);
    this.velocity.set(0, 0, 0);
    this.facingYaw = Math.atan2(-0.84, -0.54);
    this._camYaw = this.facingYaw;
    this._camPitch = 0.24;
    this._fpPitch = -0.06;
    this.stamina = 100;
    this.exhausted = false;
    this._grounded = true;
    this._applyRigTransform();
    if (this._cameraMode === 'Third-Person') {
      this._snapThirdPersonCamera();
    }
  }

  /**
   * Called by RatActor when a rat reaches the human's boot and begins climbing the shin.
   */
  triggerRatPanic(side = 'right') {
    const normSide = side === 'left' || side === 'L' ? 'L' : 'R';
    this.animator.triggerRatPanic(normSide);
    this._crouchToggled = false;
    this._cameraShake = 0.35;

    // Involuntary backward electro-shock jolt & tiny startled hop
    if (this._grounded) {
      const sinY = Math.sin(this.facingYaw);
      const cosY = Math.cos(this.facingYaw);
      this.velocity.x -= sinY * 2.1;
      this.velocity.z -= cosY * 2.1;
      this.velocity.y = 2.35;
      this._grounded = false;
    }

    this.audio?.playHumanGasp?.();
    this.callbacks.onRatPanic?.(normSide);
  }

  triggerStreamSlip() {
    this._slipTimer = 1.25;
    this._slipCooldown = 6.5;
    this._crouchToggled = false;
    this._cameraShake = 0.26;
    this.animator.triggerSlip();
    this.audio?.playSlipSplash?.();
    this.streamWater?.spawnImpact?.(this.position, 1.55);
    this._spawnDustBurst(this.position, 10, 1.4, 1.5);
  }

  triggerThunderFlinch() {
    this.animator.triggerThunderFlinch();
    this._cameraShake = Math.max(this._cameraShake, 0.22);
  }

  // Wildlife & integration getters
  getPosition(target = new THREE.Vector3()) {
    return target.copy(this.position);
  }

  getVelocity(target = new THREE.Vector3()) {
    return target.copy(this.velocity);
  }

  getStamina() {
    return this.stamina;
  }

  isExhausted() {
    return this.exhausted;
  }

  getStateName() {
    return this.animator.getStateName();
  }

  getPanicInfo() {
    return this.animator.getPanicInfo();
  }

  getRig() {
    return this.rig;
  }

  isPointerLocked() {
    return this._isPointerLocked;
  }

  getShinBone(side = 'right') {
    const isLeft = side === 'left' || side === 'L';
    return isLeft ? this.rig.bones.shinL : this.rig.bones.shinR;
  }

  getFootWorldPos(side = 'right', out = new THREE.Vector3()) {
    const isLeft = side === 'left' || side === 'L';
    return out.copy(isLeft ? this._footWorldL : this._footWorldR);
  }

  // Programmatic input setter for browser verification & demos
  setVirtualInput(partial = {}) {
    Object.assign(this._keys, partial);
  }

  // ---------------------------------------------------------------------------
  // DOM & Keyboard Listeners
  // ---------------------------------------------------------------------------

  _bindEvents() {
    const isTextField = (el) =>
      el &&
      (el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable);

    this._onKeyDown = (e) => {
      if (isTextField(document.activeElement) || isTextField(e.target)) return;

      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this._keys.forward = true;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this._keys.backward = true;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this._keys.left = true;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this._keys.right = true;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this._keys.sprint = true;
          break;
        case 'Space':
          if (!e.repeat) {
            e.preventDefault();
            this._tryJump();
          }
          break;
        case 'KeyC':
          if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
            this._crouchToggled = !this._crouchToggled;
          }
          break;
        case 'ControlLeft':
        case 'ControlRight':
          this._crouchHeld = true;
          break;
        case 'KeyV':
          if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
            this.cycleCameraMode();
          }
          break;
        case 'KeyR':
          if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
            this.callbacks.onTriggerRatScare?.();
          }
          break;
        default:
          break;
      }
    };

    this._onKeyUp = (e) => {
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this._keys.forward = false;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this._keys.backward = false;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this._keys.left = false;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this._keys.right = false;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this._keys.sprint = false;
          break;
        case 'ControlLeft':
        case 'ControlRight':
          this._crouchHeld = false;
          break;
        default:
          break;
      }
    };

    this._onPointerDown = (e) => {
      if (e.button !== 0) return;
      this.audio?.unlock?.();
      if (this._cameraMode === 'Free Orbit') return;

      this._isDraggingCam = true;
      this._dragStart.x = e.clientX;
      this._dragStart.y = e.clientY;
      this._lastPointer.x = e.clientX;
      this._lastPointer.y = e.clientY;
    };

    this._onPointerMove = (e) => {
      if (this._cameraMode === 'Free Orbit') return;

      if (this._isPointerLocked) {
        const dx = e.movementX || 0;
        const dy = e.movementY || 0;
        this._applyLookDelta(dx, dy);
      } else if (this._isDraggingCam) {
        const dx = e.clientX - this._lastPointer.x;
        const dy = e.clientY - this._lastPointer.y;
        this._lastPointer.x = e.clientX;
        this._lastPointer.y = e.clientY;
        this._applyLookDelta(dx, dy);
      }
    };

    this._onPointerUp = (e) => {
      if (e.button !== 0) return;
      if (this._isDraggingCam && this._cameraMode === 'First-Person Body' && !this._isPointerLocked) {
        const dx = e.clientX - this._dragStart.x;
        const dy = e.clientY - this._dragStart.y;
        // Request pointer lock on clean click in First-Person Body mode
        if (dx * dx + dy * dy <= 25 && !this.callbacks.isHoveringInteractive?.()) {
          try {
            const p = this.domElement.requestPointerLock?.();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {}
        }
      }
      this._isDraggingCam = false;
    };

    this._onPointerLockChange = () => {
      this._isPointerLocked = document.pointerLockElement === this.domElement;
      this.callbacks.onPointerLockChange?.(this._isPointerLocked);
    };

    this._onBlur = () => {
      this._keys.forward = false;
      this._keys.backward = false;
      this._keys.left = false;
      this._keys.right = false;
      this._keys.sprint = false;
      this._crouchHeld = false;
      this._isDraggingCam = false;
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this.domElement.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    window.addEventListener('blur', this._onBlur);
  }

  _applyLookDelta(dx, dy) {
    const sens = this._isPointerLocked ? 0.0024 : 0.0048;
    this._camYaw -= dx * sens;
    if (this._cameraMode === 'First-Person Body') {
      this._fpPitch = clamp(this._fpPitch - dy * sens, -1.28, 1.18);
      this.facingYaw = this._camYaw;
    } else {
      this._camPitch = clamp(this._camPitch + dy * sens, -0.22, 1.05);
    }
  }

  _tryJump() {
    if (!this._grounded || this._slipTimer > 0) return;
    const panic = this.animator.getPanicInfo();
    if (panic.active && panic.stage === 1) return;

    this._crouchToggled = false;
    const waterDepth = Math.max(0, WATER_LEVEL - this.terrain.getHeightAt(this.position.x, this.position.z));
    const jumpScale = waterDepth > 0.2 ? 0.78 : 1.0;
    this.velocity.y = JUMP_VELOCITY * jumpScale;
    this._grounded = false;

    if (waterDepth > 0.06) {
      this.streamWater?.spawnImpact?.(this.position, 1.15);
      this.audio?.playFootstep?.({ surface: 'water', intensity: 1.0 });
    } else {
      this._spawnDustBurst(this.position, 8, 1.0, 1.2);
      this.audio?.playFootstep?.({ surface: 'dirt', intensity: 0.75 });
    }
  }

  // ---------------------------------------------------------------------------
  // Per-Frame Physics, Foot IK, Audio & Camera Update
  // ---------------------------------------------------------------------------

  update(dt, elapsed) {
    const safeDt = clamp(dt || 0.016, 0.0005, 0.05);

    if (this._slipCooldown > 0) this._slipCooldown = Math.max(0, this._slipCooldown - safeDt);
    if (this._slipTimer > 0) this._slipTimer = Math.max(0, this._slipTimer - safeDt);
    if (this._cameraShake > 0) this._cameraShake = Math.max(0, this._cameraShake - safeDt * 1.4);

    const panic = this.animator.getPanicInfo();
    const groundYHere = this.terrain.getHeightAt(this.position.x, this.position.z);
    const waterDepth = Math.max(0, WATER_LEVEL - groundYHere);
    const wading = waterDepth > 0.05;
    const crouching = (this._crouchToggled || this._crouchHeld) && !wading && !panic.active && this._slipTimer <= 0;

    // 1. Determine camera-relative movement direction
    if (this._cameraMode === 'Free Orbit') {
      this.camera.getWorldDirection(_forward);
      _forward.y = 0;
      if (_forward.lengthSq() < 1e-5) _forward.set(0, 0, -1);
      else _forward.normalize();
    } else {
      _forward.set(Math.sin(this._camYaw), 0, Math.cos(this._camYaw)).normalize();
    }
    _right.crossVectors(_up, _forward).normalize(); // +right matches left-handed A/D relative to +Z look

    const moveF = (this._keys.forward ? 1 : 0) - (this._keys.backward ? 1 : 0);
    const moveR = (this._keys.left ? 1 : 0) - (this._keys.right ? 1 : 0);

    _v1.set(0, 0, 0);
    if (moveF !== 0) _v1.addScaledVector(_forward, moveF);
    if (moveR !== 0) _v1.addScaledVector(_right, moveR);
    const hasInput = _v1.lengthSq() > 0.001;
    if (hasInput) _v1.normalize();

    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const maxSprintSpeed = 7.45 * this.sprintMultiplier;
    const walkSpeed = 2.85;
    const crouchSpeed = 1.68;

    // Check if player wants to sprint (and has stamina)
    const wantsSprint = this._keys.sprint && hasInput && !crouching && !this.exhausted;
    const panickedSprint = Boolean(panic.active && (panic.stage === 2 || panic.stage === 3) && wantsSprint);
    const panicRooted = Boolean(panic.active && (panic.stage === 1 || (panic.stage === 2 && !panickedSprint)));

    // 2. Momentum Skid-Stop detection
    if (this._skidTimer > 0) {
      this._skidTimer = Math.max(0, this._skidTimer - safeDt);
      if (this._grounded && Math.random() < safeDt * 22) {
        this._spawnDustBurst(this.position, 2, 0.85, 0.9);
      }
    } else if (this._grounded && !wading && !panic.active && this._slipTimer <= 0) {
      if (horizSpeed > 5.0 * this.sprintMultiplier) {
        this._peakRecentSpeed = Math.max(this._peakRecentSpeed, horizSpeed);
      } else {
        this._peakRecentSpeed = Math.max(0, this._peakRecentSpeed - safeDt * 6.5);
      }

      if (this._peakRecentSpeed > 5.2 * this.sprintMultiplier && horizSpeed > 4.2) {
        const vxDir = this.velocity.x / horizSpeed;
        const vzDir = this.velocity.z / horizSpeed;
        const reverseInput = hasInput && vxDir * _v1.x + vzDir * _v1.z < -0.42;
        const abruptStop = !hasInput && !this._keys.sprint;
        if (reverseInput || abruptStop) {
          this._skidTimer = 0.44;
          this._skidDir.set(vxDir, vzDir);
          this._peakRecentSpeed = 0;
          this._spawnDustBurst(this.position, 10, 1.3, 1.25);
          this.audio?.playFootstep?.({ surface: 'dirt', intensity: 1.0 });
        }
      }
    }

    // 3. Target horizontal speed & acceleration
    let targetSpeed = 0;
    if (this._slipTimer > 0) {
      targetSpeed = horizSpeed * 0.55;
    } else if (panicRooted) {
      targetSpeed = 0;
    } else if (this._skidTimer > 0) {
      targetSpeed = 0;
    } else if (hasInput) {
      if (crouching) {
        targetSpeed = crouchSpeed;
      } else if (panickedSprint) {
        targetSpeed = 6.95 * this.sprintMultiplier;
      } else if (wantsSprint) {
        targetSpeed = maxSprintSpeed;
      } else {
        targetSpeed = this.exhausted ? 2.15 : walkSpeed;
      }
      if (wading) {
        const waterDrag = lerp(0.82, 0.52, clamp(waterDepth / 0.85, 0, 1));
        targetSpeed *= waterDrag;
      }
    }

    const desiredVx = hasInput && !panicRooted && this._skidTimer <= 0 ? _v1.x * targetSpeed : 0;
    const desiredVz = hasInput && !panicRooted && this._skidTimer <= 0 ? _v1.z * targetSpeed : 0;

    let accelRate = hasInput ? (wantsSprint ? 6.4 : 9.8) : 9.2;
    if (this._skidTimer > 0) accelRate = 4.6;
    if (!this._grounded) accelRate = 2.6;
    if (this._slipTimer > 0) accelRate = 3.2;

    const blend = 1.0 - Math.exp(-safeDt * accelRate);
    this.velocity.x = lerp(this.velocity.x, desiredVx, blend);
    this.velocity.z = lerp(this.velocity.z, desiredVz, blend);

    // 4. Stamina drain / exhaustion / sweat / flush
    const newHorizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const actuallySprinting = wantsSprint && newHorizSpeed > 4.2 && this._grounded && !this.exhausted;

    if (actuallySprinting && !this.infiniteStamina) {
      this.stamina = Math.max(0, this.stamina - 18.5 * safeDt);
      if (this.stamina <= 0.1) {
        this.stamina = 0;
        this.exhausted = true;
      }
    } else {
      const regenRate = newHorizSpeed < 0.4 ? 23.0 : 13.5;
      this.stamina = Math.min(100, this.stamina + regenRate * safeDt);
      if (this.exhausted && this.stamina >= 32) {
        this.exhausted = false;
      }
    }

    // Sweat & facial flush dynamics
    const targetSweat = actuallySprinting ? 1.0 : this.exhausted ? 0.92 : panic.active ? 0.85 : 0.0;
    this._sweatLevel = lerp(this._sweatLevel, targetSweat, 1.0 - Math.exp(-safeDt * (targetSweat > this._sweatLevel ? 0.35 : 0.14)));
    const targetFlush = panic.active ? 0.78 : this.exhausted ? 0.72 : actuallySprinting ? 0.45 : 0.0;
    this._faceFlush = lerp(this._faceFlush, targetFlush, 1.0 - Math.exp(-safeDt * 0.9));
    this.rig.setSweatLevel(this._sweatLevel);
    this.rig.setFaceFlush(this._faceFlush);

    // 5. Integrate horizontal position & resolve 2D spatial-hash trunk/boulder collisions
    this.position.x += this.velocity.x * safeDt;
    this.position.z += this.velocity.z * safeDt;
    this.position.x = clamp(this.position.x, -MAP_BOUND, MAP_BOUND);
    this.position.z = clamp(this.position.z, -MAP_BOUND, MAP_BOUND);
    this.spatialHash.resolveCircle(this.position, PLAYER_RADIUS);

    // 6. Vertical gravity & terrain ground snapping
    const groundY = this.terrain.getHeightAt(this.position.x, this.position.z);
    const wasGrounded = this._grounded;
    if (!this._grounded) {
      this.velocity.y += GRAVITY * safeDt;
      this.position.y += this.velocity.y * safeDt;
      if (this.position.y <= groundY) {
        this.position.y = groundY;
        const impactVel = Math.abs(this.velocity.y);
        this.velocity.y = 0;
        this._grounded = true;
        if (!wasGrounded && impactVel > 2.2) {
          const wDepth = Math.max(0, WATER_LEVEL - groundY);
          if (wDepth > 0.05) {
            this.streamWater?.spawnImpact?.(this.position, clamp(impactVel / 6, 0.7, 1.6));
            this.audio?.playFootstep?.({ surface: 'water', intensity: 1.0 });
          } else {
            this._spawnDustBurst(this.position, 9, 1.15, 1.25);
            this.audio?.playFootstep?.({ surface: 'dirt', intensity: 0.95 });
          }
        }
      }
    } else {
      this.position.y = groundY;
      this.velocity.y = 0;
    }

    // 7. Smooth facing yaw rotation (with turn rate computed for spine/head lean)
    let turnRate = 0;
    if (this._cameraMode === 'First-Person Body') {
      const diff = this._wrapAngle(this._camYaw - this.facingYaw);
      this.facingYaw += diff;
      turnRate = clamp(diff / safeDt, -5, 5);
    } else if (hasInput && !panicRooted && this._skidTimer <= 0 && this._slipTimer <= 0) {
      const targetYaw = Math.atan2(_v1.x, _v1.z);
      const diff = this._wrapAngle(targetYaw - this.facingYaw);
      const step = diff * (1.0 - Math.exp(-safeDt * 11.5));
      this.facingYaw = this._wrapAngle(this.facingYaw + step);
      turnRate = clamp(step / safeDt, -5, 5);
    }

    // 8. Stream wetness, wading ripples & reckless rock-sprint slip chance
    const currentWaterDepth = Math.max(0, WATER_LEVEL - groundY);
    const inStream = currentWaterDepth > 0.04;
    if (inStream) {
      this._legWetness = lerp(this._legWetness, 1.0, 1.0 - Math.exp(-safeDt * 4.5));
      if (newHorizSpeed > 0.65 && this._grounded) {
        this._wadeRippleTimer -= safeDt;
        if (this._wadeRippleTimer <= 0) {
          this._wadeRippleTimer = lerp(0.45, 0.18, clamp(newHorizSpeed / 5.5, 0, 1));
          this.streamWater?.spawnImpact?.(this.position, clamp(0.45 + newHorizSpeed * 0.14, 0.45, 1.25));
        }
      }
      // Slippery rock stumble if sprinting recklessly across shallow rocky stream!
      if (
        this._grounded &&
        this._slipCooldown <= 0 &&
        this._slipTimer <= 0 &&
        !panic.active &&
        wantsSprint &&
        newHorizSpeed > 3.6 &&
        currentWaterDepth > 0.06 &&
        currentWaterDepth < 0.62 &&
        Math.random() < safeDt * 0.28
      ) {
        this.triggerStreamSlip();
      }
    } else {
      this._legWetness = Math.max(0, this._legWetness - safeDt * 0.045);
    }
    this.rig.setLegWetness(Math.max(this._legWetness, this._rainWetness * 0.65));

    // 9. Apply root transform BEFORE running Foot IK so world coordinates are exact
    this._applyRigTransform();
    this.rig.root.updateMatrixWorld(true);

    // Project velocity into character local forward/lateral frame
    const sinF = Math.sin(this.facingYaw);
    const cosF = Math.cos(this.facingYaw);
    const forwardSpeed = this.velocity.x * sinF + this.velocity.z * cosF;
    const lateralSpeed = this.velocity.x * cosF - this.velocity.z * sinF;

    // 10. Update procedural locomotion, 2-bone Foot IK, emotions & secondary springs
    this.animator.update(
      safeDt,
      elapsed,
      {
        speed: newHorizSpeed,
        maxSprintSpeed,
        forwardSpeed,
        lateralSpeed,
        grounded: this._grounded,
        verticalVel: this.velocity.y,
        crouching,
        wading: inStream,
        waterDepth: currentWaterDepth,
        skidding: this._skidTimer > 0,
        exhausted: this.exhausted,
        staminaRatio: this.stamina / 100,
        turnRate,
        isSprinting: actuallySprinting,
        panickedSprint,
        headPitchOverride: this._cameraMode === 'First-Person Body' ? this._fpPitch * 0.55 : null,
      },
      (step) => this._handleFootstep(step)
    );

    // Sync world matrices after IK & gather accurate boot positions
    this.rig.root.updateMatrixWorld(true);
    this.animator.getFootPositions(_footL, _footR);
    this._footWorldL.copy(_footL);
    this._footWorldR.copy(_footR);

    // Feed BOTH feet into GPU foliage parting shader + torso into general interactor when not in Free Orbit
    this.windSystem?.setHumanFeet?.(this._footWorldL, this._footWorldR, true);
    if (this._cameraMode !== 'Free Orbit') {
      this.windSystem?.setInteractorTarget?.(this.position, true);
    }

    // 11. Human breathing/panting, heartbeat & frantic Stage-2 fabric brush audio
    const updatedPanic = this.animator.getPanicInfo();
    if (updatedPanic.brushingPulse && elapsed - this._lastBrushTime > 0.14) {
      this._lastBrushTime = elapsed;
      this.audio?.playFabricBrush?.();
    }
    if (updatedPanic.stage === 1 && this._lastPanicStage !== 1) {
      this._cameraShake = Math.max(this._cameraShake, 0.34);
    }
    this._lastPanicStage = updatedPanic.stage;

    const exertion = clamp(newHorizSpeed / Math.max(maxSprintSpeed, 1), 0, 1);
    this.audio?.updateHumanAudio?.(safeDt, elapsed, {
      exertion: actuallySprinting ? exertion : exertion * 0.35,
      exhausted: this.exhausted,
      panicStage: updatedPanic.stage,
      panicActive: updatedPanic.active,
    });

    // 12. Update footstep dust bursts & active camera
    this._updateDust(safeDt);
    this._updateCamera(safeDt, elapsed, newHorizSpeed, maxSprintSpeed, actuallySprinting, crouching, updatedPanic);
  }

  _handleFootstep({ side, worldPos, intensity = 0.75 }) {
    const pos = worldPos || (side === 'L' ? this._footWorldL : this._footWorldR);
    const groundY = this.terrain.getHeightAt(pos.x, pos.z);
    const waterDepth = WATER_LEVEL - groundY;

    let surface = 'grass';
    if (waterDepth > 0.04) {
      surface = 'water';
      this.streamWater?.spawnImpact?.(pos, clamp(0.55 + intensity * 0.65, 0.5, 1.35));
    } else {
      const slope = this.terrain.getSlopeAt(pos.x, pos.z);
      surface = slope > 0.24 ? 'rock' : groundY < 0.7 ? 'dirt' : 'grass';
      if (intensity > 0.65) {
        this._spawnDustBurst(pos, Math.round(3 + intensity * 5), 0.75 + intensity * 0.5, 0.9 + intensity * 0.5);
      }
    }

    this.audio?.playFootstep?.({ surface, intensity });
  }

  _applyRigTransform() {
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.set(0, this.facingYaw, 0);
  }

  _snapThirdPersonCamera() {
    const dist = 4.5;
    const sinY = Math.sin(this._camYaw);
    const cosY = Math.cos(this._camYaw);
    const cosP = Math.cos(this._camPitch);
    const sinP = Math.sin(this._camPitch);

    const lookY = this.position.y + 1.38;
    _lookGoal.set(this.position.x + sinY * 1.15, lookY, this.position.z + cosY * 1.15);

    const rightX = cosY;
    const rightZ = -sinY;
    _camGoal.set(
      this.position.x - sinY * dist * cosP - rightX * 0.38,
      lookY + dist * sinP + 0.32,
      this.position.z - cosY * dist * cosP - rightZ * 0.38
    );
    const minY = this.terrain.getHeightAt(_camGoal.x, _camGoal.z) + 0.65;
    _camGoal.y = Math.max(_camGoal.y, minY);

    this._camPosSmooth.copy(_camGoal);
    this._camTargetSmooth.copy(_lookGoal);
    this.camera.position.copy(_camGoal);
    this.camera.lookAt(_lookGoal);
  }

  _updateCamera(dt, elapsed, horizSpeed, maxSprintSpeed, isSprinting, crouching, panic) {
    // Dynamic subtle FOV speed widening when full-out sprinting
    const sprintRatio = isSprinting ? clamp((horizSpeed - 3.5) / Math.max(maxSprintSpeed - 3.5, 1), 0, 1) : 0;
    const targetFov =
      this._cameraMode === 'Free Orbit'
        ? this._baseFov
        : this._baseFov + sprintRatio * 8.5 + (panic.active && panic.stage <= 2 ? 3.5 : 0);

    this._currentFov = lerp(this._currentFov, targetFov, 1.0 - Math.exp(-dt * 5.5));
    if (Math.abs(this.camera.fov - this._currentFov) > 0.02) {
      this.camera.fov = this._currentFov;
      this.camera.updateProjectionMatrix();
    }

    if (this._cameraMode === 'Free Orbit') return;

    if (this._cameraMode === 'Third-Person') {
      const dist = 4.45 + sprintRatio * 1.15 - (crouching ? 0.45 : 0);
      const sinY = Math.sin(this._camYaw);
      const cosY = Math.cos(this._camYaw);
      const cosP = Math.cos(this._camPitch);
      const sinP = Math.sin(this._camPitch);

      const lookY = this.position.y + (crouching ? 1.05 : 1.38);
      _lookGoal.set(
        this.position.x + sinY * (1.1 + sprintRatio * 0.9),
        lookY,
        this.position.z + cosY * (1.1 + sprintRatio * 0.9)
      );

      // Subtle right-shoulder cinematic framing
      const rightX = cosY;
      const rightZ = -sinY;
      _camGoal.set(
        this.position.x - sinY * dist * cosP - rightX * 0.36,
        lookY + dist * sinP + 0.3,
        this.position.z - cosY * dist * cosP - rightZ * 0.36
      );

      // Keep camera safely above terrain slopes
      const camGround = this.terrain.getHeightAt(_camGoal.x, _camGoal.z);
      _camGoal.y = Math.max(_camGoal.y, camGround + 0.65);

      const posAlpha = 1.0 - Math.exp(-dt * 11.0);
      const lookAlpha = 1.0 - Math.exp(-dt * 14.0);
      this._camPosSmooth.lerp(_camGoal, posAlpha);
      this._camTargetSmooth.lerp(_lookGoal, lookAlpha);

      // Subtle micro-shake during electro-shock panic, thunder, or stumble
      const shakeMag = this._cameraShake * 0.16 + (panic.active && panic.stage === 2 ? 0.025 : 0);
      const shakeX = shakeMag > 0.001 ? Math.sin(elapsed * 47.0) * shakeMag : 0;
      const shakeY = shakeMag > 0.001 ? Math.cos(elapsed * 53.0) * shakeMag : 0;

      this.camera.position.set(
        this._camPosSmooth.x + shakeX,
        this._camPosSmooth.y + shakeY,
        this._camPosSmooth.z
      );
      this.camera.lookAt(this._camTargetSmooth);
    } else if (this._cameraMode === 'First-Person Body') {
      // Mount directly onto the animated eyeTarget bone so head bob, crouch, jump, and panic shakes feel visceral
      this.rig.bones.eyeTarget.getWorldPosition(_eyeWorld);
      const sinY = Math.sin(this._camYaw);
      const cosY = Math.cos(this._camYaw);
      const cosP = Math.cos(this._fpPitch);
      const sinP = Math.sin(this._fpPitch);

      const shakeMag = this._cameraShake * 0.09 + (panic.active && panic.stage === 2 ? 0.022 : 0);
      this.camera.position.set(
        _eyeWorld.x + (shakeMag > 0.001 ? Math.sin(elapsed * 51.0) * shakeMag : 0),
        Math.max(_eyeWorld.y, this.terrain.getHeightAt(_eyeWorld.x, _eyeWorld.z) + 0.35),
        _eyeWorld.z
      );
      _lookGoal.set(
        this.camera.position.x + sinY * cosP * 5.0,
        this.camera.position.y + sinP * 5.0,
        this.camera.position.z + cosY * cosP * 5.0
      );
      this.camera.lookAt(_lookGoal);
    }
  }

  _wrapAngle(rad) {
    let a = rad;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.domElement.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    window.removeEventListener('blur', this._onBlur);

    this.scene.remove(this.rig.root);
    this.rig.dispose();

    this.scene.remove(this._dust.points);
    this._dust.geo.dispose();
    this._dust.mat.dispose();
  }
}
