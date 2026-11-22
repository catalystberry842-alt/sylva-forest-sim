import { clamp, lerp } from '../utils/random.js';

/**
 * Pure Web Audio API real-time procedural forest soundscape synthesizer.
 * Generates seamless looping pink/brown noise beds, gust-modulated canopy wind,
 * distance-attenuated babbling stream + bubbles, forest rain, crackling campfire,
 * FM-synthesized daytime bird chirps (plus startle burst + wing flutter),
 * and rhythmic nighttime cricket chorus — with zero external audio files.
 */
export class ProceduralAudio {
  constructor(options = {}) {
    this._muted = true;
    this._volume = clamp(options.volume ?? 0.72, 0, 1);
    this._ctx = null;
    this._initialized = false;
    this._disposed = false;

    // Continuous DSP nodes
    this._mixBus = null;
    this._compressor = null;
    this._masterGain = null;
    this._sources = [];
    this._lfos = [];

    // Reusable noise buffers
    this._pinkBuffer = null;
    this._brownBuffer = null;
    this._crackleBuffer = null;
    this._whiteBuffer = null;

    // Wind nodes
    this._windRoarFilter = null;
    this._windRoarGain = null;
    this._windRustleFilter = null;
    this._windRustleGain = null;

    // Stream nodes
    this._streamGain = null;

    // Rain nodes
    this._rainHighFilter = null;
    this._rainGain = null;
    this._rainBodyGain = null;

    // Campfire rumble node
    this._fireRumbleGain = null;

    // Acoustic zone ('outdoor' | 'wood' | 'cave') shelter muffling & cavern echo bus
    this._acousticZone = 'outdoor';
    this._outdoorShelterFilter = null;
    this._outdoorShelterGain = null;
    this._caveSendGain = null;
    this._caveDelay = null;
    this._caveLowpass = null;
    this._caveFeedbackGain = null;
    this._caveWetGain = null;

    // Stochastic event schedulers
    this._nextCrackleTimer = 0.08;
    this._nextBubbleTimer = 0.22;
    this._nextBirdTimer = 1.6;
    this._nextCricketTimer = 0.45;

    // Character footsteps, breathing/panting & panic heartbeat schedulers
    this._footstepSide = 1;
    this._breathTimer = 0.22;
    this._breathIsInhale = true;
    this._heartbeatTimer = 0.12;
    this._heartbeatGain = 0.0;
  }

  /**
   * Creates or resumes the Web Audio context cleanly on a user gesture.
   * Never throws if the browser restricts autoplay before interaction.
   */
  unlock() {
    if (this._disposed) return false;

    if (!this._initialized) {
      const AudioCtx =
        (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) ||
        globalThis.AudioContext ||
        globalThis.webkitAudioContext;
      if (!AudioCtx) return false;
      try {
        this._ctx = new AudioCtx();
        this._initGraph();
        this._initialized = true;
      } catch {
        return false;
      }
    }

    if (this._ctx && this._ctx.state === 'suspended') {
      try {
        const p = this._ctx.resume();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {});
        }
      } catch {
        // Ignore browser autoplay block until next gesture
      }
    }

    this._applyMasterGain(0.08);
    return true;
  }

  setMuted(muted) {
    this._muted = Boolean(muted);
    if (!this._muted) {
      this.unlock();
    }
    this._applyMasterGain(0.09);
    return this._muted;
  }

  toggleMute() {
    return this.setMuted(!this._muted);
  }

  isMuted() {
    return this._muted;
  }

  setVolume(v) {
    this._volume = clamp(Number(v) || 0, 0, 1);
    this._applyMasterGain(0.05);
  }

  getVolume() {
    return this._volume;
  }

  /**
   * Switches acoustic environment zone ('outdoor' | 'wood' | 'cave'):
   * - 'outdoor': full crisp canopy wind & rain, dry one-shots
   * - 'wood': softly dampens outdoor wind & rain (~0.42x) with warm timber shelter muffling
   * - 'cave': muffles outdoor wind & rain and routes footsteps/gasp/thunder into a warm
   *   stone cavern feedback-delay echo (delay 0.16s, lowpass 1800 Hz, feedback 0.36, wet 0.42)
   */
  setAcousticZone(zone = 'outdoor') {
    const raw = String(zone || 'outdoor').toLowerCase();
    const normalized =
      raw === 'cave' || raw === 'cavern'
        ? 'cave'
        : raw === 'wood' || raw === 'cabin' || raw === 'redwood' || raw === 'indoor'
          ? 'wood'
          : 'outdoor';

    this._acousticZone = normalized;
    this._applyAcousticZone(0.18);
    return this._acousticZone;
  }

  getAcousticZone() {
    return this._acousticZone;
  }

  _applyAcousticZone(tau = 0.18) {
    if (!this._ctx) return;
    const now = this._ctx.currentTime;
    const zone = this._acousticZone;

    let outdoorGain = 1.0;
    let outdoorCutoff = 18000;
    let caveSend = 0.0;
    let caveWet = 0.0;

    if (zone === 'wood') {
      outdoorGain = 0.42;
      outdoorCutoff = 2200;
    } else if (zone === 'cave') {
      outdoorGain = 0.28;
      outdoorCutoff = 980;
      caveSend = 1.0;
      caveWet = 0.42;
    }

    if (this._outdoorShelterGain) {
      this._outdoorShelterGain.gain.setTargetAtTime(outdoorGain, now, tau);
    }
    if (this._outdoorShelterFilter) {
      this._outdoorShelterFilter.frequency.setTargetAtTime(outdoorCutoff, now, tau);
    }
    if (this._caveSendGain) {
      this._caveSendGain.gain.setTargetAtTime(caveSend, now, Math.min(tau, 0.08));
    }
    if (this._caveWetGain) {
      this._caveWetGain.gain.setTargetAtTime(caveWet, now, tau);
    }
  }

  _applyMasterGain(tau = 0.08) {
    if (!this._ctx || !this._masterGain) return;
    const now = this._ctx.currentTime;
    const target = this._muted ? 0.0 : this._volume;
    this._masterGain.gain.setTargetAtTime(target, now, tau);
  }

  _initGraph() {
    const ctx = this._ctx;
    const now = ctx.currentTime;

    // Master mix -> gentle dynamics limiter -> master volume -> speakers
    this._mixBus = ctx.createGain();
    this._mixBus.gain.value = 0.95;

    this._compressor = ctx.createDynamicsCompressor();
    this._compressor.threshold.setValueAtTime(-10, now);
    this._compressor.knee.setValueAtTime(16, now);
    this._compressor.ratio.setValueAtTime(4, now);
    this._compressor.attack.setValueAtTime(0.008, now);
    this._compressor.release.setValueAtTime(0.18, now);

    this._masterGain = ctx.createGain();
    this._masterGain.gain.setValueAtTime(0.0, now);

    this._mixBus.connect(this._compressor);
    this._compressor.connect(this._masterGain);
    this._masterGain.connect(ctx.destination);

    // Outdoor weather shelter sub-bus (muffles & dampens wind & rain in wood/cave zones)
    this._outdoorShelterFilter = ctx.createBiquadFilter();
    this._outdoorShelterFilter.type = 'lowpass';
    this._outdoorShelterFilter.frequency.setValueAtTime(18000, now);
    this._outdoorShelterFilter.Q.setValueAtTime(0.7, now);

    this._outdoorShelterGain = ctx.createGain();
    this._outdoorShelterGain.gain.setValueAtTime(1.0, now);

    this._outdoorShelterFilter.connect(this._outdoorShelterGain);
    this._outdoorShelterGain.connect(this._mixBus);

    // Stone cavern warm feedback-delay echo bus (delay 0.16s, lowpass 1800 Hz, feedback 0.36, wet 0.42)
    if (typeof ctx.createDelay === 'function') {
      this._caveSendGain = ctx.createGain();
      this._caveSendGain.gain.setValueAtTime(0.0, now);

      this._caveDelay = ctx.createDelay(1.0);
      this._caveDelay.delayTime.setValueAtTime(0.16, now);

      this._caveLowpass = ctx.createBiquadFilter();
      this._caveLowpass.type = 'lowpass';
      this._caveLowpass.frequency.setValueAtTime(1800, now);
      this._caveLowpass.Q.setValueAtTime(0.7, now);

      this._caveFeedbackGain = ctx.createGain();
      this._caveFeedbackGain.gain.setValueAtTime(0.36, now);

      this._caveWetGain = ctx.createGain();
      this._caveWetGain.gain.setValueAtTime(0.0, now);

      this._caveSendGain.connect(this._caveDelay);
      this._caveDelay.connect(this._caveLowpass);
      this._caveLowpass.connect(this._caveFeedbackGain);
      this._caveFeedbackGain.connect(this._caveDelay);
      this._caveLowpass.connect(this._caveWetGain);
      this._caveWetGain.connect(this._mixBus);
    }

    // Pre-generate seamless looping 4-second noise buffers & transient burst buffers
    this._pinkBuffer = this._createSeamlessPinkBuffer(4.0);
    this._brownBuffer = this._createSeamlessBrownBuffer(4.0);
    this._crackleBuffer = this._createShortNoiseBuffer(0.08);
    this._whiteBuffer = this._createShortNoiseBuffer(0.6);

    // 1. Deep Forest Canopy Wind Roar (brown noise -> resonant lowpass 180–520 Hz)
    const windRoarSrc = this._createLoopingSource(this._brownBuffer, 0.0);
    this._windRoarFilter = ctx.createBiquadFilter();
    this._windRoarFilter.type = 'lowpass';
    this._windRoarFilter.frequency.setValueAtTime(240, now);
    this._windRoarFilter.Q.setValueAtTime(1.15, now);

    this._windRoarGain = ctx.createGain();
    this._windRoarGain.gain.setValueAtTime(0.06, now);

    windRoarSrc.connect(this._windRoarFilter);
    this._windRoarFilter.connect(this._windRoarGain);
    this._windRoarGain.connect(this._outdoorShelterFilter);

    // 2. Airy Foliage Wind Rustle (pink noise -> bandpass 700–2400 Hz, Q 1.4)
    const windRustleSrc = this._createLoopingSource(this._pinkBuffer, 1.45);
    this._windRustleFilter = ctx.createBiquadFilter();
    this._windRustleFilter.type = 'bandpass';
    this._windRustleFilter.frequency.setValueAtTime(1100, now);
    this._windRustleFilter.Q.setValueAtTime(1.4, now);

    this._windRustleGain = ctx.createGain();
    this._windRustleGain.gain.setValueAtTime(0.03, now);

    windRustleSrc.connect(this._windRustleFilter);
    this._windRustleFilter.connect(this._windRustleGain);
    this._windRustleGain.connect(this._outdoorShelterFilter);

    // 3. Babbling Forest Stream (pink noise -> dual LFO-modulated resonant bandpasses)
    const streamSrc = this._createLoopingSource(this._pinkBuffer, 0.65);

    const streamBandA = ctx.createBiquadFilter();
    streamBandA.type = 'bandpass';
    streamBandA.frequency.setValueAtTime(650, now);
    streamBandA.Q.setValueAtTime(2.6, now);

    const streamBandB = ctx.createBiquadFilter();
    streamBandB.type = 'bandpass';
    streamBandB.frequency.setValueAtTime(1550, now);
    streamBandB.Q.setValueAtTime(3.1, now);

    const streamBandBGain = ctx.createGain();
    streamBandBGain.gain.value = 0.62;

    // Gentle LFOs sweeping the two resonant stream formants
    const lfoA = ctx.createOscillator();
    lfoA.type = 'sine';
    lfoA.frequency.setValueAtTime(0.37, now);
    const lfoAGain = ctx.createGain();
    lfoAGain.gain.setValueAtTime(135, now);
    lfoA.connect(lfoAGain);
    lfoAGain.connect(streamBandA.frequency);
    lfoA.start(now);

    const lfoB = ctx.createOscillator();
    lfoB.type = 'sine';
    lfoB.frequency.setValueAtTime(0.63, now);
    const lfoBGain = ctx.createGain();
    lfoBGain.gain.setValueAtTime(260, now);
    lfoB.connect(lfoBGain);
    lfoBGain.connect(streamBandB.frequency);
    lfoB.start(now);
    this._lfos.push(lfoA, lfoB);

    this._streamGain = ctx.createGain();
    this._streamGain.gain.setValueAtTime(0.0, now);

    streamSrc.connect(streamBandA);
    streamSrc.connect(streamBandB);
    streamBandA.connect(this._streamGain);
    streamBandB.connect(streamBandBGain);
    streamBandBGain.connect(this._streamGain);
    this._streamGain.connect(this._mixBus);

    // 4. Forest Rain Patter (high-passed & band-passed pink noise 1800–4500 Hz + soft wash)
    const rainSrc = this._createLoopingSource(this._pinkBuffer, 2.75);

    const rainHP = ctx.createBiquadFilter();
    rainHP.type = 'highpass';
    rainHP.frequency.setValueAtTime(1250, now);

    this._rainHighFilter = ctx.createBiquadFilter();
    this._rainHighFilter.type = 'bandpass';
    this._rainHighFilter.frequency.setValueAtTime(2700, now);
    this._rainHighFilter.Q.setValueAtTime(0.75, now);

    this._rainGain = ctx.createGain();
    this._rainGain.gain.setValueAtTime(0.0, now);

    rainSrc.connect(rainHP);
    rainHP.connect(this._rainHighFilter);
    this._rainHighFilter.connect(this._rainGain);
    this._rainGain.connect(this._outdoorShelterFilter);

    const rainBodyFilter = ctx.createBiquadFilter();
    rainBodyFilter.type = 'lowpass';
    rainBodyFilter.frequency.setValueAtTime(880, now);

    this._rainBodyGain = ctx.createGain();
    this._rainBodyGain.gain.setValueAtTime(0.0, now);

    rainSrc.connect(rainBodyFilter);
    rainBodyFilter.connect(this._rainBodyGain);
    this._rainBodyGain.connect(this._outdoorShelterFilter);

    // 5. Campfire Warm Low Rumble
    const fireSrc = this._createLoopingSource(this._brownBuffer, 2.15);
    const fireFilter = ctx.createBiquadFilter();
    fireFilter.type = 'bandpass';
    fireFilter.frequency.setValueAtTime(118, now);
    fireFilter.Q.setValueAtTime(0.85, now);

    this._fireRumbleGain = ctx.createGain();
    this._fireRumbleGain.gain.setValueAtTime(0.0, now);

    fireSrc.connect(fireFilter);
    fireFilter.connect(this._fireRumbleGain);
    this._fireRumbleGain.connect(this._mixBus);

    // Apply any acoustic zone configured before audio unlock
    this._applyAcousticZone(0.02);
  }

  _createLoopingSource(buffer, offsetSeconds = 0) {
    const src = this._ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const safeOffset = offsetSeconds % buffer.duration;
    src.start(this._ctx.currentTime, safeOffset);
    this._sources.push(src);
    return src;
  }

  /**
   * Generates a click-free looping pink noise buffer via Paul Kellet's filter
   * with an equal-power crossfade over the loop boundary.
   */
  _createSeamlessPinkBuffer(durationSec) {
    const sr = this._ctx.sampleRate;
    const length = Math.floor(sr * durationSec);
    const fadeLen = Math.floor(sr * 0.45);
    const raw = new Float32Array(length + fadeLen);

    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;

    for (let i = 0; i < raw.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      raw[i] = pink * 0.11;
    }

    const buffer = this._ctx.createBuffer(1, length, sr);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      if (i < fadeLen) {
        const t = i / fadeLen;
        const wHead = Math.sin(t * Math.PI * 0.5);
        const wTail = Math.cos(t * Math.PI * 0.5);
        out[i] = clamp(raw[i] * wHead + raw[length + i] * wTail, -0.95, 0.95);
      } else {
        out[i] = clamp(raw[i], -0.95, 0.95);
      }
    }
    return buffer;
  }

  /**
   * Generates a click-free looping DC-blocked brown noise buffer.
   */
  _createSeamlessBrownBuffer(durationSec) {
    const sr = this._ctx.sampleRate;
    const length = Math.floor(sr * durationSec);
    const fadeLen = Math.floor(sr * 0.45);
    const raw = new Float32Array(length + fadeLen);

    let lastOut = 0;
    let dcPrevX = 0;
    let dcPrevY = 0;
    const dcR = 0.996;

    for (let i = 0; i < raw.length; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.022 * white) / 1.022;
      // Gentle high-pass DC blocker
      const y = lastOut - dcPrevX + dcR * dcPrevY;
      dcPrevX = lastOut;
      dcPrevY = y;
      raw[i] = y * 3.1;
    }

    const buffer = this._ctx.createBuffer(1, length, sr);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      if (i < fadeLen) {
        const t = i / fadeLen;
        const wHead = Math.sin(t * Math.PI * 0.5);
        const wTail = Math.cos(t * Math.PI * 0.5);
        out[i] = clamp(raw[i] * wHead + raw[length + i] * wTail, -0.95, 0.95);
      } else {
        out[i] = clamp(raw[i], -0.95, 0.95);
      }
    }
    return buffer;
  }

  _createShortNoiseBuffer(durationSec) {
    const sr = this._ctx.sampleRate;
    const length = Math.max(256, Math.floor(sr * durationSec));
    const buffer = this._ctx.createBuffer(1, length, sr);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  _createPanner(panValue) {
    if (typeof this._ctx.createStereoPanner === 'function') {
      const panner = this._ctx.createStereoPanner();
      panner.pan.setValueAtTime(clamp(panValue, -1, 1), this._ctx.currentTime);
      return panner;
    }
    return null;
  }

  _canPlayOneShots() {
    return (
      !this._disposed &&
      this._initialized &&
      !this._muted &&
      this._volume > 0.001 &&
      this._ctx !== null &&
      this._ctx.state === 'running'
    );
  }

  /**
   * Triggers a crisp randomized campfire ember snap / wood pop.
   */
  _triggerCampfireCrackle(attenuation) {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const isPop = Math.random() < 0.22;

    const src = ctx.createBufferSource();
    src.buffer = this._crackleBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = isPop ? 'bandpass' : 'highpass';
    filter.frequency.setValueAtTime(
      isPop ? 850 + Math.random() * 900 : 2400 + Math.random() * 3400,
      now
    );
    filter.Q.setValueAtTime(isPop ? 3.2 : 1.0, now);

    const env = ctx.createGain();
    const peak = (isPop ? 0.24 : 0.17) * (0.55 + Math.random() * 0.75) * attenuation;
    const dur = isPop ? 0.024 + Math.random() * 0.02 : 0.01 + Math.random() * 0.016;

    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(peak, now + 0.0018);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(filter);
    filter.connect(env);

    const panner = this._createPanner((Math.random() - 0.5) * 0.45);
    if (panner) {
      env.connect(panner);
      panner.connect(this._mixBus);
    } else {
      env.connect(this._mixBus);
    }

    src.start(now, Math.random() * 0.03, dur + 0.01);
    src.stop(now + dur + 0.015);
  }

  /**
   * Triggers a subtle rising water bubble blip for the babbling stream.
   */
  _triggerStreamBubble(attenuation) {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';

    const baseFreq = 460 + Math.random() * 780;
    const dur = 0.032 + Math.random() * 0.036;
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * (1.28 + Math.random() * 0.35), now + dur);

    const env = ctx.createGain();
    const peak = 0.024 * (0.6 + Math.random() * 0.7) * attenuation;
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(peak, now + 0.007);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(env);
    const panner = this._createPanner((Math.random() - 0.5) * 0.9);
    if (panner) {
      env.connect(panner);
      panner.connect(this._mixBus);
    } else {
      env.connect(this._mixBus);
    }

    osc.start(now);
    osc.stop(now + dur + 0.01);
  }

  /**
   * Schedules a single FM-synthesized melodic bird note at startTime.
   */
  _scheduleBirdNote(startTime, baseFreq, endFreq, dur, peakGain, pan) {
    const ctx = this._ctx;
    const carrier = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const env = ctx.createGain();

    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(baseFreq, startTime);
    carrier.frequency.exponentialRampToValueAtTime(Math.max(400, endFreq), startTime + dur);

    mod.type = 'sine';
    mod.frequency.setValueAtTime(baseFreq * (0.35 + Math.random() * 0.45), startTime);
    modGain.gain.setValueAtTime(baseFreq * (0.04 + Math.random() * 0.06), startTime);

    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(peakGain, startTime + Math.min(0.014, dur * 0.22));
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);

    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(env);

    const panner = this._createPanner(pan);
    if (panner) {
      env.connect(panner);
      panner.connect(this._mixBus);
    } else {
      env.connect(this._mixBus);
    }

    carrier.start(startTime);
    mod.start(startTime);
    carrier.stop(startTime + dur + 0.02);
    mod.stop(startTime + dur + 0.02);
  }

  /**
   * Plays a natural 2–4 note daytime woodland songbird phrase.
   */
  _triggerAmbientBirdChirp(gainScale = 1.0) {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const noteCount = 2 + Math.floor(Math.random() * 3); // 2..4 notes
    const pan = (Math.random() - 0.5) * 1.45;
    const rootFreq = 2050 + Math.random() * 1750; // 2050..3800 Hz
    let offset = 0;

    for (let i = 0; i < noteCount; i++) {
      const dur = 0.065 + Math.random() * 0.075;
      const fStart = clamp(rootFreq * (0.86 + Math.random() * 0.28), 1800, 4200);
      const sweepUp = Math.random() > 0.42;
      const fEnd = clamp(fStart * (sweepUp ? 1.12 + Math.random() * 0.16 : 0.78 + Math.random() * 0.14), 1650, 4400);
      const amp = (0.028 + Math.random() * 0.018) * gainScale;
      this._scheduleBirdNote(now + offset, fStart, fEnd, dur, amp, pan);
      offset += dur + 0.045 + Math.random() * 0.075;
    }
  }

  /**
   * Plays an immediate excited burst of 5–7 rapid chirps + soft wing-flutter
   * when the perched forest bird flock is startled into flight.
   */
  triggerBirdStartle() {
    if (!this._canPlayOneShots()) return;

    const ctx = this._ctx;
    const now = ctx.currentTime;
    const chirpCount = 5 + Math.floor(Math.random() * 3); // 5..7 chirps

    for (let i = 0; i < chirpCount; i++) {
      const t = now + i * (0.048 + Math.random() * 0.04) + Math.random() * 0.02;
      const f0 = 2350 + Math.random() * 1650;
      const f1 = clamp(f0 * (Math.random() > 0.35 ? 1.18 : 0.82), 1900, 4500);
      const dur = 0.045 + Math.random() * 0.04;
      const pan = (Math.random() - 0.5) * 1.3;
      this._scheduleBirdNote(t, f0, f1, dur, 0.042 + Math.random() * 0.016, pan);
    }

    // Soft rhythmic wing-flutter filtered pink noise burst
    const flutterSrc = ctx.createBufferSource();
    flutterSrc.buffer = this._pinkBuffer;

    const flutterFilter = ctx.createBiquadFilter();
    flutterFilter.type = 'bandpass';
    flutterFilter.frequency.setValueAtTime(560, now);
    flutterFilter.frequency.exponentialRampToValueAtTime(340, now + 0.75);
    flutterFilter.Q.setValueAtTime(1.8, now);

    const flutterEnv = ctx.createGain();
    flutterEnv.gain.setValueAtTime(0.0001, now);

    const beats = 7;
    const beatStep = 0.085;
    for (let b = 0; b < beats; b++) {
      const bt = now + b * beatStep;
      const decay = 1.0 - (b / beats) * 0.78;
      flutterEnv.gain.linearRampToValueAtTime(0.11 * decay, bt + 0.022);
      flutterEnv.gain.exponentialRampToValueAtTime(0.004 * decay + 0.0005, bt + beatStep * 0.92);
    }
    flutterEnv.gain.exponentialRampToValueAtTime(0.0001, now + beats * beatStep + 0.08);

    flutterSrc.connect(flutterFilter);
    flutterFilter.connect(flutterEnv);
    flutterEnv.connect(this._mixBus);

    flutterSrc.start(now, Math.random() * 2.5, beats * beatStep + 0.12);
    flutterSrc.stop(now + beats * beatStep + 0.14);
  }

  /**
   * Schedules a rhythmic nighttime cricket chirp (~4300 Hz & ~4650 Hz
   * amplitude-modulated at ~14 Hz in ~0.35 s bursts).
   */
  _triggerCricketBurst(intensity) {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const useHighVoice = Math.random() > 0.45;
    const carrierFreq = (useHighVoice ? 4650 : 4300) + (Math.random() - 0.5) * 90;
    const burstDur = 0.32 + Math.random() * 0.07; // ~0.35 s burst
    const pulseFreq = 13.5 + Math.random() * 1.4; // ~14 Hz rhythmic pulse
    const pulseCount = Math.max(4, Math.round(burstDur * pulseFreq));
    const step = burstDur / pulseCount;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(carrierFreq, now);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);

    const peak = (0.015 + Math.random() * 0.009) * intensity;
    for (let p = 0; p < pulseCount; p++) {
      const pt = now + p * step;
      const bell = Math.sin(((p + 0.5) / pulseCount) * Math.PI);
      const pAmp = Math.max(0.0005, peak * (0.45 + 0.55 * bell));
      env.gain.linearRampToValueAtTime(pAmp, pt + step * 0.28);
      env.gain.exponentialRampToValueAtTime(0.0002, pt + step * 0.88);
    }
    env.gain.setValueAtTime(0.0001, now + burstDur + 0.01);

    osc.connect(env);
    const panner = this._createPanner((Math.random() - 0.5) * 1.5);
    if (panner) {
      env.connect(panner);
      panner.connect(this._mixBus);
    } else {
      env.connect(this._mixBus);
    }

    osc.start(now);
    osc.stop(now + burstDur + 0.03);
  }

  /**
   * Updates all procedural soundscape layers in real time from world state.
   */
  update(dt, elapsed, state = {}) {
    if (this._disposed || !this._initialized || !this._ctx) return;

    const {
      gustIntensity = 0.4,
      windSpeed = 1.0,
      streamDistance = 24,
      campfireDistance = 12,
      campfireLit = true,
      daylight = 0.8,
      nightFactor = 0.0,
      rainIntensity = 0.0,
    } = state;

    const now = this._ctx.currentTime;
    const safeDt = clamp(dt || 0.016, 0.001, 0.1);

    // 1. Wind Gust Soundscape (deep canopy roar + airy foliage rustle)
    const windEnergy = clamp(gustIntensity * 0.65 + windSpeed * 0.38, 0.0, 3.8);
    const normWind = clamp(windEnergy / 2.6, 0.0, 1.0);

    const roarFreq = lerp(180, 520, normWind);
    const roarGain = lerp(0.035, 0.34, Math.pow(normWind, 1.15));
    this._windRoarFilter.frequency.setTargetAtTime(roarFreq, now, 0.18);
    this._windRoarGain.gain.setTargetAtTime(roarGain, now, 0.18);

    const rustleFreq = lerp(700, 2400, normWind);
    const rustleGain = lerp(0.014, 0.19, Math.pow(normWind, 1.25));
    this._windRustleFilter.frequency.setTargetAtTime(rustleFreq, now, 0.14);
    this._windRustleGain.gain.setTargetAtTime(rustleGain, now, 0.16);

    // 2. Babbling Forest Stream (inverse-distance attenuation)
    const streamAtt = 1.0 / (1.0 + Math.pow(Math.max(0, streamDistance) / 12.0, 2));
    this._streamGain.gain.setTargetAtTime(streamAtt * 0.28, now, 0.12);

    // 3. Forest Rain Patter
    const rain = clamp(rainIntensity, 0, 1);
    const rainFreq = lerp(2200, 3900, clamp(rain * 0.7 + normWind * 0.3, 0, 1));
    this._rainHighFilter.frequency.setTargetAtTime(rainFreq, now, 0.2);
    this._rainGain.gain.setTargetAtTime(rain * 0.28, now, 0.25);
    this._rainBodyGain.gain.setTargetAtTime(rain * 0.08, now, 0.25);

    // 4. Campfire Warm Rumble + Crackle Attenuation
    const fireAtt =
      campfireLit && campfireDistance < 32
        ? (1.0 / (1.0 + Math.pow(Math.max(0, campfireDistance) / 8.5, 2))) *
          clamp(1.0 - campfireDistance / 32.0, 0, 1)
        : 0.0;
    this._fireRumbleGain.gain.setTargetAtTime(fireAtt * 0.24, now, 0.12);

    // Only schedule one-shot voices when audio is active & audible
    if (!this._canPlayOneShots()) return;

    // Campfire stochastic crisp crackle snaps (every 40–220 ms)
    if (fireAtt > 0.01) {
      this._nextCrackleTimer -= safeDt;
      if (this._nextCrackleTimer <= 0) {
        this._triggerCampfireCrackle(fireAtt);
        this._nextCrackleTimer = 0.04 + Math.random() * 0.18;
      }
    }

    // Stream soft bubble blips
    if (streamAtt > 0.06) {
      this._nextBubbleTimer -= safeDt;
      if (this._nextBubbleTimer <= 0) {
        this._triggerStreamBubble(streamAtt);
        this._nextBubbleTimer = 0.16 + Math.random() * 0.42;
      }
    }

    // Daytime melodic bird chirps (suppressed during heavy rain)
    const birdActivity = clamp((daylight - 0.35) / 0.45, 0, 1) * clamp(1.0 - rain * 1.15, 0, 1);
    if (birdActivity > 0.08) {
      this._nextBirdTimer -= safeDt * (0.65 + birdActivity * 0.65);
      if (this._nextBirdTimer <= 0) {
        this._triggerAmbientBirdChirp(0.55 + birdActivity * 0.45);
        this._nextBirdTimer = 2.6 + Math.random() * 4.4;
      }
    }

    // Nighttime cricket chorus (rhythmic 14 Hz pulses as nightFactor rises)
    const cricketActivity = clamp(nightFactor, 0, 1) * clamp(1.0 - rain * 0.75, 0.15, 1.0);
    if (cricketActivity > 0.08) {
      this._nextCricketTimer -= safeDt;
      if (this._nextCricketTimer <= 0) {
        this._triggerCricketBurst(cricketActivity);
        // Slightly denser overlapping chorus as night deepens
        this._nextCricketTimer = lerp(0.95, 0.42, cricketActivity) + Math.random() * 0.48;
      }
    }
  }

  _connectToMix(node, pan = 0.0, sendToCave = false) {
    const panner = Math.abs(pan) > 0.001 ? this._createPanner(pan) : null;
    if (panner) {
      node.connect(panner);
      panner.connect(this._mixBus);
      if (sendToCave && this._caveSendGain) {
        panner.connect(this._caveSendGain);
      }
    } else {
      node.connect(this._mixBus);
      if (sendToCave && this._caveSendGain) {
        node.connect(this._caveSendGain);
      }
    }
  }

  _scheduleDropletPing(startTime, baseFreq, peakGain, pan = 0.0, sendToCave = false) {
    const ctx = this._ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';

    const dur = 0.028 + Math.random() * 0.036;
    const f0 = clamp(baseFreq, 420, 4800);
    const f1 = clamp(f0 * (1.32 + Math.random() * 0.36), 560, 6800);
    osc.frequency.setValueAtTime(f0, startTime);
    osc.frequency.exponentialRampToValueAtTime(f1, startTime + dur);

    const env = ctx.createGain();
    const peak = Math.max(0.0005, peakGain);
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(peak, startTime + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);

    osc.connect(env);
    this._connectToMix(env, pan, sendToCave);

    osc.start(startTime);
    osc.stop(startTime + dur + 0.01);
  }

  /**
   * Synthesizes a surface-aware character footstep:
   * - 'wood': warm hollow timber plank resonance + boot sole tap
   * - 'bridge': deeper woody span thump + slight wooden plank creak
   * - 'stone': crisp hard-heel mineral tap + tight cavern stone click
   * - 'grass': soft filtered foliage rustle (900–2400 Hz) + muted low heel thud (~95 Hz)
   * - 'dirt' / 'rock': crisp gritty gravel crunch (1800–4200 Hz) + punchy footfall thump (~110 Hz)
   * - 'water': frothy bandpass splash burst (600–2800 Hz) + shimmering droplet tail
   */
  playFootstep({ surface = 'grass', intensity = 0.7 } = {}) {
    if (!this._canPlayOneShots()) return;

    const ctx = this._ctx;
    const now = ctx.currentTime;
    const inten = clamp(Number.isFinite(intensity) ? intensity : 0.7, 0.05, 1.5);
    const surf = String(surface || 'grass').toLowerCase();

    this._footstepSide = -this._footstepSide;
    const pan = this._footstepSide * 0.14 + (Math.random() - 0.5) * 0.06;

    if (surf === 'wood') {
      // 1. Warm hollow cabin floorboard timber resonance (primary + overtone body modes)
      const bodyOscA = ctx.createOscillator();
      bodyOscA.type = 'triangle';
      const baseFreq = 162 + (Math.random() - 0.5) * 26;
      bodyOscA.frequency.setValueAtTime(baseFreq, now);
      bodyOscA.frequency.exponentialRampToValueAtTime(baseFreq * 0.58, now + 0.088);

      const bodyOscB = ctx.createOscillator();
      bodyOscB.type = 'sine';
      const overtoneFreq = baseFreq * (1.84 + Math.random() * 0.18);
      bodyOscB.frequency.setValueAtTime(overtoneFreq, now);
      bodyOscB.frequency.exponentialRampToValueAtTime(overtoneFreq * 0.64, now + 0.065);

      const woodBodyFilter = ctx.createBiquadFilter();
      woodBodyFilter.type = 'bandpass';
      woodBodyFilter.frequency.setValueAtTime(245 + Math.random() * 55, now);
      woodBodyFilter.Q.setValueAtTime(1.85, now);

      const bodyEnv = ctx.createGain();
      bodyEnv.gain.setValueAtTime(0.0001, now);
      bodyEnv.gain.linearRampToValueAtTime(0.24 * inten, now + 0.0045);
      bodyEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.098);

      const overtoneGain = ctx.createGain();
      overtoneGain.gain.setValueAtTime(0.42, now);

      bodyOscA.connect(woodBodyFilter);
      bodyOscB.connect(overtoneGain);
      overtoneGain.connect(woodBodyFilter);
      woodBodyFilter.connect(bodyEnv);
      this._connectToMix(bodyEnv, pan, true);

      bodyOscA.start(now);
      bodyOscB.start(now);
      bodyOscA.stop(now + 0.11);
      bodyOscB.stop(now + 0.09);

      // 2. Crisp boot sole tap & warm plank knock transient
      const knockSrc = ctx.createBufferSource();
      knockSrc.buffer = this._pinkBuffer;
      knockSrc.loop = true;

      const knockFilter = ctx.createBiquadFilter();
      knockFilter.type = 'bandpass';
      knockFilter.frequency.setValueAtTime(620 + Math.random() * 190, now);
      knockFilter.Q.setValueAtTime(2.9, now);

      const knockEnv = ctx.createGain();
      const knockDur = 0.048 + Math.random() * 0.016;
      knockEnv.gain.setValueAtTime(0.0001, now);
      knockEnv.gain.linearRampToValueAtTime(0.165 * inten, now + 0.003);
      knockEnv.gain.exponentialRampToValueAtTime(0.0001, now + knockDur);

      knockSrc.connect(knockFilter);
      knockFilter.connect(knockEnv);
      this._connectToMix(knockEnv, pan, true);
      knockSrc.start(now, Math.random() * 3.0);
      knockSrc.stop(now + knockDur + 0.015);

      // 3. Boot sole leather/heel crisp top tap
      const soleSrc = ctx.createBufferSource();
      soleSrc.buffer = this._whiteBuffer;
      soleSrc.loop = true;

      const soleFilter = ctx.createBiquadFilter();
      soleFilter.type = 'bandpass';
      soleFilter.frequency.setValueAtTime(1650 + Math.random() * 480, now);
      soleFilter.frequency.exponentialRampToValueAtTime(840 + Math.random() * 180, now + 0.036);
      soleFilter.Q.setValueAtTime(2.0, now);

      const soleEnv = ctx.createGain();
      const soleDur = 0.034 + Math.random() * 0.012;
      soleEnv.gain.setValueAtTime(0.0001, now);
      soleEnv.gain.linearRampToValueAtTime(0.115 * inten, now + 0.0022);
      soleEnv.gain.exponentialRampToValueAtTime(0.0001, now + soleDur);

      soleSrc.connect(soleFilter);
      soleFilter.connect(soleEnv);
      this._connectToMix(soleEnv, pan, true);
      soleSrc.start(now, Math.random() * 0.35);
      soleSrc.stop(now + soleDur + 0.015);
      return;
    }

    if (surf === 'bridge') {
      // 1. Deeper hollow wooden bridge-span thump suspended over the stream
      const spanOsc = ctx.createOscillator();
      spanOsc.type = 'sine';
      const spanBase = 114 + (Math.random() - 0.5) * 18;
      spanOsc.frequency.setValueAtTime(spanBase, now);
      spanOsc.frequency.exponentialRampToValueAtTime(52 + Math.random() * 8, now + 0.125);

      const spanHarm = ctx.createOscillator();
      spanHarm.type = 'triangle';
      spanHarm.frequency.setValueAtTime(spanBase * 2.02, now);
      spanHarm.frequency.exponentialRampToValueAtTime(spanBase * 1.08, now + 0.095);

      const spanHarmGain = ctx.createGain();
      spanHarmGain.gain.setValueAtTime(0.38, now);

      const spanFilter = ctx.createBiquadFilter();
      spanFilter.type = 'lowpass';
      spanFilter.frequency.setValueAtTime(340 + Math.random() * 80, now);
      spanFilter.Q.setValueAtTime(1.4, now);

      const spanEnv = ctx.createGain();
      spanEnv.gain.setValueAtTime(0.0001, now);
      spanEnv.gain.linearRampToValueAtTime(0.28 * inten, now + 0.0055);
      spanEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.135);

      spanOsc.connect(spanFilter);
      spanHarm.connect(spanHarmGain);
      spanHarmGain.connect(spanFilter);
      spanFilter.connect(spanEnv);
      this._connectToMix(spanEnv, pan, true);

      spanOsc.start(now);
      spanHarm.start(now);
      spanOsc.stop(now + 0.15);
      spanHarm.stop(now + 0.12);

      // 2. Heavy timber plank strike + boot sole slap
      const plankSrc = ctx.createBufferSource();
      plankSrc.buffer = this._pinkBuffer;
      plankSrc.loop = true;

      const plankFilter = ctx.createBiquadFilter();
      plankFilter.type = 'bandpass';
      plankFilter.frequency.setValueAtTime(760 + Math.random() * 220, now);
      plankFilter.frequency.exponentialRampToValueAtTime(390 + Math.random() * 90, now + 0.062);
      plankFilter.Q.setValueAtTime(1.65, now);

      const plankEnv = ctx.createGain();
      const plankDur = 0.062 + Math.random() * 0.022;
      plankEnv.gain.setValueAtTime(0.0001, now);
      plankEnv.gain.linearRampToValueAtTime(0.18 * inten, now + 0.0038);
      plankEnv.gain.exponentialRampToValueAtTime(0.0001, now + plankDur);

      plankSrc.connect(plankFilter);
      plankFilter.connect(plankEnv);
      this._connectToMix(plankEnv, pan, true);
      plankSrc.start(now, Math.random() * 3.0);
      plankSrc.stop(now + plankDur + 0.015);

      // 3. Slight weathered bridge-plank creak (organic micro-groan on weight load)
      const creakStart = now + 0.014 + Math.random() * 0.018;
      const creakDur = 0.075 + Math.random() * 0.055;
      const creakOsc = ctx.createOscillator();
      creakOsc.type = 'sawtooth';
      const cF0 = 360 + Math.random() * 170;
      const cF1 = cF0 * (Math.random() > 0.45 ? 0.82 : 1.14);
      creakOsc.frequency.setValueAtTime(cF0, creakStart);
      creakOsc.frequency.exponentialRampToValueAtTime(cF1, creakStart + creakDur);

      const creakFilter = ctx.createBiquadFilter();
      creakFilter.type = 'bandpass';
      creakFilter.frequency.setValueAtTime(cF0 * 2.2, creakStart);
      creakFilter.Q.setValueAtTime(7.5, creakStart);

      const creakEnv = ctx.createGain();
      const creakPeak = (0.024 + Math.random() * 0.020) * inten;
      creakEnv.gain.setValueAtTime(0.0001, creakStart);
      creakEnv.gain.linearRampToValueAtTime(creakPeak, creakStart + creakDur * 0.28);
      creakEnv.gain.exponentialRampToValueAtTime(0.0001, creakStart + creakDur);

      creakOsc.connect(creakFilter);
      creakFilter.connect(creakEnv);
      this._connectToMix(creakEnv, pan, true);
      creakOsc.start(creakStart);
      creakOsc.stop(creakStart + creakDur + 0.015);
      return;
    }

    if (surf === 'stone') {
      // 1. Crisp hard-heel mineral tap click (tight high-mid transient)
      const tapSrc = ctx.createBufferSource();
      tapSrc.buffer = this._whiteBuffer;
      tapSrc.loop = true;

      const tapFilter = ctx.createBiquadFilter();
      tapFilter.type = 'bandpass';
      const tapF0 = 3050 + Math.random() * 1150;
      tapFilter.frequency.setValueAtTime(tapF0, now);
      tapFilter.frequency.exponentialRampToValueAtTime(1750 + Math.random() * 450, now + 0.036);
      tapFilter.Q.setValueAtTime(2.35, now);

      const tapEnv = ctx.createGain();
      const tapDur = 0.034 + Math.random() * 0.014;
      tapEnv.gain.setValueAtTime(0.0001, now);
      tapEnv.gain.linearRampToValueAtTime(0.205 * inten, now + 0.0018);
      tapEnv.gain.exponentialRampToValueAtTime(0.0001, now + tapDur);

      tapSrc.connect(tapFilter);
      tapFilter.connect(tapEnv);
      this._connectToMix(tapEnv, pan, true);
      tapSrc.start(now, Math.random() * 0.35);
      tapSrc.stop(now + tapDur + 0.015);

      // 2. Hard mineral stone ping formant (~1180–1580 Hz tight resonant knock)
      const pingSrc = ctx.createBufferSource();
      pingSrc.buffer = this._crackleBuffer;

      const pingFilter = ctx.createBiquadFilter();
      pingFilter.type = 'bandpass';
      pingFilter.frequency.setValueAtTime(1180 + Math.random() * 420, now);
      pingFilter.Q.setValueAtTime(5.2, now);

      const pingEnv = ctx.createGain();
      const pingDur = 0.044 + Math.random() * 0.014;
      pingEnv.gain.setValueAtTime(0.0001, now);
      pingEnv.gain.linearRampToValueAtTime(0.155 * inten, now + 0.002);
      pingEnv.gain.exponentialRampToValueAtTime(0.0001, now + pingDur);

      pingSrc.connect(pingFilter);
      pingFilter.connect(pingEnv);
      this._connectToMix(pingEnv, pan, true);
      pingSrc.start(now, Math.random() * 0.025, pingDur + 0.01);
      pingSrc.stop(now + pingDur + 0.015);

      // 3. Dense crisp boot-heel rock impact impulse (~145 -> 68 Hz)
      const heelOsc = ctx.createOscillator();
      heelOsc.type = 'triangle';
      heelOsc.frequency.setValueAtTime(144 + (Math.random() - 0.5) * 18, now);
      heelOsc.frequency.exponentialRampToValueAtTime(66, now + 0.042);

      const heelEnv = ctx.createGain();
      heelEnv.gain.setValueAtTime(0.0001, now);
      heelEnv.gain.linearRampToValueAtTime(0.17 * inten, now + 0.0022);
      heelEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.052);

      heelOsc.connect(heelEnv);
      this._connectToMix(heelEnv, pan, true);
      heelOsc.start(now);
      heelOsc.stop(now + 0.062);

      // 4. Subtle fine mineral grit micro-scuff on sole roll-off
      const gritTime = now + 0.012 + Math.random() * 0.008;
      const gritSrc = ctx.createBufferSource();
      gritSrc.buffer = this._whiteBuffer;
      gritSrc.loop = true;

      const gritHP = ctx.createBiquadFilter();
      gritHP.type = 'highpass';
      gritHP.frequency.setValueAtTime(3200 + Math.random() * 900, gritTime);

      const gritEnv = ctx.createGain();
      gritEnv.gain.setValueAtTime(0.0001, gritTime);
      gritEnv.gain.linearRampToValueAtTime(0.055 * inten, gritTime + 0.003);
      gritEnv.gain.exponentialRampToValueAtTime(0.0001, gritTime + 0.026);

      gritSrc.connect(gritHP);
      gritHP.connect(gritEnv);
      this._connectToMix(gritEnv, pan, true);
      gritSrc.start(gritTime, Math.random() * 0.35);
      gritSrc.stop(gritTime + 0.036);
      return;
    }

    if (surf === 'water') {
      // Frothy splash body (600–1350 Hz) + airy spray burst (1750–2800 Hz)
      const bodySrc = ctx.createBufferSource();
      bodySrc.buffer = this._pinkBuffer;
      bodySrc.loop = true;

      const bodyFilter = ctx.createBiquadFilter();
      bodyFilter.type = 'bandpass';
      bodyFilter.frequency.setValueAtTime(1150 + Math.random() * 450, now);
      bodyFilter.frequency.exponentialRampToValueAtTime(620 + Math.random() * 180, now + 0.22);
      bodyFilter.Q.setValueAtTime(1.15, now);

      const bodyEnv = ctx.createGain();
      const bodyDur = 0.18 + Math.random() * 0.07;
      bodyEnv.gain.setValueAtTime(0.0001, now);
      bodyEnv.gain.linearRampToValueAtTime(0.22 * inten, now + 0.016);
      bodyEnv.gain.exponentialRampToValueAtTime(0.0001, now + bodyDur);

      bodySrc.connect(bodyFilter);
      bodyFilter.connect(bodyEnv);
      this._connectToMix(bodyEnv, pan, true);
      bodySrc.start(now, Math.random() * 3.0);
      bodySrc.stop(now + bodyDur + 0.02);

      // Bright sparkling water froth layer (1900–2800 Hz)
      const frothSrc = ctx.createBufferSource();
      frothSrc.buffer = this._whiteBuffer;
      frothSrc.loop = true;

      const frothFilter = ctx.createBiquadFilter();
      frothFilter.type = 'bandpass';
      frothFilter.frequency.setValueAtTime(2200 + Math.random() * 600, now);
      frothFilter.frequency.exponentialRampToValueAtTime(1300 + Math.random() * 300, now + 0.24);
      frothFilter.Q.setValueAtTime(1.3, now);

      const frothEnv = ctx.createGain();
      const frothDur = 0.21 + Math.random() * 0.08;
      frothEnv.gain.setValueAtTime(0.0001, now);
      frothEnv.gain.linearRampToValueAtTime(0.14 * inten, now + 0.012);
      frothEnv.gain.exponentialRampToValueAtTime(0.0001, now + frothDur);

      frothSrc.connect(frothFilter);
      frothFilter.connect(frothEnv);
      this._connectToMix(frothEnv, pan, true);
      frothSrc.start(now, Math.random() * 0.35);
      frothSrc.stop(now + frothDur + 0.02);

      // Subtle submerged heel thump
      const thud = ctx.createOscillator();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(84 + Math.random() * 12, now);
      thud.frequency.exponentialRampToValueAtTime(42, now + 0.065);
      const thudEnv = ctx.createGain();
      thudEnv.gain.setValueAtTime(0.0001, now);
      thudEnv.gain.linearRampToValueAtTime(0.095 * inten, now + 0.006);
      thudEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);
      thud.connect(thudEnv);
      this._connectToMix(thudEnv, pan, true);
      thud.start(now);
      thud.stop(now + 0.085);

      // Shimmering droplet scatter tail
      const dropCount = 2 + Math.floor(Math.random() * 3);
      for (let d = 0; d < dropCount; d++) {
        const dt = 0.055 + d * 0.048 + Math.random() * 0.035;
        const dropFreq = 1100 + Math.random() * 1450;
        const dropPan = clamp(pan + (Math.random() - 0.5) * 0.45, -1, 1);
        this._scheduleDropletPing(now + dt, dropFreq, 0.028 * inten * (0.7 + Math.random() * 0.4), dropPan, true);
      }
      return;
    }

    if (surf === 'dirt' || surf === 'rock') {
      const isRock = surf === 'rock';

      // Crisp gritty gravel / stone crunch (1800–4200 Hz)
      const gritSrc = ctx.createBufferSource();
      gritSrc.buffer = this._whiteBuffer;
      gritSrc.loop = true;

      const gritFilter = ctx.createBiquadFilter();
      gritFilter.type = 'bandpass';
      const startFreq = isRock ? 2800 + Math.random() * 1400 : 1900 + Math.random() * 1300;
      const endFreq = isRock ? 1850 + Math.random() * 550 : 1250 + Math.random() * 450;
      const gritDur = isRock ? 0.055 + Math.random() * 0.024 : 0.078 + Math.random() * 0.032;
      gritFilter.frequency.setValueAtTime(startFreq, now);
      gritFilter.frequency.exponentialRampToValueAtTime(endFreq, now + gritDur);
      gritFilter.Q.setValueAtTime(isRock ? 1.65 : 1.35, now);

      const gritEnv = ctx.createGain();
      gritEnv.gain.setValueAtTime(0.0001, now);
      gritEnv.gain.linearRampToValueAtTime((isRock ? 0.17 : 0.145) * inten, now + 0.005);
      gritEnv.gain.exponentialRampToValueAtTime(0.0001, now + gritDur);

      gritSrc.connect(gritFilter);
      gritFilter.connect(gritEnv);
      this._connectToMix(gritEnv, pan, true);
      gritSrc.start(now, Math.random() * 0.35);
      gritSrc.stop(now + gritDur + 0.015);

      // Micro secondary pebble/grit scuff 18 ms later for organic gravel crunch
      const scuffTime = now + 0.016 + Math.random() * 0.012;
      const scuffSrc = ctx.createBufferSource();
      scuffSrc.buffer = this._whiteBuffer;
      scuffSrc.loop = true;
      const scuffFilter = ctx.createBiquadFilter();
      scuffFilter.type = 'bandpass';
      scuffFilter.frequency.setValueAtTime(2400 + Math.random() * 1600, scuffTime);
      scuffFilter.Q.setValueAtTime(2.0, scuffTime);
      const scuffEnv = ctx.createGain();
      scuffEnv.gain.setValueAtTime(0.0001, scuffTime);
      scuffEnv.gain.linearRampToValueAtTime(0.08 * inten, scuffTime + 0.004);
      scuffEnv.gain.exponentialRampToValueAtTime(0.0001, scuffTime + 0.042);
      scuffSrc.connect(scuffFilter);
      scuffFilter.connect(scuffEnv);
      this._connectToMix(scuffEnv, pan, true);
      scuffSrc.start(scuffTime, Math.random() * 0.35);
      scuffSrc.stop(scuffTime + 0.05);

      // Punchy footfall thump (~110 Hz)
      const thump = ctx.createOscillator();
      thump.type = isRock ? 'triangle' : 'sine';
      const thumpStart = (isRock ? 118 : 108) + (Math.random() - 0.5) * 14;
      thump.frequency.setValueAtTime(thumpStart, now);
      thump.frequency.exponentialRampToValueAtTime(52, now + 0.062);

      const thumpEnv = ctx.createGain();
      thumpEnv.gain.setValueAtTime(0.0001, now);
      thumpEnv.gain.linearRampToValueAtTime((isRock ? 0.175 : 0.155) * inten, now + 0.0035);
      thumpEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.072);

      thump.connect(thumpEnv);
      this._connectToMix(thumpEnv, pan, true);
      thump.start(now);
      thump.stop(now + 0.082);
      return;
    }

    // Default: 'grass' — soft filtered rustle burst (900–2400 Hz) + muted low heel thud (~95 Hz)
    const rustleSrc = ctx.createBufferSource();
    rustleSrc.buffer = this._pinkBuffer;
    rustleSrc.loop = true;

    const rustleFilter = ctx.createBiquadFilter();
    rustleFilter.type = 'bandpass';
    const rStart = 1550 + Math.random() * 850; // up to ~2400 Hz
    const rEnd = 900 + Math.random() * 350;
    const rustleDur = 0.095 + Math.random() * 0.038;
    rustleFilter.frequency.setValueAtTime(rStart, now);
    rustleFilter.frequency.exponentialRampToValueAtTime(rEnd, now + rustleDur);
    rustleFilter.Q.setValueAtTime(1.15, now);

    const rustleEnv = ctx.createGain();
    rustleEnv.gain.setValueAtTime(0.0001, now);
    rustleEnv.gain.linearRampToValueAtTime(0.135 * inten, now + 0.014);
    rustleEnv.gain.exponentialRampToValueAtTime(0.0001, now + rustleDur);

    rustleSrc.connect(rustleFilter);
    rustleFilter.connect(rustleEnv);
    this._connectToMix(rustleEnv, pan, true);
    rustleSrc.start(now, Math.random() * 3.0);
    rustleSrc.stop(now + rustleDur + 0.02);

    // Muted low heel thud (~95 Hz)
    const heelOsc = ctx.createOscillator();
    heelOsc.type = 'sine';
    heelOsc.frequency.setValueAtTime(95 + (Math.random() - 0.5) * 12, now);
    heelOsc.frequency.exponentialRampToValueAtTime(46, now + 0.068);

    const heelEnv = ctx.createGain();
    heelEnv.gain.setValueAtTime(0.0001, now);
    heelEnv.gain.linearRampToValueAtTime(0.115 * inten, now + 0.006);
    heelEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.078);

    heelOsc.connect(heelEnv);
    this._connectToMix(heelEnv, pan, true);
    heelOsc.start(now);
    heelOsc.stop(now + 0.09);
  }

  /**
   * Drives rhythmic human breathing/panting (scaling with exertion, exhaustion, and panic)
   * plus a deep visceral rapid heartbeat (130–150 BPM lub-dub) during panic stages 1–3
   * that fades out naturally across Stage 3->4.
   */
  updateHumanAudio(
    dt,
    elapsed,
    { exertion = 0, exhausted = false, panicStage = 0, panicActive = false } = {}
  ) {
    if (!this._canPlayOneShots()) return;

    const safeDt = clamp(dt || 0.016, 0.001, 0.1);
    const ex = clamp(Number(exertion) || 0, 0, 1);
    const isExhausted = Boolean(exhausted);
    const isPanic = Boolean(panicActive);
    const stage = Number(panicStage) || 0;

    // 1. Human Breathing & Panting Cadence
    const exertBreath = clamp((ex - 0.22) / 0.78, 0.0, 1.0);
    const isPanicShallow = isPanic && stage >= 2.5 && stage <= 3.5;
    let panicBreath = 0.0;
    if (isPanic) {
      if (stage <= 2) {
        panicBreath = 0.58;
      } else if (stage <= 3) {
        panicBreath = 0.90;
      } else if (stage < 4) {
        panicBreath = lerp(0.90, 0.28, clamp(stage - 3, 0, 1));
      } else {
        panicBreath = 0.22;
      }
    }

    const breathLevel = Math.max(exertBreath, isExhausted ? 0.94 : 0.0, panicBreath);

    if (breathLevel > 0.04) {
      this._breathTimer -= safeDt;
      if (this._breathTimer <= 0) {
        this._triggerHumanBreath({
          inhale: this._breathIsInhale,
          level: breathLevel,
          exhausted: isExhausted,
          panicShallow: isPanicShallow,
        });

        // Natural inhale/exhale pacing: slightly longer exhale pause when winded
        let nextHalfCycle;
        if (isPanicShallow) {
          // Fast shallow panicked breaths (~60–68 breaths/min)
          nextHalfCycle = (this._breathIsInhale ? 0.21 : 0.25) + Math.random() * 0.05;
        } else if (isExhausted) {
          // Deep heavy exhausted panting
          nextHalfCycle = (this._breathIsInhale ? 0.34 : 0.42) + Math.random() * 0.07;
        } else {
          const baseHalf = lerp(0.68, 0.34, clamp(breathLevel, 0, 1));
          nextHalfCycle = (this._breathIsInhale ? baseHalf * 0.92 : baseHalf * 1.08) + Math.random() * 0.06;
        }

        this._breathIsInhale = !this._breathIsInhale;
        this._breathTimer = nextHalfCycle;
      }
    } else {
      this._breathTimer = Math.min(this._breathTimer, 0.22);
      this._breathIsInhale = true;
    }

    // 2. Visceral Rapid Heartbeat Thump (130–150 BPM lub-dub during panicStage <= 3, fading 3->4)
    let targetHeartGain = 0.0;
    if (isPanic && stage <= 3) {
      targetHeartGain = stage >= 3 ? 0.65 : 1.0;
    } else if (isPanic && stage > 3 && stage < 4) {
      targetHeartGain = lerp(0.65, 0.0, clamp(stage - 3, 0, 1));
    }

    const heartRateSlew = 1.0 - Math.exp(-safeDt * (targetHeartGain > this._heartbeatGain ? 8.5 : 1.45));
    this._heartbeatGain += (targetHeartGain - this._heartbeatGain) * heartRateSlew;

    if (this._heartbeatGain > 0.04) {
      this._heartbeatTimer -= safeDt;
      if (this._heartbeatTimer <= 0) {
        this._triggerHeartbeat(this._heartbeatGain);
        const bpm = stage <= 1 ? 148 : stage <= 2 ? 144 : lerp(136, 130, clamp(stage - 2, 0, 1));
        this._heartbeatTimer = (60.0 / bpm) * (0.96 + Math.random() * 0.08);
      }
    } else {
      this._heartbeatTimer = Math.min(this._heartbeatTimer, 0.12);
    }
  }

  _triggerHumanBreath({ inhale = true, level = 0.6, exhausted = false, panicShallow = false } = {}) {
    const ctx = this._ctx;
    const now = ctx.currentTime;

    const dur = panicShallow
      ? 0.15 + Math.random() * 0.045
      : exhausted
        ? 0.27 + Math.random() * 0.08
        : lerp(0.32, 0.22, clamp(level, 0, 1)) + Math.random() * 0.05;

    const src = ctx.createBufferSource();
    src.buffer = this._pinkBuffer;
    src.loop = true;

    // Dual vocal-tract formant filters make pink noise read distinctly as human breath
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    const baseF1 = panicShallow ? 860 : exhausted ? 540 : 650;
    f1.frequency.setValueAtTime(baseF1 * (inhale ? 1.14 : 0.92), now);
    f1.frequency.exponentialRampToValueAtTime(baseF1 * (inhale ? 1.24 : 0.80), now + dur);
    f1.Q.setValueAtTime(2.5, now);

    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    const baseF2 = panicShallow ? 1850 : exhausted ? 1240 : 1480;
    f2.frequency.setValueAtTime(baseF2 * (inhale ? 1.12 : 0.94), now);
    f2.frequency.exponentialRampToValueAtTime(baseF2 * (inhale ? 1.2 : 0.84), now + dur);
    f2.Q.setValueAtTime(2.1, now);

    const f2Gain = ctx.createGain();
    f2Gain.gain.setValueAtTime(panicShallow ? 0.82 : 0.62, now);

    const env = ctx.createGain();
    const peak = (exhausted ? 0.15 : panicShallow ? 0.13 : 0.115) * clamp(level, 0.1, 1.0) * (inhale ? 0.92 : 1.08);
    const attack = dur * (inhale ? 0.34 : 0.24);
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(Math.max(0.0005, peak), now + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(f1);
    src.connect(f2);
    f1.connect(env);
    f2.connect(f2Gain);
    f2Gain.connect(env);
    env.connect(this._mixBus);

    src.start(now, Math.random() * 3.0);
    src.stop(now + dur + 0.02);
  }

  _triggerHeartbeat(intensity = 1.0) {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const inten = clamp(intensity, 0.05, 1.2);

    const scheduleThump = (t, fStart, fEnd, dur, peak) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(fStart, t);
      osc.frequency.exponentialRampToValueAtTime(fEnd, t + dur);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(135, t);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(Math.max(0.0005, peak), t + 0.011);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.015);

      osc.connect(lp);
      lp.connect(env);
      env.connect(this._mixBus);

      osc.start(t);
      osc.stop(t + dur + 0.025);
    };

    // Deep visceral "lub-dub" double-beat
    scheduleThump(now, 74, 34, 0.092, 0.32 * inten);
    scheduleThump(now + 0.125, 86, 40, 0.074, 0.22 * inten);
  }

  /**
   * Plays a sharp sudden startled human gasp (rapid upward formant-filtered inhale + glottal spike).
   */
  playHumanGasp() {
    if (!this._canPlayOneShots()) return;

    const ctx = this._ctx;
    const now = ctx.currentTime;
    const dur = 0.23;

    // 1. Rapid upward formant-filtered inhale breath
    const src = ctx.createBufferSource();
    src.buffer = this._pinkBuffer;
    src.loop = true;

    const throatFormant = ctx.createBiquadFilter();
    throatFormant.type = 'bandpass';
    throatFormant.frequency.setValueAtTime(620, now);
    throatFormant.frequency.exponentialRampToValueAtTime(1420, now + dur * 0.85);
    throatFormant.Q.setValueAtTime(3.1, now);

    const airwayFormant = ctx.createBiquadFilter();
    airwayFormant.type = 'bandpass';
    airwayFormant.frequency.setValueAtTime(1550, now);
    airwayFormant.frequency.exponentialRampToValueAtTime(3150, now + dur * 0.85);
    airwayFormant.Q.setValueAtTime(2.3, now);

    const airwayGain = ctx.createGain();
    airwayGain.gain.setValueAtTime(0.72, now);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.24, now + 0.026);
    env.gain.linearRampToValueAtTime(0.18, now + 0.14);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(throatFormant);
    src.connect(airwayFormant);
    throatFormant.connect(env);
    airwayFormant.connect(airwayGain);
    airwayGain.connect(env);
    this._connectToMix(env, 0.0, true);

    src.start(now, Math.random() * 3.0);
    src.stop(now + dur + 0.02);

    // 2. Subtle startled vocal glottal spike
    const glottalTime = now + 0.014;
    const glottalOsc = ctx.createOscillator();
    glottalOsc.type = 'triangle';
    glottalOsc.frequency.setValueAtTime(255, glottalTime);
    glottalOsc.frequency.exponentialRampToValueAtTime(445, glottalTime + 0.088);

    const glottalFilter = ctx.createBiquadFilter();
    glottalFilter.type = 'bandpass';
    glottalFilter.frequency.setValueAtTime(880, glottalTime);
    glottalFilter.frequency.exponentialRampToValueAtTime(1520, glottalTime + 0.095);
    glottalFilter.Q.setValueAtTime(3.4, glottalTime);

    const glottalEnv = ctx.createGain();
    glottalEnv.gain.setValueAtTime(0.0001, glottalTime);
    glottalEnv.gain.linearRampToValueAtTime(0.068, glottalTime + 0.016);
    glottalEnv.gain.exponentialRampToValueAtTime(0.0001, glottalTime + 0.105);

    glottalOsc.connect(glottalFilter);
    glottalFilter.connect(glottalEnv);
    this._connectToMix(glottalEnv, 0.0, true);

    glottalOsc.start(glottalTime);
    glottalOsc.stop(glottalTime + 0.12);
  }

  /**
   * Plays a crisp denim/canvas brushing & leg-slapping swish (1400–3600 Hz noise burst).
   */
  playFabricBrush() {
    if (!this._canPlayOneShots()) return;

    const ctx = this._ctx;
    const now = ctx.currentTime;
    const pan = (Math.random() - 0.5) * 0.42;
    const dur = 0.095 + Math.random() * 0.038;

    // 1. Crisp denim/canvas swish (1400–3600 Hz shaped burst)
    const src = ctx.createBufferSource();
    src.buffer = this._whiteBuffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    const fStart = 1650 + Math.random() * 550;
    const fPeak = 2900 + Math.random() * 700;
    filter.frequency.setValueAtTime(fStart, now);
    filter.frequency.exponentialRampToValueAtTime(fPeak, now + dur * 0.42);
    filter.frequency.exponentialRampToValueAtTime(1450 + Math.random() * 350, now + dur);
    filter.Q.setValueAtTime(1.55, now);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.21 + Math.random() * 0.04, now + 0.009);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(filter);
    filter.connect(env);
    this._connectToMix(env, pan);
    src.start(now, Math.random() * 0.35);
    src.stop(now + dur + 0.015);

    // 2. Tactile palm-on-fabric slap thwack
    const slapSrc = ctx.createBufferSource();
    slapSrc.buffer = this._pinkBuffer;
    slapSrc.loop = true;

    const slapFilter = ctx.createBiquadFilter();
    slapFilter.type = 'bandpass';
    slapFilter.frequency.setValueAtTime(340 + Math.random() * 110, now);
    slapFilter.Q.setValueAtTime(1.4, now);

    const slapEnv = ctx.createGain();
    slapEnv.gain.setValueAtTime(0.0001, now);
    slapEnv.gain.linearRampToValueAtTime(0.145, now + 0.004);
    slapEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.036);

    slapSrc.connect(slapFilter);
    slapFilter.connect(slapEnv);
    this._connectToMix(slapEnv, pan);
    slapSrc.start(now, Math.random() * 3.0);
    slapSrc.stop(now + 0.045);
  }

  /**
   * Plays an unmistakable high-pitched rodent squeak (3800–6400 Hz FM/pitch-chirp sine, ~90–140 ms).
   */
  playRatSqueak(pitchScale = 1.0) {
    if (!this._canPlayOneShots()) return;

    const ctx = this._ctx;
    const now = ctx.currentTime;
    const scale = clamp(Number.isFinite(pitchScale) ? pitchScale : 1.0, 0.55, 1.85);
    const dur = 0.09 + Math.random() * 0.05; // 90–140 ms
    const pan = (Math.random() - 0.5) * 0.7;

    const fStart = clamp((4050 + Math.random() * 650) * scale, 2400, 11000);
    const fPeak = clamp((5450 + Math.random() * 900) * scale, 3200, 13000);
    const fEnd = clamp((3820 + Math.random() * 480) * scale, 2200, 10500);

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(fStart, now);
    carrier.frequency.exponentialRampToValueAtTime(fPeak, now + dur * 0.44);
    carrier.frequency.exponentialRampToValueAtTime(fEnd, now + dur);

    // Rapid frantic FM vibrato/trill for unmistakable rodent squeak timbre
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.setValueAtTime(48 + Math.random() * 28, now);
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(280 + Math.random() * 140, now);

    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.088, now + 0.011);
    env.gain.linearRampToValueAtTime(0.072, now + dur * 0.62);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    carrier.connect(env);
    this._connectToMix(env, pan);

    carrier.start(now);
    mod.start(now);
    carrier.stop(now + dur + 0.015);
    mod.stop(now + dur + 0.015);
  }

  /**
   * Plays a sharp atmospheric crack + deep rolling sub-bass thunder rumble (38–150 Hz)
   * with a secondary echoing valley boom decaying over ~3.5 seconds.
   */
  playThunder(intensity = 1.0) {
    if (!this._canPlayOneShots()) return;

    const ctx = this._ctx;
    const now = ctx.currentTime;
    const inten = clamp(Number.isFinite(intensity) ? intensity : 1.0, 0.15, 1.5);
    const pan = (Math.random() - 0.5) * 0.5;
    const totalDur = 3.55;

    // 1. Sharp atmospheric lightning crack / snap
    const crackSrc = ctx.createBufferSource();
    crackSrc.buffer = this._whiteBuffer;
    crackSrc.loop = true;

    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'bandpass';
    crackFilter.frequency.setValueAtTime(1650, now);
    crackFilter.frequency.exponentialRampToValueAtTime(260, now + 0.34);
    crackFilter.Q.setValueAtTime(0.85, now);

    const crackEnv = ctx.createGain();
    crackEnv.gain.setValueAtTime(0.0001, now);
    crackEnv.gain.linearRampToValueAtTime(0.32 * inten, now + 0.008);
    crackEnv.gain.exponentialRampToValueAtTime(0.055 * inten, now + 0.14);
    crackEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);

    crackSrc.connect(crackFilter);
    crackFilter.connect(crackEnv);
    this._connectToMix(crackEnv, pan, true);
    crackSrc.start(now, Math.random() * 0.35);
    crackSrc.stop(now + 0.45);

    // 2. Deep rolling sub-bass thunder rumble (38–150 Hz brown + pink noise with secondary echo boom)
    const brownSrc = ctx.createBufferSource();
    brownSrc.buffer = this._brownBuffer;
    brownSrc.loop = true;

    const pinkSrc = ctx.createBufferSource();
    pinkSrc.buffer = this._pinkBuffer;
    pinkSrc.loop = true;

    const pinkMixGain = ctx.createGain();
    pinkMixGain.gain.setValueAtTime(0.36, now);

    const subHP = ctx.createBiquadFilter();
    subHP.type = 'highpass';
    subHP.frequency.setValueAtTime(38, now);
    subHP.Q.setValueAtTime(0.7, now);

    const subLP = ctx.createBiquadFilter();
    subLP.type = 'lowpass';
    subLP.frequency.setValueAtTime(150, now);
    subLP.frequency.exponentialRampToValueAtTime(72, now + 1.2);
    subLP.frequency.exponentialRampToValueAtTime(118, now + 1.48); // brightens slightly on secondary echo boom
    subLP.frequency.exponentialRampToValueAtTime(48, now + totalDur);
    subLP.Q.setValueAtTime(1.25, now);

    const rumbleEnv = ctx.createGain();
    rumbleEnv.gain.setValueAtTime(0.0001, now);
    rumbleEnv.gain.linearRampToValueAtTime(0.58 * inten, now + 0.055);
    rumbleEnv.gain.exponentialRampToValueAtTime(0.24 * inten, now + 0.62);
    // Secondary echoing valley boom
    rumbleEnv.gain.linearRampToValueAtTime(0.45 * inten, now + 1.12);
    rumbleEnv.gain.exponentialRampToValueAtTime(0.15 * inten, now + 1.92);
    // Distant trailing rolling tail
    rumbleEnv.gain.linearRampToValueAtTime(0.21 * inten, now + 2.38);
    rumbleEnv.gain.exponentialRampToValueAtTime(0.0001, now + totalDur);

    brownSrc.connect(subHP);
    pinkSrc.connect(pinkMixGain);
    pinkMixGain.connect(subHP);
    subHP.connect(subLP);
    subLP.connect(rumbleEnv);
    this._connectToMix(rumbleEnv, pan * 0.5, true);

    brownSrc.start(now, Math.random() * 3.0);
    pinkSrc.start(now, Math.random() * 3.0);
    brownSrc.stop(now + totalDur + 0.08);
    pinkSrc.stop(now + totalDur + 0.08);

    // 3. Chest-felt sub-bass pressure thump on initial strike
    const subBoom = ctx.createOscillator();
    subBoom.type = 'sine';
    subBoom.frequency.setValueAtTime(64, now + 0.015);
    subBoom.frequency.exponentialRampToValueAtTime(34, now + 0.48);

    const subBoomEnv = ctx.createGain();
    subBoomEnv.gain.setValueAtTime(0.0001, now + 0.015);
    subBoomEnv.gain.linearRampToValueAtTime(0.22 * inten, now + 0.045);
    subBoomEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);

    subBoom.connect(subBoomEnv);
    this._connectToMix(subBoomEnv, 0.0, true);
    subBoom.start(now + 0.015);
    subBoom.stop(now + 0.56);
  }

  /**
   * Plays a comedic startled slip whoosh followed by a heavy double-layered water splash.
   */
  playSlipSplash() {
    if (!this._canPlayOneShots()) return;

    const ctx = this._ctx;
    const now = ctx.currentTime;

    // 1. Comedic startled slip whoosh (0.00 -> 0.21s)
    const whooshSrc = ctx.createBufferSource();
    whooshSrc.buffer = this._pinkBuffer;
    whooshSrc.loop = true;

    const whooshFilter = ctx.createBiquadFilter();
    whooshFilter.type = 'bandpass';
    whooshFilter.frequency.setValueAtTime(1850, now);
    whooshFilter.frequency.exponentialRampToValueAtTime(420, now + 0.19);
    whooshFilter.Q.setValueAtTime(2.2, now);

    const whooshEnv = ctx.createGain();
    whooshEnv.gain.setValueAtTime(0.0001, now);
    whooshEnv.gain.linearRampToValueAtTime(0.21, now + 0.045);
    whooshEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.21);

    whooshSrc.connect(whooshFilter);
    whooshFilter.connect(whooshEnv);
    whooshEnv.connect(this._mixBus);
    whooshSrc.start(now, Math.random() * 3.0);
    whooshSrc.stop(now + 0.23);

    // Brief playful cartoon-subtle slip pitch glide
    const slipOsc = ctx.createOscillator();
    slipOsc.type = 'sine';
    slipOsc.frequency.setValueAtTime(480, now);
    slipOsc.frequency.exponentialRampToValueAtTime(880, now + 0.07);
    slipOsc.frequency.exponentialRampToValueAtTime(250, now + 0.17);

    const slipEnv = ctx.createGain();
    slipEnv.gain.setValueAtTime(0.0001, now);
    slipEnv.gain.linearRampToValueAtTime(0.062, now + 0.025);
    slipEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.175);

    slipOsc.connect(slipEnv);
    slipEnv.connect(this._mixBus);
    slipOsc.start(now);
    slipOsc.stop(now + 0.19);

    // 2. Heavy double-layered water splash (initial impact at +0.13s, full plunge surge at +0.26s)
    const splash1 = now + 0.13;
    const splash2 = now + 0.26;

    // Layer A: Heavy low-mid water plunge wash
    const plungeSrc = ctx.createBufferSource();
    plungeSrc.buffer = this._brownBuffer;
    plungeSrc.loop = true;

    const plungeLP = ctx.createBiquadFilter();
    plungeLP.type = 'lowpass';
    plungeLP.frequency.setValueAtTime(980, splash1);
    plungeLP.frequency.exponentialRampToValueAtTime(260, splash1 + 0.58);

    const plungeEnv = ctx.createGain();
    plungeEnv.gain.setValueAtTime(0.0001, splash1);
    plungeEnv.gain.linearRampToValueAtTime(0.36, splash1 + 0.022);
    plungeEnv.gain.exponentialRampToValueAtTime(0.16, splash2 - 0.01);
    plungeEnv.gain.linearRampToValueAtTime(0.32, splash2 + 0.025);
    plungeEnv.gain.exponentialRampToValueAtTime(0.0001, splash1 + 0.62);

    plungeSrc.connect(plungeLP);
    plungeLP.connect(plungeEnv);
    plungeEnv.connect(this._mixBus);
    plungeSrc.start(splash1, Math.random() * 3.0);
    plungeSrc.stop(splash1 + 0.66);

    // Deep water-cavity impact thump
    const cavityOsc = ctx.createOscillator();
    cavityOsc.type = 'sine';
    cavityOsc.frequency.setValueAtTime(132, splash1);
    cavityOsc.frequency.exponentialRampToValueAtTime(46, splash1 + 0.16);
    const cavityEnv = ctx.createGain();
    cavityEnv.gain.setValueAtTime(0.0001, splash1);
    cavityEnv.gain.linearRampToValueAtTime(0.24, splash1 + 0.012);
    cavityEnv.gain.exponentialRampToValueAtTime(0.0001, splash1 + 0.18);
    cavityOsc.connect(cavityEnv);
    cavityEnv.connect(this._mixBus);
    cavityOsc.start(splash1);
    cavityOsc.stop(splash1 + 0.2);

    // Layer B: High frothy spray crown (double surge)
    const spraySrc = ctx.createBufferSource();
    spraySrc.buffer = this._whiteBuffer;
    spraySrc.loop = true;

    const sprayFilter = ctx.createBiquadFilter();
    sprayFilter.type = 'bandpass';
    sprayFilter.frequency.setValueAtTime(1150, splash1);
    sprayFilter.frequency.exponentialRampToValueAtTime(2750, splash2);
    sprayFilter.frequency.exponentialRampToValueAtTime(920, splash1 + 0.68);
    sprayFilter.Q.setValueAtTime(0.85, splash1);

    const sprayEnv = ctx.createGain();
    sprayEnv.gain.setValueAtTime(0.0001, splash1);
    sprayEnv.gain.linearRampToValueAtTime(0.24, splash1 + 0.02);
    sprayEnv.gain.exponentialRampToValueAtTime(0.11, splash2 - 0.015);
    sprayEnv.gain.linearRampToValueAtTime(0.28, splash2 + 0.024);
    sprayEnv.gain.exponentialRampToValueAtTime(0.0001, splash1 + 0.72);

    spraySrc.connect(sprayFilter);
    sprayFilter.connect(sprayEnv);
    sprayEnv.connect(this._mixBus);
    spraySrc.start(splash1, Math.random() * 0.35);
    spraySrc.stop(splash1 + 0.76);

    // Layer C: Sparkling cascading splash droplets
    for (let i = 0; i < 6; i++) {
      const t = splash2 + 0.04 + i * 0.075 + Math.random() * 0.04;
      const freq = 750 + Math.random() * 1750;
      const pan = (Math.random() - 0.5) * 0.9;
      this._scheduleDropletPing(t, freq, 0.032 + Math.random() * 0.018, pan);
    }
  }

  dispose() {
    this._disposed = true;
    for (const src of this._sources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already stopped source
      }
    }
    this._sources.length = 0;

    for (const lfo of this._lfos) {
      try {
        lfo.stop();
        lfo.disconnect();
      } catch {
        // Ignore already stopped oscillator
      }
    }
    this._lfos.length = 0;

    if (this._ctx) {
      try {
        const p = this._ctx.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        // Ignore
      }
      this._ctx = null;
    }
    this._initialized = false;
  }
}
