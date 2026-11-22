import { clamp } from '../utils/random.js';

const STYLE_ELEMENT_ID = 'sylva-mobile-controls-styles';
const BODY_ACTIVE_CLASS = 'sylva-touch-controls-active';

const DEFAULT_MAX_RADIUS = 44; // px travel inside 124×124px base
const DEFAULT_DEADZONE = 0.12; // 12% inner deadzone
const DEFAULT_AUTO_SPRINT_THRESHOLD = 0.86; // >= 86% outer rim engages auto-sprint
const DEFAULT_LOOK_SENSITIVITY = 1.0;
const DEFAULT_PINCH_SENSITIVITY = 0.014;
const RUN_HOLD_THRESHOLD_MS = 260;

const CAMERA_MODE_BADGES = {
  'Third-Person': '3P',
  'First-Person Body': '1P',
  'Free Orbit': 'ORB',
};

/**
 * Pure analog thumbstick response math:
 * - Radial clamping to `maxRadius`
 * - 12% inner deadzone (`rawMag < 0.12 -> 0`)
 * - Quadratic curve (`norm = (rawMag - 0.12) / 0.88`, `curvedMag = norm * norm`)
 * - Outer sprint rim detection (`rawMag >= 0.86`)
 * - Converts screen offset (`+dx` right, `+dy` down) to game intent (`+moveX` right, `+moveY` forward)
 */
export function computeThumbstickResponse(
  dx,
  dy,
  maxRadius = DEFAULT_MAX_RADIUS,
  deadzone = DEFAULT_DEADZONE,
  autoSprintThreshold = DEFAULT_AUTO_SPRINT_THRESHOLD
) {
  const safeRadius = maxRadius > 0 ? maxRadius : DEFAULT_MAX_RADIUS;
  const safeDx = Number.isFinite(dx) ? dx : 0;
  const safeDy = Number.isFinite(dy) ? dy : 0;
  const dist = Math.hypot(safeDx, safeDy);

  if (dist < 1e-6) {
    return {
      moveX: 0,
      moveY: 0,
      rawMag: 0,
      curvedMag: 0,
      autoSprint: false,
      visualX: 0,
      visualY: 0,
    };
  }

  const rawMag = Math.min(1.0, dist / safeRadius);
  const clampedDist = Math.min(dist, safeRadius);
  const invDist = 1.0 / dist;
  const dirScreenX = safeDx * invDist;
  const dirScreenY = safeDy * invDist;

  const visualX = dirScreenX * clampedDist;
  const visualY = dirScreenY * clampedDist;

  if (rawMag < deadzone) {
    return {
      moveX: 0,
      moveY: 0,
      rawMag,
      curvedMag: 0,
      autoSprint: false,
      visualX,
      visualY,
    };
  }

  const span = Math.max(1e-5, 1.0 - deadzone);
  const norm = clamp((rawMag - deadzone) / span, 0, 1);
  const curvedMag = norm * norm;
  const autoSprint = rawMag + 1e-9 >= autoSprintThreshold;

  // Screen +Y is down; game forward +Y is up (-dirScreenY)
  const moveX = dirScreenX * curvedMag;
  const moveY = -dirScreenY * curvedMag;

  return {
    moveX,
    moveY,
    rawMag,
    curvedMag,
    autoSprint,
    visualX,
    visualY,
  };
}

/**
 * Detects mobile/tablet performance characteristics so renderer pixel ratio
 * and forest quality preset start smooth out of the box.
 */
export function detectMobilePerformanceProfile() {
  const hasWindow = typeof window !== 'undefined';
  const hasNavigator = typeof navigator !== 'undefined';

  const hasTouchStart = hasWindow && 'ontouchstart' in window;
  const hasTouchPoints = hasNavigator && (navigator.maxTouchPoints || 0) > 0;
  const hasCoarsePointer = Boolean(hasWindow && window.matchMedia?.('(pointer: coarse)')?.matches);
  const hasTouch = hasTouchStart || hasTouchPoints || hasCoarsePointer;

  const ua = hasNavigator && typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const smallViewport = hasWindow && Math.min(window.innerWidth || 9999, window.innerHeight || 9999) <= 900;

  const isMobile = Boolean(isMobileUA || hasCoarsePointer || (hasTouch && smallViewport));
  const dpr = hasWindow ? window.devicePixelRatio || 1 : 1;

  return {
    isMobile,
    maxPixelRatio: Math.min(dpr, 1.75),
    recommendedQuality: isMobile ? 'Medium' : 'High',
  };
}

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

const SCOPED_CSS = /* css */ `
.mc-root {
  position: fixed;
  inset: 0;
  z-index: 12;
  pointer-events: none;
  touch-action: none;
  overscroll-behavior: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  font-family: var(--font-sans, 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
}

.mc-root.is-hidden {
  display: none !important;
}

.mc-root *,
.mc-root *::before,
.mc-root *::after {
  touch-action: none;
  overscroll-behavior: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}

/* Right-side 54% Camera Touch-Look & Two-Finger Pinch-Zoom Zone */
.mc-look-zone {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 54%;
  z-index: 1;
  pointer-events: auto;
  background: transparent;
}

.mc-look-zone.is-free-orbit {
  pointer-events: none;
}

/* Bottom-Left Analog Virtual Thumbstick (strict 20px+ safe-area margin) */
.mc-stick-zone {
  position: absolute;
  left: max(22px, calc(env(safe-area-inset-left, 0px) + 20px));
  bottom: max(24px, calc(env(safe-area-inset-bottom, 0px) + 20px));
  width: 124px;
  height: 124px;
  z-index: 2;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mc-stick-base {
  position: relative;
  width: 124px;
  height: 124px;
  border-radius: 50%;
  background: rgba(15, 20, 17, 0.56);
  border: 1.5px solid rgba(214, 224, 212, 0.2);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow:
    0 10px 28px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(242, 245, 238, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
}

.mc-stick-base.is-active {
  background: rgba(15, 20, 17, 0.7);
  border-color: rgba(142, 182, 126, 0.48);
  box-shadow:
    0 12px 30px rgba(0, 0, 0, 0.42),
    0 0 16px rgba(142, 182, 126, 0.14),
    inset 0 1px 0 rgba(242, 245, 238, 0.12);
}

.mc-stick-base.is-auto-sprint {
  border-color: rgba(226, 164, 82, 0.85);
  box-shadow:
    0 12px 30px rgba(0, 0, 0, 0.44),
    0 0 22px rgba(226, 164, 82, 0.34),
    inset 0 0 14px rgba(226, 164, 82, 0.18);
}

.mc-stick-sprint-rim {
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  border: 2px dashed rgba(226, 164, 82, 0.22);
  pointer-events: none;
  opacity: 0.45;
  transition: opacity 150ms ease, border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
}

.mc-stick-base.is-active .mc-stick-sprint-rim {
  opacity: 0.72;
  border-color: rgba(226, 164, 82, 0.36);
}

.mc-stick-base.is-auto-sprint .mc-stick-sprint-rim {
  opacity: 1;
  border-style: solid;
  border-color: #e2a452;
  box-shadow: 0 0 16px rgba(226, 164, 82, 0.48);
  transform: scale(1.03);
}

.mc-stick-sprint-tag {
  position: absolute;
  top: -19px;
  left: 50%;
  transform: translateX(-50%) translateY(3px);
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(34, 24, 14, 0.86);
  border: 1px solid rgba(226, 164, 82, 0.65);
  color: #f3c882;
  font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0;
  pointer-events: none;
  transition: opacity 140ms ease, transform 140ms ease;
}

.mc-stick-base.is-auto-sprint .mc-stick-sprint-tag {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.mc-stick-guide {
  position: absolute;
  width: 68px;
  height: 68px;
  border-radius: 50%;
  border: 1px solid rgba(214, 224, 212, 0.14);
  pointer-events: none;
}

.mc-stick-ticks {
  position: absolute;
  inset: 10px;
  border-radius: 50%;
  pointer-events: none;
}

.mc-stick-tick {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(214, 224, 212, 0.28);
}

.mc-stick-tick.n { top: 0; left: 50%; transform: translateX(-50%); }
.mc-stick-tick.s { bottom: 0; left: 50%; transform: translateX(-50%); }
.mc-stick-tick.w { left: 0; top: 50%; transform: translateY(-50%); }
.mc-stick-tick.e { right: 0; top: 50%; transform: translateY(-50%); }

.mc-stick-knob {
  position: relative;
  width: 50px;
  height: 50px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, rgba(214, 228, 210, 0.34), rgba(24, 34, 27, 0.92) 72%);
  border: 1.5px solid rgba(214, 224, 212, 0.42);
  box-shadow:
    0 6px 16px rgba(0, 0, 0, 0.46),
    inset 0 1px 2px rgba(255, 255, 255, 0.22);
  pointer-events: none;
  will-change: transform;
  transform: translate3d(0px, 0px, 0px);
  transition: transform 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms ease, box-shadow 120ms ease;
}

.mc-stick-base.is-active .mc-stick-knob {
  transition: border-color 120ms ease, box-shadow 120ms ease;
  border-color: #8eb67e;
  box-shadow:
    0 8px 20px rgba(0, 0, 0, 0.5),
    0 0 14px rgba(142, 182, 126, 0.35),
    inset 0 1px 2px rgba(255, 255, 255, 0.26);
}

.mc-stick-base.is-auto-sprint .mc-stick-knob {
  border-color: #e2a452;
  background: radial-gradient(circle at 35% 30%, rgba(242, 198, 122, 0.48), rgba(44, 30, 16, 0.94) 74%);
  box-shadow:
    0 8px 22px rgba(0, 0, 0, 0.54),
    0 0 18px rgba(226, 164, 82, 0.52),
    inset 0 1px 2px rgba(255, 240, 210, 0.3);
}

/* Bottom-Right Action Button Cluster (48-52px ergonomic touch targets) */
.mc-actions {
  position: absolute;
  right: max(18px, calc(env(safe-area-inset-right, 0px) + 16px));
  bottom: max(22px, calc(env(safe-area-inset-bottom, 0px) + 18px));
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
}

.mc-actions-upper {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  gap: 9px;
  pointer-events: none;
}

.mc-actions-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 9px;
  pointer-events: none;
}

.mc-actions-row--primary {
  gap: 10px;
}

.mc-btn {
  position: relative;
  width: 52px;
  height: 52px;
  min-width: 52px;
  min-height: 52px;
  border-radius: 50%;
  border: 1.5px solid rgba(214, 224, 212, 0.22);
  background: rgba(15, 20, 17, 0.64);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: rgba(242, 245, 238, 0.94);
  box-shadow:
    0 8px 22px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 0;
  cursor: pointer;
  pointer-events: auto;
  transition: transform 90ms ease, background 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
}

.mc-btn--compact {
  width: 48px;
  height: 48px;
  min-width: 48px;
  min-height: 48px;
}

.mc-btn-icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  pointer-events: none;
}

.mc-btn-icon {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
  pointer-events: none;
}

.mc-btn--compact .mc-btn-icon {
  width: 16px;
  height: 16px;
}

.mc-btn-label {
  font-family: var(--font-sans, 'Inter', -apple-system, BlinkMacSystemFont, sans-serif);
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  line-height: 1;
  text-transform: uppercase;
  pointer-events: none;
}

.mc-btn--compact .mc-btn-label {
  font-size: 8px;
}

.mc-btn-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(15, 20, 17, 0.92);
  border: 1px solid rgba(214, 224, 212, 0.28);
  color: #e2a452;
  font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
  font-size: 8px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: 0.02em;
  pointer-events: none;
}

.mc-btn-badge.is-empty {
  display: none;
}

.mc-btn.is-pressed {
  transform: scale(0.91);
  background: rgba(28, 38, 31, 0.86);
  border-color: rgba(214, 224, 212, 0.45);
}

/* Active moss-green highlight (RUN / CROUCH) */
.mc-btn.is-active {
  background: rgba(28, 46, 32, 0.86);
  border-color: #8eb67e;
  color: #c5e6b6;
  box-shadow:
    0 8px 22px rgba(0, 0, 0, 0.38),
    0 0 16px rgba(142, 182, 126, 0.36),
    inset 0 0 10px rgba(142, 182, 126, 0.16);
}

/* Deep-water swim state highlight (UP / DIVE) */
.mc-btn.is-water {
  background: rgba(12, 34, 42, 0.78);
  border-color: rgba(88, 224, 240, 0.56);
  color: #c8f7ff;
  box-shadow:
    0 8px 22px rgba(0, 0, 0, 0.36),
    0 0 14px rgba(72, 218, 238, 0.24),
    inset 0 1px 0 rgba(180, 248, 255, 0.16);
}

.mc-btn.is-water.is-active,
.mc-btn.is-water.is-pressed {
  background: rgba(16, 52, 64, 0.9);
  border-color: #62eefc;
  color: #ebfdff;
  box-shadow:
    0 8px 22px rgba(0, 0, 0, 0.4),
    0 0 18px rgba(82, 232, 248, 0.46);
}

/* Warm golden-amber accent for CHAR switcher */
.mc-btn--char {
  border-color: rgba(226, 164, 82, 0.4);
  color: #f6ddb0;
}

.mc-btn--char.is-pressed {
  background: rgba(48, 34, 18, 0.88);
  border-color: #e2a452;
  color: #fff2d4;
  box-shadow: 0 0 16px rgba(226, 164, 82, 0.42);
}

/* Forest-sage sparkle accent for EMOTE cycler */
.mc-btn--emote {
  border-color: rgba(142, 182, 126, 0.38);
  color: #d6ecc8;
}

.mc-btn--emote.is-pressed {
  background: rgba(28, 44, 30, 0.88);
  border-color: #8eb67e;
  color: #ecfae2;
  box-shadow: 0 0 16px rgba(142, 182, 126, 0.42);
}

/* Primary jump tactile accent */
.mc-btn--jump {
  border-color: rgba(142, 182, 126, 0.36);
}

.mc-btn--jump.is-pressed {
  border-color: #8eb67e;
  box-shadow: 0 0 18px rgba(142, 182, 126, 0.4);
}

/* Distinct warm crimson-amber styling for RAT! */
.mc-btn--rat {
  background: rgba(44, 20, 16, 0.76);
  border-color: rgba(224, 107, 88, 0.56);
  color: #fbd5c4;
  box-shadow:
    0 8px 22px rgba(0, 0, 0, 0.38),
    0 0 12px rgba(224, 107, 88, 0.18),
    inset 0 1px 0 rgba(226, 164, 82, 0.16);
}

.mc-btn--rat.is-pressed {
  background: rgba(84, 30, 22, 0.92);
  border-color: #e2a452;
  color: #fff0e2;
  box-shadow:
    0 6px 18px rgba(0, 0, 0, 0.42),
    0 0 20px rgba(224, 107, 88, 0.52);
}

/* Harmonize existing desktop HUD bars when touch controls are visible */
body.${BODY_ACTIVE_CLASS} .keybind-legend {
  display: none !important;
}

body.${BODY_ACTIVE_CLASS} .hud-dock {
  bottom: max(168px, calc(env(safe-area-inset-bottom, 0px) + 164px));
}

@media (max-width: 780px) {
  body.${BODY_ACTIVE_CLASS} .hud-bottom-center {
    bottom: max(162px, calc(env(safe-area-inset-bottom, 0px) + 158px));
  }
}

/* Stack secondary RPG + utility rows cleanly on narrow portrait screens */
@media (max-width: 520px) {
  .mc-actions-upper {
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }
}

/* Compact landscape mobile ergonomics (e.g. 844×390) with zero top-center compass collision */
@media (max-height: 460px) {
  .mc-actions {
    gap: 8px;
    bottom: max(18px, calc(env(safe-area-inset-bottom, 0px) + 14px));
  }

  .mc-actions-upper,
  .mc-actions-row,
  .mc-actions-row--primary {
    gap: 8px;
  }

  .mc-btn--cam,
  .mc-btn--rat {
    width: 48px;
    height: 48px;
    min-width: 48px;
    min-height: 48px;
  }

  body.${BODY_ACTIVE_CLASS} .hud-dock {
    bottom: auto;
    top: 72px;
    left: 16px;
    transform: none;
  }
}
`;

function ensureStylesInjected() {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = SCOPED_CSS;
  document.head.appendChild(style);
}

function createActionButton({
  action,
  label,
  ariaLabel,
  extraClass = '',
  iconSvg,
  badgeText = '',
  hasBadge = false,
}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = extraClass ? `mc-btn ${extraClass}` : 'mc-btn';
  btn.dataset.action = action;
  btn.setAttribute('aria-label', ariaLabel);

  const iconWrap = document.createElement('span');
  iconWrap.className = 'mc-btn-icon-wrap';
  iconWrap.setAttribute('aria-hidden', 'true');
  iconWrap.innerHTML = iconSvg;
  btn.appendChild(iconWrap);

  const labelEl = document.createElement('span');
  labelEl.className = 'mc-btn-label';
  labelEl.textContent = label;
  btn.appendChild(labelEl);
  btn._labelEl = labelEl;

  if (badgeText || hasBadge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = badgeText ? 'mc-btn-badge' : 'mc-btn-badge is-empty';
    badgeEl.textContent = badgeText || '';
    btn.appendChild(badgeEl);
    btn._badgeEl = badgeEl;
  }

  return btn;
}

/**
 * Responsive Multi-Touch HUD overlay for mobile & tablet play.
 * Uses strict `pointerId` isolation across left analog thumbstick, right-side
 * look/pinch zone, and bottom-right 48-52px tactile action buttons.
 */
export class MobileControls {
  constructor(inputManager, options = {}) {
    this.inputManager = inputManager;
    this.options = options || {};

    this._maxRadius =
      typeof this.options.maxRadius === 'number' && this.options.maxRadius > 0
        ? this.options.maxRadius
        : DEFAULT_MAX_RADIUS;
    this._deadzone =
      typeof this.options.deadzone === 'number' ? this.options.deadzone : DEFAULT_DEADZONE;
    this._autoSprintThreshold =
      typeof this.options.autoSprintThreshold === 'number'
        ? this.options.autoSprintThreshold
        : DEFAULT_AUTO_SPRINT_THRESHOLD;
    this._lookSensitivity =
      typeof this.options.lookSensitivity === 'number'
        ? this.options.lookSensitivity
        : DEFAULT_LOOK_SENSITIVITY;
    this._pinchSensitivity =
      typeof this.options.pinchSensitivity === 'number'
        ? this.options.pinchSensitivity
        : DEFAULT_PINCH_SENSITIVITY;

    // Independent multi-touch pointer tracking
    this._stickPointerId = null;
    this._stickCenterX = 0;
    this._stickCenterY = 0;

    this._lookPointers = new Map(); // pointerId -> { x, y }
    this._lastPinchDist = null;

    this._buttonPointers = new Map(); // pointerId -> { action, btn, pressTime, wasRunToggled }
    this._runPointerId = null;
    this._runToggled = false;

    this._cameraMode = 'Third-Person';
    this._inDeepWater = false;
    this._characterName = '';
    this._visible = false;
    this._disposed = false;

    // Prevents duplicate handling when pointer events fire on element and bubble to window
    this._handledEvents = new WeakSet();

    ensureStylesInjected();
    this._buildDom();
    this._bindEvents();

    const initialVisible =
      this.options.initialVisible !== undefined
        ? Boolean(this.options.initialVisible)
        : Boolean(this.inputManager?.isTouchDevice?.());
    this.setVisible(initialVisible);
  }

  // ---------------------------------------------------------------------------
  // DOM Construction
  // ---------------------------------------------------------------------------

  _buildDom() {
    this._root = document.createElement('div');
    this._root.className = 'mc-root is-hidden';
    this._root.setAttribute('aria-label', 'Touch controls');

    // 1. Right-side 54% Camera Touch-Look & Pinch-Zoom Zone (behind action buttons)
    this._lookZone = document.createElement('div');
    this._lookZone.className = 'mc-look-zone';
    this._lookZone.dataset.zone = 'look';
    this._lookZone.setAttribute('aria-hidden', 'true');
    this._root.appendChild(this._lookZone);

    // 2. Bottom-Left Analog Virtual Thumbstick
    this._stickZone = document.createElement('div');
    this._stickZone.className = 'mc-stick-zone';
    this._stickZone.dataset.zone = 'stick';

    this._stickBase = document.createElement('div');
    this._stickBase.className = 'mc-stick-base';
    this._stickBase.setAttribute('role', 'slider');
    this._stickBase.setAttribute('aria-label', 'Movement thumbstick');

    const sprintRim = document.createElement('div');
    sprintRim.className = 'mc-stick-sprint-rim';
    this._stickBase.appendChild(sprintRim);

    const sprintTag = document.createElement('div');
    sprintTag.className = 'mc-stick-sprint-tag';
    sprintTag.textContent = 'SPRINT';
    this._stickBase.appendChild(sprintTag);

    const guide = document.createElement('div');
    guide.className = 'mc-stick-guide';
    this._stickBase.appendChild(guide);

    const ticks = document.createElement('div');
    ticks.className = 'mc-stick-ticks';
    ticks.innerHTML =
      '<span class="mc-stick-tick n"></span>' +
      '<span class="mc-stick-tick s"></span>' +
      '<span class="mc-stick-tick w"></span>' +
      '<span class="mc-stick-tick e"></span>';
    this._stickBase.appendChild(ticks);

    this._stickKnob = document.createElement('div');
    this._stickKnob.className = 'mc-stick-knob';
    this._stickBase.appendChild(this._stickKnob);

    this._stickZone.appendChild(this._stickBase);
    this._root.appendChild(this._stickZone);

    // 3. Bottom-Right Ergonomic Action Cluster (CHAR, EMOTE, CAM, RAT! + CROUCH/DIVE, RUN, JUMP/UP)
    this._actionsContainer = document.createElement('div');
    this._actionsContainer.className = 'mc-actions';
    this._actionsContainer.setAttribute('role', 'group');
    this._actionsContainer.setAttribute('aria-label', 'Explorer actions');

    const upperGroup = document.createElement('div');
    upperGroup.className = 'mc-actions-upper';

    const rpgRow = document.createElement('div');
    rpgRow.className = 'mc-actions-row mc-actions-row--rpg';

    const utilRow = document.createElement('div');
    utilRow.className = 'mc-actions-row mc-actions-row--util';

    const bottomRow = document.createElement('div');
    bottomRow.className = 'mc-actions-row mc-actions-row--primary';

    this._buttons = {
      char: createActionButton({
        action: 'char',
        label: 'CHAR',
        ariaLabel: 'Switch character',
        extraClass: 'mc-btn--char mc-btn--compact',
        hasBadge: true,
        iconSvg:
          '<svg class="mc-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="9" cy="7.5" r="3.2"/>' +
          '<path d="M3.5 18.5a5.5 5.5 0 0 1 11 0"/>' +
          '<path d="M16 7h4.5m0 0-2-2m2 2-2 2"/>' +
          '<path d="M20.5 14H16m0 0 2-2m-2 2 2 2"/>' +
          '</svg>',
      }),
      emote: createActionButton({
        action: 'emote',
        label: 'EMOTE',
        ariaLabel: 'Cycle explorer emote',
        extraClass: 'mc-btn--emote mc-btn--compact',
        iconSvg:
          '<svg class="mc-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 3l1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8-4.8-1.7 4.8-1.7L12 3Z"/>' +
          '<path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>' +
          '</svg>',
      }),
      cam: createActionButton({
        action: 'cam',
        label: 'CAM',
        ariaLabel: 'Cycle camera mode',
        extraClass: 'mc-btn--cam',
        badgeText: '3P',
        iconSvg:
          '<svg class="mc-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="12" cy="12" r="3"/>' +
          '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/>' +
          '</svg>',
      }),
      rat: createActionButton({
        action: 'rat',
        label: 'RAT!',
        ariaLabel: 'Trigger rat scare',
        extraClass: 'mc-btn--rat',
        iconSvg:
          '<svg class="mc-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>' +
          '</svg>',
      }),
      crouch: createActionButton({
        action: 'crouch',
        label: 'CROUCH',
        ariaLabel: 'Toggle crouch',
        extraClass: 'mc-btn--crouch',
        iconSvg:
          '<svg class="mc-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 5v11"/>' +
          '<path d="m7 11 5 5 5-5"/>' +
          '<path d="M5 19h14"/>' +
          '</svg>',
      }),
      run: createActionButton({
        action: 'run',
        label: 'RUN',
        ariaLabel: 'Toggle or hold sprint',
        extraClass: 'mc-btn--run',
        iconSvg:
          '<svg class="mc-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="m6 17 5-5-5-5"/>' +
          '<path d="m13 17 5-5-5-5"/>' +
          '</svg>',
      }),
      jump: createActionButton({
        action: 'jump',
        label: 'JUMP',
        ariaLabel: 'Jump',
        extraClass: 'mc-btn--jump',
        iconSvg:
          '<svg class="mc-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 19V5"/>' +
          '<path d="m6 11 6-6 6 6"/>' +
          '</svg>',
      }),
    };

    this._buttons.run.setAttribute('aria-pressed', 'false');
    this._buttons.crouch.setAttribute('aria-pressed', 'false');
    this._camBadge = this._buttons.cam._badgeEl || this._buttons.cam.querySelector?.('.mc-btn-badge') || null;
    this._charBadge = this._buttons.char._badgeEl || this._buttons.char.querySelector?.('.mc-btn-badge') || null;
    this._jumpLabel = this._buttons.jump._labelEl || this._buttons.jump.querySelector?.('.mc-btn-label') || null;
    this._crouchLabel = this._buttons.crouch._labelEl || this._buttons.crouch.querySelector?.('.mc-btn-label') || null;

    rpgRow.appendChild(this._buttons.char);
    rpgRow.appendChild(this._buttons.emote);

    utilRow.appendChild(this._buttons.cam);
    utilRow.appendChild(this._buttons.rat);

    upperGroup.appendChild(rpgRow);
    upperGroup.appendChild(utilRow);

    bottomRow.appendChild(this._buttons.crouch);
    bottomRow.appendChild(this._buttons.run);
    bottomRow.appendChild(this._buttons.jump);

    this._actionsContainer.appendChild(upperGroup);
    this._actionsContainer.appendChild(bottomRow);
    this._root.appendChild(this._actionsContainer);

    const parent = this.options.parent || (typeof document !== 'undefined' ? document.body : null);
    if (parent) {
      parent.appendChild(this._root);
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-Touch Event Binding (Strict pointerId Isolation)
  // ---------------------------------------------------------------------------

  _trySetPointerCapture(el, pointerId) {
    if (!el || typeof el.setPointerCapture !== 'function' || pointerId === undefined) return;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // Ignore synthetic events or unsupported capture states
    }
  }

  _tryReleasePointerCapture(el, pointerId) {
    if (!el || typeof el.releasePointerCapture !== 'function' || pointerId === undefined) return;
    try {
      if (typeof el.hasPointerCapture !== 'function' || el.hasPointerCapture(pointerId)) {
        el.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore release errors when pointer already ended
    }
  }

  _isPrimaryPointer(e) {
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) {
      return false;
    }
    return true;
  }

  _getPointerId(e) {
    return e.pointerId !== undefined ? e.pointerId : 0;
  }

  _markEventHandled(e) {
    if (!e || typeof e !== 'object') return false;
    if (this._handledEvents.has(e)) return true;
    this._handledEvents.add(e);
    return false;
  }

  _bindEvents() {
    // --- Thumbstick ---
    this._onStickPointerDown = (e) => {
      if (!this._visible || !this._isPrimaryPointer(e)) return;
      const pid = this._getPointerId(e);
      if (this._stickPointerId !== null) return;
      if (this._lookPointers.has(pid) || this._buttonPointers.has(pid)) return;

      e.preventDefault?.();
      e.stopPropagation?.();

      this._stickPointerId = pid;
      this._trySetPointerCapture(this._stickBase, pid);

      const rect = this._stickBase.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0) {
        this._stickCenterX = rect.left + rect.width * 0.5;
        this._stickCenterY = rect.top + rect.height * 0.5;
      } else {
        this._stickCenterX = e.clientX || 0;
        this._stickCenterY = e.clientY || 0;
      }

      this._stickBase.classList.add('is-active');
      this._updateStickFromClient(e.clientX || 0, e.clientY || 0);
    };

    // --- Right-Side Look & Pinch-Zoom Zone ---
    this._onLookPointerDown = (e) => {
      if (!this._visible || !this._isPrimaryPointer(e)) return;
      if (this._cameraMode === 'Free Orbit') return;

      const pid = this._getPointerId(e);
      if (pid === this._stickPointerId || this._buttonPointers.has(pid)) return;

      e.preventDefault?.();
      e.stopPropagation?.();

      this._trySetPointerCapture(this._lookZone, pid);
      this._lookPointers.set(pid, { x: e.clientX || 0, y: e.clientY || 0 });

      if (this._lookPointers.size === 2) {
        this._lastPinchDist = this._computePinchDistance();
      } else {
        this._lastPinchDist = null;
      }
    };

    // --- Shared Move / End Router (handles captured & bubbled events once per event) ---
    this._onPointerMove = (e) => {
      if (this._markEventHandled(e)) return;
      const pid = this._getPointerId(e);

      if (pid === this._stickPointerId) {
        e.preventDefault?.();
        this._updateStickFromClient(e.clientX || 0, e.clientY || 0);
        return;
      }

      if (this._lookPointers.has(pid)) {
        e.preventDefault?.();
        const prev = this._lookPointers.get(pid);
        const cx = e.clientX || 0;
        const cy = e.clientY || 0;
        const dx = cx - prev.x;
        const dy = cy - prev.y;
        prev.x = cx;
        prev.y = cy;

        if (this._lookPointers.size === 1) {
          this.inputManager?.addTouchLookDelta?.(dx * this._lookSensitivity, dy * this._lookSensitivity);
        } else if (this._lookPointers.size >= 2) {
          const dist = this._computePinchDistance();
          if (this._lastPinchDist !== null) {
            const pinchDeltaPx = dist - this._lastPinchDist;
            // Spreading fingers apart (+pinchDeltaPx) zooms IN (-zoomDelta)
            this.inputManager?.addPinchZoom?.(-pinchDeltaPx * this._pinchSensitivity);
          }
          this._lastPinchDist = dist;
        }
      }
    };

    this._onPointerEnd = (e) => {
      if (this._markEventHandled(e)) return;
      const pid = this._getPointerId(e);
      const isCancel = e.type === 'pointercancel';

      if (pid === this._stickPointerId) {
        this._releaseStick(pid);
        return;
      }

      if (this._lookPointers.has(pid)) {
        this._lookPointers.delete(pid);
        this._tryReleasePointerCapture(this._lookZone, pid);
        if (this._lookPointers.size === 2) {
          this._lastPinchDist = this._computePinchDistance();
        } else {
          this._lastPinchDist = null;
        }
        return;
      }

      if (this._buttonPointers.has(pid)) {
        this._releaseButtonPointer(pid, isCancel);
      }
    };

    // --- Action Button PointerDown Handlers ---
    this._buttonDownHandlers = new Map();
    for (const [action, btn] of Object.entries(this._buttons)) {
      const onDown = (e) => {
        if (!this._visible || !this._isPrimaryPointer(e)) return;
        const pid = this._getPointerId(e);
        if (pid === this._stickPointerId || this._lookPointers.has(pid) || this._buttonPointers.has(pid)) {
          return;
        }

        e.preventDefault?.();
        e.stopPropagation?.();

        this._trySetPointerCapture(btn, pid);
        btn.classList.add('is-pressed');

        const entry = {
          action,
          btn,
          pressTime: nowMs(),
          wasRunToggled: this._runToggled,
        };
        this._buttonPointers.set(pid, entry);

        if (action === 'run') {
          this._runPointerId = pid;
          this.inputManager?.setTouchSprint?.(true);
          this._buttons.run.classList.add('is-active');
          this._buttons.run.setAttribute('aria-pressed', 'true');
        } else if (action === 'jump') {
          this.inputManager?.setTouchJump?.(true);
          this.inputManager?.triggerJump?.();
        } else if (action === 'crouch') {
          this.inputManager?.toggleCrouch?.();
          const crouched = Boolean(this.inputManager?.isCrouching?.());
          this._buttons.crouch.classList.toggle('is-active', crouched);
          this._buttons.crouch.setAttribute('aria-pressed', String(crouched));
        } else if (action === 'rat') {
          this.inputManager?.triggerRatScare?.();
        } else if (action === 'cam') {
          this.inputManager?.triggerCameraCycle?.();
        } else if (action === 'char') {
          this.inputManager?.triggerCharacterSwitch?.();
        } else if (action === 'emote') {
          this.inputManager?.triggerEmoteCycle?.();
        }
      };

      this._buttonDownHandlers.set(btn, onDown);
      btn.addEventListener('pointerdown', onDown);
      btn.addEventListener('pointerup', this._onPointerEnd);
      btn.addEventListener('pointercancel', this._onPointerEnd);
    }

    // --- Window Blur & Tab Visibility Safety Reset ---
    this._onBlur = () => {
      this._resetActiveInputs();
    };

    this._onVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden || document.visibilityState === 'hidden') {
        this._resetActiveInputs();
      }
    };

    this._stickZone.addEventListener('pointerdown', this._onStickPointerDown);
    this._stickBase.addEventListener('pointermove', this._onPointerMove);
    this._stickBase.addEventListener('pointerup', this._onPointerEnd);
    this._stickBase.addEventListener('pointercancel', this._onPointerEnd);

    this._lookZone.addEventListener('pointerdown', this._onLookPointerDown);
    this._lookZone.addEventListener('pointermove', this._onPointerMove);
    this._lookZone.addEventListener('pointerup', this._onPointerEnd);
    this._lookZone.addEventListener('pointercancel', this._onPointerEnd);

    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerEnd);
      window.addEventListener('pointercancel', this._onPointerEnd);
      window.addEventListener('blur', this._onBlur);
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
  }

  // ---------------------------------------------------------------------------
  // Stick / Pinch / Button Helpers
  // ---------------------------------------------------------------------------

  _updateStickFromClient(clientX, clientY) {
    const dx = clientX - this._stickCenterX;
    const dy = clientY - this._stickCenterY;

    const response = computeThumbstickResponse(
      dx,
      dy,
      this._maxRadius,
      this._deadzone,
      this._autoSprintThreshold
    );

    this._stickKnob.style.transform = `translate3d(${response.visualX.toFixed(2)}px, ${response.visualY.toFixed(2)}px, 0px)`;
    this._stickBase.classList.toggle('is-auto-sprint', response.autoSprint);

    this.inputManager?.setTouchMove?.(response.moveX, response.moveY, response.autoSprint);
  }

  _releaseStick(pointerId) {
    if (pointerId !== undefined) {
      this._tryReleasePointerCapture(this._stickBase, pointerId);
    }
    this._stickPointerId = null;
    this._stickBase.classList.remove('is-active', 'is-auto-sprint');
    this._stickKnob.style.transform = 'translate3d(0px, 0px, 0px)';
    this.inputManager?.setTouchMove?.(0, 0, false);
  }

  _computePinchDistance() {
    if (this._lookPointers.size < 2) return 0;
    const iter = this._lookPointers.values();
    const p1 = iter.next().value;
    const p2 = iter.next().value;
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }

  _releaseButtonPointer(pointerId, isCancel) {
    const entry = this._buttonPointers.get(pointerId);
    if (!entry) return;
    this._buttonPointers.delete(pointerId);

    this._tryReleasePointerCapture(entry.btn, pointerId);
    entry.btn.classList.remove('is-pressed');

    if (entry.action === 'run' && this._runPointerId === pointerId) {
      this._runPointerId = null;
      const heldMs = nowMs() - entry.pressTime;

      if (isCancel || heldMs >= RUN_HOLD_THRESHOLD_MS) {
        // Hold-to-sprint released or pointer interrupted
        this._runToggled = false;
        this.inputManager?.setTouchSprint?.(false);
      } else {
        // Quick tap toggles sprint latch on/off
        this._runToggled = !entry.wasRunToggled;
        this.inputManager?.setTouchSprint?.(this._runToggled);
      }

      const active = Boolean(this._runToggled || this.inputManager?.isSprinting?.());
      this._buttons.run.classList.toggle('is-active', active);
      this._buttons.run.setAttribute('aria-pressed', String(active));
    } else if (entry.action === 'jump') {
      this.inputManager?.setTouchJump?.(false);
    }
  }

  _resetActiveInputs() {
    this._releaseStick(this._stickPointerId ?? undefined);

    for (const pid of this._lookPointers.keys()) {
      this._tryReleasePointerCapture(this._lookZone, pid);
    }
    this._lookPointers.clear();
    this._lastPinchDist = null;

    for (const [pid, entry] of this._buttonPointers.entries()) {
      this._tryReleasePointerCapture(entry.btn, pid);
      entry.btn.classList.remove('is-pressed');
    }
    this._buttonPointers.clear();

    this._runPointerId = null;
    this._runToggled = false;
    this._buttons.run.classList.remove('is-active');
    this._buttons.run.setAttribute('aria-pressed', 'false');
    this.inputManager?.setTouchSprint?.(false);
    this.inputManager?.setTouchJump?.(false);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  setVisible(bool) {
    const next = Boolean(bool);
    this._visible = next;

    this._root.classList.toggle('is-hidden', !next);
    this._root.setAttribute('aria-hidden', String(!next));

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle(BODY_ACTIVE_CLASS, next);
    }

    if (!next) {
      this._resetActiveInputs();
    }
  }

  isVisible() {
    return this._visible;
  }

  syncButtonStates({
    sprinting,
    crouching,
    cameraMode,
    inDeepWater = false,
    characterName = '',
  } = {}) {
    if (sprinting !== undefined) {
      const isSprint = Boolean(sprinting);
      if (!isSprint && this._runPointerId === null && !this.inputManager?.isSprinting?.()) {
        this._runToggled = false;
      }
      this._buttons.run.classList.toggle('is-active', isSprint);
      this._buttons.run.setAttribute('aria-pressed', String(isSprint));
    }

    if (crouching !== undefined) {
      const isCrouch = Boolean(crouching);
      this._buttons.crouch.classList.toggle('is-active', isCrouch);
      this._buttons.crouch.setAttribute('aria-pressed', String(isCrouch));
    }

    if (cameraMode !== undefined) {
      this._cameraMode = cameraMode;
      const badge = CAMERA_MODE_BADGES[cameraMode] || 'CAM';
      this._buttons.cam.dataset.cameraMode = cameraMode;
      this._buttons.cam.setAttribute('aria-label', `Camera mode: ${cameraMode} (tap to cycle)`);
      if (this._camBadge) {
        this._camBadge.textContent = badge;
      }
      this._lookZone.classList.toggle('is-free-orbit', cameraMode === 'Free Orbit');
    }

    const diving = Boolean(inDeepWater);
    this._inDeepWater = diving;
    if (this._jumpLabel) {
      this._jumpLabel.textContent = diving ? 'UP' : 'JUMP';
    }
    if (this._crouchLabel) {
      this._crouchLabel.textContent = diving ? 'DIVE' : 'CROUCH';
    }
    this._buttons.jump.dataset.swimMode = String(diving);
    this._buttons.crouch.dataset.swimMode = String(diving);
    this._buttons.jump.classList.toggle('is-water', diving);
    this._buttons.crouch.classList.toggle('is-water', diving);
    this._buttons.jump.setAttribute('aria-label', diving ? 'Swim up' : 'Jump');
    this._buttons.crouch.setAttribute('aria-label', diving ? 'Dive underwater' : 'Toggle crouch');

    const safeCharName = typeof characterName === 'string' ? characterName.trim() : '';
    this._characterName = safeCharName;
    if (this._buttons.char) {
      this._buttons.char.dataset.characterName = safeCharName;
      this._buttons.char.setAttribute(
        'aria-label',
        safeCharName ? `Switch character (current: ${safeCharName})` : 'Switch character'
      );
      if (this._charBadge) {
        if (safeCharName) {
          this._charBadge.textContent = safeCharName.slice(0, 3).toUpperCase();
          this._charBadge.classList.remove('is-empty');
        } else {
          this._charBadge.textContent = '';
          this._charBadge.classList.add('is-empty');
        }
      }
    }
  }

  getElement() {
    return this._root;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    this._resetActiveInputs();

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove(BODY_ACTIVE_CLASS);
    }

    this._stickZone.removeEventListener('pointerdown', this._onStickPointerDown);
    this._stickBase.removeEventListener('pointermove', this._onPointerMove);
    this._stickBase.removeEventListener('pointerup', this._onPointerEnd);
    this._stickBase.removeEventListener('pointercancel', this._onPointerEnd);

    this._lookZone.removeEventListener('pointerdown', this._onLookPointerDown);
    this._lookZone.removeEventListener('pointermove', this._onPointerMove);
    this._lookZone.removeEventListener('pointerup', this._onPointerEnd);
    this._lookZone.removeEventListener('pointercancel', this._onPointerEnd);

    for (const [btn, onDown] of this._buttonDownHandlers.entries()) {
      btn.removeEventListener('pointerdown', onDown);
      btn.removeEventListener('pointerup', this._onPointerEnd);
      btn.removeEventListener('pointercancel', this._onPointerEnd);
    }
    this._buttonDownHandlers.clear();

    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', this._onPointerMove);
      window.removeEventListener('pointerup', this._onPointerEnd);
      window.removeEventListener('pointercancel', this._onPointerEnd);
      window.removeEventListener('blur', this._onBlur);
    }

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }

    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
  }
}
