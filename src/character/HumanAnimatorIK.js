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
 * Emote definitions for playable character expressions.
 */
const EMOTE_DEFS = {
  1: { id: 1, name: 'EmoteWave', duration: 2.6 },
  2: { id: 2, name: 'EmoteWarmHands', duration: 3.6 },
  3: { id: 3, name: 'EmoteCompass', duration: 3.2 },
  4: { id: 4, name: 'EmoteVictory', duration: 3.4 },
};

const EMOTE_NAME_MAP = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  emotewave: 1,
  wave: 1,
  emotewarmhands: 2,
  warmhands: 2,
  warm: 2,
  emotecompass: 3,
  compass: 3,
  emotevictory: 4,
  victory: 4,
};

const PARANOID_LOOK_TABLE = [
  { y: 0.68, p: 0.25 }, // sharp left
  { y: -0.72, p: 0.28 }, // sharp right
  { y: 0.05, p: 0.62 }, // straight down at boots
  { y: -0.52, p: 0.48 }, // down-right grass
  { y: 0.62, p: 0.44 }, // down-left grass
  { y: 0.0, p: 0.58 }, // check boots again
  { y: -0.66, p: 0.18 }, // sharp right behind shoulder
];

/**
 * Full procedural locomotion, swimming/diving, playable emotes, emotional expression,
 * secondary spring-damper physics, and analytical 2-bone terrain-conforming Foot IK
 * animator for all character rigs.
 *
 * Supported states:
 *   'Idle', 'Walk', 'Jog', 'FullSprint', 'SkidStop', 'Jump', 'Crouch',
 *   'StreamWade', 'SwimTread', 'SwimStroke', 'SwimSprint', 'SwimDive',
 *   'EmoteWave', 'EmoteWarmHands', 'EmoteCompass', 'EmoteVictory',
 *   'SlipRecovery', 'ThunderFlinch', 'RatPanicShake' (4 stages)
 */
export class HumanAnimatorIK {
  constructor(humanRig, surfaceProvider = null) {
    this.rig = humanRig;
    this.terrain = surfaceProvider;
    this.surfaceSolver =
      surfaceProvider && typeof surfaceProvider.sampleSurface === 'function'
        ? surfaceProvider
        : null;
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
    this._swimPhase = 0;
    this._prevPhaseL = 0;
    this._prevPhaseR = Math.PI;
    this._wasGrounded = true;
    this._wasSwimming = false;
    this._prevSpeed = 0;
    this._prevVertVel = 0;
    this._prevHipsY = this._hipBindY;
    this._prevHipsVelY = 0;
    this._skidLeadSide = 'L';

    // Smooth Foot IK & contact shadow blend weights (0 = airborne/swimming/shaking, 1 = full ground IK)
    this._ikWeightL = 1.0;
    this._ikWeightR = 1.0;
    this._swimShadowWeight = 1.0;
    this._smoothedTerrainHipDrop = 0.0;

    // Expressive one-shot / multi-stage timers
    this._slipTimer = -1;
    this._slipDuration = 1.2;

    this._thunderTimer = -1;
    this._thunderDuration = 0.85;

    // Playable character emote state (1..4)
    this._emoteId = 0;
    this._emoteName = null;
    this._emoteTimer = -1;
    this._emoteDuration = 0;

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
      hairLocksPitch: new SpringDamper({ stiffness: 54, damping: 5.2, maxVal: 0.38 }),
      hairLocksRoll: new SpringDamper({ stiffness: 50, damping: 4.8, maxVal: 0.34 }),
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

    // Pre-allocated per-frame scratch structs (zero GC churn per frame)
    this._locScratch = {
      speed: 0,
      maxSprintSpeed: 7.5,
      forwardSpeed: 0,
      lateralSpeed: 0,
      grounded: true,
      verticalVel: 0,
      crouching: false,
      wading: false,
      waterDepth: 0,
      swimming: false,
      swimMode: 'none',
      submerged: false,
      verticalSwimVel: 0,
      skidding: false,
      exhausted: false,
      staminaRatio: 1.0,
      turnRate: 0,
      isSprinting: false,
      panickedSprint: false,
      windIntensity: 0,
      headPitchOverride: null,
      headYawOverride: null,
    };

    this._footstepPool = [
      { side: 'L', intensity: 0 },
      { side: 'R', intensity: 0 },
      { side: 'L', intensity: 0 },
      { side: 'R', intensity: 0 },
    ];
    this._pendingFootstepCount = 0;

    this._leftFootScratch = { x: 0, z: 0, lift: 0, swing: 0, anklePitch: 0, toeBend: 0 };
    this._rightFootScratch = { x: 0, z: 0, lift: 0, swing: 0, anklePitch: 0, toeBend: 0 };
    this._strideScratch = {
      isMoving: false,
      panicSprinting: false,
      speedRatio: 0,
      strideLen: 1.44,
      stanceDuty: 0.5,
      stepHeight: 0,
      stanceWidth: this._hipOffsetX,
      phase: 0,
      sinPhase: 0,
      cosPhase: 1,
      left: this._leftFootScratch,
      right: this._rightFootScratch,
    };

    this._targetPoseScratch = { ...this._smooth };
    this._panicLegScratch = {
      side: 'R',
      thighX: 0,
      thighY: 0,
      thighZ: 0,
      shinX: 0,
      ankleX: 0,
      ankleZ: 0,
    };
    this._overlayScratch = {
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
      shiverWrist: 0,
      shiverForearm: 0,
      shiverShoulder: 0,
      shiverKnee: 0,
      jawOpen: 0,
      browHeight: 0,
      browTilt: 0,
      eyeWide: 0,
      eyeSquint: 0,
      eyeYaw: 0,
      eyePitch: 0,
      ikTargetL: 1.0,
      ikTargetR: 1.0,
      panicShakeLeg: null,
      slipKick: 0,
    };
    this._fkLegLScratch = { thighX: 0, thighY: 0, thighZ: 0, shinX: 0, ankleX: 0, ankleY: 0, ankleZ: 0 };
    this._fkLegRScratch = { thighX: 0, thighY: 0, thighZ: 0, shinX: 0, ankleX: 0, ankleY: 0, ankleZ: 0 };

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
    this._shadowPosL = new THREE.Vector3();
    this._shadowPosR = new THREE.Vector3();
    this._shadowNormL = new THREE.Vector3(0, 1, 0);
    this._shadowNormR = new THREE.Vector3(0, 1, 0);
  }

  // ---------------------------------------------------------------------------
  // Public Event Triggers, Emotes & Queries
  // ---------------------------------------------------------------------------

  setSurfaceSolver(solver) {
    this.surfaceSolver =
      solver && typeof solver.sampleSurface === 'function' ? solver : null;
    if (solver && !this.terrain) {
      this.terrain = solver;
    }
  }

  triggerSlip() {
    this._slipTimer = 0.0;
    this.cancelEmote();
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
    this.cancelEmote();
  }

  playEmote(id) {
    if (this._panicActive || this._slipTimer >= 0) return false;
    const key = typeof id === 'string' ? id.trim().toLowerCase() : String(id);
    const resolvedId = EMOTE_NAME_MAP[key];
    const def = resolvedId ? EMOTE_DEFS[resolvedId] : null;
    if (!def) return false;

    this._emoteId = def.id;
    this._emoteName = def.name;
    this._emoteTimer = 0.0;
    this._emoteDuration = def.duration;
    return true;
  }

  cancelEmote() {
    this._emoteId = 0;
    this._emoteName = null;
    this._emoteTimer = -1;
    this._emoteDuration = 0;
  }

  getActiveEmote() {
    if (!this._emoteName || this._emoteTimer < 0) return null;
    return {
      id: this._emoteId,
      name: this._emoteName,
      timer: this._emoteTimer,
      duration: this._emoteDuration,
      progress: clamp(this._emoteTimer / Math.max(this._emoteDuration, 0.001), 0, 1),
    };
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

  _pushPendingFootstep(side, intensity) {
    if (this._pendingFootstepCount >= this._footstepPool.length) return;
    const slot = this._footstepPool[this._pendingFootstepCount++];
    slot.side = side;
    slot.intensity = intensity;
  }

  // ---------------------------------------------------------------------------
  // Terrain & SurfaceSolver Sampling Helpers (Null-Safe & NaN-Safe)
  // ---------------------------------------------------------------------------

  _sampleFootSurface(x, z, referenceY = 0, outNormal = this._tmpVecA) {
    const provider = this.surfaceSolver || this.terrain;
    if (provider && typeof provider.sampleSurface === 'function') {
      outNormal.set(0, 1, 0);
      const res = provider.sampleSurface(x, z, referenceY, outNormal);
      let y = referenceY;
      if (typeof res === 'number') {
        if (Number.isFinite(res)) y = res;
      } else if (res && typeof res === 'object') {
        if (Number.isFinite(res.y)) {
          y = res.y;
        } else if (Number.isFinite(res.height)) {
          y = res.height;
        }
        if (
          res.normal &&
          Number.isFinite(res.normal.x) &&
          Number.isFinite(res.normal.y) &&
          Number.isFinite(res.normal.z) &&
          res.normal.lengthSq() > 1e-6
        ) {
          outNormal.copy(res.normal);
        }
      }
      if (
        Number.isFinite(outNormal.x) &&
        Number.isFinite(outNormal.y) &&
        Number.isFinite(outNormal.z) &&
        outNormal.lengthSq() > 1e-6
      ) {
        outNormal.normalize();
      } else {
        outNormal.set(0, 1, 0);
      }
      return y;
    }

    const h = this._sampleGroundHeight(x, z, referenceY);
    this._sampleGroundNormal(x, z, outNormal);
    return h;
  }

  _sampleGroundHeight(x, z, fallbackY = 0) {
    const provider = this.surfaceSolver || this.terrain;
    if (provider && typeof provider.sampleSurface === 'function') {
      const res = provider.sampleSurface(x, z, fallbackY, this._tmpVecA);
      if (typeof res === 'number' && Number.isFinite(res)) return res;
      if (res && typeof res === 'object') {
        if (Number.isFinite(res.y)) return res.y;
        if (Number.isFinite(res.height)) return res.height;
      }
    }
    if (this.terrain && typeof this.terrain.getHeightAt === 'function') {
      const h = this.terrain.getHeightAt(x, z);
      if (Number.isFinite(h)) return h;
    }
    return fallbackY;
  }

  _sampleGroundNormal(x, z, target) {
    const provider = this.surfaceSolver || this.terrain;
    if (provider && typeof provider.sampleSurface === 'function') {
      target.set(0, 1, 0);
      const res = provider.sampleSurface(x, z, this._rootPos ? this._rootPos.y : 0, target);
      if (
        res &&
        typeof res === 'object' &&
        res.normal &&
        Number.isFinite(res.normal.x) &&
        Number.isFinite(res.normal.y) &&
        Number.isFinite(res.normal.z) &&
        res.normal.lengthSq() > 1e-6
      ) {
        target.copy(res.normal);
      }
      if (
        Number.isFinite(target.x) &&
        Number.isFinite(target.y) &&
        Number.isFinite(target.z) &&
        target.lengthSq() > 1e-6
      ) {
        return target.normalize();
      }
    }
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

    // Sanitize locomotion state inputs into pre-allocated scratch object (zero GC)
    const loc = this._locScratch;
    const rawSwimMode =
      typeof locomotionState?.swimMode === 'string' ? locomotionState.swimMode.toLowerCase() : 'none';
    const swimMode =
      rawSwimMode === 'tread' || rawSwimMode === 'stroke' || rawSwimMode === 'sprint' || rawSwimMode === 'dive'
        ? rawSwimMode
        : 'none';
    const swimming = Boolean(locomotionState?.swimming) || swimMode !== 'none';

    loc.speed = Number.isFinite(locomotionState?.speed) ? Math.max(0, locomotionState.speed) : 0;
    loc.maxSprintSpeed =
      Number.isFinite(locomotionState?.maxSprintSpeed) && locomotionState.maxSprintSpeed > 0.5
        ? locomotionState.maxSprintSpeed
        : 7.5;
    loc.forwardSpeed = Number.isFinite(locomotionState?.forwardSpeed)
      ? locomotionState.forwardSpeed
      : (locomotionState?.speed ?? 0);
    loc.lateralSpeed = Number.isFinite(locomotionState?.lateralSpeed) ? locomotionState.lateralSpeed : 0;
    loc.grounded = locomotionState?.grounded !== false;
    loc.verticalVel = Number.isFinite(locomotionState?.verticalVel) ? locomotionState.verticalVel : 0;
    loc.crouching = Boolean(locomotionState?.crouching);
    loc.wading = Boolean(locomotionState?.wading);
    loc.waterDepth = Number.isFinite(locomotionState?.waterDepth) ? clamp(locomotionState.waterDepth, 0, 2.5) : 0;
    loc.swimming = swimming;
    loc.swimMode = swimMode;
    loc.submerged = Boolean(locomotionState?.submerged) || swimMode === 'dive';
    loc.verticalSwimVel = Number.isFinite(locomotionState?.verticalSwimVel)
      ? clamp(locomotionState.verticalSwimVel, -6, 6)
      : 0;
    loc.skidding = Boolean(locomotionState?.skidding);
    loc.exhausted = Boolean(locomotionState?.exhausted);
    loc.staminaRatio = Number.isFinite(locomotionState?.staminaRatio) ? clamp(locomotionState.staminaRatio, 0, 1) : 1.0;
    loc.turnRate = Number.isFinite(locomotionState?.turnRate) ? clamp(locomotionState.turnRate, -8, 8) : 0;
    loc.isSprinting = Boolean(locomotionState?.isSprinting);
    loc.panickedSprint = Boolean(locomotionState?.panickedSprint);
    loc.windIntensity = Number.isFinite(locomotionState?.windIntensity)
      ? clamp(locomotionState.windIntensity, 0, 4.5)
      : 0;
    loc.headPitchOverride = Number.isFinite(locomotionState?.headPitchOverride) ? locomotionState.headPitchOverride : null;
    loc.headYawOverride = Number.isFinite(locomotionState?.headYawOverride) ? locomotionState.headYawOverride : null;

    // Ensure root world matrix reflects any controller position/yaw update before IK
    this.rig.root.updateMatrixWorld(true);
    this.rig.root.matrixWorld.decompose(this._rootPos, this._rootQuat, this._rootScale);
    this._invRootMat.copy(this.rig.root.matrixWorld).invert();
    this._invRootQuat.copy(this._rootQuat).invert();

    // Advance one-shot, emote & multi-stage expressive timers
    this._pendingFootstepCount = 0;
    this._advanceTimers(safeDt, safeElapsed, loc);

    // Detect Jump -> Grounded landing compression & double-foot thud (skip when exiting water)
    if (!this._wasGrounded && loc.grounded && !loc.swimming && !this._wasSwimming) {
      const impact = clamp(Math.abs(Math.min(this._prevVertVel, 0)) / 9.0, 0.25, 1.0);
      this._springs.landingBounce.impulse(-2.8 * impact);
      this._springs.backpackBounce.impulse(-0.65 * impact);
      this._springs.canteenPitch.impulse(3.2 * impact);
      this._springs.hairLocksPitch.impulse(-1.4 * impact);
      this._pushPendingFootstep('L', clamp(0.55 + impact * 0.45, 0.4, 1.0));
      this._pushPendingFootstep('R', clamp(0.55 + impact * 0.45, 0.4, 1.0));
    }

    // Track which leg leads when entering SkidStop
    if (loc.skidding && this._stateName !== 'SkidStop') {
      this._skidLeadSide = this._prevPhaseL < Math.PI ? 'L' : 'R';
    }

    // Resolve active state name
    const baseLocoState = this._resolveBaseLocomotionState(loc);
    this._stateName = this._resolveActiveState(baseLocoState);

    // Advance continuous swimming cycle phase when swimming
    if (loc.swimming) {
      let swimHz = 1.35;
      if (baseLocoState === 'SwimTread') {
        swimHz = 1.45;
      } else if (baseLocoState === 'SwimStroke') {
        swimHz = lerp(0.95, 1.42, clamp(loc.speed / 3.0, 0, 1));
      } else if (baseLocoState === 'SwimSprint') {
        swimHz = lerp(1.55, 2.25, clamp(loc.speed / 4.8, 0, 1));
      } else if (baseLocoState === 'SwimDive') {
        swimHz = lerp(0.85, 1.32, clamp(Math.hypot(loc.speed, loc.verticalSwimVel) / 3.5, 0, 1));
      }
      this._swimPhase = (this._swimPhase + safeDt * swimHz * TWO_PI) % (TWO_PI * 100);
    }

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
    const stride = this._computeStridePlan(safeDt, safeElapsed, loc, baseLocoState);

    // Compute target upper-body & facial posture for the active state (including swim & emotes)
    const targetPose = this._computeTargetPose(safeDt, safeElapsed, loc, baseLocoState, stride);

    // Smoothly blend base pose parameters (crisp athletic tracking on cyclic limb/pelvis channels, smooth posture transitions)
    const blendRate = 1.0 - Math.exp(-safeDt * 13.5);
    const cyclicRate = 1.0 - Math.exp(-safeDt * 30.0);
    const faceBlendRate = 1.0 - Math.exp(-safeDt * 18.0);
    for (const key in this._smooth) {
      let rate = blendRate;
      if (
        key === 'jawOpen' ||
        key === 'browHeight' ||
        key === 'browTilt' ||
        key === 'eyeWide' ||
        key === 'eyeSquint' ||
        key === 'eyeYaw' ||
        key === 'eyePitch'
      ) {
        rate = faceBlendRate;
      } else if (
        key === 'hipsY' ||
        key === 'hipsX' ||
        key === 'hipsYaw' ||
        key === 'hipsRoll' ||
        key === 'torsoYaw' ||
        key === 'torsoRoll' ||
        key === 'armLPitch' ||
        key === 'armRPitch' ||
        key === 'armLRoll' ||
        key === 'armRRoll' ||
        key === 'forearmLPitch' ||
        key === 'forearmRPitch' ||
        key === 'wristLPitch' ||
        key === 'wristRPitch' ||
        key === 'wristLRoll' ||
        key === 'wristRRoll'
      ) {
        rate = cyclicRate;
      }
      this._smooth[key] = lerp(this._smooth[key], targetPose[key], rate);
    }

    // Update landing compression spring
    const landingComp = this._springs.landingBounce.step(safeDt, 0);

    // Compute additive high-frequency expressive overlays (14Hz shake, 8Hz swipes, 20Hz shiver, shock flinch, blink)
    const overlay = this._computeExpressiveOverlays(safeDt, safeElapsed, loc);

    // Apply spine, torso, head, eyes, eyelids, brows, jaw, and arm/5-finger hand poses
    this._applyUpperBodyAndFace(safeDt, safeElapsed, loc, stride, overlay, landingComp);

    // Compute FK leg poses + analytical 2-bone surface-conforming Foot IK
    this._applyLegsAndFootIK(safeDt, safeElapsed, loc, baseLocoState, stride, overlay, landingComp);

    // Update secondary spring-damper physics (backpack, hanging canteen, jacket hem, hair locks, head lag)
    this._applySecondaryPhysics(safeDt, safeElapsed, loc, overlay);

    // Drive cloth simulation (Archer cloak & Ronin coat billowing smoothly with speed & wind)
    this.rig.setClothMotion?.(loc.speed, loc.windIntensity, safeElapsed);

    // Refresh world transforms so eyeTarget, bones, and foot positions are exact this frame
    this.rig.root.updateMatrixWorld(true);

    // Fade boot contact shadows smoothly to 0 while swimming, blending cleanly back to 1 when grounded/wading
    const shadowTarget = loc.swimming ? 0.0 : 1.0;
    const shadowRate = 1.0 - Math.exp(-safeDt * (loc.swimming ? 20.0 : 14.0));
    this._swimShadowWeight = lerp(this._swimShadowWeight, shadowTarget, shadowRate);
    if (loc.swimming && this._swimShadowWeight < 0.02) {
      this._swimShadowWeight = 0.0;
    }

    // Query exact boot sole world coordinates & update soft ground contact-shadow decals every frame
    this.rig.getFootWorldPositions(this._finalFootL, this._finalFootR);
    if (typeof this.rig.updateContactShadows === 'function') {
      const surfYL = this._sampleFootSurface(
        this._finalFootL.x,
        this._finalFootL.z,
        this._rootPos.y,
        this._shadowNormL
      );
      const surfYR = this._sampleFootSurface(
        this._finalFootR.x,
        this._finalFootR.z,
        this._rootPos.y,
        this._shadowNormR
      );
      this._shadowPosL.set(this._finalFootL.x, surfYL, this._finalFootL.z);
      this._shadowPosR.set(this._finalFootR.x, surfYR, this._finalFootR.z);
      const swimLiftPenalty = (1.0 - this._swimShadowWeight) * 0.48;
      const liftL = Math.max(0, this._finalFootL.y - surfYL) + swimLiftPenalty;
      const liftR = Math.max(0, this._finalFootR.y - surfYR) + swimLiftPenalty;
      this.rig.updateContactShadows(
        this._shadowPosL,
        this._shadowNormL,
        liftL,
        this._shadowPosR,
        this._shadowNormR,
        liftR
      );
    }

    // Emit crisp footstep callbacks with exact updated boot sole world coordinates
    if (typeof onFootstep === 'function' && this._pendingFootstepCount > 0) {
      for (let i = 0; i < this._pendingFootstepCount; i++) {
        const ev = this._footstepPool[i];
        const pos = ev.side === 'L' ? this._finalFootL.clone() : this._finalFootR.clone();
        onFootstep({
          side: ev.side,
          worldPos: pos,
          intensity: clamp(ev.intensity, 0.05, 1.0),
        });
      }
    }

    this._wasGrounded = loc.grounded;
    this._wasSwimming = loc.swimming;
    this._prevSpeed = loc.speed;
    this._prevVertVel = loc.verticalVel;
  }

  // ---------------------------------------------------------------------------
  // Timers & State Resolution
  // ---------------------------------------------------------------------------

  _advanceTimers(dt, elapsed, loc) {
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
            this._pushPendingFootstep(standSide, 0.55);
          }
          this._prevHopSin = hopSin;
        }
      } else if (this._panicTimer < 6.5) {
        this._panicStage = 3;
      } else {
        this._panicStage = 4;
      }
    }

    // Playable Emote progression & smooth auto-cancel on movement/jump/crouch/swim/slip/panic
    if (this._emoteName && this._emoteTimer >= 0) {
      const shouldCancelEmote =
        loc.speed > 0.35 ||
        !loc.grounded ||
        loc.crouching ||
        loc.swimming ||
        loc.skidding ||
        this._slipTimer >= 0 ||
        this._panicActive;
      if (shouldCancelEmote) {
        this.cancelEmote();
      } else {
        this._emoteTimer += dt;
        if (this._emoteTimer >= this._emoteDuration) {
          this.cancelEmote();
        }
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
    if (loc.swimming) {
      if (loc.swimMode === 'dive' || (loc.swimMode === 'none' && loc.submerged)) return 'SwimDive';
      if (loc.swimMode === 'sprint' || (loc.swimMode === 'none' && (loc.isSprinting || loc.speed >= 3.2))) {
        return 'SwimSprint';
      }
      if (loc.swimMode === 'stroke' || (loc.swimMode === 'none' && loc.speed >= 0.35)) {
        return 'SwimStroke';
      }
      return 'SwimTread';
    }
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
    if (this._emoteName) return this._emoteName;
    return baseLocoState;
  }

  // ---------------------------------------------------------------------------
  // Procedural Distance-Locked Stride Cycle & Zero-Slide Foot Trajectory Planning
  // ---------------------------------------------------------------------------

  _computeStridePlan(dt, elapsed, loc, baseLocoState) {
    const speedRatio = clamp(loc.speed / loc.maxSprintSpeed, 0, 1.25);
    const panicSprinting =
      this._panicActive && loc.panickedSprint && loc.grounded && !loc.swimming && loc.speed > 0.4;
    const isMoving =
      loc.grounded &&
      !loc.swimming &&
      !loc.skidding &&
      loc.speed >= 0.18 &&
      !(this._panicActive && (this._panicStage === 1 || (this._panicStage === 2 && !loc.panickedSprint)));

    let strideLen = 1.44;
    let stanceDuty = 0.5;
    let stepHeight = 0.0;
    let stanceWidth = this._hipOffsetX;
    const isSprintGait = baseLocoState === 'FullSprint' || panicSprinting;

    if (isMoving) {
      if (panicSprinting) {
        strideLen = lerp(1.82, 2.52, clamp(speedRatio, 0, 1));
        stanceDuty = 0.4;
        stepHeight = 0.25 + 0.04 * Math.abs(Math.sin(elapsed * 7.1));
        stanceWidth = this._hipOffsetX + 0.048;
      } else if (baseLocoState === 'StreamWade') {
        strideLen = 1.28;
        stanceDuty = 0.5;
        stepHeight = 0.24 + clamp(loc.waterDepth, 0, 0.75) * 0.16;
        stanceWidth = this._hipOffsetX + 0.04;
      } else if (baseLocoState === 'Crouch') {
        strideLen = 1.05;
        stanceDuty = 0.5;
        stepHeight = 0.08;
        stanceWidth = this._hipOffsetX + 0.025;
      } else if (baseLocoState === 'FullSprint') {
        const sprintT = clamp((loc.speed - 4.2) / Math.max(loc.maxSprintSpeed - 4.2, 1.8), 0, 1);
        strideLen = lerp(2.05, 2.72, sprintT);
        stanceDuty = lerp(0.44, 0.36, sprintT);
        stepHeight = lerp(0.18, 0.27, sprintT);
        stanceWidth = this._hipOffsetX - 0.008;
      } else if (baseLocoState === 'Jog') {
        const jogT = clamp((loc.speed - 2.55) / 1.65, 0, 1);
        strideLen = lerp(1.44, 2.05, jogT);
        stanceDuty = lerp(0.5, 0.44, jogT);
        stepHeight = lerp(0.105, 0.17, jogT);
        stanceWidth = this._hipOffsetX;
      } else {
        // Walk (1.44m stride)
        strideLen = 1.44;
        stanceDuty = 0.5;
        stepHeight = lerp(0.058, 0.1, clamp(loc.speed / 2.55, 0, 1));
        stanceWidth = this._hipOffsetX + 0.006;
      }

      // Lock stridePhase strictly to real horizontal travel distance so stance boots NEVER slide!
      const dirSign = loc.forwardSpeed < -0.25 ? -1 : 1;
      const dPhase = (loc.speed / Math.max(strideLen, 0.4)) * TWO_PI * dt * dirSign;
      this._stridePhase = (this._stridePhase + dPhase + TWO_PI * 10) % TWO_PI;

      const pL = this._stridePhase;
      const pR = (this._stridePhase + Math.PI) % TWO_PI;

      // Detect heel strike (phase crossing PI: swing -> stance)
      const stepIntensity = clamp(
        0.24 +
          speedRatio * 0.72 +
          (baseLocoState === 'StreamWade' ? 0.18 : 0) -
          (baseLocoState === 'Crouch' ? 0.15 : 0),
        0.15,
        1.0
      );
      if (dirSign > 0) {
        if (this._prevPhaseL < Math.PI && pL >= Math.PI) {
          this._pushPendingFootstep('L', stepIntensity);
        }
        if (this._prevPhaseR < Math.PI && pR >= Math.PI) {
          this._pushPendingFootstep('R', stepIntensity);
        }
      } else {
        if (this._prevPhaseL > Math.PI && pL <= Math.PI) {
          this._pushPendingFootstep('L', stepIntensity * 0.85);
        }
        if (this._prevPhaseR > Math.PI && pR <= Math.PI) {
          this._pushPendingFootstep('R', stepIntensity * 0.85);
        }
      }

      this._prevPhaseL = pL;
      this._prevPhaseR = pR;
    } else {
      this._prevPhaseL = this._stridePhase;
      this._prevPhaseR = (this._stridePhase + Math.PI) % TWO_PI;
    }

    const pL = this._stridePhase;
    const pR = (this._stridePhase + Math.PI) % TWO_PI;
    const strafeAmp = clamp(loc.lateralSpeed / Math.max(loc.maxSprintSpeed * 0.6, 2.0), -0.35, 0.35);

    const stanceAngle = TWO_PI * stanceDuty;
    const stanceEnd = Math.PI + stanceAngle;
    const swingAngle = Math.max(TWO_PI - stanceAngle, 0.001);
    // Exact contact sweep = strideLen * stanceDuty -> d(z_foot)/dt === -horizontalSpeed during stance!
    const halfSweep = strideLen * stanceDuty * 0.5;

    const evalFoot = (p, sideSign, out) => {
      if (!isMoving) {
        out.x = sideSign * stanceWidth;
        out.z = 0;
        out.lift = 0;
        out.swing = 0;
        out.anklePitch = 0;
        out.toeBend = 0;
        return out;
      }

      const inStance = p >= Math.PI && p < stanceEnd;
      let foreAftNorm;
      let lift = 0;
      let swing = 0;
      let anklePitch = 0;
      let toeBend = 0;

      if (inStance) {
        const stanceT = (p - Math.PI) / stanceAngle; // 0 = heel strike, 1 = toe-off
        foreAftNorm = 1.0 - 2.0 * stanceT;
        const strikeSettle = 1.0 - smoothstep(0.0, 0.2, stanceT);
        const pushOff = smoothstep(0.58, 1.0, stanceT);
        anklePitch = -strikeSettle * (isSprintGait ? 0.2 : 0.16) + pushOff * (isSprintGait ? 0.38 : 0.3);
        toeBend = -pushOff * (isSprintGait ? 0.46 : 0.4);
      } else {
        const rawSwing = p >= stanceEnd ? p - stanceEnd : p + (TWO_PI - stanceEnd);
        const swingT = clamp(rawSwing / swingAngle, 0, 1);
        const swingSin = Math.sin(swingT * Math.PI);
        // High knee drive shaping on swing leg during sprint
        const driveSin = isSprintGait ? Math.sin(Math.pow(swingT, 0.84) * Math.PI) : swingSin;
        lift = Math.pow(Math.max(0, driveSin), 1.08) * stepHeight;
        swing = swingSin;
        foreAftNorm = -Math.cos(swingT * Math.PI);

        // Crisp ankle dorsiflexion (toes lifted slightly upward -X) before heel strike!
        const strikePrep = smoothstep(0.52, 1.0, swingT);
        const toeDrag = smoothstep(0.0, 0.32, swingT) * (1.0 - strikePrep);
        anklePitch = toeDrag * 0.22 - strikePrep * (isSprintGait ? 0.32 : 0.24);
        toeBend = -toeDrag * 0.12;
      }

      out.x = sideSign * stanceWidth + foreAftNorm * strafeAmp * 0.25;
      out.z = foreAftNorm * halfSweep;
      out.lift = lift;
      out.swing = swing;
      out.anklePitch = anklePitch;
      out.toeBend = toeBend;
      return out;
    };

    evalFoot(pL, 1, this._leftFootScratch);
    evalFoot(pR, -1, this._rightFootScratch);

    const out = this._strideScratch;
    out.isMoving = isMoving;
    out.panicSprinting = panicSprinting;
    out.speedRatio = speedRatio;
    out.strideLen = strideLen;
    out.stanceDuty = stanceDuty;
    out.stepHeight = stepHeight;
    out.stanceWidth = stanceWidth;
    out.phase = this._stridePhase;
    out.sinPhase = Math.sin(this._stridePhase);
    out.cosPhase = Math.cos(this._stridePhase);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Base State Pose Synthesis (Locomotion, Swimming/Diving & Playable Emotes)
  // ---------------------------------------------------------------------------

  _computeTargetPose(dt, elapsed, loc, baseLocoState, stride) {
    const breath = Math.sin(this._breathPhase);
    const speedRatio = stride.speedRatio;
    const sp = stride.sinPhase;
    const cp = stride.cosPhase;

    // Reset pre-allocated target pose scratch to calm relaxed Idle posture (zero GC)
    const p = this._targetPoseScratch;
    p.hipsY = this._hipBindY - 0.015;
    p.hipsX = 0;
    p.hipsZ = 0;
    p.hipsPitch = 0.02;
    p.hipsYaw = 0;
    p.hipsRoll = 0;
    p.torsoPitch = 0.02 + breath * 0.012;
    p.torsoYaw = 0;
    p.torsoRoll = 0;
    p.neckPitch = -0.02;
    p.neckYaw = 0;
    p.headPitch = 0;
    p.headYaw = 0;
    p.headRoll = 0;
    p.clavLShrug = breath * 0.014;
    p.clavRShrug = breath * 0.014;
    p.armLPitch = 0.04;
    p.armLRoll = 0.11;
    p.armLYaw = 0.06;
    p.forearmLPitch = -0.22;
    p.wristLPitch = 0;
    p.wristLYaw = 0;
    p.wristLRoll = 0;
    p.fingerLCurl = 0.22;
    p.armRPitch = 0.04;
    p.armRRoll = -0.11;
    p.armRYaw = -0.06;
    p.forearmRPitch = -0.22;
    p.wristRPitch = 0;
    p.wristRYaw = 0;
    p.wristRRoll = 0;
    p.fingerRCurl = 0.22;
    p.jawOpen = 0;
    p.browHeight = 0;
    p.browTilt = 0;
    p.eyeWide = 0;
    p.eyeSquint = 0;
    p.eyeYaw = 0;
    p.eyePitch = 0;

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
      // Smooth 4° (0.070 rad) forward walk lean + double-frequency 2x inverted-pendulum bounce + stance hip drop
      const walkT = clamp(loc.speed / 2.2, 0, 1);
      const walkBounce2x = (0.5 - 0.5 * Math.cos(stride.phase * 2.0)) * 0.03;
      p.hipsY = this._hipBindY - 0.026 + walkBounce2x;
      p.hipsX = -sp * 0.02;
      p.hipsPitch = 0.0;
      p.hipsYaw = cp * 0.08;
      p.hipsRoll = sp * 0.036;
      p.torsoPitch = lerp(0.045, 0.07, walkT);
      p.torsoYaw = -cp * 0.14;
      p.torsoRoll = -p.hipsRoll * 1.05 + clamp(loc.turnRate * 0.06, -0.16, 0.16);
      p.neckPitch = -p.torsoPitch * 0.35;
      p.headPitch = -p.torsoPitch * 0.45;
      p.headYaw = -(p.hipsYaw + p.torsoYaw) * 0.78;

      // Counter-swinging arms (opposite phase to legs: when L leg is forward (cp < 0), L arm swings back (+X))
      const armSwing = 0.42 * clamp(loc.speed / 2.2, 0.35, 1.12);
      p.armLPitch = -cp * armSwing;
      p.armRPitch = cp * armSwing;
      p.armLRoll = 0.1;
      p.armRRoll = -0.1;
      p.forearmLPitch = -0.26 - Math.max(0, -p.armLPitch) * 0.55;
      p.forearmRPitch = -0.26 - Math.max(0, -p.armRPitch) * 0.55;
      p.fingerLCurl = 0.3;
      p.fingerRCurl = 0.3;
    } else if (activeBase === 'Jog') {
      // Smooth 4° -> 9° (0.070 -> 0.157 rad) jog lean + double-frequency 2x spring bounce + stance hip drop
      const jogT = clamp((loc.speed - 2.55) / 1.65, 0, 1);
      const jogBounce2x = (0.5 + 0.5 * Math.cos(stride.phase * 2.0 - 0.3)) * 0.052;
      p.hipsY = this._hipBindY - 0.052 + jogBounce2x;
      p.hipsX = -sp * 0.022;
      p.hipsPitch = 0.0;
      p.hipsYaw = cp * 0.11;
      p.hipsRoll = sp * 0.045;
      p.torsoPitch = lerp(0.07, 0.157, jogT);
      p.torsoYaw = -cp * 0.21;
      p.torsoRoll = -p.hipsRoll * 1.05 + clamp(loc.turnRate * 0.08, -0.22, 0.22);
      p.neckPitch = -p.torsoPitch * 0.42;
      p.headPitch = -p.torsoPitch * 0.48;
      p.headYaw = -(p.hipsYaw + p.torsoYaw) * 0.82;

      const armSwing = lerp(0.58, 0.78, jogT);
      p.armLPitch = -cp * armSwing - 0.05;
      p.armRPitch = cp * armSwing - 0.05;
      p.armLRoll = 0.13;
      p.armRRoll = -0.13;
      p.armLYaw = -0.12;
      p.armRYaw = 0.12;
      p.forearmLPitch = lerp(-1.12, -1.36, jogT) - clamp(-p.armLPitch, 0, 0.85) * 0.16;
      p.forearmRPitch = lerp(-1.12, -1.36, jogT) - clamp(-p.armRPitch, 0, 0.85) * 0.16;
      p.fingerLCurl = 0.85;
      p.fingerRCurl = 0.85;
      p.browTilt = -0.08;
      p.jawOpen = 0.06 + (1 - loc.staminaRatio) * 0.08;
    } else if (activeBase === 'FullSprint') {
      // Crisp 14° (0.244 rad) forward athletic torso lean blending smoothly from 9° jog,
      // 2x stridePhase pelvis vertical bounce, stance-side pelvic hip drop, ~16° (0.28 rad)
      // opposing chest/shoulder counter-rotation, and tight 90°-100° (1.57-1.74 rad) pumping elbows!
      const sprintT = clamp((loc.speed - 4.2) / Math.max(loc.maxSprintSpeed - 4.2, 1.8), 0, 1);
      const sprintBounce2x = (0.5 + 0.5 * Math.cos(stride.phase * 2.0 - 0.35)) * 0.068;
      p.hipsY = this._hipBindY - 0.074 + sprintBounce2x;
      p.hipsX = -sp * 0.024;
      p.hipsPitch = 0.0;
      p.hipsYaw = cp * 0.16;
      p.hipsRoll = sp * 0.062; // realistic slight pelvic hip drop on stance side
      p.torsoPitch = lerp(0.157, 0.244, sprintT); // crisp 14° (0.244 rad) at full sprint!
      p.torsoYaw = -cp * 0.32; // delivers ~16° (0.28 rad) opposing chest/shoulder counter-rotation at sprint cadence
      p.torsoRoll = -p.hipsRoll * 1.05 + clamp(loc.turnRate * 0.1, -0.26, 0.26);
      p.neckPitch = -p.torsoPitch * 0.44;
      p.headPitch = -p.torsoPitch * 0.48;
      p.headYaw = -(p.hipsYaw + p.torsoYaw) * 0.85;
      p.clavLShrug = 0.06;
      p.clavRShrug = 0.06;

      // Athletic front-to-back pumping arms with tight 90°-100° (1.57-1.74 rad) bent elbows!
      const armSwing = 1.02;
      p.armLPitch = -cp * armSwing - 0.1;
      p.armRPitch = cp * armSwing - 0.1;
      p.armLRoll = 0.14;
      p.armRRoll = -0.14;
      p.armLYaw = -0.16;
      p.armRYaw = 0.16;
      p.forearmLPitch = -1.59 - clamp(-p.armLPitch, 0, 1.15) * 0.125;
      p.forearmRPitch = -1.59 - clamp(-p.armRPitch, 0, 1.15) * 0.125;
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
      const crouchBob = moveAmt * (0.5 - 0.5 * Math.cos(stride.phase * 2.0)) * 0.026;
      p.hipsY = this._hipBindY - 0.36 + crouchBob;
      p.hipsX = moveAmt * -sp * 0.024;
      p.hipsYaw = moveAmt * cp * 0.1;
      p.hipsPitch = 0.16;
      p.torsoPitch = 0.34;
      p.torsoYaw = moveAmt * -cp * 0.12;
      p.neckPitch = -0.22;
      p.headPitch = -0.24;
      p.headYaw = moveAmt ? -(p.hipsYaw + p.torsoYaw) * 0.6 : this._glanceYaw * 0.7;
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
      const wadeBob = stride.isMoving
        ? (0.5 - 0.5 * Math.cos(stride.phase * 2.0)) * 0.052
        : Math.sin(elapsed * 1.4) * 0.012;
      p.hipsY = this._hipBindY - 0.065 + wadeBob;
      p.hipsX = stride.isMoving ? -sp * 0.042 : Math.sin(elapsed * 1.1) * 0.015;
      p.hipsRoll = stride.isMoving ? sp * 0.065 : 0;
      p.hipsYaw = stride.isMoving ? cp * 0.12 : 0;
      p.torsoPitch = 0.14 + (stride.isMoving ? 0.06 : 0);
      p.torsoRoll = stride.isMoving ? -p.hipsRoll * 1.1 : 0;
      p.torsoYaw = stride.isMoving ? -cp * 0.15 : 0;
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
    } else if (activeBase === 'SwimTread') {
      // Gentle buoyancy bobbing, upright ~8° torso, alternating outward sculling forearms & flat splayed palms
      const sw = this._swimPhase;
      const scullL = Math.sin(sw);
      const scullR = Math.sin(sw + Math.PI * 0.85);
      p.hipsY = this._hipBindY - 0.08 + Math.sin(elapsed * 2.15) * 0.044;
      p.hipsX = Math.sin(sw * 0.5) * 0.022;
      p.hipsPitch = 0.04;
      p.hipsRoll = Math.sin(sw) * 0.042;
      p.torsoPitch = 0.10; // combined hips + torso ~ 0.14 rad (~8° upright buoyancy tilt)
      p.torsoRoll = -p.hipsRoll * 0.65;
      p.torsoYaw = Math.cos(sw) * 0.06;
      p.neckPitch = -0.05;
      p.headPitch = -0.09 + Math.sin(elapsed * 1.4) * 0.025;
      p.headYaw = this._glanceYaw * 0.55;
      p.clavLShrug = 0.08;
      p.clavRShrug = 0.08;

      p.armLPitch = -0.52 + scullL * 0.24;
      p.armRPitch = -0.52 + scullR * 0.24;
      p.armLRoll = 0.72 + Math.cos(sw) * 0.28;
      p.armRRoll = -(0.72 + Math.cos(sw + Math.PI * 0.85) * 0.28);
      p.armLYaw = -0.24 + scullL * 0.34;
      p.armRYaw = 0.24 - scullR * 0.34;
      p.forearmLPitch = -0.82 - Math.max(0, scullL) * 0.26;
      p.forearmRPitch = -0.82 - Math.max(0, scullR) * 0.26;
      p.wristLPitch = Math.cos(sw) * 0.34;
      p.wristRPitch = Math.cos(sw + Math.PI * 0.85) * 0.34;
      p.wristLRoll = scullL * 0.36;
      p.wristRRoll = -scullR * 0.36;
      p.fingerLCurl = -0.18; // flat splayed sculling hands
      p.fingerRCurl = -0.18;
    } else if (activeBase === 'SwimStroke') {
      // Angled breaststroke (~62° = 1.08 rad forward pitch), wide synchronized sweeping arm pulls
      const sw = this._swimPhase;
      const c = Math.cos(sw);
      const s = Math.sin(sw);
      p.hipsY = this._hipBindY - 0.24 + Math.sin(sw - 0.45) * 0.052;
      p.hipsPitch = 0.90;
      p.torsoPitch = 0.18; // combined ~1.08 rad (~62°)
      p.hipsRoll = clamp(loc.turnRate * 0.08, -0.22, 0.22);
      p.torsoRoll = clamp(loc.turnRate * 0.06, -0.18, 0.18);
      p.neckPitch = -0.44;
      p.headPitch = -0.50 + Math.max(0, s) * 0.08; // keeps chin & eyes above surface
      p.clavLShrug = 0.12 - c * 0.06;
      p.clavRShrug = 0.12 - c * 0.06;

      // Synchronized breaststroke: forward glide (-2.50) -> wide outward sweep (roll ±1.32) -> chest tuck (-0.94)
      p.armLPitch = -1.72 - c * 0.78 - s * 0.18;
      p.armRPitch = p.armLPitch;
      p.armLRoll = 0.76 + s * 0.56;
      p.armRRoll = -p.armLRoll;
      p.armLYaw = -0.18 - s * 0.24;
      p.armRYaw = -p.armLYaw;
      p.forearmLPitch = -0.82 + c * 0.58 - s * 0.14;
      p.forearmRPitch = p.forearmLPitch;
      p.wristLPitch = s * 0.22;
      p.wristRPitch = s * 0.22;
      p.wristLRoll = -s * 0.26;
      p.wristRRoll = s * 0.26;
      p.fingerLCurl = -0.16; // flat open paddling hands
      p.fingerRCurl = -0.16;
    } else if (activeBase === 'SwimSprint') {
      // Sleek horizontal front-crawl (~80° = 1.40 rad), rapid alternating overhead strokes & side breath turns
      const pL = this._swimPhase;
      const pR = this._swimPhase + Math.PI;
      const bodyRoll = Math.sin(pL) * 0.24;
      p.hipsY = this._hipBindY - 0.28 + Math.sin(pL * 2.0) * 0.025;
      p.hipsPitch = 1.24;
      p.torsoPitch = 0.16; // combined ~1.40 rad (~80°)
      p.hipsRoll = bodyRoll;
      p.torsoRoll = bodyRoll * 0.9 + clamp(loc.turnRate * 0.07, -0.22, 0.22);
      p.torsoYaw = -Math.sin(pL) * 0.14;

      // Subtle alternating side-to-side head breath turns every second stroke
      const breathWave = Math.sin(pL * 0.5);
      const breathTurn = Math.pow(Math.abs(breathWave), 2.2) * Math.sign(breathWave);
      p.neckPitch = -0.52;
      p.headPitch = -0.44;
      p.headYaw = breathTurn * 0.62;
      p.headRoll = -breathTurn * 0.26;
      p.clavLShrug = 0.14 + Math.max(0, Math.cos(pL)) * 0.12;
      p.clavRShrug = 0.14 + Math.max(0, Math.cos(pR)) * 0.12;

      // Rapid alternating front-crawl overhead reaching & deep underwater pull
      p.armLPitch = -1.54 - Math.cos(pL) * 1.28;
      p.armRPitch = -1.54 - Math.cos(pR) * 1.28;
      p.armLRoll = 0.52 - Math.sin(pL) * 0.42 + Math.max(0, -Math.sin(pL)) * 0.36;
      p.armRRoll = -(0.52 - Math.sin(pR) * 0.42 + Math.max(0, -Math.sin(pR)) * 0.36);
      p.armLYaw = -0.12 + Math.sin(pL) * 0.18;
      p.armRYaw = 0.12 - Math.sin(pR) * 0.18;
      p.forearmLPitch = -0.66 + Math.cos(pL) * 0.44 - Math.max(0, Math.sin(pL)) * 0.38;
      p.forearmRPitch = -0.66 + Math.cos(pR) * 0.44 - Math.max(0, Math.sin(pR)) * 0.38;
      p.wristLPitch = Math.sin(pL) * 0.22;
      p.wristRPitch = Math.sin(pR) * 0.22;
      p.fingerLCurl = -0.14;
      p.fingerRCurl = -0.14;
      p.jawOpen = Math.abs(breathTurn) * 0.24;
      p.eyeSquint = 0.2;
    } else if (activeBase === 'SwimDive') {
      // Sleek underwater dive tilting smoothly nose-down on descent (C) & nose-up on ascent (Space)
      const sw = this._swimPhase;
      const c = Math.cos(sw);
      const s = Math.sin(sw);
      const diveTilt = clamp(-loc.verticalSwimVel * 0.24, -0.68, 0.68);
      const undulate = Math.sin(sw);
      p.hipsY = this._hipBindY - 0.30 + Math.sin(sw * 1.2) * 0.032;
      p.hipsPitch = 1.32 + diveTilt * 0.85 + undulate * 0.08;
      p.torsoPitch = 0.14 + diveTilt * 0.15 - Math.sin(sw - 0.7) * 0.12;
      p.hipsRoll = clamp(loc.turnRate * 0.12, -0.32, 0.32);
      p.torsoRoll = clamp(loc.turnRate * 0.1, -0.26, 0.26);
      p.neckPitch = -0.30 - diveTilt * 0.12;
      p.headPitch = -0.28 - diveTilt * 0.08;
      p.clavLShrug = 0.12;
      p.clavRShrug = 0.12;

      // Graceful long underwater breaststroke sweeps
      p.armLPitch = -1.78 - c * 0.92 - s * 0.15;
      p.armRPitch = p.armLPitch;
      p.armLRoll = 0.72 + s * 0.62;
      p.armRRoll = -p.armLRoll;
      p.armLYaw = -0.16 - s * 0.2;
      p.armRYaw = -p.armLYaw;
      p.forearmLPitch = -0.58 + c * 0.42 - Math.max(0, -c) * 0.35;
      p.forearmRPitch = p.forearmLPitch;
      p.wristLPitch = s * 0.24;
      p.wristRPitch = s * 0.24;
      p.fingerLCurl = -0.16;
      p.fingerRCurl = -0.16;
      p.eyeSquint = 0.24;
    }

    // Playable Character Emotes (1..4) blended smoothly over relaxed Idle when active
    if (this._emoteName && this._emoteTimer >= 0 && !this._panicActive && this._slipTimer < 0) {
      this._applyEmoteToTargetPose(p, this._emoteName, this._emoteTimer, this._emoteDuration);
    }

    // Aerodynamic squint to eyelids & brows during FullSprint or strong forest wind
    // (suppressed during wide-eyed terror in RatPanicShake Stage 1-2!)
    const inShockTerror = this._panicActive && (this._panicStage === 1 || this._panicStage === 2);
    if (!inShockTerror && !loc.swimming) {
      const sprintSquint =
        activeBase === 'FullSprint' ? clamp((speedRatio - 0.55) / 0.45, 0, 1) * 0.34 : 0;
      const windSquint = smoothstep(0.75, 2.5, loc.windIntensity) * 0.32;
      const aeroSquint = clamp(sprintSquint + windSquint, 0, 0.48);
      if (aeroSquint > 0.001) {
        p.eyeSquint = Math.max(p.eyeSquint, aeroSquint);
        p.browHeight = Math.min(p.browHeight, -0.0045 * (aeroSquint / 0.34));
        p.browTilt = Math.min(p.browTilt, -0.24 * clamp(aeroSquint / 0.32, 0, 1.25));
      }
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

  _applyEmoteToTargetPose(p, name, t, dur) {
    if (name === 'EmoteWave') {
      // 1 (2.6s): Cheerful elevated right-hand overhead wave, friendly head tilt & relaxed brows
      const env = smoothstep(0.0, 0.28, t) * (1.0 - smoothstep(dur - 0.38, dur, t));
      const wave = Math.sin(t * 9.8);
      p.hipsX = lerp(p.hipsX, -0.024, env);
      p.hipsRoll = lerp(p.hipsRoll, 0.035, env);
      p.torsoRoll = lerp(p.torsoRoll, -0.055 + wave * 0.024, env);
      p.torsoYaw = lerp(p.torsoYaw, 0.08, env);
      p.headRoll = lerp(p.headRoll, 0.14 + wave * 0.032, env);
      p.headPitch = lerp(p.headPitch, -0.06, env);
      p.headYaw = lerp(p.headYaw, 0.04, env);
      p.clavRShrug = lerp(p.clavRShrug, 0.22, env);
      p.armRPitch = lerp(p.armRPitch, -2.42, env);
      p.armRRoll = lerp(p.armRRoll, -0.78 + wave * 0.26, env);
      p.armRYaw = lerp(p.armRYaw, 0.22, env);
      p.forearmRPitch = lerp(p.forearmRPitch, -0.68 + wave * 0.22, env);
      p.wristRPitch = lerp(p.wristRPitch, -0.14 + wave * 0.18, env);
      p.wristRRoll = lerp(p.wristRRoll, wave * 0.44, env);
      p.fingerRCurl = lerp(p.fingerRCurl, -0.22, env); // wide-open friendly 5-finger splay
      p.armLRoll = lerp(p.armLRoll, 0.2, env);
      p.forearmLPitch = lerp(p.forearmLPitch, -0.4, env);
      p.browHeight = lerp(p.browHeight, 0.005, env);
      p.browTilt = lerp(p.browTilt, 0.04, env);
      p.eyeSquint = lerp(p.eyeSquint, 0.08, env);
    } else if (name === 'EmoteWarmHands') {
      // 2 (3.6s): Slight forward lean, briskly rubbing palms together warming hands -> overhead shoulder stretch!
      const warmEnv = smoothstep(0.0, 0.3, t) * (1.0 - smoothstep(2.1, 2.52, t));
      const stretchEnv = smoothstep(2.28, 2.7, t) * (1.0 - smoothstep(dur - 0.38, dur, t));
      const rub = Math.sin(t * 22.0);

      if (warmEnv > 0.001) {
        p.hipsY = lerp(p.hipsY, this._hipBindY - 0.045, warmEnv);
        p.torsoPitch = lerp(p.torsoPitch, 0.22, warmEnv);
        p.neckPitch = lerp(p.neckPitch, 0.08, warmEnv);
        p.headPitch = lerp(p.headPitch, 0.16, warmEnv);
        p.headYaw = lerp(p.headYaw, 0, warmEnv);
        p.clavLShrug = lerp(p.clavLShrug, 0.08, warmEnv);
        p.clavRShrug = lerp(p.clavRShrug, 0.08, warmEnv);
        p.armLPitch = lerp(p.armLPitch, -0.68 + rub * 0.09, warmEnv);
        p.armRPitch = lerp(p.armRPitch, -0.68 - rub * 0.09, warmEnv);
        p.armLRoll = lerp(p.armLRoll, 0.24, warmEnv);
        p.armRRoll = lerp(p.armRRoll, -0.24, warmEnv);
        p.armLYaw = lerp(p.armLYaw, -0.58, warmEnv);
        p.armRYaw = lerp(p.armRYaw, 0.58, warmEnv);
        p.forearmLPitch = lerp(p.forearmLPitch, -1.58 + rub * 0.14, warmEnv);
        p.forearmRPitch = lerp(p.forearmRPitch, -1.58 - rub * 0.14, warmEnv);
        p.wristLPitch = lerp(p.wristLPitch, rub * 0.24, warmEnv);
        p.wristRPitch = lerp(p.wristRPitch, -rub * 0.24, warmEnv);
        p.wristLRoll = lerp(p.wristLRoll, -0.35 + rub * 0.22, warmEnv);
        p.wristRRoll = lerp(p.wristRRoll, 0.35 + rub * 0.22, warmEnv);
        p.fingerLCurl = lerp(p.fingerLCurl, -0.08, warmEnv);
        p.fingerRCurl = lerp(p.fingerRCurl, -0.08, warmEnv);
      }

      if (stretchEnv > 0.001) {
        p.hipsY = lerp(p.hipsY, this._hipBindY + 0.008, stretchEnv);
        p.torsoPitch = lerp(p.torsoPitch, -0.14, stretchEnv);
        p.neckPitch = lerp(p.neckPitch, -0.08, stretchEnv);
        p.headPitch = lerp(p.headPitch, -0.16, stretchEnv);
        p.clavLShrug = lerp(p.clavLShrug, 0.28, stretchEnv);
        p.clavRShrug = lerp(p.clavRShrug, 0.28, stretchEnv);
        p.armLPitch = lerp(p.armLPitch, -2.68, stretchEnv);
        p.armRPitch = lerp(p.armRPitch, -2.68, stretchEnv);
        p.armLRoll = lerp(p.armLRoll, 0.34, stretchEnv);
        p.armRRoll = lerp(p.armRRoll, -0.34, stretchEnv);
        p.armLYaw = lerp(p.armLYaw, 0.06, stretchEnv);
        p.armRYaw = lerp(p.armRYaw, -0.06, stretchEnv);
        p.forearmLPitch = lerp(p.forearmLPitch, -0.36, stretchEnv);
        p.forearmRPitch = lerp(p.forearmRPitch, -0.36, stretchEnv);
        p.fingerLCurl = lerp(p.fingerLCurl, -0.16, stretchEnv);
        p.fingerRCurl = lerp(p.fingerRCurl, -0.16, stretchEnv);
        p.jawOpen = lerp(p.jawOpen, 0.1, stretchEnv);
      }
    } else if (name === 'EmoteCompass') {
      // 3 (3.2s): Left forearm inspecting palm compass, right hand thoughtful on chin/hip, head scanning valley L/R
      const env = smoothstep(0.0, 0.28, t) * (1.0 - smoothstep(dur - 0.38, dur, t));
      const scanYaw = Math.sin(clamp((t - 0.52) / 2.25, 0, 1) * TWO_PI) * 0.64 * env;
      const lookDown = clamp(1.0 - smoothstep(0.62, 1.05, t) + smoothstep(2.35, 2.72, t), 0, 1);

      p.torsoPitch = lerp(p.torsoPitch, 0.06, env);
      p.torsoYaw = lerp(p.torsoYaw, scanYaw * 0.2, env);
      p.neckYaw = lerp(p.neckYaw, scanYaw * 0.24, env);
      p.headYaw = lerp(p.headYaw, scanYaw * 0.76, env);
      p.eyeYaw = lerp(p.eyeYaw, scanYaw * 0.26, env);
      p.headPitch = lerp(p.headPitch, lerp(-0.04, 0.32, lookDown), env);
      p.eyePitch = lerp(p.eyePitch, lookDown * 0.14, env);

      // Left palm held up near chest reading compass
      p.armLPitch = lerp(p.armLPitch, -0.58, env);
      p.armLRoll = lerp(p.armLRoll, 0.18, env);
      p.armLYaw = lerp(p.armLYaw, -0.48, env);
      p.forearmLPitch = lerp(p.forearmLPitch, -1.68, env);
      p.wristLPitch = lerp(p.wristLPitch, 0.24, env);
      p.wristLRoll = lerp(p.wristLRoll, -0.65, env);
      p.fingerLCurl = lerp(p.fingerLCurl, 0.04, env);

      // Right hand raised thoughtfully toward chin
      p.armRPitch = lerp(p.armRPitch, -0.78, env);
      p.armRRoll = lerp(p.armRRoll, -0.22, env);
      p.armRYaw = lerp(p.armRYaw, 0.42, env);
      p.forearmRPitch = lerp(p.forearmRPitch, -1.92, env);
      p.wristRPitch = lerp(p.wristRPitch, -0.18, env);
      p.fingerRCurl = lerp(p.fingerRCurl, 0.58, env);

      p.browTilt = lerp(p.browTilt, -0.06, env);
      p.eyeSquint = lerp(p.eyeSquint, 0.08, env);
    } else if (name === 'EmoteVictory') {
      // 4 (3.4s): Playful rhythmic victory groove — bouncy knee groove, hip sway, alternating overhead fist-pumps & nod
      const env = smoothstep(0.0, 0.22, t) * (1.0 - smoothstep(dur - 0.38, dur, t));
      const beat = t * 2.35 * TWO_PI;
      const grooveBounce = 0.5 - 0.5 * Math.cos(beat * 2.0);
      const sway = Math.sin(beat);
      const pumpL = Math.max(0, sway);
      const pumpR = Math.max(0, -sway);

      p.hipsY = lerp(p.hipsY, this._hipBindY - 0.115 + grooveBounce * 0.098, env);
      p.hipsX = lerp(p.hipsX, sway * 0.062, env);
      p.hipsRoll = lerp(p.hipsRoll, -sway * 0.095, env);
      p.hipsYaw = lerp(p.hipsYaw, sway * 0.16, env);
      p.torsoRoll = lerp(p.torsoRoll, sway * 0.11, env);
      p.torsoYaw = lerp(p.torsoYaw, -sway * 0.2, env);
      p.torsoPitch = lerp(p.torsoPitch, -0.04 + grooveBounce * 0.08, env);
      p.headPitch = lerp(p.headPitch, -0.08 + Math.sin(beat * 2.0) * 0.16, env);
      p.headRoll = lerp(p.headRoll, sway * 0.1, env);
      p.headYaw = lerp(p.headYaw, 0, env);

      p.clavLShrug = lerp(p.clavLShrug, 0.12 + pumpL * 0.22, env);
      p.clavRShrug = lerp(p.clavRShrug, 0.12 + pumpR * 0.22, env);
      p.armLPitch = lerp(p.armLPitch, -1.35 - pumpL * 1.25, env);
      p.armRPitch = lerp(p.armRPitch, -1.35 - pumpR * 1.25, env);
      p.armLRoll = lerp(p.armLRoll, 0.42 + pumpL * 0.28, env);
      p.armRRoll = lerp(p.armRRoll, -(0.42 + pumpR * 0.28), env);
      p.forearmLPitch = lerp(p.forearmLPitch, -1.48 + pumpL * 0.88, env);
      p.forearmRPitch = lerp(p.forearmRPitch, -1.48 + pumpR * 0.88, env);
      p.fingerLCurl = lerp(p.fingerLCurl, 1.28, env);
      p.fingerRCurl = lerp(p.fingerRCurl, 1.28, env);

      p.browHeight = lerp(p.browHeight, 0.006, env);
      p.jawOpen = lerp(p.jawOpen, 0.1, env);
      p.eyeSquint = lerp(p.eyeSquint, 0.1, env);
    }
  }

  // ---------------------------------------------------------------------------
  // High-Frequency Expressive Overlays (RatPanicShake 4 Stages, Slip, Thunder)
  // ---------------------------------------------------------------------------

  _computeExpressiveOverlays(dt, elapsed, loc) {
    const ov = this._overlayScratch;
    const groundIK = loc.grounded && !loc.swimming ? 1.0 : 0.0;

    ov.hipsX = 0;
    ov.hipsY = 0;
    ov.hipsZ = 0;
    ov.hipsPitch = 0;
    ov.hipsYaw = 0;
    ov.hipsRoll = 0;
    ov.torsoPitch = 0;
    ov.torsoYaw = 0;
    ov.torsoRoll = 0;
    ov.neckPitch = 0;
    ov.neckYaw = 0;
    ov.headPitch = 0;
    ov.headYaw = 0;
    ov.headRoll = 0;
    ov.clavLShrug = 0;
    ov.clavRShrug = 0;
    ov.armOverrideWeight = 0;
    ov.armLPitch = 0;
    ov.armLRoll = 0;
    ov.armLYaw = 0;
    ov.forearmLPitch = 0;
    ov.wristLPitch = 0;
    ov.wristLRoll = 0;
    ov.fingerLCurl = 0;
    ov.armRPitch = 0;
    ov.armRRoll = 0;
    ov.armRYaw = 0;
    ov.forearmRPitch = 0;
    ov.wristRPitch = 0;
    ov.wristRRoll = 0;
    ov.fingerRCurl = 0;
    ov.shiverWrist = 0;
    ov.shiverForearm = 0;
    ov.shiverShoulder = 0;
    ov.shiverKnee = 0;
    ov.jawOpen = 0;
    ov.browHeight = 0;
    ov.browTilt = 0;
    ov.eyeWide = 0;
    ov.eyeSquint = 0;
    ov.eyeYaw = 0;
    ov.eyePitch = 0;
    ov.ikTargetL = groundIK;
    ov.ikTargetR = groundIK;
    ov.panicShakeLeg = null;
    ov.slipKick = 0;

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
          this._pushPendingFootstep(this._panicSide === 'L' ? 'R' : 'L', 0.65);
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
            ov.ikTargetR = groundIK;
          } else {
            ov.ikTargetR = 0.0;
            ov.ikTargetL = groundIK;
          }

          const pl = this._panicLegScratch;
          pl.side = this._panicSide;
          pl.thighX = -0.72 + tremor14 * 0.24;
          pl.thighY = sAff * 0.14 + tremor14 * 0.22;
          pl.thighZ = sAff * 0.22 + tremor14Quad * 0.16;
          pl.shinX = clamp(0.62 + tremor14 * 0.36, 0.1, 1.55);
          pl.ankleX = 0.18 + tremor14Quad * 0.42;
          pl.ankleZ = tremor14 * 0.34;
          ov.panicShakeLeg = pl;

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
        const targetLook =
          PARANOID_LOOK_TABLE[
            ((stepIdx % PARANOID_LOOK_TABLE.length) + PARANOID_LOOK_TABLE.length) %
              PARANOID_LOOK_TABLE.length
          ];
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

    if (b.upperLidL) b.upperLidL.rotation.x = clamp(upperLidAngle, -0.38, 0.65);
    if (b.upperLidR) b.upperLidR.rotation.x = clamp(upperLidAngle, -0.38, 0.65);
    if (b.lowerLidL) b.lowerLidL.rotation.x = clamp(lowerLidAngle, -0.22, 0.28);
    if (b.lowerLidR) b.lowerLidR.rotation.x = clamp(lowerLidAngle, -0.22, 0.28);

    const eyeYaw = clamp(s.eyeYaw + ov.eyeYaw, -0.35, 0.35);
    const eyePitch = clamp(s.eyePitch + ov.eyePitch, -0.28, 0.32);
    if (b.eyeL) b.eyeL.rotation.set(eyePitch, eyeYaw, 0);
    if (b.eyeR) b.eyeR.rotation.set(eyePitch, eyeYaw, 0);

    const browH = clamp(s.browHeight + ov.browHeight, -0.007, 0.018);
    const browT = clamp(s.browTilt + ov.browTilt, -0.32, 0.34);
    if (b.browL) {
      b.browL.position.y = this._browBaseY + browH;
      b.browL.rotation.z = -browT;
    }
    if (b.browR) {
      b.browR.position.y = this._browBaseY + browH;
      b.browR.rotation.z = browT;
    }

    const jawOpen = clamp(s.jawOpen + ov.jawOpen, 0, 0.58);
    if (b.jaw) b.jaw.rotation.x = jawOpen;

    // 5. Clavicles, Arms, Wrists & Articulated Fingers (clenched sprint fists vs splayed panic/swim hands)
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

    b.upperArmR.rotation.set(armRP, armRY, armRR);
    b.forearmR.rotation.set(clamp(foreRP, -2.15, -0.04), 0, 0);
    b.wristR.rotation.set(wristRP, s.wristRYaw, wristRR);

    // Articulate all 5 digits per hand (relaxed idle curl, tight sprint fist, wide-splayed panic/swim fingers)
    const splayL = fingerLC < 0 ? clamp(-fingerLC / 0.32, 0, 1) : 0;
    const splayR = fingerRC < 0 ? clamp(-fingerRC / 0.32, 0, 1) : 0;
    if (typeof this.rig.setHandPose === 'function') {
      this.rig.setHandPose('L', fingerLC, splayL);
      this.rig.setHandPose('R', fingerRC, splayR);
    } else if (b.fingersL && b.fingersR) {
      // Fallback for legacy single-bone finger rigs
      b.fingersL.rotation.set(0, 0, -fingerLC);
      b.fingersR.rotation.set(0, 0, fingerRC);
    }
  }

  // ---------------------------------------------------------------------------
  // Analytical 2-Bone Leg IK + Slope-Aligned Boots + Seamless FK Blending
  // ---------------------------------------------------------------------------

  _applyLegsAndFootIK(dt, elapsed, loc, baseLocoState, stride, ov, landingComp) {
    const b = this.bones;

    // Smoothly blend per-leg Foot IK weight (0 during swimming / Jump / RatPanicShake Stage 2 shake, 1 grounded/wading)
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
    if (ov.ikTargetL === 0 && this._ikWeightL < 0.008) this._ikWeightL = 0;
    if (ov.ikTargetR === 0 && this._ikWeightR < 0.008) this._ikWeightR = 0;

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

    // 2. Transform desired local foot XZ into world space, sample height & surface normal with referenceY = rootPos.y!
    this._footLocalL.set(fxLocalL, 0, fzLocalL);
    this._footLocalR.set(fxLocalR, 0, fzLocalR);

    this._footWorldL.copy(this._footLocalL).applyMatrix4(this.rig.root.matrixWorld);
    this._footWorldR.copy(this._footLocalR).applyMatrix4(this.rig.root.matrixWorld);

    const groundYL = this._sampleFootSurface(
      this._footWorldL.x,
      this._footWorldL.z,
      this._rootPos.y,
      this._normalWorldL
    );
    const groundYR = this._sampleFootSurface(
      this._footWorldR.x,
      this._footWorldR.z,
      this._rootPos.y,
      this._normalWorldR
    );

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

    // 4. Compute procedural FK fallback poses for swimming, Jump, SlipRecovery kick, and RatPanicShake Stage 2!
    const fkL = this._computeFKLegPose('L', elapsed, loc, baseLocoState, ov, this._fkLegLScratch);
    const fkR = this._computeFKLegPose('R', elapsed, loc, baseLocoState, ov, this._fkLegRScratch);

    // 5. Solve analytical 2-bone IK for each leg and blend cleanly with FK via ikWeight!
    this._solveLegIK('L', this._ankleTargetL, this._normalLocalL, anklePitchL, this._ikWeightL, fkL, ov.shiverKnee);
    this._solveLegIK('R', this._ankleTargetR, this._normalLocalR, anklePitchR, this._ikWeightR, fkR, -ov.shiverKnee);

    // 6. Articulated forefoot toe pitch (bend cleanly upward on push-off, relax in air/water)
    if (b.toeL) b.toeL.rotation.set(toeBendL * this._ikWeightL, 0, 0);
    if (b.toeR) b.toeR.rotation.set(toeBendR * this._ikWeightR, 0, 0);
  }

  _computeFKLegPose(side, elapsed, loc, baseLocoState, ov, out) {
    const s = side === 'L' ? 1 : -1;

    // Stage 2 RatPanicShake violent 14 Hz leg shake on affected side
    if (ov.panicShakeLeg && ov.panicShakeLeg.side === side) {
      out.thighX = ov.panicShakeLeg.thighX;
      out.thighY = ov.panicShakeLeg.thighY;
      out.thighZ = ov.panicShakeLeg.thighZ;
      out.shinX = ov.panicShakeLeg.shinX;
      out.ankleX = ov.panicShakeLeg.ankleX;
      out.ankleY = 0;
      out.ankleZ = ov.panicShakeLeg.ankleZ;
      return out;
    }

    // Stage 1 Electro-Shock involuntary mini-hop tuck
    if (this._panicActive && this._panicStage === 1) {
      out.thighX = -0.42;
      out.thighY = s * 0.08;
      out.thighZ = s * 0.14;
      out.shinX = 0.78;
      out.ankleX = 0.25;
      out.ankleY = 0;
      out.ankleZ = 0;
      return out;
    }

    // SlipRecovery comedic forward foot kick
    if (ov.slipKick > 0.05) {
      const lead = side === 'L' ? 1.0 : 0.45;
      out.thighX = -0.78 * ov.slipKick * lead;
      out.thighY = s * 0.06;
      out.thighZ = s * 0.12 * ov.slipKick;
      out.shinX = 0.24 * ov.slipKick;
      out.ankleX = -0.25 * ov.slipKick;
      out.ankleY = 0;
      out.ankleZ = 0;
      return out;
    }

    // Swimming & Diving FK leg kicks (zero ground IK interference!)
    if (loc.swimming) {
      const sw = this._swimPhase;
      if (baseLocoState === 'SwimTread') {
        // Gentle alternating frog / bicycle leg kicks keeping head safely above water
        const kickP = sw * 1.15 + (side === 'L' ? 0 : Math.PI);
        out.thighX = -0.46 + Math.sin(kickP) * 0.38;
        out.thighY = s * 0.08;
        out.thighZ = s * (0.2 + Math.max(0, -Math.sin(kickP)) * 0.16);
        out.shinX = clamp(0.78 + Math.cos(kickP) * 0.48, 0.12, 1.65);
        out.ankleX = 0.32 + Math.sin(kickP - 0.5) * 0.26;
        out.ankleY = 0;
        out.ankleZ = 0;
        return out;
      }
      if (baseLocoState === 'SwimStroke') {
        // Synchronized rhythmic breaststroke frog kick (timed against arm pull)
        const kp = sw - 0.9;
        const frogTuck = 0.5 - 0.5 * Math.cos(kp);
        const frogSnap = Math.max(0, Math.sin(kp));
        out.thighX = -0.14 - frogTuck * 0.74;
        out.thighY = s * (0.06 + frogTuck * 0.22);
        out.thighZ = s * (0.08 + frogTuck * 0.42 + frogSnap * 0.15);
        out.shinX = clamp(0.14 + frogTuck * 1.44, 0.08, 1.75);
        out.ankleX = lerp(0.54, -0.14, frogTuck);
        out.ankleY = 0;
        out.ankleZ = s * frogTuck * 0.12;
        return out;
      }
      if (baseLocoState === 'SwimSprint') {
        // Energetic 6-beat freestyle flutter kicks
        const flutterP = sw * 3.0 + (side === 'L' ? 0 : Math.PI);
        out.thighX = 0.06 + Math.sin(flutterP) * 0.34;
        out.thighY = s * 0.03;
        out.thighZ = s * 0.04;
        out.shinX = clamp(0.22 + Math.max(0, Math.sin(flutterP - 0.7)) * 0.48, 0.08, 1.0);
        out.ankleX = 0.58 + Math.sin(flutterP - 1.1) * 0.18;
        out.ankleY = 0;
        out.ankleZ = 0;
        return out;
      }
      // SwimDive: graceful rhythmic underwater dolphin/breaststroke kicks synced to undulating spine
      const dk = sw * 1.45 + (side === 'L' ? 0 : 0.35);
      out.thighX = -0.1 + Math.sin(dk - 0.45) * 0.42;
      out.thighY = s * 0.05;
      out.thighZ = s * (0.09 + Math.max(0, -Math.sin(dk)) * 0.22);
      out.shinX = clamp(0.24 + Math.max(0, Math.sin(dk - 1.15)) * 0.92, 0.1, 1.45);
      out.ankleX = 0.56 + Math.sin(dk - 1.45) * 0.22;
      out.ankleY = 0;
      out.ankleZ = 0;
      return out;
    }

    // Jump: launch extension vs mid-air athletic tuck
    const rising = smoothstep(-0.5, 4.0, loc.verticalVel);
    const airSway = Math.sin(elapsed * 5.2 + (side === 'L' ? 0 : Math.PI)) * 0.08;
    const thighX = lerp(-0.62, -0.18, rising) + (side === 'L' ? -0.14 : 0.12) + airSway;
    const shinX = lerp(1.12, 0.34, rising) + (side === 'L' ? 0.12 : -0.08);
    const ankleX = lerp(0.24, 0.38, rising);

    out.thighX = thighX;
    out.thighY = s * 0.05;
    out.thighZ = s * 0.08;
    out.shinX = Math.max(0.06, shinX);
    out.ankleX = ankleX;
    out.ankleY = 0;
    out.ankleZ = 0;
    return out;
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
    const waterDragScale = loc.swimming ? 0.35 : 1.0;

    // 1. Backpack spring-damper bounce & tilt
    const packTargetPitch =
      clamp(-horizAccel * 0.015 - loc.speed * 0.014, -0.22, 0.22) * waterDragScale + panicRattle * 0.16;
    const packTargetRoll = clamp(loc.turnRate * 0.055 + loc.lateralSpeed * 0.025, -0.22, 0.22) * waterDragScale;
    const packTargetBounce = clamp(-hipsAccelY * 0.0018, -0.04, 0.04) * waterDragScale;

    const bpPitch = sp.backpackPitch.step(dt, packTargetPitch);
    const bpRoll = sp.backpackRoll.step(dt, packTargetRoll);
    const bpBounce = sp.backpackBounce.step(dt, packTargetBounce);

    if (b.backpack) {
      b.backpack.position.y = 0.04 + bpBounce;
      b.backpack.rotation.set(bpPitch, 0, bpRoll);
    }

    // 2. Hanging aluminum canteen swinging pendulum lag
    const cantDrivePitch =
      clamp(-horizAccel * 0.048 - loc.speed * 0.036 - hipsVelY * 0.12 + panicRattle * 1.4, -0.7, 0.7) *
      waterDragScale;
    const cantDriveRoll =
      clamp(
        loc.turnRate * 0.16 +
          loc.lateralSpeed * 0.06 +
          Math.sin(this._stridePhase) * clamp(loc.speed / 5, 0, 1) * 0.22 +
          panicRattle * 1.1,
        -0.7,
        0.7
      ) * waterDragScale;
    const cPitch = sp.canteenPitch.step(dt, cantDrivePitch);
    const cRoll = sp.canteenRoll.step(dt, cantDriveRoll);
    if (b.canteen) {
      b.canteen.rotation.set(cPitch, 0, cRoll);
    }

    // 3. Lower jacket hem trailing flare (streams behind runner, flares on skids/jumps/turns)
    const hemTargetPitch = clamp(
      loc.forwardSpeed * 0.042 - horizAccel * 0.015 + (loc.grounded || loc.swimming ? 0 : 0.24) + Math.abs(ov.hipsY) * 0.5,
      -0.25,
      0.48
    );
    const hemTargetRoll = clamp(loc.turnRate * 0.08 + loc.lateralSpeed * 0.035, -0.32, 0.32);
    const hPitch = sp.jacketHemPitch.step(dt, hemTargetPitch);
    const hRoll = sp.jacketHemRoll.step(dt, hemTargetRoll);
    if (b.jacketHem) {
      b.jacketHem.rotation.set(hPitch, 0, hRoll);
    }

    // 4. Swaying front/crown hair locks spring-damper (running momentum, bounce, turns & wind flutter)
    if (b.hairLocks) {
      const windAmp = clamp(loc.windIntensity, 0, 3.5) * (loc.submerged ? 0.2 : 1.0);
      const windFlutterP =
        Math.sin(elapsed * (3.6 + windAmp * 2.1) + 0.4) * (0.014 + windAmp * 0.048) +
        Math.sin(elapsed * (7.2 + windAmp * 3.0)) * (windAmp * 0.018);
      const windFlutterR =
        Math.cos(elapsed * (3.1 + windAmp * 1.8) + 1.1) * (0.012 + windAmp * 0.044);

      const hairTargetPitch = clamp(
        -loc.forwardSpeed * 0.032 -
          horizAccel * 0.012 -
          hipsAccelY * 0.0045 -
          (loc.grounded || loc.swimming ? 0 : clamp(loc.verticalVel * 0.028, -0.18, 0.18)) +
          windFlutterP +
          panicRattle * 0.32,
        -0.34,
        0.34
      );
      const hairTargetRoll = clamp(
        loc.turnRate * 0.068 + loc.lateralSpeed * 0.026 + windFlutterR + panicRattle * 0.24,
        -0.30,
        0.30
      );
      const hlPitch = sp.hairLocksPitch.step(dt, hairTargetPitch);
      const hlRoll = sp.hairLocksRoll.step(dt, hairTargetRoll);
      b.hairLocks.rotation.set(hlPitch, 0, hlRoll);
    }

    // 5. Head inertial follow-through lag (applied next frame smoothly onto head bone)
    sp.headLagPitch.step(dt, clamp(-horizAccel * 0.009 - hipsAccelY * 0.0025, -0.18, 0.18) * waterDragScale);
    sp.headLagYaw.step(dt, clamp(-loc.turnRate * 0.04, -0.2, 0.2) * waterDragScale);
    sp.headLagRoll.step(dt, clamp(loc.turnRate * 0.025, -0.14, 0.14) * waterDragScale);
  }
}
