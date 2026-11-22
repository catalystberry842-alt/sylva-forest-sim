import * as THREE from 'three';
import { HumanMeshBuilder } from './HumanMeshBuilder.js';
import { HumanAnimatorIK } from './HumanAnimatorIK.js';
import { SpatialHash2D } from '../interaction/ControlsAndRaycast.js';
import { WATER_LEVEL } from '../world/Terrain.js';
import { clamp, lerp } from '../utils/random.js';

const CAMERA_MODES = ['Third-Person', 'First-Person Body', 'Free Orbit'];
const MAP_BOUND = 104;
const PLAYER_RADIUS = 0.42;
const GRAVITY = -16.2;
const JUMP_VELOCITY = 5.75;

const _v1 = new THREE.Vector3();
const _footL = new THREE.Vector3();
const _footR = new THREE.Vector3();
const _eyeWorld = new THREE.Vector3();
const _camGoal = new THREE.Vector3();
const _lookGoal = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _surfNormal = new THREE.Vector3(0, 1, 0);
const _lookDelta = { dx: 0, dy: 0 };
const _moveIntent = { forward: 0, right: 0, magnitude: 0, isAnalog: false };

/**
 * Playable human character controller integrating unified keyboard/mouse/multi-touch
 * InputManager, multi-layer SurfaceSolver (terrain + cabin steps/floors + arched bridge
 * + hollow redwood + stone cavern + wall/doorway sliding + indoor shelter physics),
 * SpatialHash2D trunk/boulder collision, Foot IK, dust bursts, and 3 cameras (V / CAM).
 */
export class HumanController {
  constructor(
    engine,
    terrain,
    windSystem,
    streamWater,
    audio,
    callbacks = {},
    { inputManager = null, surfaceSolver = null } = {}
  ) {
    this.engine = engine;
    this.scene = engine.scene;
    this.camera = engine.camera;
    this.domElement = engine.renderer.domElement;
    this.terrain = terrain;
    this.surfaceSolver = surfaceSolver;
    this.inputManager = inputManager;
    this.windSystem = windSystem;
    this.streamWater = streamWater;
    this.audio = audio;
    this.callbacks = callbacks;

    // 1. Build upgraded procedural human rig & surface-aware Foot IK animator
    this.rig = new HumanMeshBuilder();
    this.animator = new HumanAnimatorIK(this.rig, surfaceSolver || terrain);
    this.scene.add(this.rig.root);

    // 2. Spatial-hash 2D collision for trees, boulders, logs, stumps, and campfire
    this.spatialHash = new SpatialHash2D(4.0);

    // Spawn cleanly in the mossy campfire glade right beside the fire overlooking cabin & bridge
    const clearing = terrain.getClearingCenter3D(new THREE.Vector3());
    const spawnX = clearing.x + 3.9;
    const spawnZ = clearing.z + 1.8;
    const spawnY = this._sampleGround(spawnX, spawnZ, Infinity).height;

    this.position = new THREE.Vector3(spawnX, spawnY, spawnZ);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.facingYaw = Math.atan2(-0.84, -0.54);

    // Camera state (Third-Person default)
    this._cameraMode = 'Third-Person';
    this._camYaw = this.facingYaw;
    this._camPitch = 0.24;
    this._fpPitch = -0.06;
    this._thirdPersonDist = 4.45;
    this._camPosSmooth = new THREE.Vector3();
    this._camTargetSmooth = new THREE.Vector3();
    this._currentFov = 58;
    this._baseFov = 58;
    this._cameraShake = 0;

    // Locomotion, shelter & stamina state
    this.sprintMultiplier = 1.0;
    this.infiniteStamina = false;
    this.stamina = 100.0;
    this.exhausted = false;
    this._sweatLevel = 0.0;
    this._legWetness = 0.0;
    this._rainWetness = 0.0;
    this._faceFlush = 0.0;
    this._currentSurfaceType = 'grass';
    this._shelterState = {
      sheltered: false,
      blocksRain: false,
      windDamping: 0,
      acousticZone: 'outdoor',
      structureId: null,
    };
    this._lastAcousticZone = 'outdoor';

    this._grounded = true;
    this._skidTimer = 0;
    this._skidDir = new THREE.Vector2(0, 1);
    this._peakRecentSpeed = 0;
    this._slipCooldown = 0;
    this._slipTimer = 0;
    this._wadeRippleTimer = 0;
    this._lastPanicStage = 0;
    this._lastBrushTime = -1;

    // Cached foot world positions for wildlife & foliage parting
    this._footWorldL = new THREE.Vector3();
    this._footWorldR = new THREE.Vector3();

    // Kicked-up dirt/leaf footstep dust pool
    this._dust = this._initDustParticles();

    // Sync initial rig transform and camera placement
    this._applyRigTransform();
    this.rig.root.updateMatrixWorld(true);
    this.rig.getFootWorldPositions(this._footWorldL, this._footWorldR);
    this._snapThirdPersonCamera();
  }

  _sampleGround(x, z, referenceY = Infinity) {
    if (this.surfaceSolver && typeof this.surfaceSolver.sampleSurface === 'function') {
      return this.surfaceSolver.sampleSurface(x, z, referenceY, _surfNormal);
    }
    const h = this.terrain.getHeightAt(x, z);
    this.terrain.getNormalAt(x, z, _surfNormal);
    return {
      height: h,
      normal: _surfNormal,
      surfaceType: h < WATER_LEVEL - 0.04 ? 'water' : 'grass',
      isStructure: false,
      structureId: null,
    };
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

  setSurfaceSolver(solver) {
    this.surfaceSolver = solver;
    this.animator.setSurfaceSolver?.(solver);
  }

  setInputManager(manager) {
    this.inputManager = manager;
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

  teleportTo(pos, yaw = null) {
    if (!pos) return;
    const refY = Number.isFinite(pos.y) ? pos.y + 0.5 : Infinity;
    const surf = this._sampleGround(pos.x, pos.z, refY);
    this.position.set(pos.x, surf.height, pos.z);
    this.velocity.set(0, 0, 0);
    this._grounded = true;
    this._skidTimer = 0;
    this._slipTimer = 0;
    if (Number.isFinite(yaw)) {
      this.facingYaw = yaw;
      this._camYaw = yaw;
    }
    this._applyRigTransform();
    this.rig.root.updateMatrixWorld(true);
    if (this._cameraMode === 'Third-Person') {
      this._snapThirdPersonCamera();
    }
  }

  resetPositionAndCamera() {
    const clearing = this.terrain.getClearingCenter3D(new THREE.Vector3());
    const x = clearing.x + 3.9;
    const z = clearing.z + 1.8;
    const yaw = Math.atan2(-0.84, -0.54);
    this.stamina = 100;
    this.exhausted = false;
    this._camPitch = 0.24;
    this._fpPitch = -0.06;
    this._thirdPersonDist = 4.45;
    this.teleportTo({ x, y: this.terrain.getHeightAt(x, z), z }, yaw);
  }

  triggerJump() {
    if (!this._grounded || this._slipTimer > 0) return;
    const panic = this.animator.getPanicInfo();
    if (panic.active && panic.stage === 1) return;

    this.inputManager?.setCrouchToggled?.(false);
    const surf = this._sampleGround(this.position.x, this.position.z, this.position.y);
    const waterDepth = surf.isStructure ? 0 : Math.max(0, WATER_LEVEL - surf.height);
    const jumpScale = waterDepth > 0.2 ? 0.78 : 1.0;
    this.velocity.y = JUMP_VELOCITY * jumpScale;
    this._grounded = false;

    if (waterDepth > 0.06) {
      this.streamWater?.spawnImpact?.(this.position, 1.15);
      this.audio?.playFootstep?.({ surface: 'water', intensity: 1.0 });
    } else {
      if (!surf.isStructure) {
        this._spawnDustBurst(this.position, 8, 1.0, 1.2);
      }
      this.audio?.playFootstep?.({ surface: surf.surfaceType || 'dirt', intensity: 0.78 });
    }
  }

  triggerRatPanic(side = 'right') {
    const normSide = side === 'left' || side === 'L' ? 'L' : 'R';
    this.animator.triggerRatPanic(normSide);
    this.inputManager?.setCrouchToggled?.(false);
    this._cameraShake = 0.35;

    if (this._grounded) {
      const sinY = Math.sin(this.facingYaw);
      const cosY = Math.cos(this.facingYaw);
      this.velocity.x -= sinY * 1.9;
      this.velocity.z -= cosY * 1.9;
      this.velocity.y = 2.35;
      this._grounded = false;
    }

    this.audio?.playHumanGasp?.();
    this.callbacks.onRatPanic?.(normSide);
  }

  triggerStreamSlip() {
    this._slipTimer = 1.25;
    this._slipCooldown = 6.5;
    this.inputManager?.setCrouchToggled?.(false);
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

  // Getters
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

  getShelterState() {
    return this._shelterState;
  }

  getCurrentSurfaceType() {
    return this._currentSurfaceType;
  }

  getRig() {
    return this.rig;
  }

  isPointerLocked() {
    return Boolean(this.inputManager?.isPointerLocked?.());
  }

  isCrouching() {
    return Boolean(this.inputManager?.isCrouching?.());
  }

  isSprintingInput() {
    return Boolean(this.inputManager?.isSprinting?.());
  }

  getShinBone(side = 'right') {
    const isLeft = side === 'left' || side === 'L';
    return isLeft ? this.rig.bones.shinL : this.rig.bones.shinR;
  }

  getFootWorldPos(side = 'right', out = new THREE.Vector3()) {
    const isLeft = side === 'left' || side === 'L';
    return out.copy(isLeft ? this._footWorldL : this._footWorldR);
  }

  setVirtualInput(partial = {}) {
    this.inputManager?.setVirtualInput?.(partial);
  }

  // ---------------------------------------------------------------------------
  // Per-Frame Physics, Surface Solver, Shelter, Foot IK, Audio & Camera Update
  // ---------------------------------------------------------------------------

  update(dt, elapsed) {
    const safeDt = clamp(dt || 0.016, 0.0005, 0.05);

    if (this._slipCooldown > 0) this._slipCooldown = Math.max(0, this._slipCooldown - safeDt);
    if (this._slipTimer > 0) this._slipTimer = Math.max(0, this._slipTimer - safeDt);
    if (this._cameraShake > 0) this._cameraShake = Math.max(0, this._cameraShake - safeDt * 1.4);

    // 0. Consume camera look & pinch/wheel zoom deltas from InputManager
    if (this.inputManager && this._cameraMode !== 'Free Orbit') {
      this.inputManager.consumeLookDelta(_lookDelta);
      if (_lookDelta.dx !== 0 || _lookDelta.dy !== 0) {
        const sens = this.inputManager.isPointerLocked() ? 0.0024 : 0.0048;
        this._camYaw -= _lookDelta.dx * sens;
        if (this._cameraMode === 'First-Person Body') {
          this._fpPitch = clamp(this._fpPitch - _lookDelta.dy * sens, -1.28, 1.18);
          this.facingYaw = this._camYaw;
        } else {
          this._camPitch = clamp(this._camPitch + _lookDelta.dy * sens, -0.22, 1.08);
        }
      }

      const zoomDelta = this.inputManager.consumeZoomDelta();
      if (zoomDelta !== 0 && this._cameraMode === 'Third-Person') {
        this._thirdPersonDist = clamp(this._thirdPersonDist + zoomDelta * 0.006, 2.6, 8.2);
      }
    } else if (this.inputManager) {
      // Drain unused deltas in Free Orbit
      this.inputManager.consumeLookDelta(_lookDelta);
      this.inputManager.consumeZoomDelta();
    }

    const panic = this.animator.getPanicInfo();
    const surfHere = this._sampleGround(this.position.x, this.position.z, this.position.y);
    const waterDepth = surfHere.isStructure ? 0 : Math.max(0, WATER_LEVEL - surfHere.height);
    const wading = waterDepth > 0.05;
    const crouching = Boolean(this.inputManager?.isCrouching?.()) && !wading && !panic.active && this._slipTimer <= 0;

    // 1. Unified keyboard + analog thumbstick camera-relative movement intent
    if (this._cameraMode === 'Free Orbit') {
      this.camera.getWorldDirection(_forward);
      _forward.y = 0;
      if (_forward.lengthSq() < 1e-5) _forward.set(0, 0, -1);
      else _forward.normalize();
    } else {
      _forward.set(Math.sin(this._camYaw), 0, Math.cos(this._camYaw)).normalize();
    }
    // Right-handed camera-right vector: cross(forward, up) aligns +right to screen-right!
    _right.crossVectors(_forward, _up).normalize();

    if (this.inputManager) {
      this.inputManager.getMoveIntent(_moveIntent);
    } else {
      _moveIntent.forward = 0;
      _moveIntent.right = 0;
      _moveIntent.magnitude = 0;
      _moveIntent.isAnalog = false;
    }

    _v1.set(0, 0, 0);
    if (_moveIntent.forward !== 0) _v1.addScaledVector(_forward, _moveIntent.forward);
    if (_moveIntent.right !== 0) _v1.addScaledVector(_right, _moveIntent.right);

    const inputMag = clamp(_moveIntent.magnitude, 0, 1);
    const hasInput = inputMag > 0.01 && _v1.lengthSq() > 1e-5;
    if (hasInput) _v1.normalize();

    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const maxSprintSpeed = 7.45 * this.sprintMultiplier;
    const walkSpeed = 2.85;
    const crouchSpeed = 1.68;

    const wantsSprint = Boolean(this.inputManager?.isSprinting?.()) && hasInput && !crouching && !this.exhausted;
    const panickedSprint = Boolean(panic.active && (panic.stage === 2 || panic.stage === 3) && wantsSprint);
    const panicRooted = Boolean(panic.active && (panic.stage === 1 || (panic.stage === 2 && !panickedSprint)));

    // 2. Momentum Skid-Stop detection
    if (this._skidTimer > 0) {
      this._skidTimer = Math.max(0, this._skidTimer - safeDt);
      if (this._grounded && !surfHere.isStructure && Math.random() < safeDt * 22) {
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
        const abruptStop = !hasInput && !wantsSprint;
        if (reverseInput || abruptStop) {
          this._skidTimer = 0.44;
          this._skidDir.set(vxDir, vzDir);
          this._peakRecentSpeed = 0;
          if (!surfHere.isStructure) {
            this._spawnDustBurst(this.position, 10, 1.3, 1.25);
          }
          this.audio?.playFootstep?.({ surface: surfHere.surfaceType || 'dirt', intensity: 1.0 });
        }
      }
    }

    // 3. Target horizontal speed & acceleration (honoring analog thumbstick quadratic tilt!)
    let targetSpeed = 0;
    if (this._slipTimer > 0) {
      targetSpeed = horizSpeed * 0.55;
    } else if (panicRooted || this._skidTimer > 0) {
      targetSpeed = 0;
    } else if (hasInput) {
      if (crouching) {
        targetSpeed = crouchSpeed * (_moveIntent.isAnalog ? lerp(0.45, 1.0, inputMag) : 1.0);
      } else if (panickedSprint) {
        targetSpeed = 6.95 * this.sprintMultiplier;
      } else if (wantsSprint) {
        targetSpeed = maxSprintSpeed;
      } else {
        const baseWalk = this.exhausted ? 2.15 : walkSpeed;
        // Smooth slow walk at slight analog tilt -> brisk walk at mid-tilt
        targetSpeed = _moveIntent.isAnalog ? lerp(0.95, baseWalk * 1.22, inputMag) : baseWalk;
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

    const targetSweat = actuallySprinting ? 1.0 : this.exhausted ? 0.92 : panic.active ? 0.85 : 0.0;
    this._sweatLevel = lerp(
      this._sweatLevel,
      targetSweat,
      1.0 - Math.exp(-safeDt * (targetSweat > this._sweatLevel ? 0.35 : 0.14))
    );
    const targetFlush = panic.active ? 0.78 : this.exhausted ? 0.72 : actuallySprinting ? 0.45 : 0.0;
    this._faceFlush = lerp(this._faceFlush, targetFlush, 1.0 - Math.exp(-safeDt * 0.9));
    this.rig.setSweatLevel(this._sweatLevel);
    this.rig.setFaceFlush(this._faceFlush);

    // 5. Integrate horizontal position & resolve BOTH tree/boulder AND structure wall/doorway collisions!
    this.position.x += this.velocity.x * safeDt;
    this.position.z += this.velocity.z * safeDt;
    this.position.x = clamp(this.position.x, -MAP_BOUND, MAP_BOUND);
    this.position.z = clamp(this.position.z, -MAP_BOUND, MAP_BOUND);

    this.spatialHash.resolveCircle(this.position, PLAYER_RADIUS);
    if (this.surfaceSolver && typeof this.surfaceSolver.resolveCollision === 'function') {
      this.surfaceSolver.resolveCollision(this.position, PLAYER_RADIUS, crouching ? 1.25 : 1.76);
    }

    // 6. Vertical gravity & multi-layer walkable surface snapping (steps, cabin floors, bridge deck, cavern floor)
    const nextSurf = this._sampleGround(this.position.x, this.position.z, this.position.y);
    const groundY = nextSurf.height;
    this._currentSurfaceType = nextSurf.surfaceType;

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
          const wDepth = nextSurf.isStructure ? 0 : Math.max(0, WATER_LEVEL - groundY);
          if (wDepth > 0.05) {
            this.streamWater?.spawnImpact?.(this.position, clamp(impactVel / 6, 0.7, 1.6));
            this.audio?.playFootstep?.({ surface: 'water', intensity: 1.0 });
          } else {
            if (!nextSurf.isStructure) {
              this._spawnDustBurst(this.position, 9, 1.15, 1.25);
            }
            this.audio?.playFootstep?.({ surface: nextSurf.surfaceType || 'dirt', intensity: 0.95 });
          }
        }
      }
    } else {
      // Smooth step-up interpolation so climbing 3 porch steps looks fluid & organic
      const stepDiff = groundY - this.position.y;
      if (stepDiff > 0.01 && stepDiff <= 0.42) {
        this.position.y = lerp(this.position.y, groundY, 1.0 - Math.exp(-safeDt * 22.0));
      } else if (stepDiff < -0.55) {
        // Stepping off a high ledge launches cleanly into gravity
        this._grounded = false;
      } else {
        this.position.y = groundY;
      }
      this.velocity.y = 0;
    }

    // 7. Indoor Shelter Physics (blocks rain wetness, dampens outdoor wind gusts, sets cave/wood acoustics!)
    if (this.surfaceSolver && typeof this.surfaceSolver.getShelterState === 'function') {
      this._shelterState = this.surfaceSolver.getShelterState(this.position);
    }
    const acousticZone = this._shelterState.acousticZone || 'outdoor';
    if (acousticZone !== this._lastAcousticZone) {
      this._lastAcousticZone = acousticZone;
      this.audio?.setAcousticZone?.(acousticZone);
    }

    // 8. Smooth facing yaw rotation
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

    // 9. Stream wetness (dry when on bridge or indoors!), wading ripples & rock slip chance
    const currentWaterDepth = nextSurf.isStructure ? 0 : Math.max(0, WATER_LEVEL - groundY);
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
      const dryRate = this._shelterState.sheltered ? 0.11 : 0.045;
      this._legWetness = Math.max(0, this._legWetness - safeDt * dryRate);
    }

    // Rain shelter occlusion: standing under cabin roof, hollow redwood, or cave keeps character dry!
    const effectiveRainWet = this._shelterState.blocksRain ? 0.0 : this._rainWetness;
    const smoothRain = lerp(
      this.rig.shaderUniforms.uRainWetness.value,
      effectiveRainWet,
      1.0 - Math.exp(-safeDt * (effectiveRainWet > 0 ? 1.8 : 0.8))
    );
    this.rig.setRainWetness(smoothRain);
    this.rig.setLegWetness(Math.max(this._legWetness, smoothRain * 0.65));

    // 10. Apply root transform BEFORE running Foot IK
    this._applyRigTransform();
    this.rig.root.updateMatrixWorld(true);

    const sinF = Math.sin(this.facingYaw);
    const cosF = Math.cos(this.facingYaw);
    const forwardSpeed = this.velocity.x * sinF + this.velocity.z * cosF;
    const lateralSpeed = this.velocity.x * cosF - this.velocity.z * sinF;

    // Damp outdoor wind intensity on hair & eyelids when sheltered indoors!
    const localWind = this.windSystem
      ? this.windSystem.sampleGustAt(this.position.x, this.position.z).intensity
      : 0.4;
    const shelteredWind = localWind * (1.0 - (this._shelterState.windDamping || 0));

    // 11. Update procedural locomotion, SurfaceSolver-aware 2-bone Foot IK, emotions & secondary springs
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
        windIntensity: shelteredWind,
        headPitchOverride: this._cameraMode === 'First-Person Body' ? this._fpPitch * 0.55 : null,
      },
      (step) => this._handleFootstep(step)
    );

    this.rig.root.updateMatrixWorld(true);
    this.animator.getFootPositions(_footL, _footR);
    this._footWorldL.copy(_footL);
    this._footWorldR.copy(_footR);

    // Feed BOTH boots into GPU foliage parting shader
    this.windSystem?.setHumanFeet?.(this._footWorldL, this._footWorldR, true);
    if (this._cameraMode !== 'Free Orbit') {
      this.windSystem?.setInteractorTarget?.(this.position, true);
    }

    // 12. Human breathing/panting, heartbeat & frantic Stage-2 fabric brush audio
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

    // 13. Update dust bursts & camera
    this._updateDust(safeDt);
    this._updateCamera(safeDt, elapsed, newHorizSpeed, maxSprintSpeed, actuallySprinting, crouching, updatedPanic);
  }

  _handleFootstep({ side, worldPos, intensity = 0.75 }) {
    const pos = worldPos || (side === 'L' ? this._footWorldL : this._footWorldR);
    const surf = this._sampleGround(pos.x, pos.z, this.position.y);

    let surface = surf.surfaceType || 'grass';
    if (!surf.isStructure) {
      const waterDepth = WATER_LEVEL - surf.height;
      if (waterDepth > 0.04) {
        surface = 'water';
        this.streamWater?.spawnImpact?.(pos, clamp(0.55 + intensity * 0.65, 0.5, 1.35));
      } else {
        const slope = this.terrain.getSlopeAt(pos.x, pos.z);
        surface = slope > 0.24 ? 'rock' : surf.height < 0.7 ? 'dirt' : 'grass';
        if (intensity > 0.65) {
          this._spawnDustBurst(pos, Math.round(3 + intensity * 5), 0.75 + intensity * 0.5, 0.9 + intensity * 0.5);
        }
      }
    }

    this.audio?.playFootstep?.({ surface, intensity });
  }

  _applyRigTransform() {
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.set(0, this.facingYaw, 0);
  }

  _snapThirdPersonCamera() {
    const dist = this._thirdPersonDist;
    const sinY = Math.sin(this._camYaw);
    const cosY = Math.cos(this._camYaw);
    const cosP = Math.cos(this._camPitch);
    const sinP = Math.sin(this._camPitch);

    const lookY = this.position.y + 1.38;
    _lookGoal.set(this.position.x + sinY * 1.15, lookY, this.position.z + cosY * 1.15);

    const rightX = -cosY;
    const rightZ = sinY;
    _camGoal.set(
      this.position.x - sinY * dist * cosP + rightX * 0.36,
      lookY + dist * sinP + 0.3,
      this.position.z - cosY * dist * cosP + rightZ * 0.36
    );
    const minY = this.terrain.getHeightAt(_camGoal.x, _camGoal.z) + 0.65;
    _camGoal.y = Math.max(_camGoal.y, minY);

    this._camPosSmooth.copy(_camGoal);
    this._camTargetSmooth.copy(_lookGoal);
    this.camera.position.copy(_camGoal);
    this.camera.lookAt(_lookGoal);
  }

  _updateCamera(dt, elapsed, horizSpeed, maxSprintSpeed, isSprinting, crouching, panic) {
    const sprintRatio = isSprinting
      ? clamp((horizSpeed - 3.5) / Math.max(maxSprintSpeed - 3.5, 1), 0, 1)
      : 0;
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
      // Pull camera slightly tighter indoors so cabin walls/redwood trunk never obscure the explorer!
      const indoorPull = this._shelterState.sheltered ? 0.62 : 1.0;
      const dist = (this._thirdPersonDist * indoorPull) + sprintRatio * 1.05 - (crouching ? 0.42 : 0);
      const sinY = Math.sin(this._camYaw);
      const cosY = Math.cos(this._camYaw);
      const cosP = Math.cos(this._camPitch);
      const sinP = Math.sin(this._camPitch);

      const lookY = this.position.y + (crouching ? 1.05 : 1.38);
      _lookGoal.set(
        this.position.x + sinY * (1.0 + sprintRatio * 0.85),
        lookY,
        this.position.z + cosY * (1.0 + sprintRatio * 0.85)
      );

      // Right-shoulder offset (+right in right-handed frame is (-cosY, 0, sinY))
      const rightX = -cosY;
      const rightZ = sinY;
      _camGoal.set(
        this.position.x - sinY * dist * cosP + rightX * 0.34,
        lookY + dist * sinP + (this._shelterState.sheltered ? 0.12 : 0.3),
        this.position.z - cosY * dist * cosP + rightZ * 0.34
      );

      const camGround = this.terrain.getHeightAt(_camGoal.x, _camGoal.z);
      _camGoal.y = Math.max(_camGoal.y, camGround + 0.6);

      // Keep camera safely below indoor cabin ceiling/cavern roof when sheltered
      if (this._shelterState.sheltered) {
        _camGoal.y = Math.min(_camGoal.y, this.position.y + 2.45);
      }

      const posAlpha = 1.0 - Math.exp(-dt * 11.0);
      const lookAlpha = 1.0 - Math.exp(-dt * 14.0);
      this._camPosSmooth.lerp(_camGoal, posAlpha);
      this._camTargetSmooth.lerp(_lookGoal, lookAlpha);

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
    this.scene.remove(this.rig.root);
    this.rig.dispose();

    this.scene.remove(this._dust.points);
    this._dust.geo.dispose();
    this._dust.mat.dispose();
  }
}
