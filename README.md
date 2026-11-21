# Sylva — Interactive 3D Forest Simulation

An interactive, procedurally generated 3D forest ecosystem built with **Vite** and **Three.js (ES Modules)**.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcatalystberry842-alt%2Fsylva-forest-sim&project-name=sylva-forest-sim&repository-name=sylva-forest-sim)

## Highlights
- **Procedural Terrain & Winding Stream (`src/world/Terrain.js`, `src/world/StreamWater.js`)**: 5-octave Simplex noise hills, carved sinusoidal valley channel, flat mossy campfire glade, custom 4-biome PBR splat-blended shader (soil/pine litter, moss, wet river pebbles, slope-blended cliff rock), and custom GLSL stream water with dual-scrolling ripples, raindrop rings, Fresnel reflections, depth absorption, shoreline foam, and riverbed caustics.
- **GPU-Instanced Forest Ecosystem (`src/vegetation/TreeFactory.js`, `src/vegetation/Undergrowth.js`)**: Three procedural tree species (Ancient Pines / Douglas Firs, Gnarled Broadleaf Oaks, Silver Birches) with procedural bark/foliage textures and baked canopy AO, plus up to 52,000 curved 4-segment grass blades, sword ferns, wildflowers, world-up mossy granite boulders, nurse logs, tree stumps, and night-blooming cyan/amber bioluminescent mushrooms.
- **Unified GPU Wind & Foliage Parting (`src/shaders/windSystem.js`)**: Toroidal 4D-Simplex gust-field texture driving synchronized 3-tier hierarchical tree sway (plus swaying cast shadows), meadow wind ripples, and smooth 2.5-unit player/cursor grass & fern parting.
- **Atmosphere, Volumetric Sunbeams & Post-Processing (`src/atmosphere/SkyLighting.js`, `src/atmosphere/Particles.js`, `src/core/Engine.js`)**: 24-hour sun/moon cycle, Rayleigh/Mie sky, starfield + cratered moon, volumetric sunbeams, pollen motes, wind-swept falling leaves, 3D curl-noise nocturnal fireflies, forest rain precipitation, and `EffectComposer` + `UnrealBloomPass`.
- **Dual Cameras, Interactive World & Procedural Web Audio (`src/interaction/ControlsAndRaycast.js`, `src/audio/ProceduralAudio.js`, `src/ui/ControlPanel.js`)**: Orbit & First-Person Explorer modes (`C` key) with 2D spatial-hash collision, clickable stone campfire, clickable 18-bird flock with 3D boid steering, real-time Web Audio soundscape, `lil-gui` controls, and `stats.js`.

## Local Development

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
npm run preview
```
