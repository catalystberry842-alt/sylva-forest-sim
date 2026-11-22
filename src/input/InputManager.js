import { clamp } from '../utils/random.js';

const WHEEL_LINE_HEIGHT_PX = 16;
const WHEEL_PAGE_HEIGHT_PX = 100;
const DEFAULT_WHEEL_ZOOM_SENSITIVITY = 0.0045;
const POINTER_LOCK_CLICK_MAX_DIST_SQ = 25; // < 5px drag counts as a clean click

/**
 * Checks whether a DOM element is an editable text field where keyboard
 * movement/action hotkeys must be ignored.
 */
function isEditableTarget(el) {
  if (!el) return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  if (typeof el.getAttribute === 'function') {
    const attr = el.getAttribute('contenteditable');
    if (attr === '' || attr === 'true' || attr === 'plaintext-only') return true;
  }
  return false;
}

/**
 * Unified, device-agnostic input intent layer merging Keyboard, Mouse,
 * Pointer Lock, Wheel, and Multi-Touch Pointer inputs (via MobileControls).
 *
 * Coordinate convention for `getMoveIntent()`:
 * - `forward`: +1 = W / ArrowUp / thumbstick up, -1 = S / ArrowDown / thumbstick down
 * - `right`:   +1 = D / ArrowRight / thumbstick right, -1 = A / ArrowLeft / thumbstick left
 * - `magnitude`: clamped to [0, 1]
 * - `isAnalog`: true when driven solely by analog touch stick input
 *
 * Note for HumanController integration:
 * In right-handed Three.js space with `_up = (0, 1, 0)`, `_up.cross(_forward)` points
 * camera-LEFT, while `_forward.cross(_up)` points camera-RIGHT. Multiply camera-RIGHT
 * by `+intent.right` (or `_up.cross(_forward)` by `-intent.right`).
 */
export class InputManager {
  constructor(domElement, callbacks = {}) {
    this.domElement = domElement || null;
    this.callbacks = callbacks || {};

    this._wheelZoomSensitivity =
      typeof callbacks.wheelZoomSensitivity === 'number'
        ? callbacks.wheelZoomSensitivity
        : DEFAULT_WHEEL_ZOOM_SENSITIVITY;

    // Digital keyboard movement & sprint state
    this._keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      sprint: false,
    };

    // Crouch states (keyboard toggle, keyboard hold, mobile touch toggle)
    this._crouchToggled = false;
    this._crouchHeld = false;
    this._touchCrouch = false;

    // Multi-touch analog movement & sprint states (fed from MobileControls)
    this._touchMoveX = 0;
    this._touchMoveY = 0;
    this._touchAutoSprint = false;
    this._touchSprint = false;

    // Unified look & zoom accumulators (consumed per frame by HumanController)
    this._lookDeltaX = 0;
    this._lookDeltaY = 0;
    this._zoomDelta = 0;

    // Mouse drag & pointer-lock state
    this._isDraggingMouse = false;
    this._mousePointerId = null;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._lastMouseX = 0;
    this._lastMouseY = 0;
    this._isPointerLocked = false;

    // One-shot first user gesture notification (e.g., Web Audio unlock)
    this._firstGestureFired = false;
    this._disposed = false;

    this._bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  _getCameraMode() {
    return this.callbacks.getCameraMode?.() ?? 'Third-Person';
  }

  _notifyFirstGesture() {
    if (this._firstGestureFired) return;
    this._firstGestureFired = true;
    this.callbacks.onFirstUserGesture?.();
  }

  _isMouseEvent(e) {
    return e.pointerType === undefined || e.pointerType === 'mouse';
  }

  _notifyCrouchIfChanged(wasCrouching) {
    const nowCrouching = this.isCrouching();
    if (nowCrouching !== wasCrouching) {
      this.callbacks.onCrouchChange?.(nowCrouching);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM Event Listeners
  // ---------------------------------------------------------------------------

  _bindEvents() {
    this._onKeyDown = (e) => {
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      if (isEditableTarget(activeEl) || isEditableTarget(e.target)) return;

      this._notifyFirstGesture();

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
          e.preventDefault?.();
          if (!e.repeat) {
            this.callbacks.onJump?.();
          }
          break;
        case 'KeyC':
          if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const wasCrouching = this.isCrouching();
            if (this._crouchToggled || this._touchCrouch) {
              this._crouchToggled = false;
              this._touchCrouch = false;
            } else {
              this._crouchToggled = true;
            }
            this._notifyCrouchIfChanged(wasCrouching);
          }
          break;
        case 'ControlLeft':
        case 'ControlRight': {
          const wasCrouching = this.isCrouching();
          this._crouchHeld = true;
          this._notifyCrouchIfChanged(wasCrouching);
          break;
        }
        case 'KeyR':
          if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
            this.callbacks.onRatScare?.();
          }
          break;
        case 'KeyV':
          if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
            this.callbacks.onCameraCycle?.();
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
        case 'ControlRight': {
          const wasCrouching = this.isCrouching();
          this._crouchHeld = false;
          this._notifyCrouchIfChanged(wasCrouching);
          break;
        }
        default:
          break;
      }
    };

    this._onPointerDown = (e) => {
      if (!this._isMouseEvent(e)) return;
      if (e.button !== 0) return;

      this._notifyFirstGesture();
      if (this._getCameraMode() === 'Free Orbit') return;

      this._isDraggingMouse = true;
      this._mousePointerId = e.pointerId !== undefined ? e.pointerId : null;
      this._dragStartX = e.clientX || 0;
      this._dragStartY = e.clientY || 0;
      this._lastMouseX = this._dragStartX;
      this._lastMouseY = this._dragStartY;
    };

    this._onPointerMove = (e) => {
      if (!this._isMouseEvent(e)) return;
      if (this._getCameraMode() === 'Free Orbit') return;

      if (this._isPointerLocked) {
        const dx = Number.isFinite(e.movementX) ? e.movementX : 0;
        const dy = Number.isFinite(e.movementY) ? e.movementY : 0;
        this._lookDeltaX += dx;
        this._lookDeltaY += dy;
      } else if (this._isDraggingMouse) {
        if (this._mousePointerId !== null && e.pointerId !== undefined && e.pointerId !== this._mousePointerId) {
          return;
        }
        const cx = e.clientX || 0;
        const cy = e.clientY || 0;
        this._lookDeltaX += cx - this._lastMouseX;
        this._lookDeltaY += cy - this._lastMouseY;
        this._lastMouseX = cx;
        this._lastMouseY = cy;
      }
    };

    this._onPointerUp = (e) => {
      if (!this._isMouseEvent(e)) return;
      if (!this._isDraggingMouse) return;
      if (e.type === 'pointerup' && e.button !== undefined && e.button !== 0) return;
      if (this._mousePointerId !== null && e.pointerId !== undefined && e.pointerId !== this._mousePointerId) {
        return;
      }

      if (
        e.type === 'pointerup' &&
        this._getCameraMode() === 'First-Person Body' &&
        !this._isPointerLocked
      ) {
        const dx = (e.clientX || 0) - this._dragStartX;
        const dy = (e.clientY || 0) - this._dragStartY;
        if (dx * dx + dy * dy < POINTER_LOCK_CLICK_MAX_DIST_SQ && !this.callbacks.isHoveringInteractive?.()) {
          try {
            const p = this.domElement?.requestPointerLock?.();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {
            // Ignore browser pointer lock rejection
          }
        }
      }

      this._isDraggingMouse = false;
      this._mousePointerId = null;
    };

    this._onWheel = (e) => {
      if (this._getCameraMode() !== 'Third-Person') return;
      if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return;

      e.preventDefault?.();
      this._notifyFirstGesture();

      let deltaPx = e.deltaY;
      if (e.deltaMode === 1) deltaPx *= WHEEL_LINE_HEIGHT_PX;
      else if (e.deltaMode === 2) deltaPx *= WHEEL_PAGE_HEIGHT_PX;

      this._zoomDelta += deltaPx * this._wheelZoomSensitivity;
    };

    this._onPointerLockChange = () => {
      const lockEl = typeof document !== 'undefined' ? document.pointerLockElement : null;
      const locked = Boolean(this.domElement && lockEl === this.domElement);
      this._isPointerLocked = locked;
      if (locked) {
        this._isDraggingMouse = false;
        this._mousePointerId = null;
      }
      this.callbacks.onPointerLockChange?.(this._isPointerLocked);
    };

    this._onBlur = () => {
      this.resetTransientState();
    };

    this._onVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden || document.visibilityState === 'hidden') {
        this.resetTransientState();
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);
      window.addEventListener('pointercancel', this._onPointerUp);
      window.addEventListener('blur', this._onBlur);
    }

    if (this.domElement) {
      this.domElement.addEventListener('pointerdown', this._onPointerDown);
      this.domElement.addEventListener('wheel', this._onWheel, { passive: false });
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('pointerlockchange', this._onPointerLockChange);
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
  }

  // ---------------------------------------------------------------------------
  // Safety Reset
  // ---------------------------------------------------------------------------

  /**
   * Immediately clears all held keys, touch thumbstick, touch sprint, mouse
   * drag states, and pending look/zoom deltas so stuck movement never occurs.
   */
  resetTransientState() {
    const wasCrouching = this.isCrouching();

    this._keys.forward = false;
    this._keys.backward = false;
    this._keys.left = false;
    this._keys.right = false;
    this._keys.sprint = false;
    this._crouchHeld = false;

    this._touchMoveX = 0;
    this._touchMoveY = 0;
    this._touchAutoSprint = false;
    this._touchSprint = false;

    this._isDraggingMouse = false;
    this._mousePointerId = null;
    this._lookDeltaX = 0;
    this._lookDeltaY = 0;
    this._zoomDelta = 0;

    this._notifyCrouchIfChanged(wasCrouching);
  }

  // ---------------------------------------------------------------------------
  // Multi-Touch Inputs (fed from MobileControls)
  // ---------------------------------------------------------------------------

  /**
   * Sets analog touch thumbstick vector.
   * @param {number} x Right-positive in [-1, 1]
   * @param {number} y Forward-positive in [-1, 1]
   * @param {boolean} [autoSprint=false] True when stick is pushed into outer sprint rim
   */
  setTouchMove(x, y, autoSprint = false) {
    let nx = Number.isFinite(x) ? clamp(x, -1, 1) : 0;
    let ny = Number.isFinite(y) ? clamp(y, -1, 1) : 0;

    const mag = Math.hypot(nx, ny);
    if (mag > 1.0) {
      nx /= mag;
      ny /= mag;
    }

    this._touchMoveX = nx;
    this._touchMoveY = ny;
    this._touchAutoSprint = Boolean(autoSprint);

    if (mag > 0) {
      this._notifyFirstGesture();
    }
  }

  addTouchLookDelta(dx, dy) {
    const safeDx = Number.isFinite(dx) ? dx : 0;
    const safeDy = Number.isFinite(dy) ? dy : 0;
    if (safeDx === 0 && safeDy === 0) return;

    this._notifyFirstGesture();
    this._lookDeltaX += safeDx;
    this._lookDeltaY += safeDy;
  }

  addPinchZoom(delta) {
    if (!Number.isFinite(delta) || delta === 0) return;
    this._notifyFirstGesture();
    this._zoomDelta += delta;
  }

  setTouchSprint(active) {
    const next = Boolean(active);
    this._touchSprint = next;
    if (next) {
      this._notifyFirstGesture();
    }
  }

  triggerJump() {
    this._notifyFirstGesture();
    this.callbacks.onJump?.();
  }

  toggleCrouch() {
    this._notifyFirstGesture();
    const wasCrouching = this.isCrouching();
    if (this._crouchToggled || this._touchCrouch) {
      this._crouchToggled = false;
      this._touchCrouch = false;
    } else {
      this._touchCrouch = true;
    }
    this._notifyCrouchIfChanged(wasCrouching);
  }

  triggerRatScare() {
    this._notifyFirstGesture();
    this.callbacks.onRatScare?.();
  }

  triggerCameraCycle() {
    this._notifyFirstGesture();
    this.callbacks.onCameraCycle?.();
  }

  // ---------------------------------------------------------------------------
  // Unified Query API (consumed by HumanController)
  // ---------------------------------------------------------------------------

  getMoveIntent(target = { forward: 0, right: 0, magnitude: 0, isAnalog: false }) {
    let keyF = (this._keys.forward ? 1 : 0) - (this._keys.backward ? 1 : 0);
    let keyR = (this._keys.right ? 1 : 0) - (this._keys.left ? 1 : 0);
    const keyMag = Math.hypot(keyR, keyF);
    if (keyMag > 1.0) {
      keyF /= keyMag;
      keyR /= keyMag;
    }

    const touchF = this._touchMoveY;
    const touchR = this._touchMoveX;
    const touchMag = Math.hypot(touchR, touchF);

    const hasKey = keyMag > 1e-5;
    const hasTouch = touchMag > 1e-5;

    let forward = 0;
    let right = 0;
    let magnitude = 0;
    let isAnalog = false;

    if (hasKey && !hasTouch) {
      forward = keyF;
      right = keyR;
      magnitude = Math.min(1.0, Math.hypot(right, forward));
      isAnalog = false;
    } else if (!hasKey && hasTouch) {
      forward = touchF;
      right = touchR;
      magnitude = Math.min(1.0, touchMag);
      if (touchMag > 1.0) {
        forward /= touchMag;
        right /= touchMag;
      }
      isAnalog = true;
    } else if (hasKey && hasTouch) {
      forward = keyF + touchF;
      right = keyR + touchR;
      const combinedMag = Math.hypot(right, forward);
      if (combinedMag > 1.0) {
        forward /= combinedMag;
        right /= combinedMag;
        magnitude = 1.0;
      } else {
        magnitude = combinedMag;
      }
      isAnalog = false;
    }

    target.forward = forward;
    target.right = right;
    target.magnitude = magnitude;
    target.isAnalog = isAnalog;
    return target;
  }

  isSprinting() {
    return Boolean(this._keys.sprint || this._touchSprint || this._touchAutoSprint);
  }

  isCrouching() {
    return Boolean(this._crouchToggled || this._crouchHeld || this._touchCrouch);
  }

  setCrouchToggled(bool) {
    const wasCrouching = this.isCrouching();
    const next = Boolean(bool);
    this._crouchToggled = next;
    if (!next) {
      this._touchCrouch = false;
    }
    this._notifyCrouchIfChanged(wasCrouching);
  }

  consumeLookDelta(target = { dx: 0, dy: 0 }) {
    target.dx = this._lookDeltaX;
    target.dy = this._lookDeltaY;
    this._lookDeltaX = 0;
    this._lookDeltaY = 0;
    return target;
  }

  consumeZoomDelta() {
    const delta = this._zoomDelta;
    this._zoomDelta = 0;
    return delta;
  }

  isPointerLocked() {
    return this._isPointerLocked;
  }

  isTouchDevice() {
    if (typeof window === 'undefined') return false;
    const hasTouchStart = 'ontouchstart' in window;
    const hasTouchPoints = typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0;
    const hasCoarsePointer = Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
    return hasTouchStart || hasTouchPoints || hasCoarsePointer;
  }

  /**
   * Programmatic input override for automated testing and scripted demos.
   */
  setVirtualInput(partial = {}) {
    if (!partial || typeof partial !== 'object') return;

    if ('forward' in partial) this._keys.forward = Boolean(partial.forward);
    if ('backward' in partial) this._keys.backward = Boolean(partial.backward);
    if ('left' in partial) this._keys.left = Boolean(partial.left);
    if ('right' in partial) this._keys.right = Boolean(partial.right);
    if ('sprint' in partial) this._keys.sprint = Boolean(partial.sprint);
    if ('touchSprint' in partial) this._touchSprint = Boolean(partial.touchSprint);

    if ('crouchToggled' in partial) {
      this.setCrouchToggled(Boolean(partial.crouchToggled));
    }
    if ('crouchHeld' in partial) {
      const was = this.isCrouching();
      this._crouchHeld = Boolean(partial.crouchHeld);
      this._notifyCrouchIfChanged(was);
    }
    if ('touchCrouch' in partial) {
      const was = this.isCrouching();
      this._touchCrouch = Boolean(partial.touchCrouch);
      this._notifyCrouchIfChanged(was);
    }

    if ('touchMoveX' in partial || 'touchMoveY' in partial || 'touchAutoSprint' in partial) {
      this.setTouchMove(
        'touchMoveX' in partial ? partial.touchMoveX : this._touchMoveX,
        'touchMoveY' in partial ? partial.touchMoveY : this._touchMoveY,
        'touchAutoSprint' in partial ? partial.touchAutoSprint : this._touchAutoSprint
      );
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('pointermove', this._onPointerMove);
      window.removeEventListener('pointerup', this._onPointerUp);
      window.removeEventListener('pointercancel', this._onPointerUp);
      window.removeEventListener('blur', this._onBlur);
    }

    if (this.domElement) {
      this.domElement.removeEventListener('pointerdown', this._onPointerDown);
      this.domElement.removeEventListener('wheel', this._onWheel);
    }

    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerlockchange', this._onPointerLockChange);
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }

    this.resetTransientState();
    this._isPointerLocked = false;
  }
}
