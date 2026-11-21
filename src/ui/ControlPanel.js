import GUI from 'lil-gui';
import Stats from 'stats.js';

/**
 * Interactive lil-gui forest, character & wildlife control suite + Stats.js FPS monitor.
 */
export class ControlPanel {
  constructor(state = {}, callbacks = {}) {
    this.state = state;
    this.callbacks = callbacks;

    // Ensure expected state defaults exist without overriding provided values
    if (this.state.timeOfDay === undefined) this.state.timeOfDay = 9.25;
    if (this.state.autoCycle === undefined) this.state.autoCycle = true;
    if (this.state.cycleSpeed === undefined) this.state.cycleSpeed = 0.12;
    if (this.state.weather === undefined) this.state.weather = 'Clear';
    if (this.state.fogDensity === undefined) this.state.fogDensity = 1.0;
    if (this.state.godRayIntensity === undefined) this.state.godRayIntensity = 1.0;
    if (this.state.windSpeed === undefined) this.state.windSpeed = 1.0;
    if (this.state.windDirection === undefined) this.state.windDirection = 25;
    if (this.state.gustTurbulence === undefined) this.state.gustTurbulence = 0.55;
    if (this.state.cameraMode === undefined) this.state.cameraMode = 'Third-Person';
    if (this.state.sprintSpeed === undefined) this.state.sprintSpeed = 1.0;
    if (this.state.infiniteStamina === undefined) this.state.infiniteStamina = false;
    if (this.state.wildlifePopulation === undefined) this.state.wildlifePopulation = 1.0;
    if (this.state.quality === undefined) this.state.quality = 'High';

    // FPS Monitor (Stats.js)
    this.stats = new Stats();
    this.stats.showPanel(0);
    this.stats.dom.classList.add('forest-stats');
    document.body.appendChild(this.stats.dom);

    // Collapsible lil-gui Control Panel
    this.gui = new GUI({ title: 'Forest Controls', width: 282 });

    // 1. Character & Wildlife (primary playable controls)
    const characterFolder = this.gui.addFolder('Character & Wildlife');
    characterFolder
      .add(this.state, 'cameraMode', ['Third-Person', 'First-Person Body', 'Free Orbit'])
      .name('Camera Mode')
      .listen()
      .onChange((value) => {
        this.callbacks.onCameraModeChange?.(value, this.state);
      });

    characterFolder
      .add(this.state, 'sprintSpeed', 0.6, 1.8, 0.05)
      .name('Sprint Speed ×')
      .onChange((value) => {
        this.callbacks.onCharacterChange?.(this.state, value);
      });

    characterFolder
      .add(this.state, 'infiniteStamina')
      .name('Infinite Stamina')
      .onChange(() => {
        this.callbacks.onCharacterChange?.(this.state);
      });

    characterFolder
      .add(this.state, 'wildlifePopulation', 0.25, 1.5, 0.05)
      .name('Wildlife Pop ×')
      .onChange((value) => {
        this.callbacks.onWildlifeChange?.(value, this.state);
      });

    const wildlifeActions = {
      triggerRatScare: () => this.callbacks.onTriggerRatScare?.(),
      triggerStreamSlip: () => this.callbacks.onTriggerStreamSlip?.(),
    };
    characterFolder.add(wildlifeActions, 'triggerRatScare').name('Trigger Rat Scare (Key: R)');
    characterFolder.add(wildlifeActions, 'triggerStreamSlip').name('Trigger Stream Slip');

    // 2. Atmosphere & Sky
    const atmosphereFolder = this.gui.addFolder('Atmosphere & Sky');
    atmosphereFolder
      .add(this.state, 'timeOfDay', 0, 24, 0.05)
      .name('Time of Day (h)')
      .listen()
      .onChange((value) => {
        this.callbacks.onTimeChange?.(value, this.state);
      });

    atmosphereFolder
      .add(this.state, 'autoCycle')
      .name('Auto Time Cycle')
      .onChange(() => {
        this.callbacks.onTimeChange?.(this.state.timeOfDay, this.state);
      });

    atmosphereFolder
      .add(this.state, 'cycleSpeed', 0, 2.0, 0.05)
      .name('Cycle Speed')
      .onChange(() => {
        this.callbacks.onTimeChange?.(this.state.timeOfDay, this.state);
      });

    atmosphereFolder
      .add(this.state, 'weather', ['Clear', 'Gale', 'Rain'])
      .name('Weather')
      .onChange((value) => {
        this.callbacks.onWeatherChange?.(value, this.state);
      });

    atmosphereFolder
      .add(this.state, 'fogDensity', 0, 2.5, 0.05)
      .name('Fog Density')
      .onChange(() => {
        this.callbacks.onAtmosphereChange?.(this.state);
      });

    atmosphereFolder
      .add(this.state, 'godRayIntensity', 0, 2.0, 0.05)
      .name('God-Ray Intensity')
      .onChange(() => {
        this.callbacks.onAtmosphereChange?.(this.state);
      });

    // 3. Wind Simulation (collapsed cleanly to keep panel tidy)
    const windFolder = this.gui.addFolder('Wind Simulation');
    windFolder
      .add(this.state, 'windSpeed', 0, 3.5, 0.05)
      .name('Wind Speed')
      .onChange(() => {
        this.callbacks.onWindChange?.(this.state);
      });

    windFolder
      .add(this.state, 'windDirection', 0, 360, 1)
      .name('Wind Direction (°)')
      .onChange(() => {
        this.callbacks.onWindChange?.(this.state);
      });

    windFolder
      .add(this.state, 'gustTurbulence', 0, 1.5, 0.05)
      .name('Gust Turbulence')
      .onChange(() => {
        this.callbacks.onWindChange?.(this.state);
      });
    windFolder.close();

    // 4. Graphics & Quick Actions
    const actionsFolder = this.gui.addFolder('Quality & Quick Actions');
    actionsFolder
      .add(this.state, 'quality', ['Medium', 'High', 'Ultra'])
      .name('Quality Preset')
      .onChange((value) => {
        this.callbacks.onQualityChange?.(value, this.state);
      });

    const setTimePreset = (hours) => {
      this.state.timeOfDay = hours;
      this.sync();
      this.callbacks.onTimeChange?.(hours, this.state);
    };

    const actions = {
      dawn: () => setTimePreset(6.25),
      morning: () => setTimePreset(9.5),
      sunset: () => setTimePreset(18.33),
      night: () => setTimePreset(23.0),
      toggleCampfire: () => this.callbacks.onToggleCampfire?.(),
      startleBirds: () => this.callbacks.onStartleBirds?.(),
      triggerLightning: () => this.callbacks.onTriggerLightning?.(),
      resetCamera: () => this.callbacks.onResetCamera?.(),
    };

    actionsFolder.add(actions, 'dawn').name('Dawn (6:15)');
    actionsFolder.add(actions, 'morning').name('Morning (9:30)');
    actionsFolder.add(actions, 'sunset').name('Sunset (18:20)');
    actionsFolder.add(actions, 'night').name('Moonlit Night (23:00)');
    actionsFolder.add(actions, 'toggleCampfire').name('Toggle Campfire');
    actionsFolder.add(actions, 'startleBirds').name('Startle Birds');
    actionsFolder.add(actions, 'triggerLightning').name('Trigger Lightning');
    actionsFolder.add(actions, 'resetCamera').name('Reset Camera');
    actionsFolder.close();
  }

  sync() {
    if (!this.gui) return;
    const controllers = this.gui.controllersRecursive();
    for (let i = 0; i < controllers.length; i++) {
      controllers[i].updateDisplay();
    }
  }

  dispose() {
    if (this.gui) {
      this.gui.destroy();
      this.gui = null;
    }
    if (this.stats && this.stats.dom && this.stats.dom.parentNode) {
      this.stats.dom.parentNode.removeChild(this.stats.dom);
    }
    this.stats = null;
  }
}
