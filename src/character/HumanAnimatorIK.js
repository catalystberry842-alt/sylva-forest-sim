import * as THREE from 'three';
import { clamp, lerp, smoothstep, smootherstep } from '../utils/random.js';

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

/**
 * Unconditionally stable sub-stepped 1D damped harmonic spring for secondary physics
 * (backpack inertia, hanging canteen pendulum, jacket hem flare, head follow-through,
 * and landing knee compression).
 */
class SpringDamper {
  constructor({ stiffness = 60, damping = 9, initial = 0, maxVal = 1.5 } = {}) {
    this.stiffness = stiffness;
    this.damping = damping;
    this.value = initial;
    this.velocity = 0;
    this.maxVal = maxVal;
  }

  impulse(deltaV) {
    if (Number.isFinite(deltaV)) {
      this.velocity += deltaV;
    }
  }

  step(dt, target = 0) {
    const safeTarget = Number.isFinite(target) ? target : 0;
    const totalDt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.05);
    if (totalDt <= 0) return this.value;

    const subSteps = Math.max(1, Math.ceil(totalDt / 0.01));
    const h = totalDt / subSteps;

    for (let i = 0; i < subSteps; i++) {
      const accel = (safeTarget - this.value) * this.stiffness - this.velocity * this.damping;
      this.velocity += accel * h;
      this.value += this.velocity * h;
      if (this.value > this.maxVal) {
        this.value = this.maxVal;
        if (this.velocity > 0) this.velocity *= -0.2;
      } else if (this.value < -this.maxVal) {
        this.value = -this.maxVal;
        if (this.velocity < 0) this.velocity *= -0.2;
      }
    }

    if (!Number.isFinite(this.value) || !Number.isFinite(this.velocity)) {
      this.value = 0;
      this.velocity = 0;
    }
    return this.value;
  }
}

/**
 * Full procedural locomotion, emotional expression, secondary spring-damper physics,
 * and analytical 2-bone terrain-conforming Foot IK animator for HumanMeshBuilder.
 *
 * Supported states:
 *   'Idle', 'Walk', 'Jog', 'FullSprint', 'SkidStop', 'Jump', 'Crouch',
 *   'StreamWade', 'SlipRecovery', 'ThunderFlinch', 'RatPanicShake' (4 stages)
 */
export class HumanAnimatorIK {
  constructor(humanRig, terrain = null) {
    this.rig = humanRig;
    this.terrain = terrain;
    this.bones = humanRig.bones;
    this.metrics = humanRig.metrics;

    // Exact leg kinematics constants derived from rig bind hierarchy
    this._hipBindY = this.metrics.hipBindY ?? 0.94;
    this._thighLen = this.metrics.thighLen ?? 0.44;
    this._shinLen = this.metrics.shinLen ?? 0.42;
    this._hipOffsetX = this.metrics.hipOffsetX ?? 0.105;
    this._thighOffsetY = this.bones.thighL ? this.bones.thighL.position.y : -0.02;
    this._soleOffsetY =
      this.rig._soleOffsetBelowAnkle ??
      Math.max(0.04, this._hipBindY + this._thighOffsetY - this._thighLen - this._shinLen);
    this._maxLegReach = this._thighLen + this._shinLen - 0.018;

    // Base rest positions of expressive facial bones
    this._browBaseY = this.bones.browL ? this.bones.browL.position.y : 0.072;
    this._hipsBaseZ = this.bones.hips ? this.bones.hips.position.z : 0;

    // Current locomotion & state machine tracking
    this._stateName = 'Idle';
    this._stridePhase = 0;
    this._prevPhaseL = 0;
    this._prevPhaseR = Math.PI;
    this._wasGrounded = true;
    this._prevSpeed = 0;
    this._prevVertVel = 0;
    this._prevHipsY = this._hipBindY;
    this._prevHipsVelY = 0;
    this._skidLeadSide = 'L';

    // Smooth Foot IK blend weights per leg (0 = pure FK airborne/shaking, 1 = full terrain IK)
    this._ikWeightL = 1.0;
    this._ikWeightR = 1.0;
    this._smoothedTerrainHipDrop = 0.0;

    // Expressive one-shot / multi-stage timers
    this._slipTimer = -1;
    this._slipDuration = 1.2;

    this._thunderTimer = -1;
    this._thunderDuration = 0.85;

    // 4-Stage RatPanicShake state (0.0 .. 8.5s)
    this._panicActive = false;
    this._panicTimer = 0;
    this._panicDuration = 8.5;
    this._panicStage = 0;
    this._panicSide = 'R';
    this._brushingPulse = false;
    this._prevSwipeSin = 0;
    this._prevHopSin = 0;

    // Natural eye blinking & ambient glance timers
    this._blinkTimer = 2.4;
    this._blinkDuration = 0.15;
    this._blinkProgress = -1;
    this._glanceTimer = 1.8;
    this._glanceTargetYaw = 0;
    this._glanceTargetPitch = 0;
    this._glanceYaw = 0;
    this._glancePitch = 0;

    // Stage 3 paranoid look-around sequencer
    this._paranoidYaw = 0;
    this._paranoidPitch = 0;

    // Breathing phase
    this._breathPhase = 0;

    // Secondary spring-damper physics
    this._springs = {
      backpackPitch: new SpringDamper({ stiffness: 52, damping: 7.2, maxVal: 0.35 }),
      backpackRoll: new SpringDamper({ stiffness: 46, damping: 6.5, maxVal: 0.28 }),
      backpackBounce: new SpringDamper({ stiffness: 78, damping: 8.5, maxVal: 0.055 }),
      canteenPitch: new SpringDamper({ stiffness: 28, damping: 2.6, maxVal: 0.78 }),
      canteenRoll: new SpringDamper({ stiffness: 26, damping: 2.4, maxVal: 0.78 }),
      jacketHemPitch: new SpringDamper({ stiffness: 42, damping: 6.2, maxVal: 0.52 }),
      jacketHemRoll: new SpringDamper({ stiffness: 38, damping: 5.8, maxVal: 0.38 }),
      headLagPitch: new SpringDamper({ stiffness: 68, damping: 9.2, maxVal: 0.26 }),
      headLagYaw: new SpringDamper({ stiffness: 64, damping: 8.8, maxVal: 0.28 }),
      headLagRoll: new SpringDamper({ stiffness: 64, damping: 8.8, maxVal: 0.22 }),
      landingBounce: new SpringDamper({ stiffness: 95, damping: 11.5, maxVal: 0.32 }),
    };

    // Smoothed base pose values for seamless state transitions
    this._smooth = {
      hipsY: this._hipBindY,
      hipsX: 0,
      hipsZ: 0,
      hipsPitch: 0,
      hipsYaw: 0,
      hipsRoll: 0,
      torsoPitch: 0,
      torsoYaw: 0,
      torsoRoll: 0,
      neckPitch: 0,
      neckYaw: 0,
      headPitch: 0,
      headYaw: 0,
      headRoll: 0,
      clavLShrug: 0,
      clavRShrug: 0,
      armLPitch: 0,
      armLRoll: 0.08,
      armLYaw: 0,
      forearmLPitch: -0.18,
      wristLPitch: 0,
      wristLYaw: 0,
      wristLRoll: 0,
      fingerLCurl: 0.18,
      armRPitch: 0,
      armRRoll: -0.08,
      armRYaw: 0,
      forearmRPitch: -0.18,
      wristRPitch: 0,
      wristRYaw: 0,
      wristRRoll: 0,
      fingerRCurl: 0.18,
      jawOpen: 0,
      browHeight: 0,
      browTilt: 0,
      eyeWide: 0,
      eyeSquint: 0,
      eyeYaw: 0,
      eyePitch: 0,
    };

    // Reusable scratch math objects (zero GC churn per frame)
    this._invRootMat = new THREE.Matrix4();
    this._rootQuat = new THREE.Quaternion();
    this._invRootQuat = new THREE.Quaternion();
    this._rootPos = new THREE.Vector3();
    this._rootScale = new THREE.Vector3();

    this._footWorldL = new THREE.Vector3();
    this._footWorldR = new THREE.Vector3();
    this._footLocalL = new THREE.Vector3();
    this._footLocalR = new THREE.Vector3();
    this._ankleTargetL = new THREE.Vector3();
    this._ankleTargetR = new THREE.Vector3();
    this._normalWorldL = new THREE.Vector3(0, 1, 0);
    this._normalWorldR = new THREE.Vector3(0, 1, 0);
    this._normalLocalL = new THREE.Vector3(0, 1, 0);
    this._normalLocalR = new THREE.Vector3(0, 1, 0);

    this._hipsLocalMat = new THREE.Matrix4();
    this._invHipsLocalMat = new THREE.Matrix4();
    this._hipsQuat = new THREE.Quaternion();
    this._thighQuat = new THREE.Quaternion();
    this._shinQuat = new THREE.Quaternion();
    this._shinInRootQuat = new THREE.Quaternion();
    this._fkThighQuat = new THREE.Quaternion();
    this._fkShinQuat = new THREE.Quaternion();
    this._fkAnkleQuat = new THREE.Quaternion();
    this._ikThighQuat = new THREE.Quaternion();
    this._ikShinQuat = new THREE.Quaternion();
    this._ikAnkleQuat = new THREE.Quaternion();
    this._desiredFootQuat = new THREE.Quaternion();
    this._pitchOffsetQuat = new THREE.Quaternion();
    this._basisMat = new THREE.Matrix4();
    this._tmpVecA = new THREE.Vector3();
    this._tmpVecB = new THREE.Vector3();
    this._tmpVecC = new THREE.Vector3();
    this._tmpEuler = new THREE.Euler(0, 0, 0, 'ZXY');
    this._tmpEulerXYZ = new THREE.Euler(0, 0, 0, 'XYZ');
    this._xAxis = new THREE.Vector3(1, 0, 0);
    this._finalFootL = new THREE.Vector3();
    this._finalFootR = new THREE.Vector3();
  }

  // ---------------------------------------------------------------------------
  // Public Event Triggers & Queries
  // ---------------------------------------------------------------------------

  triggerSlip() {
    this._slipTimer = 0.0;
  }

  triggerThunderFlinch() {
    this._thunderTimer = 0.0;
  }

  triggerRatPanic(side = 'R') {
    this._panicActive = true;
    this._panicTimer = 0.0;
    this._panicStage = 1;
    this._panicSide = side === 'L' ? 'L' : 'R';
    this._brushingPulse = false;
    this._prevSwipeSin = 0;
    this._prevHopSin = 0;
  }

  getPanicInfo() {
    return {
      active: this._panicActive,
      stage: this._panicStage,
      timer: this._panicActive ? this._panicTimer : 0,
      side: this._panicSide,
      brushingPulse: this._brushingPulse,
    };
  }

  getStateName() {
    return this._stateName;
  }

  getFootPositions(leftOut = new THREE.Vector3(), rightOut = new THREE.Vector3()) {
    return this.rig.getFootWorldPositions(leftOut, rightOut);
  }

  // ---------------------------------------------------------------------------
  // Terrain Sampling Helpers (Null-Safe & NaN-Safe)
  // ---------------------------------------------------------------------------

  _sampleGroundHeight(x, z, fallbackY = 0) {
    if (this.terrain && typeof this.terrain.getHeightAt === 'function') {
      const h = this.terrain.getHeightAt(x, z);
      if (Number.isFinite(h)) return h;
    }
    return fallbackY;
  }

  _sampleGroundNormal(x, z, target) {
    if (this.terrain && typeof this.terrain.getNormalAt === 'function') {
      this.terrain.getNormalAt(x, z, target);
      if (
        Number.isFinite(target.x) &&
        Number.isFinite(target.y) &&
        Number.isFinite(target.z) &&
        target.lengthSq() > 1e-6
      ) {
        return target.normalize();
      }
    }
    return target.set(0, 1, 0);
  }

  // ---------------------------------------------------------------------------
  // Main Frame Update
  // ---------------------------------------------------------------------------

  update(dt, elapsed = 0, locomotionState = {}, onFootstep = null) {
    const safeDt = clamp(Number.isFinite(dt) ? dt : 0.016, 0.0001, 0.05);
    const safeElapsed = Number.isFinite(elapsed) ? elapsed : 0;

    // Sanitize locomotion state inputs
    const loc = {
      speed: Number.isFinite(locomotionState?.speed) ? Math.max(0, locomotionState.speed) : 0,
      maxSprintSpeed:
        Number.isFinite(locomotionState?.maxSprintSpeed) && locomotionState.maxSprintSpeed > 0.5
          ? locomotionState.maxSprintSpeed
          : 7.5,
      forwardSpeed: Number.isFinite(locomotionState?.forwardSpeed) ? locomotionState.forwardSpeed : (locomotionState?.speed ?? 0),
      lateralSpeed: Number.isFinite(locomotionState?.lateralSpeed) ? locomotionState.lateralSpeed : 0,
      grounded: locomotionState?.grounded !== false,
      verticalVel: Number.isFinite(locomotionState?.verticalVel) ? locomotionState.verticalVel : 0,
      crouching: Boolean(locomotionState?.crouching),
      wading: Boolean(locomotionState?.wading),
      waterDepth: Number.isFinite(locomotionState?.waterDepth) ? clamp(locomotionState.waterDepth, 0, 1.5) : 0,
      skidding: Boolean(locomotionState?.skidding),
      exhausted: Boolean(locomotionState?.exhausted),
      staminaRatio: Number.isFinite(locomotionState?.staminaRatio) ? clamp(locomotionState.staminaRatio, 0, 1) : 1.0,
      turnRate: Number.isFinite(locomotionState?.turnRate) ? clamp(locomotionState.turnRate, -8, 8) : 0,
      isSprinting: Boolean(locomotionState?.isSprinting),
      panickedSprint: Boolean(locomotionState?.panickedSprint),
      headPitchOverride: Number.isFinite(locomotionState?.headPitchOverride) ? locomotionState.headPitchOverride : null,
      headYawOverride: Number.isFinite(locomotionState?.headYawOverride) ? locomotionState.headYawOverride : null,
    };

    // Ensure root world matrix reflects any controller position/yaw update before IK
    this.rig.root.updateMatrixWorld(true);
    this.rig.root.matrixWorld.decompose(this._rootPos, this._rootQuat, this._rootScale);
    this._invRootMat.copy(this.rig.root.matrixWorld).invert();
    this._invRootQuat.copy(this._rootQuat).invert();

    // Advance one-shot & multi-stage expressive timers
    const pendingFootsteps = [];
    this._advanceTimers(safeDt, safeElapsed, loc, pendingFootsteps);

    // Detect Jump -> Grounded landing compression & double-foot thud
    if (!this._wasGrounded && loc.grounded) {
      const impact = clamp(Math.abs(Math.min(this._prevVertVel, 0)) / 9.0, 0.25, 1.0);
      this._springs.landingBounce.impulse(-2.8 * impact);
      this._springs.backpackBounce.impulse(-0.65 * impact);
      this._springs.canteenPitch.impulse(3.2 * impact);
      pendingFootsteps.push({ side: 'L', intensity: clamp(0.55 + impact * 0.45, 0.4, 1.0) });
      pendingFootsteps.push({ side: 'R', intensity: clamp(0.55 + impact * 0.45, 0.4, 1.0) });
    }

    // Track which leg leads when entering SkidStop
    if (loc.skidding && this._stateName !== 'SkidStop') {
      this._skidLeadSide = this._prevPhaseL < Math.PI ? 'L' : 'R';
    }

    // Resolve active state name
    const baseLocoState = this._resolveBaseLocomotionState(loc);
    this._stateName = this._resolveActiveState(baseLocoState);

    // Advance rhythmic breathing phase
    const panicBreathBoost =
      this._panicActive && this._panicStage >= 1
        ? this._panicStage === 4
          ? 1.0 - smootherstep(6.5, 8.5, this._panicTimer)
          : 1.0
        : 0.0;
    const breathHz =
      0.26 +
      (1.0 - loc.staminaRatio) * 0.55 +
      (loc.exhausted ? 0.32 : 0) +
      panicBreathBoost * 1.15;
    this._breathPhase = (this._breathPhase + safeDt * breathHz * TWO_PI) % (TWO_PI * 100);

    // Advance stride phase & compute desired foot offsets + heel-strike callbacks
    const stride = this._computeStridePlan(safeDt, safeElapsed, loc, baseLocoState, pendingFootsteps);

    // Compute target upper-body & facial posture for the active state
    const targetPose = this._computeTargetPose(safeDt, safeElapsed, loc, baseLocoState, stride);

    // Smoothly blend base pose parameters (fast crisp damping, no abrupt pops)
    const blendRate = 1.0 - Math.exp(-safeDt * 13.5);
    const faceBlendRate = 1.0 - Math.exp(-safeDt * 18.0);
    for (const key in this._smooth) {
      const rate =
        key === 'jawOpen' ||
        key === 'browHeight' ||
        key === 'browTilt' ||
        key === 'eyeWide' ||
        key === 'eyeSquint' ||
        key === 'eyeYaw' ||
        key === 'eyePitch'
          ? faceBlendRate
          : blendRate;
      this._smooth[key] = lerp(this._smooth[key], targetPose[key], rate);
    }

    // Update landing compression spring
    const landingComp = this._springs.landingBounce.step(safeDt, 0);

    // Compute additive high-frequency expressive overlays (14Hz shake, 8Hz swipes, 20Hz shiver, shock flinch, blink)
    const overlay = this._computeExpressiveOverlays(safeDt, safeElapsed, loc, pendingFootsteps);

    // Apply spine, torso, head, eyes, eyelids, brows, jaw, and arm poses
    this._applyUpperBodyAndFace(safeDt, safeElapsed, loc, stride, overlay, landingComp);

    // Compute FK leg poses + analytical 2-bone terrain-conforming Foot IK
    this._applyLegsAndFootIK(safeDt, safeElapsed, loc, baseLocoState, stride, overlay, landingComp);

    // Update secondary spring-damper physics (backpack, hanging canteen, jacket hem, head lag)
    this._applySecondaryPhysics(safeDt, safeElapsed, loc, overlay);

    // Refresh world transforms so eyeTarget, bones, and foot positions are exact this frame
    this.rig.root.updateMatrixWorld(true);

    // Emit crisp footstep callbacks with exact updated boot sole world coordinates
    if (typeof onFootstep === 'function' && pendingFootsteps.length > 0) {
      this.rig.getFootWorldPositions(this._finalFootL, this._finalFootR);
      for (let i = 0; i < pendingFootsteps.length; i++) {
        const ev = pendingFootsteps[i];
        const pos = ev.side === 'L' ? this._finalFootL.clone() : this._finalFootR.clone();
        onFootstep({
          side: ev.side,
          worldPos: pos,
          intensity: clamp(ev.intensity, 0.05, 1.0),
        });
      }
    }

    this._wasGrounded = loc.grounded;
    this._prevSpeed = loc.speed;
    this._prevVertVel = loc.verticalVel;
  }

  // ---------------------------------------------------------------------------
  // Timers & State Resolution
  // ---------------------------------------------------------------------------

  _advanceTimers(dt, elapsed, loc, pendingFootsteps) {
    // Slip recovery (1.2s)
    if (this._slipTimer >= 0) {
      this._slipTimer += dt;
      if (this._slipTimer >= this._slipDuration) {
        this._slipTimer = -1;
      }
    }

    // Thunder flinch (0.85s)
    if (this._thunderTimer >= 0) {
      this._thunderTimer += dt;
      if (this._thunderTimer >= this._thunderDuration) {
        this._thunderTimer = -1;
      }
    }

    // 4-Stage RatPanicShake (0.0 .. 8.5s)
    this._brushingPulse = false;
    if (this._panicActive) {
      this._panicTimer += dt;
      if (this._panicTimer >= this._panicDuration) {
        this._panicActive = false;
        this._panicTimer = 0;
        this._panicStage = 0;
      } else if (this._panicTimer < 0.4) {
        this._panicStage = 1;
      } else if (this._panicTimer < 2.4) {
        this._panicStage = 2;
        if (!loc.panickedSprint) {
          const stageT = this._panicTimer - 0.4;
          const swipeSin = Math.sin(stageT * 8.0 * TWO_PI);
          // Pulse true at each alternating hand's downward swipe peak (16 peaks/sec -> ~8 Hz per hand)
          if (Math.abs(swipeSin) > 0.86 && Math.abs(this._prevSwipeSin) <= 0.86) {
            this._brushingPulse = true;
          }
          this._prevSwipeSin = swipeSin;

          // Awkward hopping footstep on standing leg during Stage 2
          const hopSin = Math.sin(stageT * 4.2 * TWO_PI);
          if (this._prevHopSin > 0 && hopSin <= 0) {
            const standSide = this._panicSide === 'L' ? 'R' : 'L';
            pendingFootsteps.push({ side: standSide, intensity: 0.55 });
          }
          this._prevHopSin = hopSin;
        }
      } else if (this._panicTimer < 6.5) {
        this._panicStage = 3;
      } else {
        this._panicStage = 4;
      }
    }

    // Natural eye blink timer (suppressed when eyes are peeled wide in Stage 1-2 panic or slip)
    const eyesForcedOpen =
      (this._panicActive && (this._panicStage === 1 || this._panicStage === 2)) ||
      (this._slipTimer >= 0 && this._slipTimer < 0.75);

    if (this._blinkProgress >= 0) {
      this._blinkProgress += dt;
      if (this._blinkProgress >= this._blinkDuration) {
        this._blinkProgress = -1;
      }
    } else if (!eyesForcedOpen) {
      this._blinkTimer -= dt;
      if (this._blinkTimer <= 0) {
        this._blinkProgress = 0;
        // Deterministic pseudo-random interval between 2.5s and 5.2s
        const frac = Math.abs(Math.sin(elapsed * 12.9898 + 4.1414) * 43758.5453) % 1;
        this._blinkTimer = 2.5 + frac * 2.7;
      }
    }

    // Ambient idle head glance scheduler
    this._glanceTimer -= dt;
    if (this._glanceTimer <= 0) {
      const h1 = Math.sin(elapsed * 3.17 + 1.1);
      const h2 = Math.cos(elapsed * 2.31 + 2.7);
      this._glanceTargetYaw = h1 * 0.24;
      this._glanceTargetPitch = h2 * 0.08;
      this._glanceTimer = 2.2 + Math.abs(h2) * 2.4;
    }
    const glanceFollow = 1.0 - Math.exp(-dt * 2.6);
    this._glanceYaw = lerp(this._glanceYaw, this._glanceTargetYaw, glanceFollow);
    this._glancePitch = lerp(this._glancePitch, this._glanceTargetPitch, glanceFollow);
  }

  _resolveBaseLocomotionState(loc) {
    if (!loc.grounded) return 'Jump';
    if (loc.skidding) return 'SkidStop';
    if (loc.wading || loc.waterDepth > 0.14) return 'StreamWade';
    if (loc.crouching) return 'Crouch';
    if (loc.isSprinting || loc.speed >= loc.maxSprintSpeed * 0.76) return 'FullSprint';
    if (loc.speed >= 2.55) return 'Jog';
    if (loc.speed >= 0.22) return 'Walk';
    return 'Idle';
  }

  _resolveActiveState(baseLocoState) {
    if (this._panicActive) return 'RatPanicShake';
    if (this._slipTimer >= 0) return 'SlipRecovery';
    if (this._thunderTimer >= 0) return 'ThunderFlinch';
    return baseLocoState;
  }

  // ---------------------------------------------------------------------------
  // Procedural Stride Cycle & Foot Trajectory Planning
  // ---------------------------------------------------------------------------

  _computeStridePlan(dt, elapsed, loc, baseLocoState, pendingFootsteps) {
    const speedRatio = clamp(loc.speed / loc.maxSprintSpeed, 0, 1.25);
    const panicSprinting = this._panicActive && loc.panickedSprint && loc.grounded && loc.speed > 0.4;
    const isMoving =
      loc.grounded &&
      !loc.skidding &&
      loc.speed >= 0.18 &&
      !(this._panicActive && (this._panicStage === 1 || (this._panicStage === 2 && !loc.panickedSprint)));

    let strideLen = 0.0;
    let stepHeight = 0.0;
    let stanceWidth = this._hipOffsetX;
    let cadence = 0.0;

    if (isMoving) {
      if (panicSprinting) {
        // Erratic ungainly panicked sprint cadence
        const jitter = 1.0 + 0.16 * Math.sin(elapsed * 9.2);
        strideLen = lerp(0.75, 1.18, clamp(speedRatio, 0, 1));
        stepHeight = 0.24 + 0.05 * Math.abs(Math.sin(elapsed * 7.1));
        stanceWidth = this._hipOffsetX + 0.048;
        cadence = Math.max(loc.speed / Math.max(strideLen * 0.85, 0.5), 2.1) * jitter;
      } else if (baseLocoState === 'StreamWade') {
        strideLen = lerp(0.38, 0.64, clamp(speedRatio * 1.4, 0, 1));
        stepHeight = 0.24 + clamp(loc.waterDepth, 0, 0.75) * 0.16;
        stanceWidth = this._hipOffsetX + 0.04;
        cadence = loc.speed / Math.max(strideLen * 1.15, 0.42);
      } else if (baseLocoState === 'Crouch') {
        strideLen = lerp(0.32, 0.52, clamp(speedRatio * 1.8, 0, 1));
        stepHeight = 0.075;
        stanceWidth = this._hipOffsetX + 0.025;
        cadence = loc.speed / Math.max(strideLen * 1.08, 0.36);
      } else if (baseLocoState === 'FullSprint') {
        strideLen = lerp(1.06, 1.32, clamp((speedRatio - 0.7) / 0.35, 0, 1));
        stepHeight = 0.21;
        stanceWidth = this._hipOffsetX - 0.008;
        cadence = loc.speed / Math.max(strideLen * 0.92, 0.65);
      } else if (baseLocoState === 'Jog') {
        strideLen = lerp(0.78, 1.04, clamp((loc.speed - 2.5) / 3.2, 0, 1));
        stepHeight = 0.145;
        stanceWidth = this._hipOffsetX;
        cadence = loc.speed / Math.max(strideLen * 0.98, 0.55);
      } else {
        // Walk
        strideLen = lerp(0.42, 0.72, clamp(loc.speed / 2.55, 0, 1));
        stepHeight = lerp(0.055, 0.095, clamp(loc.speed / 2.55, 0, 1));
        stanceWidth = this._hipOffsetX + 0.006;
        cadence = loc.speed / Math.max(strideLen * 1.04, 0.42);
      }

      const dirSign = loc.forwardSpeed < -0.25 ? -1 : 1;
      const dPhase = clamp(cadence, 0.4, 4.4) * Math.PI * dt * dirSign;
      this._stridePhase = (this._stridePhase + dPhase + TWO_PI * 10) % TWO_PI;

      const pL = this._stridePhase;
      const pR = (this._stridePhase + Math.PI) % TWO_PI;

      // Detect heel strike (phase crossing PI: swing -> stance)
      const stepIntensity = clamp(
        0.24 + speedRatio * 0.72 + (baseLocoState === 'StreamWade' ? 0.18 : 0) - (baseLocoState === 'Crouch' ? 0.15 : 0),
        0.15,
        1.0
      );
      if (dirSign > 0) {
        if (this._prevPhaseL < Math.PI && pL >= Math.PI) {
          pendingFootsteps.push({ side: 'L', intensity: stepIntensity });
        }
        if (this._prevPhaseR < Math.PI && pR >= Math.PI) {
          pendingFootsteps.push({ side: 'R', intensity: stepIntensity });
        }
      } else {
        if (this._prevPhaseL > Math.PI && pL <= Math.PI) {
          pendingFootsteps.push({ side: 'L', intensity: stepIntensity * 0.85 });
        }
        if (this._prevPhaseR > Math.PI && pR <= Math.PI) {
          pendingFootsteps.push({ side: 'R', intensity: stepIntensity * 0.85 });
        }
      }

      this._prevPhaseL = pL;
      this._prevPhaseR = pR;
    } else {
      // Gently relax phase toward neutral planted stance when stationary
      this._prevPhaseL = this._stridePhase;
      this._prevPhaseR = (this._stridePhase + Math.PI) % TWO_PI;
    }

    const pL = this._stridePhase;
    const pR = (this._stridePhase + Math.PI) % TWO_PI;

    // Lateral strafe component
    const strafeAmp = clamp(loc.lateralSpeed / Math.max(loc.maxSprintSpeed * 0.6, 2.0), -0.35, 0.35);

    const evalFoot = (p, sideSign) => {
      if (!isMoving) {
        return { x: sideSign * stanceWidth, z: 0, lift: 0, swing: 0, anklePitch: 0, toeBend: 0 };
      }
      const inSwing = p < Math.PI;
      const swingSin = inSwing ? Math.sin(p) : 0;
      const lift = inSwing ? Math.pow(swingSin, 1.15) * stepHeight : 0;

      // Continuous fore-aft trajectory: cosine sweep in swing, constant-velocity linear pull in stance
      const foreAftNorm = inSwing ? -Math.cos(p) : 1.0 - 2.0 * ((p - Math.PI) / Math.PI);
      const z = foreAftNorm * (strideLen * 0.5);
      const x = sideSign * stanceWidth + foreAftNorm * strafeAmp * 0.25;

      // Heel-strike dorsiflexion (-X) on landing, smooth plantarflexion + toe push-off near p -> 2*PI
      let anklePitch = 0;
      let toeBend = 0;
      if (inSwing) {
        // Subtle toe clearance mid-swing, heel pitch preparing for strike near PI
        const strikePrep = smoothstep(Math.PI * 0.62, Math.PI, p);
        const toeDrag = smoothstep(0.0, Math.PI * 0.35, p) * (1.0 - strikePrep);
        anklePitch = toeDrag * 0.22 - strikePrep * 0.24;
        toeBend = -toeDrag * 0.12;
      } else {
        const stanceT = (p - Math.PI) / Math.PI; // 0 = heel strike, 1 = toe-off
        const pushOff = smoothstep(0.62, 1.0, stanceT);
        const strikeSettle = 1.0 - smoothstep(0.0, 0.22, stanceT);
        anklePitch = -strikeSettle * 0.16 + pushOff * 0.32;
        toeBend = -pushOff * 0.42; // toes flex UP while heel pushes off!
      }

      return { x, z, lift, swing: swingSin, anklePitch, toeBend };
    };

    const left = evalFoot(pL, 1);
    const right = evalFoot(pR, -1);

    return {
      isMoving,
      panicSprinting,
      speedRatio,
      strideLen,
      stepHeight,
      stanceWidth,
      phase: this._stridePhase,
      sinPhase: Math.sin(this._stridePhase),
      cosPhase: Math.cos(this._stridePhase),
      left,
      right,
    };
  }

  // ---------------------------------------------------------------------------
  // Base State Pose Synthesis (All 11 States)
  // ---------------------------------------------------------------------------

  _computeTargetPose(dt, elapsed, loc, baseLocoState, stride) {
    const breath = Math.sin(this._breathPhase);
    const speedRatio = stride.speedRatio;
    const sp = stride.sinPhase;
    const cp = stride.cosPhase;

    // Start from calm relaxed Idle posture
    const p = {
      hipsY: this._hipBindY - 0.015,
      hipsX: 0,
      hipsZ: 0,
      hipsPitch: 0.02,
      hipsYaw: 0,
      hipsRoll: 0,
      torsoPitch: 0.02 + breath * 0.012,
      torsoYaw: 0,
      torsoRoll: 0,
      neckPitch: -0.02,
      neckYaw: 0,
      headPitch: 0,
      headYaw: 0,
      headRoll: 0,
      clavLShrug: breath * 0.014,
      clavRShrug: breath * 0.014,
      armLPitch: 0.04,
      armLRoll: 0.11,
      armLYaw: 0.06,
      forearmLPitch: -0.22,
      wristLPitch: 0,
      wristLYaw: 0,
      wristLRoll: 0,
      fingerLCurl: 0.22,
      armRPitch: 0.04,
      armRRoll: -0.11,
      armRYaw: -0.06,
      forearmRPitch: -0.22,
      wristRPitch: 0,
      wristRYaw: 0,
      wristRRoll: 0,
      fingerRCurl: 0.22,
      jawOpen: 0,
      browHeight: 0,
      browTilt: 0,
      eyeWide: 0,
      eyeSquint: 0,
      eyeYaw: 0,
      eyePitch: 0,
    };

    const activeBase = stride.panicSprinting ? 'FullSprint' : baseLocoState;

    if (activeBase === 'Idle') {
      const sway = Math.sin(elapsed * 0.65);
      p.hipsX = sway * 0.014;
      p.hipsRoll = -sway * 0.022;
      p.torsoRoll = sway * 0.024;
      p.headYaw = this._glanceYaw;
      p.headPitch = this._glancePitch;
      p.eyeYaw = this._glanceYaw * 0.45;
      p.eyePitch = this._glancePitch * 0.35;

      // Exhausted stationary recovery posture: hands braced on hips/knees, heavy panting!
      if (loc.exhausted) {
        p.hipsY = this._hipBindY - 0.075;
        p.hipsPitch = 0.14;
        p.torsoPitch = 0.34 + breath * 0.045;
        p.neckPitch = -0.14;
        p.headPitch = -0.08 + breath * 0.03;
        p.clavLShrug = -0.04 + breath * 0.055;
        p.clavRShrug = -0.04 + breath * 0.055;
        p.armLPitch = -0.42;
        p.armRPitch = -0.42;
        p.armLRoll = 0.22;
        p.armRRoll = -0.22;
        p.armLYaw = -0.22;
        p.armRYaw = 0.22;
        p.forearmLPitch = -0.62;
        p.forearmRPitch = -0.62;
        p.wristLPitch = 0.25;
        p.wristRPitch = 0.25;
        p.fingerLCurl = 0.35;
        p.fingerRCurl = 0.35;
        p.jawOpen = 0.18 + (breath * 0.5 + 0.5) * 0.14;
        p.browTilt = -0.14;
        p.eyeSquint = 0.16;
      }
    } else if (activeBase === 'Walk') {
      const walkBob = Math.abs(Math.sin(stride.phase)) * 0.032;
      p.hipsY = this._hipBindY - 0.028 + walkBob;
      p.hipsX = cp * 0.022;
      p.hipsYaw = -cp * 0.085;
      p.hipsRoll = cp * 0.04;
      p.torsoPitch = 0.075 + speedRatio * 0.06;
      p.torsoYaw = cp * 0.13;
      p.torsoRoll = -cp * 0.045 + clamp(loc.turnRate * 0.06, -0.16, 0.16);
      // Stabilize head against torso twist
      p.headYaw = -p.torsoYaw * 0.65;
      p.headPitch = -0.04;

      // Counter-swinging arms (opposite phase to legs: when L leg is forward (cp < 0), L arm swings back (+X))
      const armSwing = 0.42 * clamp(loc.speed / 2.2, 0.35, 1.15);
      p.armLPitch = -cp * armSwing;
      p.armRPitch = cp * armSwing;
      p.armLRoll = 0.1;
      p.armRRoll = -0.1;
      p.forearmLPitch = -0.26 - Math.max(0, -p.armLPitch) * 0.55;
      p.forearmRPitch = -0.26 - Math.max(0, -p.armRPitch) * 0.55;
      p.fingerLCurl = 0.3;
      p.fingerRCurl = 0.3;
    } else if (activeBase === 'Jog') {
      const jogBob = Math.abs(sp) * 0.062;
      p.hipsY = this._hipBindY - 0.055 + jogBob;
      p.hipsX = cp * 0.024;
      p.hipsYaw = -cp * 0.12;
      p.hipsRoll = cp * 0.05;
      p.torsoPitch = 0.22;
      p.torsoYaw = cp * 0.18;
      p.torsoRoll = -cp * 0.055 + clamp(loc.turnRate * 0.08, -0.22, 0.22);
      p.neckPitch = -0.1;
      p.headPitch = -0.08;
      p.headYaw = -p.torsoYaw * 0.72;

      const armSwing = 0.72;
      p.armLPitch = -cp * armSwing;
      p.armRPitch = cp * armSwing;
      p.armLRoll = 0.14;
      p.armRRoll = -0.14;
      p.armLYaw = -0.12;
      p.armRYaw = 0.12;
      p.forearmLPitch = -1.18 - Math.max(0, -p.armLPitch) * 0.32;
      p.forearmRPitch = -1.18 - Math.max(0, -p.armRPitch) * 0.32;
      p.fingerLCurl = 0.85;
      p.fingerRCurl = 0.85;
      p.browTilt = -0.08;
      p.jawOpen = 0.06 + (1 - loc.staminaRatio) * 0.08;
    } else if (activeBase === 'FullSprint') {
      // Forward athletic lean (16°-26° = 0.28..0.45 rad), powerful pumping elbows, clenched fists, furrowed brows
      const sprintIntensity = clamp((speedRatio - 0.65) / 0.35, 0, 1);
      const sprintBob = Math.abs(sp) * 0.082;
      p.hipsY = this._hipBindY - 0.088 + sprintBob;
      p.hipsX = cp * 0.026;
      p.hipsPitch = 0.08;
      p.hipsYaw = -cp * 0.17;
      p.hipsRoll = cp * 0.065;
      p.torsoPitch = lerp(0.30, 0.44, sprintIntensity);
      p.torsoYaw = cp * 0.26;
      p.torsoRoll = -cp * 0.065 + clamp(loc.turnRate * 0.11, -0.28, 0.28);
      p.neckPitch = -0.16;
      p.headPitch = -0.14;
      p.headYaw = -p.torsoYaw * 0.78;
      p.clavLShrug = 0.08;
      p.clavRShrug = 0.08;

      const armSwing = 1.08;
      p.armLPitch = -cp * armSwing - 0.08;
      p.armRPitch = cp * armSwing - 0.08;
      p.armLRoll = 0.18;
      p.armRRoll = -0.18;
      p.armLYaw = -0.18;
      p.armRYaw = 0.18;
      p.forearmLPitch = -1.52 - Math.max(0, -p.armLPitch) * 0.32;
      p.forearmRPitch = -1.52 - Math.max(0, -p.armRPitch) * 0.32;
      // Tightly clenched sprinting fists
      p.fingerLCurl = 1.32;
      p.fingerRCurl = 1.32;
      // Determined furrowed brows
      p.browHeight = -0.004;
      p.browTilt = -0.24;
      p.eyeSquint = 0.14;
      p.jawOpen = 0.09 + (1 - loc.staminaRatio) * 0.12;
    } else if (activeBase === 'SkidStop') {
      // Planted front heel braced forward, rear knee dropped low, torso leaned back, arms spread wide
      const leadSign = this._skidLeadSide === 'L' ? 1 : -1;
      p.hipsY = this._hipBindY - 0.19;
      p.hipsPitch = -0.14;
      p.hipsYaw = -leadSign * 0.26;
      p.hipsRoll = leadSign * 0.08;
      p.torsoPitch = -0.24;
      p.torsoYaw = leadSign * 0.18;
      p.torsoRoll = -leadSign * 0.1;
      p.neckPitch = 0.16;
      p.headPitch = 0.14;
      p.clavLShrug = 0.14;
      p.clavRShrug = 0.14;
      p.armLPitch = -0.18;
      p.armRPitch = -0.18;
      p.armLRoll = 0.96;
      p.armRRoll = -0.96;
      p.forearmLPitch = -0.34;
      p.forearmRPitch = -0.34;
      p.fingerLCurl = -0.12;
      p.fingerRCurl = -0.12;
      p.browHeight = 0.004;
      p.eyeWide = 0.12;
    } else if (activeBase === 'Jump') {
      const rising = smoothstep(-0.5, 3.8, loc.verticalVel);
      const falling = smoothstep(0.5, -5.5, loc.verticalVel);
      p.hipsY = this._hipBindY - 0.04 + rising * 0.04 - falling * 0.03;
      p.torsoPitch = lerp(0.16, 0.05, rising) + falling * 0.12;
      p.neckPitch = -0.08;
      p.headPitch = falling * 0.18 - rising * 0.1;
      p.clavLShrug = 0.12 + rising * 0.12;
      p.clavRShrug = 0.12 + rising * 0.12;
      // Launch raises arms, mid-air spreads arms wide for balance
      p.armLPitch = lerp(-0.45, -1.15, rising) + falling * 0.15;
      p.armRPitch = lerp(-0.35, -1.05, rising) + falling * 0.15;
      p.armLRoll = lerp(0.62, 0.35, rising) + falling * 0.35;
      p.armRRoll = -(lerp(0.62, 0.35, rising) + falling * 0.35);
      p.forearmLPitch = lerp(-0.75, -0.5, rising);
      p.forearmRPitch = lerp(-0.75, -0.5, rising);
      p.fingerLCurl = 0.12;
      p.fingerRCurl = 0.12;
    } else if (activeBase === 'Crouch') {
      const moveAmt = stride.isMoving ? 1 : 0;
      const crouchBob = moveAmt * Math.abs(sp) * 0.026;
      p.hipsY = this._hipBindY - 0.36 + crouchBob;
      p.hipsX = moveAmt * cp * 0.025;
      p.hipsYaw = moveAmt * -cp * 0.1;
      p.hipsPitch = 0.16;
      p.torsoPitch = 0.34;
      p.torsoYaw = moveAmt * cp * 0.12;
      p.neckPitch = -0.22;
      p.headPitch = -0.24;
      p.headYaw = moveAmt ? -p.torsoYaw * 0.6 : this._glanceYaw * 0.7;
      p.clavLShrug = 0.05;
      p.clavRShrug = 0.05;
      // Stealthy compact arms tucked ready for balance
      p.armLPitch = -0.34 - moveAmt * cp * 0.25;
      p.armRPitch = -0.34 + moveAmt * cp * 0.25;
      p.armLRoll = 0.26;
      p.armRRoll = -0.26;
      p.forearmLPitch = -1.08;
      p.forearmRPitch = -1.08;
      p.fingerLCurl = 0.38;
      p.fingerRCurl = 0.38;
      p.browTilt = -0.12;
    } else if (activeBase === 'StreamWade') {
      const wadeBob = stride.isMoving ? Math.abs(sp) * 0.055 : Math.sin(elapsed * 1.4) * 0.012;
      p.hipsY = this._hipBindY - 0.065 + wadeBob;
      p.hipsX = stride.isMoving ? cp * 0.042 : Math.sin(elapsed * 1.1) * 0.015;
      p.hipsRoll = stride.isMoving ? cp * 0.075 : 0;
      p.hipsYaw = stride.isMoving ? -cp * 0.12 : 0;
      p.torsoPitch = 0.14 + (stride.isMoving ? 0.06 : 0);
      p.torsoRoll = stride.isMoving ? -cp * 0.09 : 0;
      p.torsoYaw = stride.isMoving ? cp * 0.15 : 0;
      p.headPitch = 0.12; // watches footing in rocky stream
      p.clavLShrug = 0.1;
      p.clavRShrug = 0.1;
      // Arms held slightly out and raised above water for balance
      const wadeArm = stride.isMoving ? cp * 0.28 : 0;
      p.armLPitch = -0.22 - wadeArm;
      p.armRPitch = -0.22 + wadeArm;
      p.armLRoll = 0.56 + clamp(loc.waterDepth * 0.25, 0, 0.25);
      p.armRRoll = -(0.56 + clamp(loc.waterDepth * 0.25, 0, 0.25));
      p.forearmLPitch = -0.92;
      p.forearmRPitch = -0.92;
      p.fingerLCurl = 0.1;
      p.fingerRCurl = 0.1;
    }

    // Override base posture slightly during panic Stage 3/4 calm-down stance
    if (this._panicActive && this._panicStage >= 3 && !stride.panicSprinting) {
      const s3Weight =
        this._panicStage === 3 ? 1.0 : 1.0 - smootherstep(6.5, 8.5, this._panicTimer);
      p.clavLShrug = lerp(p.clavLShrug, 0.24, s3Weight);
      p.clavRShrug = lerp(p.clavRShrug, 0.24, s3Weight);
      if (!stride.isMoving) {
        // Defensive jittery posture looking around at the grass
        p.hipsY = lerp(p.hipsY, this._hipBindY - 0.055, s3Weight);
        p.torsoPitch = lerp(p.torsoPitch, 0.14 + breath * 0.04, s3Weight);
        p.armLPitch = lerp(p.armLPitch, -0.45, s3Weight);
        p.armRPitch = lerp(p.armRPitch, -0.45, s3Weight);
        p.armLRoll = lerp(p.armLRoll, 0.34, s3Weight);
        p.armRRoll = lerp(p.armRRoll, -0.34, s3Weight);
        p.forearmLPitch = lerp(p.forearmLPitch, -1.18, s3Weight);
        p.forearmRPitch = lerp(p.forearmRPitch, -1.18, s3Weight);
        p.fingerLCurl = lerp(p.fingerLCurl, -0.06, s3Weight);
        p.fingerRCurl = lerp(p.fingerRCurl, -0.06, s3Weight);
      }
      p.jawOpen = Math.max(p.jawOpen, (0.14 + (breath * 0.5 + 0.5) * 0.12) * s3Weight);
      p.browHeight = Math.max(p.browHeight, 0.011 * s3Weight);
      p.browTilt = lerp(p.browTilt, 0.18, s3Weight);
      p.eyeWide = Math.max(p.eyeWide, 0.24 * s3Weight);
    }

    return p;
  }

  // ---------------------------------------------------------------------------
  // High-Frequency Expressive Overlays (RatPanicShake 4 Stages, Slip, Thunder)
  // ---------------------------------------------------------------------------

  _computeExpressiveOverlays(dt, elapsed, loc, pendingFootsteps) {
    const ov = {
      hipsX: 0,
      hipsY: 0,
      hipsZ: 0,
      hipsPitch: 0,
      hipsYaw: 0,
      hipsRoll: 0,
      torsoPitch: 0,
      torsoYaw: 0,
      torsoRoll: 0,
      neckPitch: 0,
      neckYaw: 0,
      headPitch: 0,
      headYaw: 0,
      headRoll: 0,
      clavLShrug: 0,
      clavRShrug: 0,
      // Additive or override arm channels (blend 0..1 overrides smoothed arm angles crisply)
      armOverrideWeight: 0,
      armLPitch: 0,
      armLRoll: 0,
      armLYaw: 0,
      forearmLPitch: 0,
      wristLPitch: 0,
      wristLRoll: 0,
      fingerLCurl: 0,
      armRPitch: 0,
      armRRoll: 0,
      armRYaw: 0,
      forearmRPitch: 0,
      wristRPitch: 0,
      wristRRoll: 0,
      fingerRCurl: 0,
      // Additive shiver micro-tremors (Stage 3-4)
      shiverWrist: 0,
      shiverForearm: 0,
      shiverShoulder: 0,
      shiverKnee: 0,
      // Facial additive overrides
      jawOpen: 0,
      browHeight: 0,
      browTilt: 0,
      eyeWide: 0,
      eyeSquint: 0,
      eyeYaw: 0,
      eyePitch: 0,
      // Leg IK weight targets & FK overrides
      ikTargetL: loc.grounded ? 1.0 : 0.0,
      ikTargetR: loc.grounded ? 1.0 : 0.0,
      panicShakeLeg: null, // { side, thighX, thighY, thighZ, shinX, ankleX, ankleZ }
      slipKick: 0,
    };

    // 1. Thunder Flinch (0.85s): shoulder hunch toward ears, knee flinch, head whips up toward sky
    if (this._thunderTimer >= 0) {
      const t = this._thunderTimer;
      const flinchSnap = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.16, 0.45, t));
      const skyLook = smoothstep(0.12, 0.24, t) * (1.0 - smoothstep(0.56, 0.85, t));
      const hunchHold = smoothstep(0.0, 0.07, t) * (1.0 - smoothstep(0.42, 0.85, t));

      ov.hipsY -= 0.095 * flinchSnap;
      ov.torsoPitch += 0.14 * flinchSnap - 0.08 * skyLook;
      ov.clavLShrug += 0.42 * hunchHold;
      ov.clavRShrug += 0.42 * hunchHold;
      ov.neckPitch += 0.12 * flinchSnap - 0.24 * skyLook;
      ov.headPitch += 0.08 * flinchSnap - 0.56 * skyLook;
      ov.headYaw += Math.sin(t * 7.5) * 0.22 * skyLook;
      ov.eyeSquint += 0.48 * flinchSnap;
      ov.eyeWide += 0.22 * skyLook;
      ov.browHeight += 0.01 * skyLook;
      ov.jawOpen += 0.18 * (flinchSnap + skyLook * 0.5);

      if (flinchSnap > 0.05) {
        ov.armOverrideWeight = Math.max(ov.armOverrideWeight, flinchSnap * 0.85);
        ov.armLPitch = -0.35;
        ov.armRPitch = -0.35;
        ov.armLRoll = 0.44;
        ov.armRRoll = -0.44;
        ov.forearmLPitch = -1.42;
        ov.forearmRPitch = -1.42;
        ov.fingerLCurl = 0.65;
        ov.fingerRCurl = 0.65;
      }
    }

    // 2. Slip Recovery (1.2s): feet kick forward, torso pitches dramatically back, arms windmill rapidly!
    if (this._slipTimer >= 0) {
      const t = this._slipTimer;
      const kickEnv = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.45, 0.88, t));
      const millEnv = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.72, 1.2, t));
      const snapBack = smoothstep(0.52, 0.82, t) * (1.0 - smoothstep(0.95, 1.2, t));

      ov.slipKick = kickEnv;
      ov.hipsY -= 0.15 * kickEnv + 0.05 * snapBack;
      ov.hipsPitch -= 0.18 * kickEnv;
      ov.torsoPitch += -0.48 * kickEnv + 0.22 * snapBack;
      ov.torsoRoll += Math.sin(t * 14.0) * 0.14 * millEnv;
      ov.headPitch += 0.26 * kickEnv - 0.12 * snapBack;
      ov.clavLShrug += 0.34 * millEnv;
      ov.clavRShrug += 0.34 * millEnv;

      // Rapid counter-phase windmill arms!
      const millAngle = t * 18.0;
      ov.armOverrideWeight = Math.max(ov.armOverrideWeight, millEnv);
      ov.armLPitch = Math.sin(millAngle) * 1.45 - 0.45;
      ov.armRPitch = Math.sin(millAngle + Math.PI) * 1.45 - 0.45;
      ov.armLRoll = 0.85 + Math.cos(millAngle) * 0.52;
      ov.armRRoll = -(0.85 + Math.cos(millAngle + Math.PI) * 0.52);
      ov.forearmLPitch = -0.35 - Math.abs(Math.cos(millAngle)) * 0.35;
      ov.forearmRPitch = -0.35 - Math.abs(Math.cos(millAngle + Math.PI)) * 0.35;
      ov.fingerLCurl = -0.22;
      ov.fingerRCurl = -0.22;

      // Wide eyes & open-mouthed surprise
      ov.eyeWide += 0.34 * millEnv;
      ov.browHeight += 0.014 * millEnv;
      ov.browTilt += 0.22 * millEnv;
      ov.jawOpen += 0.44 * millEnv;

      // Slipping foot briefly kicks forward off ground
      ov.ikTargetL = Math.min(ov.ikTargetL, 1.0 - kickEnv * 0.85);
      ov.ikTargetR = Math.min(ov.ikTargetR, 1.0 - kickEnv * 0.35);
    }

    // 3. 4-Stage RatPanicShake (0.0 .. 8.5s)
    if (this._panicActive) {
      const pt = this._panicTimer;
      const sAff = this._panicSide === 'L' ? 1 : -1;

      if (this._panicStage === 1) {
        // STAGE 1 (0.0s - 0.4s): Electro-Shock Flinch!
        const u = clamp(pt / 0.4, 0, 1);
        const shockEnv = smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.82, 1.0, u) * 0.25);
        const hopArc = Math.sin(u * Math.PI);

        // Instantaneous backward torso jolt + involuntary mini-hop
        ov.hipsY += 0.17 * hopArc;
        ov.hipsPitch -= 0.12 * shockEnv;
        ov.torsoPitch -= 0.42 * shockEnv;
        ov.neckPitch += 0.18 * shockEnv;
        ov.headPitch += 0.12 * shockEnv;

        // Shoulders rocket up to ears
        ov.clavLShrug += 0.5 * shockEnv;
        ov.clavRShrug += 0.5 * shockEnv;

        // Both arms fly wide out with fingers splayed wide open!
        ov.armOverrideWeight = 1.0;
        ov.armLPitch = -0.28 * shockEnv;
        ov.armRPitch = -0.28 * shockEnv;
        ov.armLRoll = 1.22 * shockEnv;
        ov.armRRoll = -1.22 * shockEnv;
        ov.armLYaw = 0.25 * shockEnv;
        ov.armRYaw = -0.25 * shockEnv;
        ov.forearmLPitch = -0.52 * shockEnv;
        ov.forearmRPitch = -0.52 * shockEnv;
        ov.wristLPitch = -0.35 * shockEnv;
        ov.wristRPitch = -0.35 * shockEnv;
        ov.fingerLCurl = -0.32; // wide splayed horror fingers
        ov.fingerRCurl = -0.32;

        // Maximal facial terror: spiked brows, wide peeled eyelids, dropped jaw
        ov.browHeight = 0.016 * shockEnv;
        ov.browTilt = 0.28 * shockEnv;
        ov.eyeWide = 0.36 * shockEnv;
        ov.jawOpen = 0.54 * shockEnv;

        // Both legs briefly leave ground during involuntary shock mini-hop
        const airFade = clamp(1.0 - hopArc * 1.45, 0, 1);
        ov.ikTargetL = Math.min(ov.ikTargetL, airFade);
        ov.ikTargetR = Math.min(ov.ikTargetR, airFade);

        // Trigger shock landing thud at end of Stage 1
        if (u > 0.92 && this._prevHopSin <= 0.92) {
          pendingFootsteps.push({ side: this._panicSide === 'L' ? 'R' : 'L', intensity: 0.65 });
        }
        this._prevHopSin = u;
      } else if (this._panicStage === 2) {
        // STAGE 2 (0.4s - 2.4s): Frantic Leg-Shake & Brush-Off OR Panicked Sprint!
        const stageT = pt - 0.4; // 0.0 .. 2.0s

        if (loc.panickedSprint) {
          // Ungainly panicked sprint with flailing arms waving wildly overhead & sideways!
          const w1 = Math.sin(elapsed * 13.8);
          const w2 = Math.cos(elapsed * 14.7);
          ov.clavLShrug += 0.36;
          ov.clavRShrug += 0.36;
          ov.torsoRoll += Math.sin(elapsed * 11.5) * 0.14;
          ov.headPitch += 0.18 + Math.sin(elapsed * 9.0) * 0.14;
          ov.headYaw += Math.sin(elapsed * 8.2) * 0.28;

          ov.armOverrideWeight = 1.0;
          ov.armLPitch = -1.75 + w1 * 0.62;
          ov.armRPitch = -1.75 - w2 * 0.62;
          ov.armLRoll = 1.32 + w2 * 0.44;
          ov.armRRoll = -(1.32 + w1 * 0.44);
          ov.forearmLPitch = -0.58 + Math.sin(elapsed * 17.5) * 0.42;
          ov.forearmRPitch = -0.58 + Math.cos(elapsed * 18.2) * 0.42;
          ov.wristLPitch = Math.sin(elapsed * 22.0) * 0.5;
          ov.wristRPitch = Math.cos(elapsed * 23.0) * 0.5;
          ov.fingerLCurl = -0.28;
          ov.fingerRCurl = -0.28;

          ov.browHeight = 0.015;
          ov.browTilt = 0.26;
          ov.eyeWide = 0.35;
          ov.jawOpen = 0.48;
        } else {
          // Standing awkward hop on opposite leg + 14 Hz violent leg-shake + 8 Hz frantic brush-off!
          const env =
            smoothstep(0.0, 0.08, stageT) *
            (1.0 - smoothstep(1.82, 2.0, stageT)) *
            (0.62 + 0.38 * Math.exp(-stageT * 0.4));

          // Awkward frantic hop on standing leg
          const hop = Math.abs(Math.sin(stageT * 4.2 * Math.PI));
          ov.hipsY += -0.075 + hop * 0.072;
          ov.hipsX += -sAff * 0.055; // shift weight cleanly over standing leg
          ov.hipsRoll += -sAff * 0.12;
          ov.hipsYaw += sAff * 0.16;

          // Bent steeply forward staring straight down in horror at affected shin
          ov.torsoPitch += 0.52;
          ov.torsoYaw += sAff * 0.26;
          ov.torsoRoll += -sAff * 0.08;
          ov.neckPitch += 0.28;
          ov.headPitch += 0.46;
          ov.headYaw += sAff * 0.18;
          ov.clavLShrug += 0.34;
          ov.clavRShrug += 0.34;

          // 14 Hz damped sinusoidal tremor across hip, knee, and ankle of affected leg!
          const tremor14 = Math.sin(stageT * 14.0 * TWO_PI) * env;
          const tremor14Quad = Math.cos(stageT * 14.0 * TWO_PI) * env;

          if (this._panicSide === 'L') {
            ov.ikTargetL = 0.0;
            ov.ikTargetR = loc.grounded ? 1.0 : 0.0;
          } else {
            ov.ikTargetR = 0.0;
            ov.ikTargetL = loc.grounded ? 1.0 : 0.0;
          }

          ov.panicShakeLeg = {
            side: this._panicSide,
            thighX: -0.72 + tremor14 * 0.24,
            thighY: sAff * 0.14 + tremor14 * 0.22,
            thighZ: sAff * 0.22 + tremor14Quad * 0.16,
            shinX: clamp(0.62 + tremor14 * 0.36, 0.1, 1.55),
            ankleX: 0.18 + tremor14Quad * 0.42,
            ankleZ: tremor14 * 0.34,
          };

          // Both hands frantically slap / brush downward at affected shin (~8 Hz alternating swipes!)
          const swipePhase = stageT * 8.0 * TWO_PI;
          const swipeL = Math.sin(swipePhase);
          const swipeR = Math.sin(swipePhase + Math.PI);

          ov.armOverrideWeight = 1.0;
          // Reach down & across toward affected side shin
          ov.armLPitch = -0.95 + swipeL * 0.36;
          ov.armRPitch = -0.95 + swipeR * 0.36;
          ov.armLRoll = (sAff > 0 ? 0.18 : -0.26) + swipeL * 0.18;
          ov.armRRoll = (sAff < 0 ? -0.18 : 0.26) + swipeR * 0.18;
          ov.armLYaw = (sAff > 0 ? -0.25 : -0.58) + swipeL * 0.16;
          ov.armRYaw = (sAff < 0 ? 0.25 : 0.58) + swipeR * 0.16;
          ov.forearmLPitch = -0.62 - Math.max(0, -swipeL) * 0.52;
          ov.forearmRPitch = -0.62 - Math.max(0, -swipeR) * 0.52;
          ov.wristLPitch = swipeL * 0.52;
          ov.wristRPitch = swipeR * 0.52;
          ov.wristLRoll = swipeL * 0.25;
          ov.wristRRoll = swipeR * 0.25;
          ov.fingerLCurl = -0.24;
          ov.fingerRCurl = -0.24;

          // Locked-wide terror face looking straight down at shin
          ov.browHeight = 0.015;
          ov.browTilt = 0.28;
          ov.eyeWide = 0.35;
          ov.eyePitch = 0.24;
          ov.jawOpen = 0.48 + Math.abs(swipeL) * 0.08;
        }
      } else {
        // STAGE 3 (2.4s - 6.5s) Residual Shivering & Paranoid Look-Around
        // STAGE 4 (6.5s - 8.5s) Gradual Recovery
        const decay =
          this._panicStage === 3 ? 1.0 : 1.0 - smootherstep(6.5, 8.5, pt);

        // 20 Hz high-frequency nervous shivering micro-tremor across wrists, forearms, knees, shoulders
        const shivA = Math.sin(elapsed * 20.0 * TWO_PI);
        const shivB = Math.sin(elapsed * 21.1 * TWO_PI + 1.2);
        const shivC = Math.sin(elapsed * 19.3 * TWO_PI + 2.4);

        ov.shiverWrist = shivA * 0.095 * decay;
        ov.shiverForearm = shivB * 0.048 * decay;
        ov.shiverShoulder = shivC * 0.042 * decay;
        ov.shiverKnee = shivA * 0.036 * decay;
        ov.hipsY += shivB * 0.004 * decay; // subtle knee-quiver vertical tremor with feet grounded!

        // Panicked sprint arms if user sprints during Stage 3
        if (loc.panickedSprint && this._panicStage === 3) {
          const w1 = Math.sin(elapsed * 13.0);
          const w2 = Math.cos(elapsed * 14.0);
          ov.armOverrideWeight = 0.9;
          ov.armLPitch = -1.55 + w1 * 0.52;
          ov.armRPitch = -1.55 - w2 * 0.52;
          ov.armLRoll = 1.15 + w2 * 0.35;
          ov.armRRoll = -(1.15 + w1 * 0.35);
          ov.forearmLPitch = -0.62 + w2 * 0.32;
          ov.forearmRPitch = -0.62 + w1 * 0.32;
          ov.fingerLCurl = -0.22;
          ov.fingerRCurl = -0.22;
        }

        // Sharp paranoid left / right / down grass-checking snaps during Stage 3
        const stepIdx = Math.floor((pt - 2.4) / 0.62);
        const lookTable = [
          { y: 0.68, p: 0.25 },   // sharp left
          { y: -0.72, p: 0.28 },  // sharp right
          { y: 0.05, p: 0.62 },   // straight down at boots
          { y: -0.52, p: 0.48 },  // down-right grass
          { y: 0.62, p: 0.44 },   // down-left grass
          { y: 0.0, p: 0.58 },    // check boots again
          { y: -0.66, p: 0.18 },  // sharp right behind shoulder
        ];
        const targetLook = lookTable[((stepIdx % lookTable.length) + lookTable.length) % lookTable.length];
        const snapRate = 1.0 - Math.exp(-dt * 17.5);
        this._paranoidYaw = lerp(this._paranoidYaw, targetLook.y * decay, snapRate);
        this._paranoidPitch = lerp(this._paranoidPitch, targetLook.p * decay, snapRate);

        ov.headYaw += this._paranoidYaw * 0.72;
        ov.neckYaw += this._paranoidYaw * 0.28;
        ov.headPitch += this._paranoidPitch * 0.7;
        ov.neckPitch += this._paranoidPitch * 0.3;
        ov.eyeYaw += (targetLook.y * decay - this._paranoidYaw) * 0.55;
        ov.eyePitch += (targetLook.p * decay - this._paranoidPitch) * 0.45;
      }
    }

    return ov;
  }

  // ---------------------------------------------------------------------------
  // Upper Body, Arms, Hands & Expressive Facial Rig Application
  // ---------------------------------------------------------------------------

  _applyUpperBodyAndFace(dt, elapsed, loc, stride, ov, landingComp) {
    const b = this.bones;
    const s = this._smooth;
    const breath = Math.sin(this._breathPhase);

    // 1. Hips base transform (vertical terrain IK offset applied in _applyLegsAndFootIK)
    b.hips.position.x = s.hipsX + (ov.hipsX ?? 0);
    b.hips.position.z = this._hipsBaseZ + s.hipsZ;
    b.hips.rotation.set(
      s.hipsPitch + ov.hipsPitch + Math.max(0, -landingComp) * 0.45,
      s.hipsYaw + ov.hipsYaw,
      s.hipsRoll + ov.hipsRoll
    );

    // 2. Distribute torso bend/twist organically across spine1 -> spine2 -> chest
    const totalTorsoPitch = s.torsoPitch + ov.torsoPitch + Math.max(0, -landingComp) * 0.65;
    const totalTorsoYaw = s.torsoYaw + ov.torsoYaw;
    const totalTorsoRoll = s.torsoRoll + ov.torsoRoll;

    b.spine1.rotation.set(totalTorsoPitch * 0.34, totalTorsoYaw * 0.25, totalTorsoRoll * 0.34);
    b.spine2.rotation.set(totalTorsoPitch * 0.36, totalTorsoYaw * 0.35, totalTorsoRoll * 0.34);
    b.chest.rotation.set(
      totalTorsoPitch * 0.3 + breath * 0.018,
      totalTorsoYaw * 0.4,
      totalTorsoRoll * 0.32
    );

    // Subtle organic ribcage chest expansion with breathing
    const breathAmp =
      loc.exhausted || (this._panicActive && this._panicStage >= 2)
        ? 0.036
        : 0.014 + (1 - loc.staminaRatio) * 0.018;
    const chestScaleXZ = 1.0 + breath * breathAmp;
    b.chest.scale.set(chestScaleXZ, 1.0, 1.0 + breath * breathAmp * 1.25);

    // 3. Neck & Head (supporting optional First-Person / camera look overrides)
    let neckPitch = s.neckPitch + ov.neckPitch;
    let neckYaw = s.neckYaw + ov.neckYaw;
    let headPitch = s.headPitch + ov.headPitch;
    let headYaw = s.headYaw + ov.headYaw;

    if (loc.headPitchOverride !== null) {
      const clampedPitch = clamp(loc.headPitchOverride, -1.1, 1.1);
      neckPitch = clampedPitch * 0.32 + ov.neckPitch * 0.5;
      headPitch = clampedPitch * 0.68 + ov.headPitch * 0.5;
    }
    if (loc.headYawOverride !== null) {
      const clampedYaw = clamp(loc.headYawOverride, -1.25, 1.25);
      neckYaw = clampedYaw * 0.35 + ov.neckYaw * 0.5;
      headYaw = clampedYaw * 0.65 + ov.headYaw * 0.5;
    }

    // Add head inertial follow-through lag from secondary springs
    b.neck.rotation.set(neckPitch, neckYaw, 0);
    b.head.rotation.set(
      headPitch + this._springs.headLagPitch.value,
      headYaw + this._springs.headLagYaw.value,
      s.headRoll + ov.headRoll + this._springs.headLagRoll.value
    );

    // 4. Expressive face: eyes, eyelids (blinking + wide terror + squint), eyebrows, jaw
    let blinkAmt = 0;
    if (this._blinkProgress >= 0) {
      const u = clamp(this._blinkProgress / this._blinkDuration, 0, 1);
      blinkAmt = Math.sin(u * Math.PI);
    }

    const eyeWide = clamp(s.eyeWide + ov.eyeWide, 0, 0.42);
    const eyeSquint = clamp(s.eyeSquint + ov.eyeSquint, 0, 0.55);
    const upperLidAngle = blinkAmt * 0.62 + eyeSquint * 0.22 - eyeWide * 0.85;
    const lowerLidAngle = -blinkAmt * 0.14 - eyeSquint * 0.16 + eyeWide * 0.55;

    b.upperLidL.rotation.x = clamp(upperLidAngle, -0.38, 0.65);
    b.upperLidR.rotation.x = clamp(upperLidAngle, -0.38, 0.65);
    b.lowerLidL.rotation.x = clamp(lowerLidAngle, -0.22, 0.28);
    b.lowerLidR.rotation.x = clamp(lowerLidAngle, -0.22, 0.28);

    const eyeYaw = clamp(s.eyeYaw + ov.eyeYaw, -0.35, 0.35);
    const eyePitch = clamp(s.eyePitch + ov.eyePitch, -0.28, 0.32);
    b.eyeL.rotation.set(eyePitch, eyeYaw, 0);
    b.eyeR.rotation.set(eyePitch, eyeYaw, 0);

    const browH = clamp(s.browHeight + ov.browHeight, -0.007, 0.018);
    const browT = clamp(s.browTilt + ov.browTilt, -0.32, 0.34);
    b.browL.position.y = this._browBaseY + browH;
    b.browR.position.y = this._browBaseY + browH;
    // Inner-up horror vs inner-down furrowed brow tilt
    b.browL.rotation.z = -browT;
    b.browR.rotation.z = browT;

    const jawOpen = clamp(s.jawOpen + ov.jawOpen, 0, 0.58);
    b.jaw.rotation.x = jawOpen;

    // 5. Clavicles, Arms, Wrists & Articulated Fingers (clenched sprint fists vs splayed panic hands)
    const shivS = ov.shiverShoulder;
    const shivF = ov.shiverForearm;
    const shivW = ov.shiverWrist;

    b.clavicleL.rotation.set(0, 0, clamp(s.clavLShrug + ov.clavLShrug + shivS, -0.15, 0.55));
    b.clavicleR.rotation.set(0, 0, clamp(-(s.clavRShrug + ov.clavRShrug) - shivS, -0.55, 0.15));

    const w = clamp(ov.armOverrideWeight, 0, 1);

    const armLP = lerp(s.armLPitch, ov.armLPitch, w);
    const armLR = lerp(s.armLRoll, ov.armLRoll, w);
    const armLY = lerp(s.armLYaw, ov.armLYaw, w);
    const foreLP = lerp(s.forearmLPitch, ov.forearmLPitch, w) + shivF;
    const wristLP = lerp(s.wristLPitch, ov.wristLPitch, w) + shivW;
    const wristLR = lerp(s.wristLRoll, ov.wristLRoll, w) + shivW * 0.7;
    const fingerLC = clamp(lerp(s.fingerLCurl, ov.fingerLCurl, w), -0.35, 1.45);

    const armRP = lerp(s.armRPitch, ov.armRPitch, w);
    const armRR = lerp(s.armRRoll, ov.armRRoll, w);
    const armRY = lerp(s.armRYaw, ov.armRYaw, w);
    const foreRP = lerp(s.forearmRPitch, ov.forearmRPitch, w) - shivF;
    const wristRP = lerp(s.wristRPitch, ov.wristRPitch, w) - shivW;
    const wristRR = lerp(s.wristRRoll, ov.wristRRoll, w) - shivW * 0.7;
    const fingerRC = clamp(lerp(s.fingerRCurl, ov.fingerRCurl, w), -0.35, 1.45);

    b.upperArmL.rotation.set(armLP, armLY, armLR);
    b.forearmL.rotation.set(clamp(foreLP, -2.15, -0.04), 0, 0);
    b.wristL.rotation.set(wristLP, s.wristLYaw, wristLR);
    // Left palm faces -X, so negative Z curls fingers inward into a fist; positive Z splays open!
    b.fingersL.rotation.set(0, 0, -fingerLC);

    b.upperArmR.rotation.set(armRP, armRY, armRR);
    b.forearmR.rotation.set(clamp(foreRP, -2.15, -0.04), 0, 0);
    b.wristR.rotation.set(wristRP, s.wristRYaw, wristRR);
    // Right palm faces +X, so positive Z curls fingers inward into a fist; negative Z splays open!
    b.fingersR.rotation.set(0, 0, fingerRC);
  }

  // ---------------------------------------------------------------------------
  // Analytical 2-Bone Leg IK + Slope-Aligned Boots + Seamless FK Blending
  // ---------------------------------------------------------------------------

  _applyLegsAndFootIK(dt, elapsed, loc, baseLocoState, stride, ov, landingComp) {
    const b = this.bones;

    // Smoothly blend per-leg Foot IK weight (0 during airborne Jump / RatPanicShake Stage 2 shake, 1 grounded)
    const ikFadeIn = 1.0 - Math.exp(-dt * 14.0);
    const ikFadeOut = 1.0 - Math.exp(-dt * 22.0);
    this._ikWeightL = lerp(
      this._ikWeightL,
      ov.ikTargetL,
      ov.ikTargetL > this._ikWeightL ? ikFadeIn : ikFadeOut
    );
    this._ikWeightR = lerp(
      this._ikWeightR,
      ov.ikTargetR,
      ov.ikTargetR > this._ikWeightR ? ikFadeIn : ikFadeOut
    );

    // 1. Compute desired local foot XZ targets for each leg
    let fxLocalL = stride.left.x;
    let fzLocalL = stride.left.z;
    let liftL = stride.left.lift;
    let anklePitchL = stride.left.anklePitch;
    let toeBendL = stride.left.toeBend;

    let fxLocalR = stride.right.x;
    let fzLocalR = stride.right.z;
    let liftR = stride.right.lift;
    let anklePitchR = stride.right.anklePitch;
    let toeBendR = stride.right.toeBend;

    // SkidStop overrides foot placement (lead heel planted forward, rear leg braced low behind)
    if (baseLocoState === 'SkidStop' && !this._panicActive) {
      if (this._skidLeadSide === 'L') {
        fxLocalL = this._hipOffsetX + 0.04;
        fzLocalL = 0.34;
        anklePitchL = -0.26;
        fxLocalR = -this._hipOffsetX - 0.05;
        fzLocalR = -0.24;
        anklePitchR = 0.24;
        toeBendR = -0.35;
      } else {
        fxLocalR = -this._hipOffsetX - 0.04;
        fzLocalR = 0.34;
        anklePitchR = -0.26;
        fxLocalL = this._hipOffsetX + 0.05;
        fzLocalL = -0.24;
        anklePitchL = 0.24;
        toeBendL = -0.35;
      }
      liftL = 0;
      liftR = 0;
    }

    // 2. Transform desired local foot XZ into world space, sample terrain height & surface normal!
    this._footLocalL.set(fxLocalL, 0, fzLocalL);
    this._footLocalR.set(fxLocalR, 0, fzLocalR);

    this._footWorldL.copy(this._footLocalL).applyMatrix4(this.rig.root.matrixWorld);
    this._footWorldR.copy(this._footLocalR).applyMatrix4(this.rig.root.matrixWorld);

    const groundYL = this._sampleGroundHeight(this._footWorldL.x, this._footWorldL.z, this._rootPos.y);
    const groundYR = this._sampleGroundHeight(this._footWorldR.x, this._footWorldR.z, this._rootPos.y);
    this._sampleGroundNormal(this._footWorldL.x, this._footWorldL.z, this._normalWorldL);
    this._sampleGroundNormal(this._footWorldR.x, this._footWorldR.z, this._normalWorldR);

    // Convert terrain surface normals into character-root local space
    this._normalLocalL.copy(this._normalWorldL).applyQuaternion(this._invRootQuat).normalize();
    this._normalLocalR.copy(this._normalWorldR).applyQuaternion(this._invRootQuat).normalize();

    // Sole world targets (clamped relative to rootY so stepping near extreme cliffs never breaks rig)
    const relGroundL = clamp(groundYL - this._rootPos.y, -0.42, 0.36);
    const relGroundR = clamp(groundYR - this._rootPos.y, -0.42, 0.36);

    // Ankle joint sits `_soleOffsetY` (0.06m) above sole along the sloped surface normal
    const soleLiftL = Math.max(this._normalLocalL.y, 0.65) * this._soleOffsetY;
    const soleLiftR = Math.max(this._normalLocalR.y, 0.65) * this._soleOffsetY;

    this._ankleTargetL.set(
      fxLocalL + this._normalLocalL.x * 0.025,
      relGroundL + liftL + soleLiftL,
      fzLocalL + this._normalLocalL.z * 0.025
    );
    this._ankleTargetR.set(
      fxLocalR + this._normalLocalR.x * 0.025,
      relGroundR + liftR + soleLiftR,
      fzLocalR + this._normalLocalR.z * 0.025
    );

    // 3. Dynamically adjust pelvis vertical offset on steep hills/banks so neither grounded leg overextends!
    const desiredBaseHipsY = this._smooth.hipsY + ov.hipsY + landingComp;
    const baseHipSocketY = desiredBaseHipsY + this._thighOffsetY;

    const computeNeededDrop = (ankleTarget, weight, sideSign) => {
      if (weight < 0.05) return 0;
      const dx = ankleTarget.x - (b.hips.position.x + sideSign * this._hipOffsetX);
      const dz = ankleTarget.z - b.hips.position.z;
      const horizSq = dx * dx + dz * dz;
      const maxVert = Math.sqrt(Math.max(0.06, this._maxLegReach * this._maxLegReach - horizSq));
      const maxAllowedSocketY = ankleTarget.y + maxVert;
      const drop = Math.min(0, maxAllowedSocketY - baseHipSocketY);
      return drop * weight;
    };

    const dropL = computeNeededDrop(this._ankleTargetL, this._ikWeightL, 1);
    const dropR = computeNeededDrop(this._ankleTargetR, this._ikWeightR, -1);
    const targetTerrainDrop = clamp(Math.min(dropL, dropR), -0.44, 0.0);

    const dropFollow = 1.0 - Math.exp(-dt * 18.0);
    this._smoothedTerrainHipDrop = lerp(this._smoothedTerrainHipDrop, targetTerrainDrop, dropFollow);

    // Enforce exact hard reach floor on the current frame so downhill boot NEVER floats even mid-transition
    const effectiveDrop = Math.min(this._smoothedTerrainHipDrop, targetTerrainDrop);
    b.hips.position.y = Math.max(0.32, desiredBaseHipsY + effectiveDrop);

    // Precompute hips local matrix & inverse once so both legs solve in exact hips-local space
    b.hips.updateMatrix();
    this._hipsLocalMat.copy(b.hips.matrix);
    this._invHipsLocalMat.copy(this._hipsLocalMat).invert();
    this._hipsQuat.setFromEuler(b.hips.rotation);

    // 4. Compute procedural FK fallback poses for airborne Jump, SlipRecovery kick, and RatPanicShake Stage 2!
    const fkL = this._computeFKLegPose('L', elapsed, loc, ov);
    const fkR = this._computeFKLegPose('R', elapsed, loc, ov);

    // 5. Solve analytical 2-bone IK for each leg and blend cleanly with FK via ikWeight!
    this._solveLegIK('L', this._ankleTargetL, this._normalLocalL, anklePitchL, this._ikWeightL, fkL, ov.shiverKnee);
    this._solveLegIK('R', this._ankleTargetR, this._normalLocalR, anklePitchR, this._ikWeightR, fkR, -ov.shiverKnee);

    // 6. Articulated forefoot toe pitch (bend cleanly upward on push-off, relax in air)
    b.toeL.rotation.set(toeBendL * this._ikWeightL, 0, 0);
    b.toeR.rotation.set(toeBendR * this._ikWeightR, 0, 0);
  }

  _computeFKLegPose(side, elapsed, loc, ov) {
    const s = side === 'L' ? 1 : -1;

    // Stage 2 RatPanicShake violent 14 Hz leg shake on affected side
    if (ov.panicShakeLeg && ov.panicShakeLeg.side === side) {
      return {
        thighX: ov.panicShakeLeg.thighX,
        thighY: ov.panicShakeLeg.thighY,
        thighZ: ov.panicShakeLeg.thighZ,
        shinX: ov.panicShakeLeg.shinX,
        ankleX: ov.panicShakeLeg.ankleX,
        ankleY: 0,
        ankleZ: ov.panicShakeLeg.ankleZ,
      };
    }

    // Stage 1 Electro-Shock involuntary mini-hop tuck
    if (this._panicActive && this._panicStage === 1) {
      return {
        thighX: -0.42,
        thighY: s * 0.08,
        thighZ: s * 0.14,
        shinX: 0.78,
        ankleX: 0.25,
        ankleY: 0,
        ankleZ: 0,
      };
    }

    // SlipRecovery comedic forward foot kick
    if (ov.slipKick > 0.05) {
      const lead = side === 'L' ? 1.0 : 0.45;
      return {
        thighX: -0.78 * ov.slipKick * lead,
        thighY: s * 0.06,
        thighZ: s * 0.12 * ov.slipKick,
        shinX: 0.24 * ov.slipKick,
        ankleX: -0.25 * ov.slipKick,
        ankleY: 0,
        ankleZ: 0,
      };
    }

    // Jump: launch extension vs mid-air athletic tuck
    const rising = smoothstep(-0.5, 4.0, loc.verticalVel);
    const airSway = Math.sin(elapsed * 5.2 + (side === 'L' ? 0 : Math.PI)) * 0.08;
    const thighX = lerp(-0.62, -0.18, rising) + (side === 'L' ? -0.14 : 0.12) + airSway;
    const shinX = lerp(1.12, 0.34, rising) + (side === 'L' ? 0.12 : -0.08);
    const ankleX = lerp(0.24, 0.38, rising);

    return {
      thighX,
      thighY: s * 0.05,
      thighZ: s * 0.08,
      shinX: Math.max(0.06, shinX),
      ankleX,
      ankleY: 0,
      ankleZ: 0,
    };
  }

  /**
   * Exact analytical 2-bone law-of-cosines leg IK solver with hip roll compensation,
   * hips-rotation invariance, and terrain surface normal boot alignment.
   */
  _solveLegIK(side, ankleTargetRootLocal, terrainNormalRootLocal, strideAnklePitch, ikWeight, fkPose, shiverKnee = 0) {
    const thigh = this.bones[`thigh${side}`];
    const shin = this.bones[`shin${side}`];
    const ankle = this.bones[`ankle${side}`];
    const s = side === 'L' ? 1 : -1;

    // Build FK quaternions first
    this._tmpEuler.set(fkPose.thighX, fkPose.thighY, fkPose.thighZ, 'ZXY');
    this._fkThighQuat.setFromEuler(this._tmpEuler);
    this._tmpEulerXYZ.set(fkPose.shinX, 0, 0, 'XYZ');
    this._fkShinQuat.setFromEuler(this._tmpEulerXYZ);
    this._tmpEulerXYZ.set(fkPose.ankleX, fkPose.ankleY, fkPose.ankleZ, 'XYZ');
    this._fkAnkleQuat.setFromEuler(this._tmpEulerXYZ);

    if (ikWeight <= 0.001) {
      thigh.quaternion.copy(this._fkThighQuat);
      shin.quaternion.copy(this._fkShinQuat);
      ankle.quaternion.copy(this._fkAnkleQuat);
      return;
    }

    // 1. Transform desired ankle position from root space into hips-local space, then subtract thigh origin
    const V = this._tmpVecA
      .copy(ankleTargetRootLocal)
      .applyMatrix4(this._invHipsLocalMat)
      .sub(thigh.position);

    const vx = V.x;
    const vy = Math.min(V.y, -0.05); // keep ankle strictly below hip socket
    const vz = V.z;

    // 2. Solve lateral roll (ZXY order: Rz(roll) * Rx(hipPitch) maps sagittal plane cleanly to V)
    const hipRoll = clamp(Math.atan2(vx, -vy), -0.62, 0.62);
    const ySag = -Math.hypot(vx, vy);
    const zSag = vz;

    // 3. Analytical Law of Cosines in the sagittal plane
    const L1 = this._thighLen;
    const L2 = this._shinLen;
    const dist = clamp(Math.hypot(ySag, zSag), 0.14, this._maxLegReach);

    // Exterior knee flexion angle (0 = straight, +PI/2 = 90 deg backward bend)
    const cosKnee = clamp((dist * dist - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1);
    const kneeAngle = clamp(Math.acos(cosKnee), 0.04, 2.38);

    // Interior thigh elevation angle ahead of target chord
    const cosBeta = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
    const beta = Math.acos(cosBeta);
    const targetAngle = Math.atan2(zSag, -ySag);
    // Negative X pitch swings downward limb forward (+Z)
    const hipPitch = clamp(-(targetAngle + beta), -2.05, 1.35);

    // Natural slight outward toe/knee turn + Stage 3 nervous 20 Hz knee micro-quiver (preserves ground contact!)
    const kneeTurnY = s * 0.05 + shiverKnee;

    this._tmpEuler.set(hipPitch, kneeTurnY, hipRoll, 'ZXY');
    this._ikThighQuat.setFromEuler(this._tmpEuler);

    this._tmpEulerXYZ.set(kneeAngle, 0, 0, 'XYZ');
    this._ikShinQuat.setFromEuler(this._tmpEulerXYZ);

    // 4. Align boot sole flush with terrain surface normal in root space!
    const up = this._tmpVecB.copy(terrainNormalRootLocal).normalize();
    // Forward direction (+Z) projected onto terrain tangent plane
    const fwd = this._tmpVecC.set(s * 0.04, 0, 1).addScaledVector(up, -up.z);
    if (fwd.lengthSq() < 1e-5) {
      fwd.set(0, 0, 1);
    } else {
      fwd.normalize();
    }
    // Orthonormal basis: +X = Left = up x fwd, +Y = up, +Z = fwd
    const left = this._tmpVecA.crossVectors(up, fwd).normalize();
    fwd.crossVectors(left, up).normalize();

    this._basisMat.makeBasis(left, up, fwd);
    this._desiredFootQuat.setFromRotationMatrix(this._basisMat);

    // Layer heel-strike / toe-off pitch locally onto terrain-aligned boot orientation
    if (Math.abs(strideAnklePitch) > 1e-4) {
      this._pitchOffsetQuat.setFromAxisAngle(this._xAxis, clamp(strideAnklePitch, -0.5, 0.55));
      this._desiredFootQuat.multiply(this._pitchOffsetQuat);
    }

    // Shin orientation in root space = hipsQuat * ikThighQuat * ikShinQuat
    this._shinInRootQuat
      .copy(this._hipsQuat)
      .multiply(this._ikThighQuat)
      .multiply(this._ikShinQuat);

    this._ikAnkleQuat.copy(this._shinInRootQuat).invert().multiply(this._desiredFootQuat);

    // 5. Blend seamlessly between FK and IK using ikWeight
    if (ikWeight >= 0.999) {
      thigh.quaternion.copy(this._ikThighQuat);
      shin.quaternion.copy(this._ikShinQuat);
      ankle.quaternion.copy(this._ikAnkleQuat);
    } else {
      thigh.quaternion.copy(this._fkThighQuat).slerp(this._ikThighQuat, ikWeight);
      shin.quaternion.copy(this._fkShinQuat).slerp(this._ikShinQuat, ikWeight);
      ankle.quaternion.copy(this._fkAnkleQuat).slerp(this._ikAnkleQuat, ikWeight);
    }
  }

  // ---------------------------------------------------------------------------
  // Secondary Spring-Damper Physics (Backpack, Canteen Pendulum, Jacket Hem, Head Lag)
  // ---------------------------------------------------------------------------

  _applySecondaryPhysics(dt, elapsed, loc, ov) {
    const b = this.bones;
    const sp = this._springs;

    // Linear & vertical accelerations driving realistic inertia
    const horizAccel = clamp((loc.speed - this._prevSpeed) / dt, -18, 18);
    const currHipsY = b.hips.position.y;
    const hipsVelY = clamp((currHipsY - this._prevHipsY) / dt, -8, 8);
    const hipsAccelY = clamp((hipsVelY - this._prevHipsVelY) / dt, -35, 35);
    this._prevHipsY = currHipsY;
    this._prevHipsVelY = hipsVelY;

    const panicRattle =
      this._panicActive && (this._panicStage === 1 || this._panicStage === 2)
        ? Math.sin(elapsed * 14.0 * TWO_PI) * 0.25
        : 0;

    // 1. Backpack spring-damper bounce & tilt
    const packTargetPitch = clamp(-horizAccel * 0.015 - loc.speed * 0.014, -0.22, 0.22) + panicRattle * 0.16;
    const packTargetRoll = clamp(loc.turnRate * 0.055 + loc.lateralSpeed * 0.025, -0.22, 0.22);
    const packTargetBounce = clamp(-hipsAccelY * 0.0018, -0.04, 0.04);

    const bpPitch = sp.backpackPitch.step(dt, packTargetPitch);
    const bpRoll = sp.backpackRoll.step(dt, packTargetRoll);
    const bpBounce = sp.backpackBounce.step(dt, packTargetBounce);

    b.backpack.position.y = 0.04 + bpBounce;
    b.backpack.rotation.set(bpPitch, 0, bpRoll);

    // 2. Hanging aluminum canteen swinging pendulum lag
    const cantDrivePitch = clamp(-horizAccel * 0.048 - loc.speed * 0.036 - hipsVelY * 0.12 + panicRattle * 1.4, -0.7, 0.7);
    const cantDriveRoll = clamp(
      loc.turnRate * 0.16 + loc.lateralSpeed * 0.06 + Math.sin(this._stridePhase) * clamp(loc.speed / 5, 0, 1) * 0.22 + panicRattle * 1.1,
      -0.7,
      0.7
    );
    const cPitch = sp.canteenPitch.step(dt, cantDrivePitch);
    const cRoll = sp.canteenRoll.step(dt, cantDriveRoll);
    b.canteen.rotation.set(cPitch, 0, cRoll);

    // 3. Lower jacket hem trailing flare (streams behind runner, flares on skids/jumps/turns)
    const hemTargetPitch = clamp(
      loc.forwardSpeed * 0.042 - horizAccel * 0.015 + (loc.grounded ? 0 : 0.24) + Math.abs(ov.hipsY) * 0.5,
      -0.25,
      0.48
    );
    const hemTargetRoll = clamp(loc.turnRate * 0.08 + loc.lateralSpeed * 0.035, -0.32, 0.32);
    const hPitch = sp.jacketHemPitch.step(dt, hemTargetPitch);
    const hRoll = sp.jacketHemRoll.step(dt, hemTargetRoll);
    b.jacketHem.rotation.set(hPitch, 0, hRoll);

    // 4. Head inertial follow-through lag (applied next frame smoothly onto head bone)
    sp.headLagPitch.step(dt, clamp(-horizAccel * 0.009 - hipsAccelY * 0.0025, -0.18, 0.18));
    sp.headLagYaw.step(dt, clamp(-loc.turnRate * 0.04, -0.2, 0.2));
    sp.headLagRoll.step(dt, clamp(loc.turnRate * 0.025, -0.14, 0.14));
  }
}
