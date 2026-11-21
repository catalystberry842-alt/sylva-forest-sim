import './style.css';
import * as THREE from 'three';

import { Engine } from './core/Engine.js';
import { WindSystem } from './shaders/windSystem.js';
import { Terrain } from './world/Terrain.js';
import { StreamWater } from './world/StreamWater.js';
import { SkyLighting } from './atmosphere/SkyLighting.js';
import { Particles } from './atmosphere/Particles.js';
import { TreeFactory } from './vegetation/TreeFactory.js';
import { Undergrowth } from './vegetation/Undergrowth.js';
import { ControlsAndRaycast } from './interaction/ControlsAndRaycast.js';
import { ProceduralAudio } from './audio/ProceduralAudio.js';
import { ControlPanel } from './ui/ControlPanel.js';

const WEATHER_PRESETS = {
  Clear: { rain: 0.0, wetness: 0.0, windMult: 1.0, gustMult: 1.0 },
  Gale: { rain: 0.0, wetness: 0.12, windMult: 2.35, gustMult: 2.15 },
  Rain: { rain: 1.0, wetness: 1.0, windMult: 1.55, gustMult: 1.45 },
};

const QUALITY_PIXEL_RATIO = {
  Medium: 1.25,
  High: 1.75,
  Ultra: 2.0,
};

function formatClock(hours) {
  const normalized = ((hours % 24) + 24) % 24;
  const h = Math.floor(normalized);
  const m = Math.floor((normalized - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getDayPhaseLabel(hours) {
  const h = ((hours % 24) + 24) % 24;
  if (h >= 5.2 && h < 7.5) return 'Dawn';
  if (h >= 7.5 && h < 11.2) return 'Morning';
  if (h >= 11.2 && h < 15.5) return 'Midday';
  if (h >= 15.5 && h < 17.6) return 'Afternoon';
  if (h >= 17.6 && h < 19.8) return 'Sunset';
  if (h >= 19.8 && h < 21.3) return 'Twilight';
  return 'Moonlit Night';
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function bootstrapForest() {
  const viewport = document.getElementById('viewport');
  const loadingScreen = document.getElementById('loading-screen');
  const loadingStatus = document.getElementById('loading-status');
  const loadingBarFill = document.getElementById('loading-bar-fill');

  // HUD DOM elements
  const hudClock = document.getElementById('hud-clock');
  const hudPhase = document.getElementById('hud-phase');
  const hudWeather = document.getElementById('hud-weather');
  const hudCamera = document.getElementById('hud-camera');
  const crosshair = document.getElementById('crosshair');
  const promptEl = document.getElementById('interaction-prompt');
  const promptText = document.getElementById('prompt-text');
  const audioToggleBtn = document.getElementById('audio-toggle');
  const audioLabel = document.getElementById('audio-label');
  const iconAudioOff = document.getElementById('icon-audio-off');
  const iconAudioOn = document.getElementById('icon-audio-on');
  const audioVolumeSlider = document.getElementById('audio-volume');
  const cameraToggleBtn = document.getElementById('camera-toggle');
  const cameraBtnLabel = document.getElementById('camera-btn-label');

  const setProgress = (pct, msg) => {
    if (loadingBarFill) loadingBarFill.style.width = `${pct}%`;
    if (loadingStatus && msg) loadingStatus.textContent = msg;
  };

  // Shared reactive simulation state bound to ControlPanel
  const simState = {
    timeOfDay: 9.25,
    autoCycle: true,
    cycleSpeed: 0.12,
    weather: 'Clear',
    fogDensity: 1.0,
    godRayIntensity: 1.0,
    windSpeed: 1.0,
    windDirection: 25,
    gustTurbulence: 0.55,
    cameraMode: 'Orbit',
    quality: 'High',
  };

  // Smoothly interpolated weather transition state
  const weatherState = {
    rainIntensity: 0.0,
    wetness: 0.0,
    windMult: 1.0,
    gustMult: 1.0,
  };

  setProgress(15, 'Initializing WebGL renderer & wind field…');
  await nextPaint();

  const engine = new Engine(viewport);
  const windSystem = new WindSystem({
    windSpeed: simState.windSpeed,
    windDirection: simState.windDirection,
    gustTurbulence: simState.gustTurbulence,
  });

  setProgress(32, 'Sculpting terrain, stream valley & ground shaders…');
  await nextPaint();

  const terrain = new Terrain(4242);
  engine.scene.add(terrain.mesh);

  const streamWater = new StreamWater(terrain, windSystem);
  engine.scene.add(streamWater.mesh);

  const skyLighting = new SkyLighting(engine.scene, engine.renderer, terrain);

  setProgress(54, 'Growing pines, oaks & silver birches…');
  await nextPaint();

  const treeFactory = new TreeFactory(engine.scene, terrain, windSystem);

  setProgress(74, 'Scattering grass meadow, ferns, boulders & mushrooms…');
  await nextPaint();

  const undergrowth = new Undergrowth(engine.scene, terrain, windSystem, treeFactory.treePositions);
  const particles = new Particles(engine.scene, terrain, windSystem);
  const audio = new ProceduralAudio({ volume: parseFloat(audioVolumeSlider?.value || '0.72') });

  setProgress(90, 'Lighting campfire, flock & soundscape…');
  await nextPaint();

  // HUD synchronization helpers
  let isPointerLocked = false;
  let lastClockText = '';
  let lastPhaseText = '';

  const updateAudioUI = () => {
    const muted = audio.isMuted();
    if (audioToggleBtn) {
      audioToggleBtn.classList.toggle('active', !muted);
      audioToggleBtn.setAttribute('aria-pressed', String(!muted));
    }
    if (audioLabel) audioLabel.textContent = muted ? 'Sound Off' : 'Sound On';
    if (iconAudioOff) iconAudioOff.classList.toggle('hidden', !muted);
    if (iconAudioOn) iconAudioOn.classList.toggle('hidden', muted);
  };

  const updateCameraUI = (mode) => {
    simState.cameraMode = mode;
    if (hudCamera) hudCamera.textContent = mode;
    if (cameraBtnLabel) {
      cameraBtnLabel.textContent = mode === 'Orbit' ? 'First-Person' : 'Orbit View';
    }
    viewport.classList.toggle('fp-mode', mode === 'First-Person');
    if (crosshair) {
      crosshair.classList.toggle('visible', mode === 'First-Person' && isPointerLocked);
      if (mode !== 'First-Person') crosshair.classList.remove('interactive');
    }
    controlPanel?.sync();
  };

  const updatePromptUI = (text, isInteractive) => {
    if (promptText && text) promptText.textContent = text;
    if (promptEl) promptEl.classList.toggle('highlight', Boolean(isInteractive));
    viewport.classList.toggle('interactive-hover', Boolean(isInteractive) && simState.cameraMode === 'Orbit');
    if (crosshair) {
      crosshair.classList.toggle('interactive', Boolean(isInteractive) && simState.cameraMode === 'First-Person');
    }
  };

  const controls = new ControlsAndRaycast(engine, terrain, windSystem, audio, {
    onCameraModeChange: (mode) => updateCameraUI(mode),
    onPromptChange: (text, isInteractive) => updatePromptUI(text, isInteractive),
    onPointerLockChange: (locked) => {
      isPointerLocked = locked;
      if (crosshair) {
        crosshair.classList.toggle('visible', simState.cameraMode === 'First-Person' && locked);
      }
    },
    onCampfireToggle: () => {
      // Prompt updates immediately on next raycast tick
    },
    onBirdsStartled: () => {
      // Audio trigger handled inside ControlsAndRaycast
    },
  });

  const syncColliders = () => {
    const combined = [
      ...treeFactory.getActiveColliders(),
      ...undergrowth.getActiveColliders(),
    ];
    controls.setColliders(combined);
  };

  const applyQualityPreset = (preset) => {
    simState.quality = preset;
    treeFactory.setQuality(preset);
    undergrowth.setQuality(preset);
    skyLighting.setQuality(preset);
    particles.setQuality(preset);
    engine.setMaxPixelRatio(QUALITY_PIXEL_RATIO[preset] ?? 1.75);
    syncColliders();
  };

  const applyWindParams = () => {
    windSystem.setWindSpeed(simState.windSpeed);
    windSystem.setWindDirection(simState.windDirection);
    windSystem.setGustTurbulence(simState.gustTurbulence);
  };

  const applyWeatherImmediate = (weather) => {
    simState.weather = weather;
    const target = WEATHER_PRESETS[weather] || WEATHER_PRESETS.Clear;
    weatherState.rainIntensity = target.rain;
    weatherState.wetness = target.wetness;
    weatherState.windMult = target.windMult;
    weatherState.gustMult = target.gustMult;
    windSystem.setWeatherModifiers({
      windMult: weatherState.windMult,
      gustMult: weatherState.gustMult,
      wetness: weatherState.wetness,
    });
    if (hudWeather) hudWeather.textContent = weather;
    controlPanel?.sync();
  };

  const controlPanel = new ControlPanel(simState, {
    onTimeChange: () => {
      if (hudClock) hudClock.textContent = formatClock(simState.timeOfDay);
      if (hudPhase) hudPhase.textContent = getDayPhaseLabel(simState.timeOfDay);
    },
    onWeatherChange: (weather) => {
      if (hudWeather) hudWeather.textContent = weather;
    },
    onWindChange: () => applyWindParams(),
    onAtmosphereChange: () => {},
    onCameraModeChange: (mode) => controls.setCameraMode(mode),
    onQualityChange: (preset) => applyQualityPreset(preset),
    onToggleCampfire: () => controls.toggleCampfire(),
    onStartleBirds: () => controls.startleBirds(),
    onResetCamera: () => controls.resetCamera(),
  });

  engine.attachStats(controlPanel.stats);
  applyQualityPreset(simState.quality);
  applyWindParams();
  updateAudioUI();
  updateCameraUI(simState.cameraMode);

  // Wire HUD dock controls
  if (audioToggleBtn) {
    audioToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      audio.unlock();
      audio.toggleMute();
      updateAudioUI();
    });
  }

  if (audioVolumeSlider) {
    audioVolumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      audio.setVolume(vol);
      if (vol > 0 && audio.isMuted()) {
        audio.unlock();
        audio.setMuted(false);
        updateAudioUI();
      }
    });
  }

  if (cameraToggleBtn) {
    cameraToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextMode = simState.cameraMode === 'Orbit' ? 'First-Person' : 'Orbit';
      controls.setCameraMode(nextMode);
    });
  }

  // Reusable scratch vector for update loop (zero per-frame allocations)
  const playerPos = new THREE.Vector3();

  // Fixed-step loop for boid flock steering
  engine.onFixedUpdate((fixedDt, elapsed) => {
    controls.updateFixed(fixedDt, elapsed);
  });

  // Main per-frame simulation loop
  engine.onUpdate((dt, elapsed) => {
    // 1. Advance 24h cycle when enabled
    if (simState.autoCycle && simState.cycleSpeed > 0) {
      simState.timeOfDay = (simState.timeOfDay + dt * simState.cycleSpeed * 0.45) % 24;
    }

    // 2. Smoothly blend weather modifiers
    const targetWeather = WEATHER_PRESETS[simState.weather] || WEATHER_PRESETS.Clear;
    const weatherAlpha = 1.0 - Math.exp(-dt * 3.8);
    weatherState.rainIntensity += (targetWeather.rain - weatherState.rainIntensity) * weatherAlpha;
    weatherState.wetness += (targetWeather.wetness - weatherState.wetness) * weatherAlpha;
    weatherState.windMult += (targetWeather.windMult - weatherState.windMult) * weatherAlpha;
    weatherState.gustMult += (targetWeather.gustMult - weatherState.gustMult) * weatherAlpha;

    windSystem.setWeatherModifiers({
      windMult: weatherState.windMult,
      gustMult: weatherState.gustMult,
      wetness: weatherState.wetness,
    });
    windSystem.update(dt, elapsed);

    // 3. Update camera, raycasting, campfire & birds
    controls.update(dt, elapsed);
    controls.getPlayerPosition(playerPos);

    // 4. Update 24h sky, directional sun/moon, fog, and volumetric sunbeams
    const sky = skyLighting.update(dt, elapsed, {
      timeOfDay: simState.timeOfDay,
      weather: simState.weather,
      fogDensityMultiplier: simState.fogDensity,
      godRayIntensity: simState.godRayIntensity,
      camera: engine.camera,
    });

    engine.setExposure(sky.recommendedExposure);
    engine.setBloomConfig({ strength: sky.recommendedBloomStrength });

    // 5. Update terrain & meandering stream water shaders
    terrain.update(elapsed, {
      sunDir: sky.sunDir,
      sunIntensity: sky.sunIntensity,
      wetness: weatherState.wetness,
    });

    streamWater.update(elapsed, {
      sunDir: sky.sunDir,
      sunColor: sky.sunColor,
      skyZenithColor: sky.skyZenithColor,
      skyHorizonColor: sky.skyHorizonColor,
      sunIntensity: sky.sunIntensity,
      fogColor: sky.fogColor,
      fogDensity: sky.fogDensity,
      rainIntensity: weatherState.rainIntensity,
      windSpeed: windSystem.uniforms.uWindSpeed.value,
    });

    // 6. Update bioluminescent mushrooms, mossy boulder wetness, and atmospheric particles
    undergrowth.update(dt, elapsed, {
      nightFactor: sky.nightFactor,
      wetness: weatherState.wetness,
    });

    particles.update(dt, elapsed, {
      cameraPos: engine.camera.position,
      daylight: sky.daylight,
      nightFactor: sky.nightFactor,
      weather: simState.weather,
      rainIntensity: weatherState.rainIntensity,
      windSpeed: windSystem.uniforms.uWindSpeed.value,
    });

    // 7. Update real-time procedural Web Audio soundscape
    const localGust = windSystem.sampleGustAt(playerPos.x, playerPos.z);
    const streamDistance = terrain.getStreamDistance(playerPos.x, playerPos.z);
    const campfireDistance = playerPos.distanceTo(controls.campfirePos);

    audio.update(dt, elapsed, {
      gustIntensity: localGust.intensity,
      windSpeed: windSystem.uniforms.uWindSpeed.value,
      streamDistance,
      campfireDistance,
      campfireLit: controls.isCampfireLit(),
      daylight: sky.daylight,
      nightFactor: sky.nightFactor,
      rainIntensity: weatherState.rainIntensity,
    });

    // 8. Refresh compact HUD clock & phase text only when changed
    const clockStr = formatClock(simState.timeOfDay);
    if (clockStr !== lastClockText) {
      lastClockText = clockStr;
      if (hudClock) hudClock.textContent = clockStr;
    }
    const phaseStr = getDayPhaseLabel(simState.timeOfDay);
    if (phaseStr !== lastPhaseText) {
      lastPhaseText = phaseStr;
      if (hudPhase) hudPhase.textContent = phaseStr;
    }
  });

  // Expose live inspection & test API on window
  window.__FOREST_SIM__ = {
    state: simState,
    engine,
    terrain,
    streamWater,
    windSystem,
    skyLighting,
    treeFactory,
    undergrowth,
    particles,
    controls,
    audio,
    controlPanel,
    setTimeOfDay(hours) {
      simState.autoCycle = false;
      simState.timeOfDay = ((hours % 24) + 24) % 24;
      controlPanel.sync();
    },
    setWeather(weather, immediate = true) {
      if (immediate) {
        applyWeatherImmediate(weather);
      } else {
        simState.weather = weather;
        if (hudWeather) hudWeather.textContent = weather;
        controlPanel.sync();
      }
    },
    setQuality(preset) {
      applyQualityPreset(preset);
      controlPanel.sync();
    },
    setCameraMode(mode) {
      controls.setCameraMode(mode);
    },
    toggleCampfire(forceState) {
      return controls.toggleCampfire(forceState);
    },
    startleBirds() {
      return controls.startleBirds();
    },
    getWebGLError() {
      const gl = engine.renderer.getContext();
      return gl ? gl.getError() : -1;
    },
    getSceneStats() {
      const info = engine.renderer.info;
      return {
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        campfireLit: controls.isCampfireLit(),
        birdsFlying: controls.areBirdsFlying(),
        cameraMode: controls.getCameraMode(),
        timeOfDay: simState.timeOfDay,
        weather: simState.weather,
        quality: simState.quality,
        treeColliders: treeFactory.getActiveColliders().length,
        undergrowthColliders: undergrowth.getActiveColliders().length,
      };
    },
  };

  setProgress(100, 'Compiling forest shaders…');
  engine.start();

  // Warm up one frame so shader compilation finishes before fading loading veil
  await nextPaint();
  await nextPaint();

  if (loadingScreen) {
    loadingScreen.classList.add('fade-out');
    setTimeout(() => loadingScreen.remove(), 600);
  }
}

bootstrapForest().catch((err) => {
  console.error('Failed to initialize Sylva 3D Forest Simulation:', err);
  const status = document.getElementById('loading-status');
  if (status) {
    status.textContent = `Initialization error: ${err.message}`;
    status.style.color = '#f08a7e';
  }
});
