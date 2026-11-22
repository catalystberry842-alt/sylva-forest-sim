import * as THREE from 'three';
import { WATER_LEVEL } from './Terrain.js';
import { clamp } from '../utils/random.js';

const STEP_UP_MAX = 0.88;
const COPLANAR_STRUCTURE_BIAS = 0.035;
const FINITE_DIFF_EPS = 0.08;
const COLLISION_PASSES = 3;

function wrapAngle(angle) {
  let a = (angle + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

function toVector3(v) {
  if (v instanceof THREE.Vector3) return v.clone();
  return new THREE.Vector3(v?.x ?? 0, v?.y ?? 0, v?.z ?? 0);
}

/**
 * Push circle `(pos.x, pos.z)` with `radius` out of 2D line segment `A -> B`.
 * Returns true if any displacement was applied.
 */
function resolveCircleVsSegment2D(pos, radius, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const abLenSq = abx * abx + abz * abz;
  let t = 0;
  if (abLenSq > 1e-10) {
    t = clamp(((pos.x - ax) * abx + (pos.z - az) * abz) / abLenSq, 0, 1);
  }
  const qx = ax + abx * t;
  const qz = az + abz * t;
  const dx = pos.x - qx;
  const dz = pos.z - qz;
  const distSq = dx * dx + dz * dz;
  if (distSq >= radius * radius) return false;

  if (distSq > 1e-10) {
    const dist = Math.sqrt(distSq);
    const push = radius - dist;
    pos.x += (dx / dist) * push;
    pos.z += (dz / dist) * push;
  } else {
    // Fallback perpendicular to segment
    const len = Math.sqrt(abLenSq) || 1;
    pos.x += (-abz / len) * radius;
    pos.z += (abx / len) * radius;
  }
  return true;
}

/**
 * Unified multi-layer walkable surface, doorway sliding collision, and indoor
 * shelter / acoustic volume solver wrapping `Terrain`.
 *
 * Orientation convention matches Three.js `Object3D.rotation.y = yaw`:
 *   Local -> World: wx = cx + lx * cos(yaw) + lz * sin(yaw)
 *                   wz = cz - lx * sin(yaw) + lz * cos(yaw)
 *   World -> Local: lx =  dx * cos(yaw) - dz * sin(yaw)
 *                   lz =  dx * sin(yaw) + dz * cos(yaw)
 */
export class SurfaceSolver {
  constructor(terrain) {
    this.terrain = terrain;
    this.waterLevel = terrain?.waterLevel ?? WATER_LEVEL;

    this._decks = [];
    this._circleFloors = [];
    this._wallOBBs = [];
    this._hollowRings = [];
    this._shelterVolumes = [];

    // Reusable scratch vectors to minimize GC overhead in hot query paths
    this._scratchNormal = new THREE.Vector3();
    this._candidateNormal = new THREE.Vector3();
  }

  // ---------------------------------------------------------------------------
  // Multi-Layer Walkable Surface Primitives
  // ---------------------------------------------------------------------------

  /**
   * Registers an oriented rectangular walkable deck, porch, stair tread,
   * cavern floor, or curved bridge deck.
   */
  addDeck({
    id = null,
    cx = 0,
    cz = 0,
    halfW = 1,
    halfD = 1,
    yaw = 0,
    heightFn = () => 0,
    normalFn = null,
    surfaceType = 'wood',
  }) {
    const resolvedHeightFn =
      typeof heightFn === 'function' ? heightFn : () => Number(heightFn) || 0;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const boundR = Math.hypot(halfW, halfD);

    const entry = {
      id: id ?? `deck_${this._decks.length}`,
      cx,
      cz,
      halfW: Math.abs(halfW),
      halfD: Math.abs(halfD),
      yaw,
      cosY,
      sinY,
      boundR,
      boundRSq: boundR * boundR,
      heightFn: resolvedHeightFn,
      normalFn: typeof normalFn === 'function' ? normalFn : null,
      surfaceType,
    };

    this._decks.push(entry);
    return entry;
  }

  /**
   * Registers a circular walkable floor (e.g., hollow ancient redwood interior).
   */
  addCircleFloor({
    id = null,
    cx = 0,
    cz = 0,
    radius = 1,
    height = 0,
    surfaceType = 'moss',
  }) {
    const r = Math.abs(radius);
    const heightFn = typeof height === 'function' ? height : () => Number(height) || 0;

    const entry = {
      id: id ?? `circle_${this._circleFloors.length}`,
      cx,
      cz,
      radius: r,
      radiusSq: r * r,
      heightFn,
      isConstantHeight: typeof height !== 'function',
      surfaceType,
    };

    this._circleFloors.push(entry);
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Wall & Doorway Sliding Collision Primitives
  // ---------------------------------------------------------------------------

  /**
   * Registers an oriented bounding-box wall segment for smooth 2D circle sliding.
   * Doorways are formed cleanly by splitting a wall into left/right OBBs around a gap.
   */
  addWallOBB({
    id = null,
    cx = 0,
    cz = 0,
    halfW = 0.25,
    halfD = 0.25,
    yaw = 0,
    minY = -10,
    maxY = 20,
  }) {
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const hw = Math.abs(halfW);
    const hd = Math.abs(halfD);
    const boundR = Math.hypot(hw, hd);

    const entry = {
      id: id ?? `wall_${this._wallOBBs.length}`,
      cx,
      cz,
      halfW: hw,
      halfD: hd,
      yaw,
      cosY,
      sinY,
      boundR,
      minY,
      maxY,
    };

    this._wallOBBs.push(entry);
    return entry;
  }

  /**
   * Registers a circular thick ring wall (e.g., Hollow Giant Redwood) with a crisp
   * open archway across `[gapAngle - gapHalfWidth, gapAngle + gapHalfWidth]`.
   * Polar angle convention: `atan2(z - cz, x - cx)` (`0` = +X east, `PI/2` = +Z south).
   */
  addHollowRingWall({
    id = null,
    cx = 0,
    cz = 0,
    innerRadius = 1.5,
    outerRadius = 2.4,
    gapAngle = 0,
    gapHalfWidth = 0.4,
    minY = -10,
    maxY = 20,
  }) {
    const rIn = Math.max(0.05, Math.min(innerRadius, outerRadius));
    const rOut = Math.max(rIn + 0.05, outerRadius);
    const halfGap = clamp(Math.abs(gapHalfWidth), 0, Math.PI);

    const theta1 = gapAngle - halfGap;
    const theta2 = gapAngle + halfGap;

    const entry = {
      id: id ?? `ring_${this._hollowRings.length}`,
      cx,
      cz,
      innerRadius: rIn,
      outerRadius: rOut,
      gapAngle,
      gapHalfWidth: halfGap,
      minY,
      maxY,
      // Precomputed radial doorway jamb segment endpoints (inner -> outer)
      jamb1Ax: cx + Math.cos(theta1) * rIn,
      jamb1Az: cz + Math.sin(theta1) * rIn,
      jamb1Bx: cx + Math.cos(theta1) * rOut,
      jamb1Bz: cz + Math.sin(theta1) * rOut,
      jamb2Ax: cx + Math.cos(theta2) * rIn,
      jamb2Az: cz + Math.sin(theta2) * rIn,
      jamb2Bx: cx + Math.cos(theta2) * rOut,
      jamb2Bz: cz + Math.sin(theta2) * rOut,
    };

    this._hollowRings.push(entry);
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Indoor Shelter & Acoustic Volumes
  // ---------------------------------------------------------------------------

  /**
   * Registers an indoor shelter volume for rain exclusion, wind damping, and
   * spatial acoustics ('wood', 'cave', etc.).
   */
  addShelterVolume({
    id = null,
    type = 'structure',
    min,
    max,
    testFn = null,
    blocksRain = true,
    windDamping = 0.85,
    acousticZone = 'wood',
  }) {
    const vMin = toVector3(min);
    const vMax = toVector3(max);
    // Ensure min <= max per axis
    const minVec = new THREE.Vector3(
      Math.min(vMin.x, vMax.x),
      Math.min(vMin.y, vMax.y),
      Math.min(vMin.z, vMax.z)
    );
    const maxVec = new THREE.Vector3(
      Math.max(vMin.x, vMax.x),
      Math.max(vMin.y, vMax.y),
      Math.max(vMin.z, vMax.z)
    );

    const entry = {
      id: id ?? `shelter_${this._shelterVolumes.length}`,
      type,
      min: minVec,
      max: maxVec,
      testFn: typeof testFn === 'function' ? testFn : null,
      blocksRain: Boolean(blocksRain),
      windDamping: clamp(windDamping, 0, 1),
      acousticZone: acousticZone || 'wood',
    };

    this._shelterVolumes.push(entry);
    return entry;
  }

  /**
   * Returns world-space AABB boxes (`{ min: THREE.Vector3, max: THREE.Vector3 }`)
   * for all rain-blocking shelter volumes (consumed by `Particles.js` rain shader).
   */
  getShelterBoxes() {
    const boxes = [];
    for (let i = 0; i < this._shelterVolumes.length; i++) {
      const v = this._shelterVolumes[i];
      if (!v.blocksRain) continue;
      boxes.push({
        min: v.min.clone(),
        max: v.max.clone(),
      });
    }
    return boxes;
  }

  /**
   * Queries indoor shelter, rain blocking, wind damping, and acoustic zone at `pos`.
   */
  getShelterState(pos) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
      return {
        sheltered: false,
        blocksRain: false,
        windDamping: 0.0,
        acousticZone: 'outdoor',
        structureId: null,
      };
    }

    let best = null;
    for (let i = 0; i < this._shelterVolumes.length; i++) {
      const v = this._shelterVolumes[i];
      if (
        pos.x < v.min.x ||
        pos.x > v.max.x ||
        pos.y < v.min.y ||
        pos.y > v.max.y ||
        pos.z < v.min.z ||
        pos.z > v.max.z
      ) {
        continue;
      }
      if (v.testFn && !v.testFn(pos)) {
        continue;
      }
      if (!best || v.windDamping > best.windDamping) {
        best = v;
      }
    }

    if (!best) {
      return {
        sheltered: false,
        blocksRain: false,
        windDamping: 0.0,
        acousticZone: 'outdoor',
        structureId: null,
      };
    }

    return {
      sheltered: true,
      blocksRain: best.blocksRain,
      windDamping: best.windDamping,
      acousticZone: best.acousticZone,
      structureId: best.id,
    };
  }

  // ---------------------------------------------------------------------------
  // Unified Walkable Surface Queries
  // ---------------------------------------------------------------------------

  _classifyTerrainSurface(x, z, height, normal) {
    const waterY = this.terrain?.waterLevel ?? WATER_LEVEL;
    if (height <= waterY + 0.04) return 'water';

    const slope = clamp(1.0 - normal.y, 0, 1);
    if (slope > 0.22) return 'rock';

    if (this.terrain?.getClearingDistance) {
      const clearDist = this.terrain.getClearingDistance(x, z);
      const clearRad = this.terrain.clearingRadius ?? 11.5;
      if (clearDist < clearRad * 1.05) return 'moss';
    }

    if (height < waterY + 0.55) return 'dirt';
    if (height < waterY + 1.65 && slope < 0.14) return 'moss';

    return slope < 0.095 ? 'grass' : 'dirt';
  }

  _computeDeckNormal(deck, lx, lz, out) {
    if (deck.normalFn) {
      const res = deck.normalFn(lx, lz, out);
      if (res && res !== out) out.copy(res);
      if (Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z) && out.lengthSq() > 1e-8) {
        return out.normalize();
      }
      return out.set(0, 1, 0);
    }

    // Finite-difference local gradient rotated into world space
    const eps = Math.min(FINITE_DIFF_EPS, deck.halfW * 0.45, deck.halfD * 0.45);
    if (eps < 1e-4) {
      return out.set(0, 1, 0);
    }

    const x0 = clamp(lx - eps, -deck.halfW, deck.halfW);
    const x1 = clamp(lx + eps, -deck.halfW, deck.halfW);
    const z0 = clamp(lz - eps, -deck.halfD, deck.halfD);
    const z1 = clamp(lz + eps, -deck.halfD, deck.halfD);

    const dxSpan = x1 - x0;
    const dzSpan = z1 - z0;

    const dHdx = dxSpan > 1e-5 ? (deck.heightFn(x1, lz) - deck.heightFn(x0, lz)) / dxSpan : 0;
    const dHdz = dzSpan > 1e-5 ? (deck.heightFn(lx, z1) - deck.heightFn(lx, z0)) / dzSpan : 0;

    if (!Number.isFinite(dHdx) || !Number.isFinite(dHdz)) {
      return out.set(0, 1, 0);
    }

    // Local normal (-dHdx, 1, -dHdz) rotated by +yaw into world space
    const nlx = -dHdx;
    const nlz = -dHdz;
    const nwx = nlx * deck.cosY + nlz * deck.sinY;
    const nwz = -nlx * deck.sinY + nlz * deck.cosY;
    return out.set(nwx, 1.0, nwz).normalize();
  }

  /**
   * Samples the highest valid walkable surface at `(x, z)` at or below `referenceY + 0.88`.
   * Waist-height step-up cutoff allows climbing porch stairs & walking through interiors
   * without snapping onto overhead roofs, ceilings, or bridges while wading underneath.
   */
  sampleSurface(x, z, referenceY = Infinity, targetNormal = new THREE.Vector3()) {
    const safeX = Number.isFinite(x) ? x : 0;
    const safeZ = Number.isFinite(z) ? z : 0;
    const cutoff = Number.isFinite(referenceY) ? referenceY + STEP_UP_MAX : Infinity;

    let bestY = this.terrain ? this.terrain.getHeightAt(safeX, safeZ) : 0;
    if (!Number.isFinite(bestY)) bestY = 0;

    if (this.terrain && typeof this.terrain.getNormalAt === 'function') {
      this.terrain.getNormalAt(safeX, safeZ, targetNormal);
      if (!Number.isFinite(targetNormal.x) || targetNormal.lengthSq() < 1e-8) {
        targetNormal.set(0, 1, 0);
      }
    } else {
      targetNormal.set(0, 1, 0);
    }

    let bestType = this._classifyTerrainSurface(safeX, safeZ, bestY, targetNormal);
    let isStructure = false;
    let structureId = null;

    // 1. Evaluate oriented rectangular decks (floors, porch decks, steps, bridges, cavern slabs)
    for (let i = 0; i < this._decks.length; i++) {
      const deck = this._decks[i];
      const dx = safeX - deck.cx;
      const dz = safeZ - deck.cz;
      if (dx * dx + dz * dz > deck.boundRSq) continue;

      const lx = dx * deck.cosY - dz * deck.sinY;
      if (Math.abs(lx) > deck.halfW) continue;
      const lz = dx * deck.sinY + dz * deck.cosY;
      if (Math.abs(lz) > deck.halfD) continue;

      const surfY = deck.heightFn(lx, lz);
      if (!Number.isFinite(surfY) || surfY > cutoff) continue;

      const beats = isStructure ? surfY > bestY : surfY >= bestY - COPLANAR_STRUCTURE_BIAS;
      if (beats) {
        bestY = surfY;
        bestType = deck.surfaceType;
        isStructure = true;
        structureId = deck.id;
        this._computeDeckNormal(deck, lx, lz, this._candidateNormal);
        targetNormal.copy(this._candidateNormal);
      }
    }

    // 2. Evaluate circular walkable floors (e.g., hollow ancient redwood sanctuary)
    for (let i = 0; i < this._circleFloors.length; i++) {
      const cf = this._circleFloors[i];
      const dx = safeX - cf.cx;
      const dz = safeZ - cf.cz;
      if (dx * dx + dz * dz > cf.radiusSq) continue;

      const surfY = cf.heightFn(safeX, safeZ);
      if (!Number.isFinite(surfY) || surfY > cutoff) continue;

      const beats = isStructure ? surfY > bestY : surfY >= bestY - COPLANAR_STRUCTURE_BIAS;
      if (beats) {
        bestY = surfY;
        bestType = cf.surfaceType;
        isStructure = true;
        structureId = cf.id;
        if (cf.isConstantHeight) {
          targetNormal.set(0, 1, 0);
        } else {
          const eps = 0.08;
          const hL = cf.heightFn(safeX - eps, safeZ);
          const hR = cf.heightFn(safeX + eps, safeZ);
          const hD = cf.heightFn(safeX, safeZ - eps);
          const hU = cf.heightFn(safeX, safeZ + eps);
          targetNormal.set(hL - hR, 2.0 * eps, hD - hU).normalize();
        }
      }
    }

    return {
      height: bestY,
      normal: targetNormal,
      surfaceType: bestType,
      isStructure,
      structureId,
    };
  }

  /**
   * Drop-in compatible height query supporting optional waist-height `referenceY`.
   */
  getHeightAt(x, z, referenceY = Infinity) {
    return this.sampleSurface(x, z, referenceY, this._scratchNormal).height;
  }

  /**
   * Drop-in compatible normal query writing into `target` and returning it.
   */
  getNormalAt(x, z, target = new THREE.Vector3(), referenceY = Infinity) {
    this.sampleSurface(x, z, referenceY, target);
    return target;
  }

  /**
   * Drop-in compatible slope query (`1 - normal.y`).
   */
  getSlopeAt(x, z, referenceY = Infinity) {
    const n = this.getNormalAt(x, z, this._scratchNormal, referenceY);
    return clamp(1.0 - n.y, 0, 1);
  }

  // Terrain passthrough helpers for seamless drop-in compatibility
  getClearingCenter3D(target = new THREE.Vector3()) {
    return this.terrain?.getClearingCenter3D ? this.terrain.getClearingCenter3D(target) : target.set(0, 0, 0);
  }

  getClearingDistance(x, z) {
    return this.terrain?.getClearingDistance ? this.terrain.getClearingDistance(x, z) : Math.hypot(x, z);
  }

  getStreamDistance(x, z) {
    return this.terrain?.getStreamDistance ? this.terrain.getStreamDistance(x, z) : Infinity;
  }

  getStreamCenterX(z) {
    return this.terrain?.getStreamCenterX ? this.terrain.getStreamCenterX(z) : 0;
  }

  // ---------------------------------------------------------------------------
  // Iterative Wall & Doorway Sliding Collision Resolution
  // ---------------------------------------------------------------------------

  /**
   * Iteratively resolves (3 passes) 2D circle-vs-OBB walls and hollow-ring arc walls
   * whose vertical `[minY, maxY]` span overlaps `[pos.y + 0.15, pos.y + charHeight]`.
   * Mutates `pos.x` and `pos.z` in place for silky wall-sliding and clean doorway passage.
   */
  resolveCollision(pos, radius = 0.42, charHeight = 1.75) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return false;

    const r = Math.max(0.05, Number.isFinite(radius) ? radius : 0.42);
    const y = Number.isFinite(pos.y) ? pos.y : 0;
    const minCharY = y + 0.15;
    const maxCharY = y + charHeight;

    let anyCollision = false;

    for (let pass = 0; pass < COLLISION_PASSES; pass++) {
      let moved = false;

      // 1. Resolve against all active OBB wall segments
      for (let i = 0; i < this._wallOBBs.length; i++) {
        const wall = this._wallOBBs[i];
        if (wall.maxY < minCharY || wall.minY > maxCharY) continue;

        const dx = pos.x - wall.cx;
        const dz = pos.z - wall.cz;
        const broad = wall.boundR + r;
        if (dx * dx + dz * dz > broad * broad) continue;

        // World -> Wall local space
        const lx = dx * wall.cosY - dz * wall.sinY;
        const lz = dx * wall.sinY + dz * wall.cosY;

        const clx = clamp(lx, -wall.halfW, wall.halfW);
        const clz = clamp(lz, -wall.halfD, wall.halfD);

        const dlx = lx - clx;
        const dlz = lz - clz;
        const distSq = dlx * dlx + dlz * dlz;

        if (distSq >= r * r) continue;

        let plx = 0;
        let plz = 0;
        if (distSq > 1e-10) {
          const dist = Math.sqrt(distSq);
          const push = r - dist;
          plx = (dlx / dist) * push;
          plz = (dlz / dist) * push;
        } else {
          // Center penetrated inside OBB: eject across shallowest axis
          const penX = wall.halfW - Math.abs(lx);
          const penZ = wall.halfD - Math.abs(lz);
          if (penX < penZ) {
            plx = (lx >= 0 ? 1 : -1) * (penX + r);
          } else {
            plz = (lz >= 0 ? 1 : -1) * (penZ + r);
          }
        }

        // Wall local push -> World space
        pos.x += plx * wall.cosY + plz * wall.sinY;
        pos.z += -plx * wall.sinY + plz * wall.cosY;
        moved = true;
        anyCollision = true;
      }

      // 2. Resolve against hollow-ring arc walls (e.g., Hollow Giant Redwood)
      for (let i = 0; i < this._hollowRings.length; i++) {
        const ring = this._hollowRings[i];
        if (ring.maxY < minCharY || ring.minY > maxCharY) continue;

        const dx = pos.x - ring.cx;
        const dz = pos.z - ring.cz;
        const distSq = dx * dx + dz * dz;
        const outerBroad = ring.outerRadius + r;
        if (distSq > outerBroad * outerBroad) continue;

        // Comfortably clear of the inner wall inside the hollow center
        const innerClear = ring.innerRadius - r;
        if (innerClear > 0 && distSq < innerClear * innerClear) continue;

        const dist = Math.sqrt(distSq);
        const ang = dist > 1e-8 ? Math.atan2(dz, dx) : ring.gapAngle;
        const angDiff = wrapAngle(ang - ring.gapAngle);
        const absDiff = Math.abs(angDiff);

        if (absDiff < ring.gapHalfWidth) {
          // Inside angular doorway gap: resolve smoothly against both radial doorway jambs
          const hit1 = resolveCircleVsSegment2D(
            pos,
            r,
            ring.jamb1Ax,
            ring.jamb1Az,
            ring.jamb1Bx,
            ring.jamb1Bz
          );
          const hit2 = resolveCircleVsSegment2D(
            pos,
            r,
            ring.jamb2Ax,
            ring.jamb2Az,
            ring.jamb2Bx,
            ring.jamb2Bz
          );
          if (hit1 || hit2) {
            moved = true;
            anyCollision = true;
          }
        } else {
          // Angularly within the solid annular wall arc
          const nx = dist > 1e-8 ? dx / dist : Math.cos(ring.gapAngle);
          const nz = dist > 1e-8 ? dz / dist : Math.sin(ring.gapAngle);

          if (dist < ring.innerRadius) {
            const targetR = ring.innerRadius - r;
            if (dist > targetR) {
              const push = dist - targetR;
              pos.x -= nx * push;
              pos.z -= nz * push;
              moved = true;
              anyCollision = true;
            }
          } else if (dist > ring.outerRadius) {
            const targetR = ring.outerRadius + r;
            if (dist < targetR) {
              const push = targetR - dist;
              pos.x += nx * push;
              pos.z += nz * push;
              moved = true;
              anyCollision = true;
            }
          } else {
            // Center penetrated into the thick ring wall: eject toward closest surface (inner, outer, or jamb)
            const dInner = dist - ring.innerRadius;
            const dOuter = ring.outerRadius - dist;
            const dJamb = (absDiff - ring.gapHalfWidth) * dist;

            if (dJamb < dInner && dJamb < dOuter && ring.gapHalfWidth > 1e-4) {
              // Eject into doorway opening along nearest jamb
              const jambTheta = angDiff >= 0 ? ring.gapAngle + ring.gapHalfWidth : ring.gapAngle - ring.gapHalfWidth;
              const targetTheta =
                angDiff >= 0
                  ? jambTheta - r / Math.max(dist, 0.25)
                  : jambTheta + r / Math.max(dist, 0.25);
              pos.x = ring.cx + Math.cos(targetTheta) * dist;
              pos.z = ring.cz + Math.sin(targetTheta) * dist;
            } else if (dInner <= dOuter) {
              const targetR = Math.max(0, ring.innerRadius - r);
              pos.x = ring.cx + nx * targetR;
              pos.z = ring.cz + nz * targetR;
            } else {
              const targetR = ring.outerRadius + r;
              pos.x = ring.cx + nx * targetR;
              pos.z = ring.cz + nz * targetR;
            }
            moved = true;
            anyCollision = true;
          }
        }
      }

      if (!moved) break;
    }

    return anyCollision;
  }
}
