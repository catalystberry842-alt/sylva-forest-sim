import './style.css';
import * as THREE from 'three';

import { Engine } from './core/Engine.js';
import { WindSystem } from './shaders/windSystem.js';
import { Terrain } from './world/Terrain.js';
import { SurfaceSolver } from './world/SurfaceSolver.js';
import { WalkableStructures } from './world/WalkableStructures.js';
import { StreamWater } from './world/StreamWater.js';
import { SkyLighting } from './atmosphere/SkyLighting.js';
import { Particles } from './atmosphere/Particles.js';
import { TreeFactory } from './vegetation/TreeFactory.js';
import { Undergrowth } from './vegetation/Undergrowth.js';
import { ControlsAndRaycast } from './interaction/ControlsAndRaycast.js';
import { ProceduralAudio } from './audio/ProceduralAudio.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { InputManager } from './input/InputManager.js';
import { MobileControls, detectMobilePerformanceProfile } from './ui/MobileControls.js';
import { HumanController } from './character/HumanController.js';
import { ForestWildlife } from './wildlife/ForestWildlife.js';
import { GameSystems } from './game/GameSystems.js';

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

const UNDERWATER_FOG_COLOR = new THREE.Color(0x094c60);
const _playerPos = new THREE.Vector3();
const _camForward = new THREE.Vector3();
const _lagoonPos = new THREE.Vector3();
const _swapPos = new THREE.Vector3();

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
  return 'Aurora Night';
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function bootstrapForest() {
  const viewport = document.getElementById('viewport');
  const underwaterOverlay = document.getElementById('underwater-overlay');
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
  const staminaContainer = document.getElementById('stamina-container');
  const staminaFill = document.getElementById('stamina-fill');
  const staminaLabel = document.getElementById('stamina-label');
  const staminaPct = document.getElementById('stamina-pct');
  const reactionBadge = document.getElementById('reaction-badge');
  const reactionText = document.getElementById('reaction-text');
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

  const mobileProfile = detectMobilePerformanceProfile();

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
    character: 'liam',
    cameraMode: 'Third-Person',
    sprintSpeed: 1.0,
    infiniteStamina: false,
    wildlifePopulation: 1.0,
    showTouchControls: mobileProfile.isMobile,
    quality: mobileProfile.recommendedQuality || 'High',
  };

  const weatherState = {
    rainIntensity: 0.0,
    wetness: 0.0,
    windMult: 1.0,
    gustMult: 1.0,
  };

  setProgress(12, 'Initializing WebGL renderer & unified input…');
  await nextPaint();

  const engine = new Engine(viewport);
  engine.setMaxPixelRatio(mobileProfile.isMobile ? 1.75 : 2.0);

  const windSystem = new WindSystem({
    windSpeed: simState.windSpeed,
    windDirection: simState.windDirection,
    gustTurbulence: simState.gustTurbulence,
  });

  setProgress(24, 'Sculpting valley, lagoon, cabin, bridge, redwood & cavern…');
  await nextPaint();

  const terrain = new Terrain(4242);
  engine.scene.add(terrain.mesh);

  const surfaceSolver = new SurfaceSolver(terrain);
  const structures = new WalkableStructures(engine.scene, terrain, surfaceSolver);

  const streamWater = new StreamWater(terrain, windSystem);
  streamWater.setBridgePilings(structures.bridgePilings);
  engine.scene.add(streamWater.mesh);

  const skyLighting = new SkyLighting(engine.scene, engine.renderer, terrain);

  setProgress(44, 'Growing ancient pines, gnarled oaks & silver birches…');
  await nextPaint();

  const treeFactory = new TreeFactory(engine.scene, terrain, windSystem, structures.exclusionZones);

  setProgress(62, 'Scattering meadow, clover, twigs, pebbles & mushrooms…');
  await nextPaint();

  const undergrowth = new Undergrowth(
    engine.scene,
    terrain,
    windSystem,
    treeFactory.treePositions,
    structures.exclusionZones
  );
  const particles = new Particles(engine.scene, terrain, windSystem);
  particles.setShelterBoxes(surfaceSolver.getShelterBoxes());

  const audio = new ProceduralAudio({ volume: parseFloat(audioVolumeSlider?.value || '0.72') });

  setProgress(78, 'Binding skinned characters, Foot IK, wildlife & ancient relics…');
  await nextPaint();

  // HUD & subsystem references
  let isPointerLocked = false;
  let lastClockText = '';
  let lastPhaseText = '';
  let wasCameraUnderwater = false;
  let controlPanel = null;
  let wildlife = null;
  let human = null;
  let mobileControls = null;
  let gameSystems = null;

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

  const updatePromptUI = (text, isInteractive) => {
    if (promptText && text) promptText.textContent = text;
    if (promptEl) promptEl.classList.toggle('highlight', Boolean(isInteractive));
    viewport.classList.toggle(
      'interactive-hover',
      Boolean(isInteractive) && simState.cameraMode !== 'First-Person Body'
    );
    if (crosshair) {
      crosshair.classList.toggle(
        'interactive',
        Boolean(isInteractive) && simState.cameraMode === 'First-Person Body'
      );
    }
  };

  const controls = new ControlsAndRaycast(engine, terrain, windSystem, audio, {
    onPromptChange: (text, isInteractive) => updatePromptUI(text, isInteractive),
  });

  // Unified device-agnostic InputManager (Keyboard + Mouse + Multi-Touch + Tab/1-4)
  const inputManager = new InputManager(engine.renderer.domElement, {
    onJump: () => human?.triggerJump(),
    onRatScare: () => wildlife?.triggerRatScare(human),
    onCameraCycle: () => human?.cycleCameraMode(),
    onCharacterSwitch: () => human?.cycleCharacter(),
    onEmote: (id) => human?.playEmote(id),
    onEmoteCycle: () => human?.cycleEmote(),
    onFirstUserGesture: () => audio.unlock(),
    isHoveringInteractive: () => controls.isHoveringInteractive(),
    getCameraMode: () => human?.getCameraMode() || 'Third-Person',
    onPointerLockChange: (locked) => {
      isPointerLocked = locked;
      controls.setExternalPointerLocked(locked);
      if (crosshair) {
        crosshair.classList.toggle('visible', simState.cameraMode === 'First-Person Body' && locked);
      }
    },
  });

  mobileControls = new MobileControls(inputManager);
  const applyTouchVisibility = (visible) => {
    const show = Boolean(visible);
    simState.showTouchControls = show;
    mobileControls.setVisible(show);
    document.body.classList.toggle('touch-ui-active', show);
    if (show && mobileProfile.isMobile && controlPanel?.gui) {
      controlPanel.gui.close();
    }
    controlPanel?.sync();
  };

  const syncCameraModeUI = (mode) => {
    simState.cameraMode = mode;
    if (hudCamera) hudCamera.textContent = mode;
    if (cameraBtnLabel) cameraBtnLabel.textContent = mode;
    viewport.classList.toggle('fp-mode', mode === 'First-Person Body');
    if (crosshair) {
      crosshair.classList.toggle('visible', mode === 'First-Person Body' && isPointerLocked);
      if (mode !== 'First-Person Body') crosshair.classList.remove('interactive');
    }

    if (mode === 'Free Orbit' && human) {
      human.getPosition(_playerPos);
      controls.orbitControls.target.set(_playerPos.x, _playerPos.y + 1.25, _playerPos.z);
      const camX = _playerPos.x + 6.2;
      const camZ = _playerPos.z + 5.6;
      const camY = Math.max(terrain.getHeightAt(camX, camZ) + 2.4, _playerPos.y + 3.4);
      engine.camera.position.set(camX, camY, camZ);
      controls.orbitControls.update();
    }

    controls.setExternalMode(mode, { pointerLocked: isPointerLocked });
    controlPanel?.sync();
  };

  human = new HumanController(
    engine,
    terrain,
    windSystem,
    streamWater,
    audio,
    {
      onCameraModeChange: (mode) => syncCameraModeUI(mode),
      onCharacterSwitched: (id, pos) => {
        simState.character = id;
        controlPanel?.sync();
        if (pos && gameSystems) {
          _swapPos.set(pos.x, pos.y + 0.95, pos.z);
          gameSystems.spawnSwapBurst(_swapPos);
        }
      },
    },
    { inputManager, surfaceSolver, initialCharacter: simState.character }
  );

  wildlife = new ForestWildlife(engine.scene, terrain, treeFactory.treePositions, audio);
  wildlife.setSurfaceSolver(surfaceSolver);

  gameSystems = new GameSystems(engine.scene, terrain, surfaceSolver, structures, audio);

  // Connect Rain lightning thunderclaps to rolling thunder audio & human startle flinch
  skyLighting.setThunderCallback((intensity) => {
    audio.playThunder(intensity);
    human.triggerThunderFlinch();
  });

  const syncColliders = () => {
    const combined = [
      ...treeFactory.getActiveColliders(),
      ...undergrowth.getActiveColliders(),
    ];
    controls.setColliders(combined);
    human.setColliders(combined);
  };

  const applyQualityPreset = (preset) => {
    simState.quality = preset;
    treeFactory.setQuality(preset);
    undergrowth.setQuality(preset);
    skyLighting.setQuality(preset);
    particles.setQuality(preset);
    const maxDpr = mobileProfile.isMobile
      ? Math.min(QUALITY_PIXEL_RATIO[preset] ?? 1.5, 1.75)
      : Math.min(QUALITY_PIXEL_RATIO[preset] ?? 1.75, 2.0);
    engine.setMaxPixelRatio(maxDpr);
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
    human.setRainWetness(weatherState.wetness);
    if (hudWeather) hudWeather.textContent = weather;
    controlPanel?.sync();
  };

  const teleportToLocation = (name) => {
    if (name === 'clearing') {
      human.resetPositionAndCamera();
      return;
    }
    if (name === 'deepLagoon') {
      terrain.getLagoonCenter3D(_lagoonPos);
      human.teleportTo({ x: _lagoonPos.x, y: -1.34, z: _lagoonPos.z }, 0);
      return;
    }
    const wp = structures.waypoints?.[name];
    if (wp) {
      human.teleportTo(wp.position || wp, Number.isFinite(wp.yaw) ? wp.yaw : null);
      if (simState.cameraMode === 'Free Orbit') {
        human.getPosition(_playerPos);
        controls.orbitControls.target.set(_playerPos.x, _playerPos.y + 1.2, _playerPos.z);
        controls.orbitControls.update();
      }
    }
  };

  controlPanel = new ControlPanel(simState, {
    onCharacterSwitch: (id) => human.switchCharacter(id),
    onCycleCharacter: () => human.cycleCharacter(),
    onEmote: (id) => human.playEmote(id),
    onCameraModeChange: (mode) => human.setCameraMode(mode),
    onToggleTouchControls: (visible) => applyTouchVisibility(visible),
    onTeleport: (loc) => teleportToLocation(loc),
    onCharacterChange: () => {
      human.setSprintMultiplier(simState.sprintSpeed);
      human.setInfiniteStamina(simState.infiniteStamina);
    },
    onWildlifeChange: (pop) => {
      wildlife.setPopulation(pop);
    },
    onTriggerRatScare: () => {
      wildlife.triggerRatScare(human);
    },
    onTriggerStreamSlip: () => {
      human.triggerStreamSlip();
    },
    onTriggerLightning: () => {
      skyLighting.triggerLightning(true);
    },
    onTimeChange: () => {
      if (hudClock) hudClock.textContent = formatClock(simState.timeOfDay);
      if (hudPhase) hudPhase.textContent = getDayPhaseLabel(simState.timeOfDay);
    },
    onWeatherChange: (weather) => {
      if (hudWeather) hudWeather.textContent = weather;
    },
    onWindChange: () => applyWindParams(),
    onAtmosphereChange: () => {},
    onQualityChange: (preset) => applyQualityPreset(preset),
    onToggleCampfire: () => controls.toggleCampfire(),
    onStartleBirds: () => controls.startleBirds(),
    onResetCamera: () => {
      human.resetPositionAndCamera();
      if (simState.cameraMode === 'Free Orbit') {
        controls.resetCamera();
      }
    },
  });

  engine.attachStats(controlPanel.stats);
  applyQualityPreset(simState.quality);
  applyWindParams();
  updateAudioUI();
  syncCameraModeUI(simState.cameraMode);
  applyTouchVisibility(simState.showTouchControls);

  // Wire HUD dock buttons
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
      human.cycleCameraMode();
    });
  }

  // Fixed-step update for 3D boid bird flock
  engine.onFixedUpdate((fixedDt, elapsed) => {
    controls.updateFixed(fixedDt, elapsed);
  });

  // Main per-frame simulation loop (zero per-frame heap allocations!)
  engine.onUpdate((dt, elapsed) => {
    // 1. Advance 24h cycle
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
    human.setRainWetness(weatherState.wetness);

    // 3. Update playable skinned character, SurfaceSolver, Swimming/Diving, Foot IK & camera
    human.update(dt, elapsed);
    human.getPosition(_playerPos);

    if (mobileControls.isVisible()) {
      mobileControls.syncButtonStates({
        sprinting: human.isSprintingInput(),
        crouching: human.isCrouching(),
        cameraMode: human.getCameraMode(),
        inDeepWater: human.isInDeepWater(),
        characterName: human.getCharacterShortName(),
      });
    }

    // 4. Update RPG Relics & Top-Center Compass Bar
    engine.camera.getWorldDirection(_camForward);
    gameSystems.update(dt, elapsed, {
      playerPos: _playerPos,
      cameraForward: _camForward,
    });

    // 5. Update forest wildlife (rats including indoors, squirrels, rabbits)
    wildlife.update(dt, elapsed, human);

    // 6. Update interactive campfire, birds & Free Orbit raycasting
    controls.update(dt, elapsed);

    // 7. Update extreme atmospheric sky, clouds, Milky Way, Aurora, dynamic PMREM & sunbeams
    const sky = skyLighting.update(dt, elapsed, {
      timeOfDay: simState.timeOfDay,
      weather: simState.weather,
      fogDensityMultiplier: simState.fogDensity,
      godRayIntensity: simState.godRayIntensity,
      camera: engine.camera,
    });

    // Apply Underwater View overrides (rich teal-blue exponential fog + caustic veil + muffled audio!)
    const camUnderwater = human.isCameraUnderwater();
    if (camUnderwater !== wasCameraUnderwater) {
      wasCameraUnderwater = camUnderwater;
      audio.setUnderwater(camUnderwater);
      if (underwaterOverlay) {
        underwaterOverlay.classList.toggle('active', camUnderwater);
      }
    }
    if (camUnderwater && engine.scene.fog) {
      engine.scene.fog.color.copy(UNDERWATER_FOG_COLOR).multiplyScalar(0.55 + sky.daylight * 0.65);
      engine.scene.fog.density = 0.088;
      engine.setExposure(sky.recommendedExposure * 0.96);
    } else {
      engine.setExposure(sky.recommendedExposure);
    }
    engine.setBloomConfig({ strength: sky.recommendedBloomStrength });

    // 8. Update walkable structures (lanterns, window spill, cave crystals, redwood sunbeams)
    structures.update(dt, elapsed, {
      nightFactor: sky.nightFactor,
      daylight: sky.daylight,
    });

    // 9. Update terrain & ultra-realistic water (Gerstner + Voronoi caustics + Snell's Window + piling foam)
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
      fogColor: camUnderwater ? engine.scene.fog.color : sky.fogColor,
      fogDensity: camUnderwater ? engine.scene.fog.density : sky.fogDensity,
      rainIntensity: weatherState.rainIntensity,
      windSpeed: windSystem.uniforms.uWindSpeed.value,
    });

    // 10. Update undergrowth & atmospheric particles
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

    // 11. Update procedural Web Audio soundscape
    const listenerPos = simState.cameraMode === 'Free Orbit' ? engine.camera.position : _playerPos;
    const localGust = windSystem.sampleGustAt(listenerPos.x, listenerPos.z);
    const streamDistance = terrain.getStreamDistance(listenerPos.x, listenerPos.z);
    const campfireDistance = listenerPos.distanceTo(controls.campfirePos);

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

    // 12. Update auto-hiding HUD Stamina bar & contextual reaction/swim/shelter alerts
    const stamina = human.getStamina();
    const exhausted = human.isExhausted();
    const showStamina = !simState.infiniteStamina && (stamina < 99.4 || exhausted);
    if (staminaContainer) {
      staminaContainer.classList.toggle('hidden-fade', !showStamina);
      staminaContainer.classList.toggle('exhausted', exhausted);
    }
    if (staminaFill) {
      staminaFill.style.width = `${Math.round(stamina)}%`;
      staminaFill.classList.toggle('low', !exhausted && stamina < 35);
      staminaFill.classList.toggle('exhausted', exhausted);
    }
    if (staminaLabel) {
      staminaLabel.textContent = exhausted ? 'Winded — Recovering' : 'Stamina';
    }
    if (staminaPct) {
      staminaPct.textContent = `${Math.round(stamina)}%`;
    }

    const stateName = human.getStateName();
    const panicInfo = human.getPanicInfo();
    const shelter = human.getShelterState();
    let badgeMsg = '';
    let isCalmStyle = false;
    if (panicInfo.active) {
      if (panicInfo.stage === 1) {
        badgeMsg = 'RAT ON BOOT! Electro-Shock Flinch!';
      } else if (panicInfo.stage === 2) {
        badgeMsg = 'RAT CLIMBING LEG! Shaking furiously — Hold Sprint+Move to flee!';
      } else if (panicInfo.stage === 3) {
        badgeMsg = 'Shivering… Checking boots';
        isCalmStyle = true;
      }
    } else if (stateName === 'SlipRecovery') {
      badgeMsg = 'Slipping on wet stream rocks!';
    } else if (stateName === 'ThunderFlinch') {
      badgeMsg = 'Startled by thunderclap!';
      isCalmStyle = true;
    } else if (human.isSubmerged()) {
      badgeMsg = 'Underwater Diving — Hold Space / UP to Surface';
      isCalmStyle = true;
    } else if (human.isSwimming()) {
      badgeMsg = 'Swimming in Deep Lagoon — Press C / DIVE to Submerge';
      isCalmStyle = true;
    } else if (shelter?.sheltered) {
      const labels = {
        ranger_cabin: 'Inside Rustic Ranger Cabin — Sheltered',
        hollow_redwood: 'Inside Hollow Giant Redwood — Sheltered',
        mossy_cavern: 'Inside Mossy Stone Cavern — Echoing Shelter',
      };
      badgeMsg = labels[shelter.structureId] || 'Sheltered Indoors';
      isCalmStyle = true;
    }

    if (reactionBadge) {
      reactionBadge.classList.toggle('hidden-fade', !badgeMsg);
      reactionBadge.classList.toggle('calm', isCalmStyle);
    }
    if (reactionText && badgeMsg) {
      reactionText.textContent = badgeMsg;
    }

    // 13. Refresh HUD clock & phase text
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
    surfaceSolver,
    structures,
    streamWater,
    windSystem,
    skyLighting,
    treeFactory,
    undergrowth,
    particles,
    controls,
    inputManager,
    mobileControls,
    human,
    wildlife,
    gameSystems,
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
      human.setCameraMode(mode);
    },
    switchCharacter(id) {
      return human.switchCharacter(id);
    },
    cycleCharacter() {
      return human.cycleCharacter();
    },
    playEmote(id) {
      return human.playEmote(id);
    },
    setShowTouchControls(visible) {
      applyTouchVisibility(visible);
    },
    teleportTo(name) {
      teleportToLocation(name);
    },
    triggerRatScare() {
      return wildlife.triggerRatScare(human);
    },
    triggerStreamSlip() {
      human.triggerStreamSlip();
    },
    triggerLightning(immediateThunder = true) {
      skyLighting.triggerLightning(immediateThunder);
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
    getMemoryInfo() {
      return {
        geometries: engine.renderer.info.memory.geometries,
        textures: engine.renderer.info.memory.textures,
        programs: engine.renderer.info.programs?.length ?? 0,
      };
    },
    getSceneStats() {
      const info = engine.renderer.info;
      const hp = human.getPosition(new THREE.Vector3());
      return {
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        character: human.getCharacterId(),
        characterName: human.getCharacterName(),
        cameraMode: human.getCameraMode(),
        humanState: human.getStateName(),
        surfaceType: human.getCurrentSurfaceType(),
        swimming: human.isSwimming(),
        submerged: human.isSubmerged(),
        cameraUnderwater: human.isCameraUnderwater(),
        shelter: human.getShelterState(),
        relicsCollected: gameSystems.getCollectedCount(),
        relicsTotal: gameSystems.getTotalCount(),
        humanPos: { x: Number(hp.x.toFixed(2)), y: Number(hp.y.toFixed(2)), z: Number(hp.z.toFixed(2)) },
        stamina: Number(human.getStamina().toFixed(1)),
        panic: human.getPanicInfo(),
        touchVisible: mobileControls.isVisible(),
        hasEnvironment: Boolean(engine.scene.environment),
        timeOfDay: simState.timeOfDay,
        weather: simState.weather,
        quality: simState.quality,
      };
    },
  };

  setProgress(100, 'Compiling skinned characters, extreme sky & water shaders…');
  engine.start();

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
