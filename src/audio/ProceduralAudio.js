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

    // Stochastic event schedulers
    this._nextCrackleTimer = 0.08;
    this._nextBubbleTimer = 0.22;
    this._nextBirdTimer = 1.6;
    this._nextCricketTimer = 0.45;
  }

  /**
   * Creates or resumes the Web Audio context cleanly on a user gesture.
   * Never throws if the browser restricts autoplay before interaction.
   */
  unlock() {
    if (this._disposed) return false;

    if (!this._initialized) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
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

    // Pre-generate seamless looping 4-second noise buffers & crackle burst buffer
    this._pinkBuffer = this._createSeamlessPinkBuffer(4.0);
    this._brownBuffer = this._createSeamlessBrownBuffer(4.0);
    this._crackleBuffer = this._createShortNoiseBuffer(0.08);

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
    this._windRoarGain.connect(this._mixBus);

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
    this._windRustleGain.connect(this._mixBus);

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
    this._rainGain.connect(this._mixBus);

    const rainBodyFilter = ctx.createBiquadFilter();
    rainBodyFilter.type = 'lowpass';
    rainBodyFilter.frequency.setValueAtTime(880, now);

    this._rainBodyGain = ctx.createGain();
    this._rainBodyGain.gain.setValueAtTime(0.0, now);

    rainSrc.connect(rainBodyFilter);
    rainBodyFilter.connect(this._rainBodyGain);
    this._rainBodyGain.connect(this._mixBus);

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
