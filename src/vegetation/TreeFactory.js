import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise2D } from 'simplex-noise';
import { createRng, clamp, lerp, smoothstep, remap } from '../utils/random.js';

const QUALITY_RATIOS = {
  Medium: 0.55,
  High: 0.78,
  Ultra: 1.0,
};

/**
 * Dilates RGB colors outward into alpha=0 pixels so bilinear filtering and
 * mipmap generation never bleed black fringes around alpha-tested foliage cards.
 */
function dilateAlphaRGB(data, width, height, fallbackRGB, iterations = 10) {
  const total = width * height;
  let valid = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (data[i * 4 + 3] > 28) valid[i] = 1;
  }

  let nextValid = new Uint8Array(valid);
  const offsets = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [1, -1], [-1, 1], [1, 1],
  ];

  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (valid[idx]) continue;

        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let count = 0;
        for (let k = 0; k < offsets.length; k++) {
          const nx = x + offsets[k][0];
          const ny = y + offsets[k][1];
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (valid[nIdx]) {
            const p = nIdx * 4;
            rSum += data[p];
            gSum += data[p + 1];
            bSum += data[p + 2];
            count++;
          }
        }
        if (count > 0) {
          const p = idx * 4;
          data[p] = Math.round(rSum / count);
          data[p + 1] = Math.round(gSum / count);
          data[p + 2] = Math.round(bSum / count);
          nextValid[idx] = 1;
          changed = true;
        }
      }
    }
    valid.set(nextValid);
    if (!changed) break;
  }

  for (let i = 0; i < total; i++) {
    if (!valid[i]) {
      const p = i * 4;
      data[p] = fallbackRGB[0];
      data[p + 1] = fallbackRGB[1];
      data[p + 2] = fallbackRGB[2];
    }
  }
}

/**
 * Ensures a BufferGeometry part is strictly non-indexed and contains the exact
 * 5 attributes required for safe mergeGeometries + windSystem.applyTreeWindShader:
 *   position (3), normal (3), uv (2), color (3: R=trunk, G=branch, B=leaf), aCanopyAO (1).
 */
function finalizeTreePart(geo, windFn, aoFn) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  if (!src.attributes.normal) {
    src.computeVertexNormals();
  }

  const posAttr = src.attributes.position;
  const normAttr = src.attributes.normal;
  const uvAttr = src.attributes.uv;
  const count = posAttr.count;

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const colors = new Float32Array(count * 3);
  const ao = new Float32Array(count);

  const windOut = [0, 0, 0];

  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    normals[i * 3] = normAttr.getX(i);
    normals[i * 3 + 1] = normAttr.getY(i);
    normals[i * 3 + 2] = normAttr.getZ(i);

    const u = uvAttr ? uvAttr.getX(i) : 0;
    const v = uvAttr ? uvAttr.getY(i) : 0;
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;

    windFn(x, y, z, u, v, i, windOut);
    colors[i * 3] = clamp(windOut[0], 0, 1);
    colors[i * 3 + 1] = clamp(windOut[1], 0, 1);
    colors[i * 3 + 2] = clamp(windOut[2], 0, 1);

    ao[i] = clamp(aoFn(x, y, z, u, v, i), 0.35, 1.15);
  }

  const clean = new THREE.BufferGeometry();
  clean.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  clean.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  clean.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  clean.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  clean.setAttribute('aCanopyAO', new THREE.BufferAttribute(ao, 1));

  if (src !== geo) src.dispose();
  geo.dispose();
  return clean;
}

/**
 * Safely merges non-indexed tree parts and disposes all intermediate buffers.
 */
function mergeTreeParts(parts) {
  const merged = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) {
    parts[i].dispose();
  }
  if (!merged) {
    throw new Error('TreeFactory: mergeGeometries returned null due to mismatched attributes.');
  }
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Builds an organic tapered curved tube along a 3D polyline using Parallel Transport
 * frames (zero twisting), optional flared root buttresses, gnarly bark ridges,
 * and closed tip cap.
 */
function buildOrganicTube({
  points,
  radii,
  radialSegs = 8,
  flareStrength = 0.0,
  flareLobes = 5,
  flareHeightFrac = 0.22,
  gnarlAmp = 0.0,
  gnarlPhase = 0.0,
  uvRepeatU = 1.0,
  uvScaleV = 0.45,
  capTip = true,
  windFn,
  aoFn,
}) {
  const ringCount = points.length;
  const cols = radialSegs + 1;

  // Compute Parallel Transport frames along polyline
  const tangents = [];
  const normalsF = [];
  const binormalsF = [];
  const arcLengths = [0];

  for (let i = 0; i < ringCount; i++) {
    const t = new THREE.Vector3();
    if (i === 0) {
      t.subVectors(points[1], points[0]);
    } else if (i === ringCount - 1) {
      t.subVectors(points[i], points[i - 1]);
    } else {
      t.subVectors(points[i + 1], points[i - 1]);
    }
    if (t.lengthSq() < 1e-8) t.set(0, 1, 0);
    t.normalize();
    tangents.push(t);

    if (i > 0) {
      arcLengths.push(arcLengths[i - 1] + points[i].distanceTo(points[i - 1]));
    }
  }

  const refAxis = Math.abs(tangents[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const n0 = new THREE.Vector3().crossVectors(tangents[0], refAxis).normalize();
  const b0 = new THREE.Vector3().crossVectors(tangents[0], n0).normalize();
  normalsF.push(n0);
  binormalsF.push(b0);

  const qRot = new THREE.Quaternion();
  for (let i = 1; i < ringCount; i++) {
    qRot.setFromUnitVectors(tangents[i - 1], tangents[i]);
    const ni = normalsF[i - 1].clone().applyQuaternion(qRot);
    // Re-orthogonalize against tangent
    ni.addScaledVector(tangents[i], -ni.dot(tangents[i])).normalize();
    const bi = new THREE.Vector3().crossVectors(tangents[i], ni).normalize();
    normalsF.push(ni);
    binormalsF.push(bi);
  }

  const totalLen = Math.max(arcLengths[ringCount - 1], 0.001);
  const ringVerts = [];
  const ringNorms = [];
  const ringUVs = [];

  for (let i = 0; i < ringCount; i++) {
    const tFrac = arcLengths[i] / totalLen;
    const baseR = radii[i];
    const center = points[i];
    const N = normalsF[i];
    const B = binormalsF[i];
    const vCoord = arcLengths[i] * uvScaleV;

    // Root buttress flare multiplier
    const rootT = flareHeightFrac > 0 ? clamp(1.0 - tFrac / flareHeightFrac, 0, 1) : 0;
    const rootCurve = rootT * rootT * (2.2 - 1.2 * rootT);

    const verts = [];
    const norms = [];
    const uvs = [];

    for (let j = 0; j < cols; j++) {
      const uFrac = j / radialSegs;
      const angle = uFrac * Math.PI * 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      let r = baseR;
      if (flareStrength > 0 && rootCurve > 0.001) {
        const lobe = 0.52 + 0.48 * Math.cos(angle * flareLobes + gnarlPhase + tFrac * 1.4);
        r *= 1.0 + flareStrength * rootCurve * lobe;
      }
      if (gnarlAmp > 0) {
        const gnarl =
          Math.sin(angle * 3.0 + tFrac * 9.5 + gnarlPhase) * 0.55 +
          Math.cos(angle * 5.0 - tFrac * 14.0 + gnarlPhase * 1.7) * 0.45;
        r *= 1.0 + gnarlAmp * gnarl * (1.0 - tFrac * 0.4);
      }

      const dirX = N.x * cosA + B.x * sinA;
      const dirY = N.y * cosA + B.y * sinA;
      const dirZ = N.z * cosA + B.z * sinA;

      verts.push(new THREE.Vector3(center.x + dirX * r, center.y + dirY * r, center.z + dirZ * r));
      norms.push(new THREE.Vector3(dirX, dirY, dirZ).normalize());
      uvs.push([uFrac * uvRepeatU, vCoord]);
    }

    ringVerts.push(verts);
    ringNorms.push(norms);
    ringUVs.push(uvs);
  }

  const posArr = [];
  const normArr = [];
  const uvArr = [];

  const pushTri = (p0, n0v, uv0, p1, n1v, uv1, p2, n2v, uv2) => {
    posArr.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    normArr.push(n0v.x, n0v.y, n0v.z, n1v.x, n1v.y, n1v.z, n2v.x, n2v.y, n2v.z);
    uvArr.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
  };

  for (let i = 0; i < ringCount - 1; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const p00 = ringVerts[i][j];
      const p10 = ringVerts[i][j + 1];
      const p01 = ringVerts[i + 1][j];
      const p11 = ringVerts[i + 1][j + 1];

      const n00 = ringNorms[i][j];
      const n10 = ringNorms[i][j + 1];
      const n01 = ringNorms[i + 1][j];
      const n11 = ringNorms[i + 1][j + 1];

      const uv00 = ringUVs[i][j];
      const uv10 = ringUVs[i][j + 1];
      const uv01 = ringUVs[i + 1][j];
      const uv11 = ringUVs[i + 1][j + 1];

      // Outward CCW winding
      pushTri(p00, n00, uv00, p01, n01, uv01, p10, n10, uv10);
      pushTri(p10, n10, uv10, p01, n01, uv01, p11, n11, uv11);
    }
  }

  if (capTip && radii[ringCount - 1] > 0.004) {
    const lastIdx = ringCount - 1;
    const tipCenter = points[lastIdx].clone().addScaledVector(tangents[lastIdx], radii[lastIdx] * 1.15);
    const tipNorm = tangents[lastIdx];
    const tipUV = [0.5, arcLengths[lastIdx] * uvScaleV + 0.1];
    for (let j = 0; j < radialSegs; j++) {
      pushTri(
        ringVerts[lastIdx][j],
        ringNorms[lastIdx][j],
        ringUVs[lastIdx][j],
        tipCenter,
        tipNorm,
        tipUV,
        ringVerts[lastIdx][j + 1],
        ringNorms[lastIdx][j + 1],
        ringUVs[lastIdx][j + 1]
      );
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normArr, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));

  return finalizeTreePart(geo, windFn, aoFn);
}

/**
 * Builds a 2x2 subdivided curved/cupped botanical foliage card with spherical
 * canopy-normal blending so foliage volumes catch light smoothly from every angle.
 */
function buildCuppedFoliageCard({
  width,
  height,
  cupDepth = 0.22,
  archY = 0.16,
  anchor = 'center', // 'center' or 'base'
  matrix,
  canopyCenter,
  normalBlend = 0.62,
  windFn,
  aoFn,
}) {
  const segs = 2;
  const gridPos = [];
  const gridNorm = [];
  const gridUV = [];

  const normalMat = new THREE.Matrix3().getNormalMatrix(matrix);
  const tmpV = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  const radialN = new THREE.Vector3();

  for (let iy = 0; iy <= segs; iy++) {
    const v = iy / segs; // 0 bottom -> 1 top
    const rowPos = [];
    const rowNorm = [];
    const rowUV = [];

    for (let ix = 0; ix <= segs; ix++) {
      const u = ix / segs; // 0 left -> 1 right
      const sx = u * 2 - 1; // -1 .. 1
      const sy = anchor === 'base' ? v : v - 0.5;

      const lx = sx * width * 0.5;
      const ly = sy * height;
      // Gentle double-axis cupping so cards look volumetric rather than flat billboards
      const vCurve = anchor === 'base' ? Math.sin(v * Math.PI) : 1.0 - (v * 2 - 1) * (v * 2 - 1);
      const lz = vCurve * archY * height - sx * sx * cupDepth * width * 0.5;

      tmpV.set(lx, ly, lz).applyMatrix4(matrix);

      // Local surface normal from curvature gradient
      const dZdX = -sx * cupDepth;
      const dZdY = anchor === 'base'
        ? Math.cos(v * Math.PI) * Math.PI * archY
        : -2.0 * (v * 2 - 1) * 2.0 * archY;
      tmpN.set(-dZdX, -dZdY, 1.0).normalize().applyMatrix3(normalMat).normalize();

      // Blend with outward spherical normal from canopy center for soft painterly foliage shading
      if (canopyCenter && normalBlend > 0) {
        radialN.subVectors(tmpV, canopyCenter);
        radialN.y *= 1.15;
        if (radialN.lengthSq() > 1e-6) {
          radialN.normalize();
          tmpN.lerp(radialN, normalBlend).normalize();
        }
      }

      rowPos.push(tmpV.clone());
      rowNorm.push(tmpN.clone());
      rowUV.push([u, v]);
    }
    gridPos.push(rowPos);
    gridNorm.push(rowNorm);
    gridUV.push(rowUV);
  }

  const posArr = [];
  const normArr = [];
  const uvArr = [];

  const pushTri = (p0, n0v, uv0, p1, n1v, uv1, p2, n2v, uv2) => {
    posArr.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    normArr.push(n0v.x, n0v.y, n0v.z, n1v.x, n1v.y, n1v.z, n2v.x, n2v.y, n2v.z);
    uvArr.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
  };

  for (let iy = 0; iy < segs; iy++) {
    for (let ix = 0; ix < segs; ix++) {
      const p00 = gridPos[iy][ix];
      const p10 = gridPos[iy][ix + 1];
      const p01 = gridPos[iy + 1][ix];
      const p11 = gridPos[iy + 1][ix + 1];

      const n00 = gridNorm[iy][ix];
      const n10 = gridNorm[iy][ix + 1];
      const n01 = gridNorm[iy + 1][ix];
      const n11 = gridNorm[iy + 1][ix + 1];

      const uv00 = gridUV[iy][ix];
      const uv10 = gridUV[iy][ix + 1];
      const uv01 = gridUV[iy + 1][ix];
      const uv11 = gridUV[iy + 1][ix + 1];

      pushTri(p00, n00, uv00, p10, n10, uv10, p11, n11, uv11);
      pushTri(p00, n00, uv00, p11, n11, uv11, p01, n01, uv01);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normArr, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));

  return finalizeTreePart(geo, windFn, aoFn);
}

/**
 * Generates seamless tileable bark textures (diffuse + Sobel tangent normal map)
 * and alpha-tested botanical foliage card textures for Pine, Oak, and Birch,
 * builds volumetric 3D species geometry with hierarchical wind weights & canopy AO,
 * and populates an ecologically zoned instanced forest across the terrain.
 */
export class TreeFactory {
  constructor(scene, terrain, windSystem, exclusionZones = []) {
    this.scene = scene;
    this.terrain = terrain;
    this.windSystem = windSystem;
    this.exclusionZones = Array.isArray(exclusionZones) ? exclusionZones : [];

    this.group = new THREE.Group();
    this.group.name = 'ForestTrees';
    this.scene.add(this.group);

    this._textures = [];
    this._materials = [];
    this._depthMaterials = [];
    this._geometries = [];

    this._speciesData = {};
    this.meshes = {};
    this.treePositions = [];
    this.colliders = [];
    this._currentQuality = 'High';

    // 1. Procedural bark & foliage textures
    const textures = {
      pine: {
        bark: this._generateBarkTextures('pine', 1101),
        foliage: this._generatePineFoliageTexture(2101),
      },
      oak: {
        bark: this._generateBarkTextures('oak', 1202),
        foliage: this._generateOakFoliageTexture(2202),
      },
      birch: {
        bark: this._generateBarkTextures('birch', 1303),
        foliage: this._generateBirchFoliageTexture(2303),
      },
    };

    // 2. Procedural 3D species geometry prototypes
    const prototypes = {
      pine: this._buildPineGeometry(),
      oak: this._buildOakGeometry(),
      birch: this._buildBirchGeometry(),
    };

    // 3. PBR materials + 3-tier hierarchical wind shaders & synchronized shadow depth materials
    const windProfiles = {
      pine: {
        bark: { isFoliage: false, trunkFlex: 0.72, branchFlex: 0.85, leafFlutter: 0.0 },
        foliage: { isFoliage: true, trunkFlex: 0.72, branchFlex: 0.90, leafFlutter: 0.58 },
        barkRoughness: 0.92,
        foliageRoughness: 0.76,
      },
      oak: {
        bark: { isFoliage: false, trunkFlex: 0.52, branchFlex: 0.76, leafFlutter: 0.0 },
        foliage: { isFoliage: true, trunkFlex: 0.52, branchFlex: 0.82, leafFlutter: 0.95 },
        barkRoughness: 0.90,
        foliageRoughness: 0.72,
      },
      birch: {
        bark: { isFoliage: false, trunkFlex: 1.15, branchFlex: 1.10, leafFlutter: 0.0 },
        foliage: { isFoliage: true, trunkFlex: 1.15, branchFlex: 1.15, leafFlutter: 1.28 },
        barkRoughness: 0.78,
        foliageRoughness: 0.66,
      },
    };

    // 4. Generate ecologically zoned forest placements (~460 trees max across 3 species)
    const placements = this._generateForestPlacements();

    // 5. Build 6 InstancedMeshes (bark + foliage for each of the 3 species)
    for (const species of ['pine', 'oak', 'birch']) {
      const proto = prototypes[species];
      const tex = textures[species];
      const profile = windProfiles[species];
      const list = placements[species];

      this._geometries.push(proto.barkGeo, proto.foliageGeo);

      const barkNormalAmp = species === 'birch' ? 0.95 : species === 'oak' ? 1.42 : 1.48;
      const barkMat = new THREE.MeshStandardMaterial({
        map: tex.bark.diffuse,
        normalMap: tex.bark.normal,
        normalScale: new THREE.Vector2(barkNormalAmp, barkNormalAmp),
        roughness: profile.barkRoughness,
        metalness: 0.0,
        vertexColors: false, // geometry `color` drives wind ONLY; instanceColor tints per-tree!
      });

      const foliageMat = new THREE.MeshStandardMaterial({
        map: tex.foliage,
        alphaTest: 0.42,
        side: THREE.DoubleSide,
        roughness: profile.foliageRoughness,
        metalness: 0.0,
        vertexColors: false,
      });

      const barkDepthMat = this.windSystem.applyTreeWindShader(barkMat, profile.bark);
      // Chain north-facing & root-collar mossy bark shading cleanly WITHOUT overwriting windSystem's hook!
      this._chainNorthMossBarkShader(barkMat, species);
      const foliageDepthMat = this.windSystem.applyTreeWindShader(foliageMat, profile.foliage);

      this._materials.push(barkMat, foliageMat);
      this._depthMaterials.push(barkDepthMat, foliageDepthMat);

      const maxCount = list.length;
      const barkMesh = new THREE.InstancedMesh(proto.barkGeo, barkMat, maxCount);
      const foliageMesh = new THREE.InstancedMesh(proto.foliageGeo, foliageMat, maxCount);

      barkMesh.name = `Trees_${species}_Bark`;
      foliageMesh.name = `Trees_${species}_Foliage`;

      barkMesh.customDepthMaterial = barkDepthMat;
      foliageMesh.customDepthMaterial = foliageDepthMat;

      barkMesh.castShadow = true;
      barkMesh.receiveShadow = true;
      barkMesh.frustumCulled = false;

      foliageMesh.castShadow = true;
      foliageMesh.receiveShadow = true;
      foliageMesh.frustumCulled = false;

      const dummy = new THREE.Object3D();
      const barkCol = new THREE.Color();
      const leafCol = new THREE.Color();

      for (let i = 0; i < maxCount; i++) {
        const t = list[i];
        dummy.position.set(t.x, t.y - 0.12 * t.scale, t.z);
        dummy.rotation.set(t.tiltX, t.yaw, t.tiltZ);
        dummy.scale.set(t.scaleXZ, t.scaleY, t.scaleXZ);
        dummy.updateMatrix();

        barkMesh.setMatrixAt(i, dummy.matrix);
        foliageMesh.setMatrixAt(i, dummy.matrix);

        barkCol.setRGB(t.barkTint[0], t.barkTint[1], t.barkTint[2]);
        leafCol.setRGB(t.leafTint[0], t.leafTint[1], t.leafTint[2]);
        barkMesh.setColorAt(i, barkCol);
        foliageMesh.setColorAt(i, leafCol);
      }

      barkMesh.instanceMatrix.needsUpdate = true;
      foliageMesh.instanceMatrix.needsUpdate = true;
      if (barkMesh.instanceColor) barkMesh.instanceColor.needsUpdate = true;
      if (foliageMesh.instanceColor) foliageMesh.instanceColor.needsUpdate = true;

      this.group.add(barkMesh, foliageMesh);

      this.meshes[species] = { bark: barkMesh, foliage: foliageMesh };
      this._speciesData[species] = {
        placements: list,
        maxCount,
        barkMesh,
        foliageMesh,
      };
    }

    // Apply initial High quality preset & populate active colliders + treePositions
    this.setQuality('High');
  }

  _isInExclusionZone(x, z, extraPad = 0.0) {
    for (let i = 0; i < this.exclusionZones.length; i++) {
      const zone = this.exclusionZones[i];
      if (!zone) continue;
      const r = (zone.radius ?? 0) + extraPad;
      if (r <= 0) continue;
      const dx = x - zone.x;
      const dz = z - zone.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  /**
   * Chains organic north-facing (-Z) & lower root-collar velvety moss shading
   * onto a tree bark material AFTER windSystem.applyTreeWindShader without
   * overwriting windSystem's onBeforeCompile hook.
   */
  _chainNorthMossBarkShader(barkMat, species) {
    const prevCompile = barkMat.onBeforeCompile;
    const prevKey = barkMat.customProgramCacheKey;

    const mossStrength = species === 'oak' ? '0.80' : species === 'pine' ? '0.66' : '0.38';
    const maxMossH = species === 'oak' ? '6.6' : species === 'pine' ? '5.8' : '3.4';

    barkMat.customProgramCacheKey = () =>
      `${prevKey ? prevKey() : 'treeBark'}_northMoss_${species}_v1`;

    barkMat.onBeforeCompile = (shader, renderer) => {
      if (prevCompile) prevCompile(shader, renderer);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBarkWorldPos;
        varying vec3 vBarkWorldNormal;
        varying float vBarkLocalY;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vBarkLocalY = position.y;
        {
          vec4 barkWp = vec4( position, 1.0 );
          mat3 barkM3 = mat3( modelMatrix );
          #ifdef USE_INSTANCING
            barkWp = instanceMatrix * barkWp;
            barkM3 = barkM3 * mat3( instanceMatrix );
          #endif
          barkWp = modelMatrix * barkWp;
          vBarkWorldPos = barkWp.xyz;
          vBarkWorldNormal = normalize( transpose( inverse( barkM3 ) ) * objectNormal );
        }`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBarkWorldPos;
        varying vec3 vBarkWorldNormal;
        varying float vBarkLocalY;

        float barkMossHash( vec2 p ) {
          return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
        }
        float barkMossNoise( vec2 p ) {
          vec2 i = floor( p );
          vec2 f = fract( p );
          vec2 u = f * f * ( 3.0 - 2.0 * f );
          return mix(
            mix( barkMossHash( i ), barkMossHash( i + vec2( 1.0, 0.0 ) ), u.x ),
            mix( barkMossHash( i + vec2( 0.0, 1.0 ) ), barkMossHash( i + vec2( 1.0, 1.0 ) ), u.x ),
            u.y
          );
        }`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 barkWN = normalize( vBarkWorldNormal );
        float bmMacro = barkMossNoise( vec2( vBarkWorldPos.x * 1.15 + vBarkWorldPos.z * 0.85, vBarkWorldPos.y * 0.52 ) );
        float bmFine = barkMossNoise( vec2( vBarkWorldPos.x * 3.4 - vBarkWorldPos.z * 2.9, vBarkWorldPos.y * 1.85 ) );
        float bmPatch = bmMacro * 0.62 + bmFine * 0.38;

        // North-facing (-Z) shaded damp bark preference + upward-facing root-flare moss ledges
        float northFace = smoothstep( -0.18, 0.68, -barkWN.z + barkWN.y * 0.28 + ( bmPatch - 0.48 ) * 0.32 );
        float rootUpFace = smoothstep( 0.25, 0.78, barkWN.y + ( bmPatch - 0.5 ) * 0.24 );
        float trunkHeightFade = 1.0 - smoothstep( 0.55, ${maxMossH}, vBarkLocalY + ( bmMacro - 0.5 ) * 1.55 );
        float basalCollar = ( 1.0 - smoothstep( -0.15, 1.45, vBarkLocalY + ( bmFine - 0.5 ) * 0.45 ) ) * ( 0.45 + 0.55 * rootUpFace );

        float barkNorthMoss = clamp( max( northFace * trunkHeightFade, basalCollar * 0.92 ) * smoothstep( 0.26, 0.74, bmPatch ) * ${mossStrength}, 0.0, 0.85 );
        vec3 barkMossCol = mix( vec3( 0.048, 0.132, 0.028 ), vec3( 0.142, 0.268, 0.054 ), bmPatch );
        diffuseColor.rgb = mix( diffuseColor.rgb, barkMossCol, barkNorthMoss );`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.94, barkNorthMoss * 0.58 );`
      );
    };
  }

  // =========================================================================
  // PROCEDURAL SEAMLESS BARK TEXTURES (256x256 diffuse + Sobel tangent normal)
  // =========================================================================

  _generateBarkTextures(species, seed) {
    const size = 256;
    const rng = createRng(seed);
    const noiseA = createNoise2D(rng);
    const noiseB = createNoise2D(createRng(seed + 41));

    const tileNoise = (u, v, freqX, freqY, fn) => {
      const a = fn(u * freqX, v * freqY);
      const b = fn((u - 1) * freqX, v * freqY);
      const c = fn(u * freqX, (v - 1) * freqY);
      const d = fn((u - 1) * freqX, (v - 1) * freqY);
      const wx = smoothstep(0.0, 1.0, u);
      const wy = smoothstep(0.0, 1.0, v);
      return lerp(lerp(a, b, wx), lerp(c, d, wx), wy);
    };

    const heightBuf = new Float32Array(size * size);
    const diffData = new Uint8Array(size * size * 4);

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const idx = y * size + x;
        const p = idx * 4;

        let r = 100;
        let g = 80;
        let b = 60;
        let h = 0.5;

        if (species === 'pine') {
          // Deeply furrowed reddish-brown plates with dark fissures & faint moss/lichen specks
          const warp = tileNoise(u, v, 3.0, 2.0, noiseB) * 0.08;
          const uW = ((u + warp) % 1 + 1) % 1;
          const ridgeMain = Math.abs(tileNoise(uW, v, 10.0, 2.2, noiseA));
          const plateCrack = Math.abs(tileNoise(uW, v, 18.0, 6.5, noiseB));
          const scaleBreak = tileNoise(u, v, 6.0, 14.0, noiseA) * 0.5 + 0.5;
          const grain = tileNoise(u, v, 32.0, 18.0, noiseB) * 0.5 + 0.5;

          const furrow = smoothstep(0.10, 0.42, ridgeMain);
          const subPlate = smoothstep(0.08, 0.35, plateCrack);
          const plateMask = furrow * (0.65 + 0.35 * subPlate);

          // Deep dark fissure -> warm cinnamon/reddish-brown outer bark plates
          r = lerp(32, 118, plateMask) + (scaleBreak - 0.5) * 18 + (grain - 0.5) * 10;
          g = lerp(20, 70, plateMask) + (scaleBreak - 0.5) * 10 + (grain - 0.5) * 8;
          b = lerp(14, 44, plateMask) + (grain - 0.5) * 6;

          // Subtle sage-olive lichen / moss specks tucked near plate edges
          const lichen = tileNoise(u, v, 14.0, 12.0, noiseA) * 0.5 + 0.5;
          if (lichen > 0.74 && plateMask > 0.25 && plateMask < 0.72) {
            const m = smoothstep(0.74, 0.88, lichen) * 0.52;
            r = lerp(r, 82, m);
            g = lerp(g, 102, m);
            b = lerp(b, 64, m);
          }

          h = clamp(plateMask * 0.78 + scaleBreak * 0.14 + grain * 0.08, 0, 1);
        } else if (species === 'oak') {
          // Rugged interlaced gray-brown ridges with organic mossy-green crevice streaks
          const warp = tileNoise(u, v, 4.0, 2.5, noiseA) * 0.09;
          const uW = ((u + warp) % 1 + 1) % 1;
          const ridgeA = Math.abs(tileNoise(uW, v, 12.0, 3.0, noiseA));
          const ridgeB = Math.abs(tileNoise(((u - warp * 0.8) % 1 + 1) % 1, v, 9.0, 4.0, noiseB));
          const ridge = Math.min(ridgeA, ridgeB * 1.15);
          const grain = tileNoise(u, v, 28.0, 20.0, noiseB) * 0.5 + 0.5;

          const crest = smoothstep(0.08, 0.48, ridge);
          r = lerp(38, 108, crest) + (grain - 0.5) * 14;
          g = lerp(34, 98, crest) + (grain - 0.5) * 13;
          b = lerp(29, 84, crest) + (grain - 0.5) * 11;

          // Organic mossy-green streaks running vertically inside crevices
          const mossStreak = tileNoise(u, v, 5.0, 2.0, noiseB) * 0.5 + 0.5;
          const mossDetail = tileNoise(u, v, 18.0, 9.0, noiseA) * 0.5 + 0.5;
          const crevice = 1.0 - smoothstep(0.12, 0.52, crest);
          const mossAmt = smoothstep(0.42, 0.76, mossStreak * 0.75 + mossDetail * 0.35) * (0.35 + crevice * 0.65);
          if (mossAmt > 0.02) {
            r = lerp(r, 48 + mossDetail * 24, mossAmt * 0.72);
            g = lerp(g, 88 + mossDetail * 34, mossAmt * 0.78);
            b = lerp(b, 34 + mossDetail * 14, mossAmt * 0.72);
          }

          h = clamp(crest * 0.80 + grain * 0.20, 0, 1);
        } else {
          // Silver Birch: luminous papery cream-white bark + horizontal lenticels + peeling curls + dark knots
          const paperBand = tileNoise(u, v, 2.0, 10.0, noiseA) * 0.5 + 0.5;
          const finePaper = tileNoise(u, v, 14.0, 32.0, noiseB) * 0.5 + 0.5;
          const warmTint = tileNoise(u, v, 3.0, 5.0, noiseB) * 0.5 + 0.5;

          r = lerp(206, 240, paperBand * 0.7 + finePaper * 0.3) - (1 - warmTint) * 10;
          g = lerp(198, 234, paperBand * 0.7 + finePaper * 0.3) - (1 - warmTint) * 11;
          b = lerp(184, 220, paperBand * 0.7 + finePaper * 0.3) - (1 - warmTint) * 14;

          // Subtle tan papery peeling horizontal strips
          const peel = tileNoise(u, v, 3.0, 18.0, noiseA);
          if (peel > 0.64) {
            const pAmt = smoothstep(0.64, 0.85, peel) * 0.55;
            r = lerp(r, 168, pAmt);
            g = lerp(g, 138, pAmt);
            b = lerp(b, 104, pAmt);
          }

          h = clamp(0.68 + paperBand * 0.18 + finePaper * 0.10 - (peel > 0.64 ? 0.18 : 0), 0, 1);
        }

        diffData[p] = clamp(Math.round(r), 0, 255);
        diffData[p + 1] = clamp(Math.round(g), 0, 255);
        diffData[p + 2] = clamp(Math.round(b), 0, 255);
        diffData[p + 3] = 255;
        heightBuf[idx] = h;
      }
    }

    // Stamp crisp seamless horizontal lenticels & occasional dark fissures onto Silver Birch
    if (species === 'birch') {
      // Crisp horizontal dark charcoal lenticel dashes
      for (let i = 0; i < 155; i++) {
        const cx = rng() * size;
        const cy = rng() * size;
        const halfLen = 5 + rng() * 19;
        const halfThick = 0.75 + rng() * 1.45;
        const dark = 0.65 + rng() * 0.32;

        const minY = Math.floor(cy - halfThick - 1);
        const maxY = Math.ceil(cy + halfThick + 1);
        const minX = Math.floor(cx - halfLen - 1);
        const maxX = Math.ceil(cx + halfLen + 1);

        for (let py = minY; py <= maxY; py++) {
          const dy = (py - cy) / halfThick;
          if (Math.abs(dy) > 1.0) continue;
          const wy = ((py % size) + size) % size;
          for (let px = minX; px <= maxX; px++) {
            const dx = (px - cx) / halfLen;
            const d2 = dx * dx + dy * dy;
            if (d2 >= 1.0) continue;
            const mask = (1.0 - d2) * dark;
            const wx = ((px % size) + size) % size;
            const idx = wy * size + wx;
            const p = idx * 4;
            diffData[p] = Math.round(lerp(diffData[p], 42, mask));
            diffData[p + 1] = Math.round(lerp(diffData[p + 1], 36, mask));
            diffData[p + 2] = Math.round(lerp(diffData[p + 2], 32, mask));
            heightBuf[idx] = Math.max(0.1, heightBuf[idx] - mask * 0.32);
          }
        }
      }

      // 6 dark diamond knot/fissure bark patches
      for (let k = 0; k < 6; k++) {
        const kx = rng() * size;
        const ky = rng() * size;
        const rx = 8 + rng() * 11;
        const ry = 4 + rng() * 6;
        for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
          for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
            const nx = dx / rx;
            const ny = dy / ry;
            const dist = Math.abs(nx) * 0.75 + Math.abs(ny) * 1.05 + (noiseA(dx * 0.25 + k, dy * 0.25) * 0.18);
            if (dist < 1.0) {
              const mask = smoothstep(1.0, 0.35, dist) * 0.92;
              const wx = ((Math.round(kx + dx) % size) + size) % size;
              const wy = ((Math.round(ky + dy) % size) + size) % size;
              const idx = wy * size + wx;
              const p = idx * 4;
              diffData[p] = Math.round(lerp(diffData[p], 36, mask));
              diffData[p + 1] = Math.round(lerp(diffData[p + 1], 32, mask));
              diffData[p + 2] = Math.round(lerp(diffData[p + 2], 28, mask));
              heightBuf[idx] = Math.max(0.05, heightBuf[idx] - mask * 0.45);
            }
          }
        }
      }
    }

    const diffuse = new THREE.DataTexture(diffData, size, size, THREE.RGBAFormat);
    diffuse.wrapS = THREE.RepeatWrapping;
    diffuse.wrapT = THREE.RepeatWrapping;
    diffuse.magFilter = THREE.LinearFilter;
    diffuse.minFilter = THREE.LinearMipmapLinearFilter;
    diffuse.generateMipmaps = true;
    diffuse.colorSpace = THREE.SRGBColorSpace;
    diffuse.flipY = true;
    diffuse.needsUpdate = true;

    // Deepened Sobel tangent-space normal map from seamless height buffer
    const normData = new Uint8Array(size * size * 4);
    const strength = species === 'pine' ? 5.4 : species === 'oak' ? 4.9 : 2.95;
    const hAt = (ix, iy) => heightBuf[((iy + size) % size) * size + ((ix + size) % size)];

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const tl = hAt(x - 1, y - 1);
        const t = hAt(x, y - 1);
        const tr = hAt(x + 1, y - 1);
        const l = hAt(x - 1, y);
        const r = hAt(x + 1, y);
        const bl = hAt(x - 1, y + 1);
        const b = hAt(x, y + 1);
        const br = hAt(x + 1, y + 1);

        const dX = (tr + 2 * r + br - (tl + 2 * l + bl)) * strength;
        const dY = (bl + 2 * b + br - (tl + 2 * t + tr)) * strength;
        let nx = -dX;
        let ny = -dY;
        let nz = 1.0;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;

        const p = (y * size + x) * 4;
        normData[p] = Math.round((nx * 0.5 + 0.5) * 255);
        normData[p + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        normData[p + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        normData[p + 3] = 255;
      }
    }

    const normal = new THREE.DataTexture(normData, size, size, THREE.RGBAFormat);
    normal.wrapS = THREE.RepeatWrapping;
    normal.wrapT = THREE.RepeatWrapping;
    normal.magFilter = THREE.LinearFilter;
    normal.minFilter = THREE.LinearMipmapLinearFilter;
    normal.generateMipmaps = true;
    normal.colorSpace = THREE.NoColorSpace;
    normal.flipY = true;
    normal.needsUpdate = true;

    this._textures.push(diffuse, normal);
    return { diffuse, normal };
  }

  // =========================================================================
  // PROCEDURAL 512x512 ALPHA-TESTED BOTANICAL FOLIAGE CARD TEXTURES
  // =========================================================================

  _canvasToFoliageTexture(canvas, fallbackRGB) {
    const size = canvas.width;
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, size, size);
    const bytes = new Uint8Array(img.data);

    // Bleed leaf RGB outward into transparent pixels to guarantee halo-free mipmaps
    dilateAlphaRGB(bytes, size, size, fallbackRGB, 12);

    const tex = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    tex.needsUpdate = true;
    this._textures.push(tex);
    return tex;
  }

  /**
   * 512x512 Pine / Douglas Fir needle bough spray:
   * radiating dark-emerald & blue-green needles fanning densely along reddish twigs.
   */
  _generatePineFoliageTexture(seed) {
    const size = 512;
    const rng = createRng(seed);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);

    const drawNeedleShoot = (x0, y0, x1, y1, needleLen, density, palette) => {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const shootLen = Math.hypot(dx, dy);
      const baseAngle = Math.atan2(dy, dx);

      // 1. Background deeper shaded needle layer for lush volume
      const steps = Math.floor(shootLen * density);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const bx = lerp(x0, x1, t) + (rng() - 0.5) * 3;
        const by = lerp(y0, y1, t) + (rng() - 0.5) * 3;
        const taper = smoothstep(0.0, 0.14, t) * (1.0 - 0.58 * Math.pow(t, 1.55));
        const len = needleLen * (0.55 + 0.58 * taper) * (0.82 + rng() * 0.36);

        for (const side of [-1, 1]) {
          const spread = (0.42 + rng() * 0.62) * side;
          const ang = baseAngle + spread;
          const nx = bx + Math.cos(ang) * len;
          const ny = by + Math.sin(ang) * len;

          const col = palette[Math.floor(rng() * palette.length)];
          ctx.strokeStyle = col;
          ctx.lineWidth = 2.6 + rng() * 2.1;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(nx, ny);
          ctx.stroke();
        }
      }

      // 2. Central reddish-brown woody twig
      ctx.strokeStyle = '#5a3622';
      ctx.lineWidth = Math.max(3.5, shootLen * 0.025);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      // 3. Foreground sunlit emerald & new-growth tip needles
      for (let i = 0; i <= Math.floor(steps * 0.72); i++) {
        const t = i / Math.max(1, Math.floor(steps * 0.72));
        const bx = lerp(x0, x1, t);
        const by = lerp(y0, y1, t);
        const taper = smoothstep(0.0, 0.16, t) * (1.0 - 0.55 * Math.pow(t, 1.4));
        const len = needleLen * (0.48 + 0.55 * taper) * (0.8 + rng() * 0.35);

        for (const side of [-1, 1]) {
          const ang = baseAngle + (0.28 + rng() * 0.52) * side;
          const isTip = t > 0.76;
          ctx.strokeStyle = isTip
            ? (rng() > 0.45 ? '#3d7443' : '#4a834d')
            : (rng() > 0.5 ? '#24593c' : '#2d6844');
          ctx.lineWidth = 2.1 + rng() * 1.5;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + Math.cos(ang) * len, by + Math.sin(ang) * len);
          ctx.stroke();
        }
      }
    };

    const deepPalette = ['#143322', '#19402c', '#1c4836', '#215035', '#173a2c'];

    // Main central bough + 8 lush fanning side shoots (fills card richly with organic silhouette)
    const shoots = [
      // Lower wide shoots
      { x0: 256, y0: 448, x1: 92, y1: 365, len: 46, dens: 0.52 },
      { x0: 256, y0: 448, x1: 420, y1: 362, len: 46, dens: 0.52 },
      // Mid-lower shoots
      { x0: 256, y0: 374, x1: 60, y1: 252, len: 48, dens: 0.54 },
      { x0: 256, y0: 374, x1: 452, y1: 248, len: 48, dens: 0.54 },
      // Mid-upper shoots
      { x0: 256, y0: 282, x1: 86, y1: 146, len: 44, dens: 0.54 },
      { x0: 256, y0: 282, x1: 426, y1: 144, len: 44, dens: 0.54 },
      // Upper crown shoots
      { x0: 256, y0: 196, x1: 148, y1: 78, len: 38, dens: 0.55 },
      { x0: 256, y0: 196, x1: 364, y1: 78, len: 38, dens: 0.55 },
      // Central leader shoot
      { x0: 256, y0: 478, x1: 256, y1: 44, len: 52, dens: 0.56 },
    ];

    // Secondary infill shoots for rich dense silhouette
    const subShoots = [
      { x0: 170, y0: 310, x1: 118, y1: 215, len: 34, dens: 0.48 },
      { x0: 342, y0: 308, x1: 394, y1: 212, len: 34, dens: 0.48 },
      { x0: 178, y0: 214, x1: 176, y1: 112, len: 32, dens: 0.48 },
      { x0: 334, y0: 214, x1: 336, y1: 112, len: 32, dens: 0.48 },
    ];

    for (const s of subShoots) {
      drawNeedleShoot(s.x0, s.y0, s.x1, s.y1, s.len, s.dens, deepPalette);
    }
    for (const s of shoots) {
      drawNeedleShoot(s.x0, s.y0, s.x1, s.y1, s.len, s.dens, deepPalette);
    }

    return this._canvasToFoliageTexture(canvas, [30, 74, 48]);
  }

  /**
   * 512x512 Oak broadleaf cluster:
   * lush overlapping deeply-lobed oak leaves in varied sunlit/shaded forest greens with veins.
   */
  _generateOakFoliageTexture(seed) {
    const size = 512;
    const rng = createRng(seed);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);

    const drawOakLeaf = (cx, cy, len, wid, angle, baseColor, veinColor, shadeAlpha) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);

      // Authentic multi-lobed oak leaf contour using smooth sinusoidal lobe modulation
      const steps = 42;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const theta = (i / steps) * Math.PI * 2;
        const t = 0.5 - 0.5 * Math.cos(theta); // 0 at petiole -> 1 at tip
        const side = Math.sin(theta) >= 0 ? 1 : -1;

        const baseEnv = Math.sin(Math.pow(t, 0.72) * Math.PI);
        // 4 deep rounded oak lobes along each margin
        const lobeWave = 0.68 + 0.34 * Math.sin(t * Math.PI * 7.5 - 0.9);
        const widthAtT = wid * 0.5 * baseEnv * lerp(0.55, lobeWave, smoothstep(0.08, 0.28, t));

        const px = t * len;
        const py = side * widthAtT;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();

      // Subtle gradient along leaf for organic 3D sunlight
      const grad = ctx.createLinearGradient(0, -wid * 0.4, len, wid * 0.4);
      grad.addColorStop(0, baseColor[0]);
      grad.addColorStop(0.55, baseColor[1]);
      grad.addColorStop(1, baseColor[2]);
      ctx.fillStyle = grad;
      ctx.fill();

      // Crisp subtle darker margin outline for botanical depth
      ctx.strokeStyle = `rgba(18, 38, 14, ${shadeAlpha})`;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // Delicate central midrib & lateral veins into lobes
      ctx.strokeStyle = veinColor;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(2, 0);
      ctx.lineTo(len * 0.92, 0);
      ctx.stroke();

      ctx.lineWidth = 1.05;
      for (let v = 1; v <= 4; v++) {
        const vt = 0.18 + v * 0.17;
        const vx = len * vt;
        const vReach = wid * (0.28 + 0.14 * Math.sin(vt * Math.PI));
        ctx.beginPath();
        ctx.moveTo(vx, 0);
        ctx.lineTo(vx + len * 0.11, vReach);
        ctx.moveTo(vx, 0);
        ctx.lineTo(vx + len * 0.11, -vReach);
        ctx.stroke();
      }

      ctx.restore();
    };

    // Branching woody twig backbone underneath leaves
    ctx.strokeStyle = '#3d2c1e';
    ctx.lineCap = 'round';
    ctx.lineWidth = 6.5;
    ctx.beginPath();
    ctx.moveTo(256, 452);
    ctx.quadraticCurveTo(252, 320, 256, 170);
    ctx.stroke();

    ctx.lineWidth = 4.2;
    const twigEnds = [
      [135, 310], [375, 315], [118, 210], [392, 205], [182, 130], [330, 132],
    ];
    for (const [tx, ty] of twigEnds) {
      ctx.beginPath();
      ctx.moveTo(256, lerp(ty + 80, 340, 0.35));
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }

    const darkGreens = [
      ['#1e3f19', '#2b5422', '#356428'],
      ['#23471b', '#315d24', '#3f702c'],
    ];
    const midGreens = [
      ['#2d5822', '#42732d', '#548735'],
      ['#326024', '#497b30', '#5e923a'],
      ['#2a5420', '#3d6b2b', '#4d7e32'],
    ];
    const sunlitGreens = [
      ['#42732d', '#5d9139', '#75a844'],
      ['#4c7d31', '#689d3e', '#80b34b'],
    ];

    // Layer 1: 18 shaded background oak leaves filling a rounded billowing silhouette
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + (rng() - 0.5) * 0.25;
      const dist = 56 + rng() * 88;
      const cx = 256 + Math.cos(a) * dist;
      const cy = 256 + Math.sin(a) * dist;
      const len = 96 + rng() * 38;
      const wid = len * (0.54 + rng() * 0.12);
      const pal = darkGreens[Math.floor(rng() * darkGreens.length)];
      drawOakLeaf(cx, cy, len, wid, a + (rng() - 0.5) * 0.55, pal, 'rgba(90, 128, 56, 0.42)', 0.45);
    }

    // Layer 2: 20 rich mid-canopy overlapping oak leaves
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2 + rng() * 0.4;
      const dist = 24 + rng() * 98;
      const cx = 256 + Math.cos(a) * dist;
      const cy = 254 + Math.sin(a) * dist;
      const len = 88 + rng() * 40;
      const wid = len * (0.52 + rng() * 0.14);
      const pal = midGreens[Math.floor(rng() * midGreens.length)];
      drawOakLeaf(cx, cy, len, wid, a + (rng() - 0.5) * 0.75, pal, 'rgba(130, 168, 78, 0.52)', 0.36);
    }

    // Layer 3: 14 sunlit top-layer oak leaves for lively highlights and volume
    for (let i = 0; i < 14; i++) {
      const a = rng() * Math.PI * 2;
      const dist = rng() * 84;
      const cx = 256 + Math.cos(a) * dist;
      const cy = 244 + Math.sin(a) * dist;
      const len = 78 + rng() * 34;
      const wid = len * (0.52 + rng() * 0.12);
      const pal = sunlitGreens[Math.floor(rng() * sunlitGreens.length)];
      drawOakLeaf(cx, cy, len, wid, a + (rng() - 0.5) * 0.9, pal, 'rgba(170, 206, 102, 0.58)', 0.28);
    }

    return this._canvasToFoliageTexture(canvas, [64, 112, 46]);
  }

  /**
   * 512x512 Silver Birch leaf cluster:
   * airy, luminous yellow-green serrated diamond/ovate leaves along delicate dark twigs.
   */
  _generateBirchFoliageTexture(seed) {
    const size = 512;
    const rng = createRng(seed);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);

    const drawBirchLeaf = (cx, cy, len, wid, angle, colors) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);

      // Serrated ovate-diamond birch leaf (pointed tip, rounded-wedge base)
      const steps = 32;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const theta = u * Math.PI * 2;
        const t = 0.5 - 0.5 * Math.cos(theta); // 0 base -> 1 pointed tip
        const side = Math.sin(theta) >= 0 ? 1 : -1;

        // Classic birch diamond/ovate silhouette (widest at t ~ 0.34, sharp point at t = 1)
        const ovate = Math.pow(t, 0.52) * Math.pow(1.0 - t, 0.88) * 2.45;
        const serration = 1.0 + 0.08 * Math.sin(t * Math.PI * 18.0) * smoothstep(0.12, 0.35, t);
        const py = side * wid * 0.5 * ovate * serration;
        const px = t * len;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, -wid * 0.3, len, wid * 0.3);
      grad.addColorStop(0, colors[0]);
      grad.addColorStop(0.55, colors[1]);
      grad.addColorStop(1, colors[2]);
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.strokeStyle = 'rgba(48, 78, 22, 0.32)';
      ctx.lineWidth = 1.1;
      ctx.stroke();

      // Delicate midrib & chevron veins
      ctx.strokeStyle = 'rgba(202, 232, 128, 0.55)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(2, 0);
      ctx.lineTo(len * 0.9, 0);
      for (let v = 1; v <= 4; v++) {
        const vt = 0.16 + v * 0.16;
        const vx = len * vt;
        const vw = wid * 0.32 * Math.sin(vt * Math.PI);
        ctx.moveTo(vx, 0);
        ctx.lineTo(vx + len * 0.12, vw);
        ctx.moveTo(vx, 0);
        ctx.lineTo(vx + len * 0.12, -vw);
      }
      ctx.stroke();

      ctx.restore();
    };

    // Delicate dark reddish-brown branching birch twigs
    const twigs = [
      { x0: 256, y0: 468, cx: 248, cy: 290, x1: 256, y1: 68 },
      { x0: 256, y0: 382, cx: 180, cy: 325, x1: 86, y1: 264 },
      { x0: 256, y0: 372, cx: 332, cy: 318, x1: 426, y1: 254 },
      { x0: 254, y0: 280, cx: 168, cy: 215, x1: 98, y1: 146 },
      { x0: 256, y0: 274, cx: 342, cy: 212, x1: 414, y1: 142 },
      { x0: 255, y0: 186, cx: 204, cy: 130, x1: 168, y1: 84 },
      { x0: 256, y0: 184, cx: 308, cy: 128, x1: 346, y1: 82 },
    ];

    ctx.strokeStyle = '#3c2a22';
    ctx.lineCap = 'round';
    for (let i = 0; i < twigs.length; i++) {
      const tw = twigs[i];
      ctx.lineWidth = i === 0 ? 4.2 : 2.6;
      ctx.beginPath();
      ctx.moveTo(tw.x0, tw.y0);
      ctx.quadraticCurveTo(tw.cx, tw.cy, tw.x1, tw.y1);
      ctx.stroke();
    }

    const palettes = [
      ['#4d8029', '#6da637', '#8ec447'],
      ['#598d2e', '#7db73e', '#a1d452'],
      ['#649833', '#8bc244', '#b4de5d'],
      ['#3f7024', '#5b9232', '#78af40'],
    ];

    // Scatter ~68 luminous birch leaves along the graceful twigs with airy dappled spacing
    for (const tw of twigs) {
      const count = tw === twigs[0] ? 16 : 9;
      for (let i = 0; i < count; i++) {
        const t = 0.14 + (i / count) * 0.84;
        const omt = 1 - t;
        const bx = omt * omt * tw.x0 + 2 * omt * t * tw.cx + t * t * tw.x1;
        const by = omt * omt * tw.y0 + 2 * omt * t * tw.cy + t * t * tw.y1;
        const tx = 2 * omt * (tw.cx - tw.x0) + 2 * t * (tw.x1 - tw.cx);
        const ty = 2 * omt * (tw.cy - tw.y0) + 2 * t * (tw.y1 - tw.cy);
        const tangAng = Math.atan2(ty, tx);

        for (const side of [-1, 1]) {
          if (rng() < 0.14) continue;
          const ox = bx + (rng() - 0.5) * 18;
          const oy = by + (rng() - 0.5) * 18;
          const len = 46 + rng() * 28;
          const wid = len * (0.64 + rng() * 0.14);
          const ang = tangAng + side * (0.48 + rng() * 0.72);
          const pal = palettes[Math.floor(rng() * palettes.length)];
          drawBirchLeaf(ox, oy, len, wid, ang, pal);
        }
      }
    }

    return this._canvasToFoliageTexture(canvas, [118, 174, 62]);
  }

  // =========================================================================
  // PROCEDURAL 3D SPECIES GEOMETRY BUILDERS
  // =========================================================================

  /**
   * 1. Ancient Pine / Douglas Fir (~19.2 base height -> ~16-22 units scaled)
   * Gently curving tapered trunk with flared root buttresses, 7 tiered whorls of
   * drooping outward boughs tapering to a conical spire, draped with layered needle cards.
   */
  _buildPineGeometry() {
    const rng = createRng(5101);
    const barkParts = [];
    const foliageParts = [];
    const H = 19.2;
    const canopyCenter = new THREE.Vector3(0, 11.4, 0);

    const calcTrunkWind = (x, y, z, u, v, i, out) => {
      const hNorm = clamp(y / H, 0, 1);
      const rDist = Math.hypot(x, z);
      out[0] = Math.pow(hNorm, 1.55); // R: anchored cleanly at y <= 0
      out[1] = clamp((rDist / 4.2) * smoothstep(0.15, 0.5, hNorm) * 0.85, 0, 0.95);
      out[2] = 0.0;
    };

    const calcBarkAO = (x, y, z) => {
      const hNorm = clamp(y / H, 0, 1);
      const rDist = Math.hypot(x, z);
      // Darker inside lower canopy core, brighter near outer branch tips & lower ground bounce
      const inCanopy = smoothstep(3.5, 6.5, y) * (1.0 - smoothstep(15.5, 18.5, y));
      const baseAO = lerp(0.82, 0.48, inCanopy);
      return clamp(baseAO + rDist * 0.11 + hNorm * 0.18, 0.42, 1.02);
    };

    const calcFoliageAO = (x, y, z) => {
      const hNorm = clamp((y - 4.0) / (H - 3.8), 0, 1);
      const expectedRadius = Math.max(0.65, (1.0 - hNorm * 0.88) * 4.5);
      const radialNorm = clamp(Math.hypot(x, z) / expectedRadius, 0, 1.25);
      return clamp(0.44 + radialNorm * 0.42 + hNorm * 0.28, 0.42, 1.08);
    };

    // Main gently curving tapered trunk with 5-lobe flared root buttress
    const trunkPts = [];
    const trunkRadii = [];
    const trunkSteps = 14;
    for (let i = 0; i <= trunkSteps; i++) {
      const t = i / trunkSteps;
      const y = lerp(-0.65, 18.4, t);
      const curveX = Math.sin(t * Math.PI * 1.15) * 0.26;
      const curveZ = Math.cos(t * Math.PI * 0.95 - 0.5) * 0.18 - 0.14;
      const r = lerp(0.56, 0.055, Math.pow(t, 0.88));
      trunkPts.push(new THREE.Vector3(curveX, y, curveZ));
      trunkRadii.push(r);
    }

    const trunkPointAt = (yTarget) => {
      const t = clamp((yTarget + 0.65) / (18.4 + 0.65), 0, 1);
      return new THREE.Vector3(
        Math.sin(t * Math.PI * 1.15) * 0.26,
        yTarget,
        Math.cos(t * Math.PI * 0.95 - 0.5) * 0.18 - 0.14
      );
    };

    barkParts.push(
      buildOrganicTube({
        points: trunkPts,
        radii: trunkRadii,
        radialSegs: 10,
        flareStrength: 0.94,
        flareLobes: 5,
        flareHeightFrac: 0.21,
        gnarlAmp: 0.055,
        gnarlPhase: 0.8,
        uvRepeatU: 2.0,
        uvScaleV: 0.36,
        capTip: true,
        windFn: calcTrunkWind,
        aoFn: calcBarkAO,
      })
    );

    // 5 sculpted radiating buttress root spurs anchoring the pine trunk deep into forest soil
    const rootZeroWind = (_x, _y, _z, _u, _v, _i, out) => {
      out[0] = 0.0;
      out[1] = 0.0;
      out[2] = 0.0;
    };
    const pineBase = trunkPointAt(0.0);
    for (let rIdx = 0; rIdx < 5; rIdx++) {
      const rAz = (rIdx / 5) * Math.PI * 2 + 0.16 + (rng() - 0.5) * 0.28;
      const rdx = Math.cos(rAz);
      const rdz = Math.sin(rAz);
      const reach = 1.38 + rng() * 0.42;
      const bend = (rng() - 0.5) * 0.24;
      const rPts = [
        new THREE.Vector3(pineBase.x + rdx * 0.24, 1.05 + rng() * 0.22, pineBase.z + rdz * 0.24),
        new THREE.Vector3(pineBase.x + rdx * (reach * 0.42) - rdz * bend * 0.5, 0.48, pineBase.z + rdz * (reach * 0.42) + rdx * bend * 0.5),
        new THREE.Vector3(pineBase.x + rdx * (reach * 0.78) - rdz * bend, 0.06, pineBase.z + rdz * (reach * 0.78) + rdx * bend),
        new THREE.Vector3(pineBase.x + rdx * reach - rdz * bend * 1.15, -0.58, pineBase.z + rdz * reach + rdx * bend * 1.15),
      ];
      barkParts.push(
        buildOrganicTube({
          points: rPts,
          radii: [0.30, 0.23, 0.14, 0.055],
          radialSegs: 6,
          gnarlAmp: 0.08,
          gnarlPhase: rIdx * 1.7,
          uvRepeatU: 1.0,
          uvScaleV: 0.6,
          capTip: true,
          windFn: rootZeroWind,
          aoFn: (_x, y) => clamp(0.56 + smoothstep(-0.35, 0.9, y) * 0.28, 0.52, 0.86),
        })
      );
    }

    // 7 tiered whorls of drooping outward boughs tapering into a conical spire
    const whorls = [
      { y: 4.8, count: 6, reach: 4.45, droop: 1.05, rBase: 0.15, cardScale: 1.24 },
      { y: 6.85, count: 6, reach: 4.05, droop: 0.92, rBase: 0.135, cardScale: 1.16 },
      { y: 8.95, count: 6, reach: 3.55, droop: 0.78, rBase: 0.12, cardScale: 1.08 },
      { y: 11.0, count: 5, reach: 2.95, droop: 0.62, rBase: 0.105, cardScale: 0.98 },
      { y: 12.95, count: 5, reach: 2.32, droop: 0.44, rBase: 0.09, cardScale: 0.88 },
      { y: 14.8, count: 5, reach: 1.72, droop: 0.28, rBase: 0.075, cardScale: 0.76 },
      { y: 16.5, count: 4, reach: 1.15, droop: 0.14, rBase: 0.06, cardScale: 0.62 },
    ];

    const mCard = new THREE.Matrix4();
    const qCard = new THREE.Quaternion();
    const sCard = new THREE.Vector3(1, 1, 1);
    const eul = new THREE.Euler();

    for (let wIdx = 0; wIdx < whorls.length; wIdx++) {
      const w = whorls[wIdx];
      const baseAngleOffset = wIdx * 0.68 + rng() * 0.25;

      for (let b = 0; b < w.count; b++) {
        const az = baseAngleOffset + (b / w.count) * Math.PI * 2 + (rng() - 0.5) * 0.28;
        const dirX = Math.cos(az);
        const dirZ = Math.sin(az);
        const reach = w.reach * (0.86 + rng() * 0.26);
        const yOrigin = w.y + (rng() - 0.5) * 0.36;
        const origin = trunkPointAt(yOrigin);

        // 5-point drooping bough polyline that sweeps gently up at outer tip
        const bPts = [];
        const bRadii = [];
        for (let k = 0; k <= 4; k++) {
          const frac = k / 4;
          const dist = reach * frac;
          // Classic Douglas fir graceful downward sag then upturned growing tip
          const sag = -w.droop * Math.sin(frac * Math.PI * 0.84) + (wIdx >= 4 ? frac * 0.32 : frac * frac * 0.26);
          const swaySide = Math.sin(frac * Math.PI) * (rng() - 0.5) * 0.22;
          const px = origin.x + dirX * dist - dirZ * swaySide;
          const py = origin.y + sag;
          const pz = origin.z + dirZ * dist + dirX * swaySide;
          bPts.push(new THREE.Vector3(px, py, pz));
          bRadii.push(lerp(w.rBase, 0.022, Math.pow(frac, 0.9)));
        }

        barkParts.push(
          buildOrganicTube({
            points: bPts,
            radii: bRadii,
            radialSegs: wIdx < 3 ? 5 : 4,
            uvRepeatU: 1.0,
            uvScaleV: 0.65,
            capTip: true,
            windFn: calcTrunkWind,
            aoFn: calcBarkAO,
          })
        );

        // Drape layered overlapping cupped needle bough cards along each bough
        const cardTiers = wIdx < 4 ? [0.28, 0.58, 0.84] : [0.32, 0.74];
        for (let cIdx = 0; cIdx < cardTiers.length; cIdx++) {
          const ct = cardTiers[cIdx];
          const segIdx = Math.min(3, Math.floor(ct * 4));
          const segFrac = ct * 4 - segIdx;
          const pos = new THREE.Vector3().lerpVectors(bPts[segIdx], bPts[segIdx + 1], segFrac);
          const nextPt = bPts[Math.min(4, segIdx + 1)];
          const bDir = new THREE.Vector3().subVectors(nextPt, bPts[segIdx]).normalize();

          const cardW = (1.95 - cIdx * 0.24) * w.cardScale * (0.9 + rng() * 0.2);
          const cardH = (2.15 - cIdx * 0.18) * w.cardScale * (0.9 + rng() * 0.2);

          // Main draping upper shingle card lying over the bough
          const yaw = Math.atan2(bDir.x, bDir.z);
          const pitchDown = 1.18 + (1.0 - wIdx / 7) * 0.25 + (rng() - 0.5) * 0.18;

          eul.set(pitchDown, yaw, (rng() - 0.5) * 0.24, 'YXZ');
          qCard.setFromEuler(eul);
          mCard.compose(pos.clone().add(new THREE.Vector3(0, 0.16, 0)), qCard, sCard);

          foliageParts.push(
            buildCuppedFoliageCard({
              width: cardW,
              height: cardH,
              cupDepth: 0.26,
              archY: 0.15,
              anchor: 'base',
              matrix: mCard,
              canopyCenter,
              normalBlend: 0.56,
              windFn: (x, y, z, u, v, i, out) => {
                const hNorm = clamp(y / H, 0, 1);
                const rDist = Math.hypot(x, z);
                out[0] = Math.pow(hNorm, 1.55);
                out[1] = clamp((rDist / 4.2) * 0.88, 0.08, 0.96);
                out[2] = clamp(0.18 + v * 0.52 + Math.abs(u * 2 - 1) * 0.34, 0.15, 0.95);
              },
              aoFn: calcFoliageAO,
            })
          );

          // Crossed pitched under-wing card so boughs look lush & 3D from ground view
          if (cIdx === 0 || (cIdx === 1 && wIdx < 5)) {
            const rollSign = (b + cIdx) % 2 === 0 ? 1 : -1;
            eul.set(pitchDown - 0.32, yaw + rollSign * 0.42, rollSign * 0.62, 'YXZ');
            qCard.setFromEuler(eul);
            mCard.compose(pos.clone().add(new THREE.Vector3(0, 0.04, 0)), qCard, sCard);

            foliageParts.push(
              buildCuppedFoliageCard({
                width: cardW * 0.92,
                height: cardH * 0.92,
                cupDepth: 0.22,
                archY: 0.12,
                anchor: 'base',
                matrix: mCard,
                canopyCenter,
                normalBlend: 0.58,
                windFn: (x, y, z, u, v, i, out) => {
                  const hNorm = clamp(y / H, 0, 1);
                  const rDist = Math.hypot(x, z);
                  out[0] = Math.pow(hNorm, 1.55);
                  out[1] = clamp((rDist / 4.2) * 0.88, 0.08, 0.96);
                  out[2] = clamp(0.2 + v * 0.5 + Math.abs(u * 2 - 1) * 0.32, 0.15, 0.95);
                },
                aoFn: calcFoliageAO,
              })
            );
          }
        }
      }
    }

    // Lush conical spire apex crown cap (y = 16.6 to 19.8)
    const apexBase = trunkPointAt(16.9);
    for (let k = 0; k < 4; k++) {
      const yaw = (k / 4) * Math.PI + 0.2;
      eul.set(0.24, yaw, (rng() - 0.5) * 0.14, 'YXZ');
      qCard.setFromEuler(eul);
      mCard.compose(apexBase.clone().add(new THREE.Vector3(0, -0.15, 0)), qCard, sCard);

      foliageParts.push(
        buildCuppedFoliageCard({
          width: 1.85,
          height: 2.95,
          cupDepth: 0.22,
          archY: 0.08,
          anchor: 'base',
          matrix: mCard,
          canopyCenter,
          normalBlend: 0.55,
          windFn: (x, y, z, u, v, i, out) => {
            const hNorm = clamp(y / H, 0, 1);
            out[0] = Math.pow(hNorm, 1.55);
            out[1] = 0.52 + v * 0.38;
            out[2] = 0.25 + v * 0.65;
          },
          aoFn: (x, y, z) => clamp(0.76 + clamp((y - 16.5) / 3.2, 0, 1) * 0.32, 0.72, 1.08),
        })
      );
    }

    return {
      barkGeo: mergeTreeParts(barkParts),
      foliageGeo: mergeTreeParts(foliageParts),
    };
  }

  /**
   * 2. Gnarled Broadleaf Oak (~13.8 base height -> ~11-16 units scaled)
   * Stout buttressed gnarled trunk splitting into 5 crooked spreading primary limbs
   * and 15 secondary sub-branches, crowned with a billowing volumetric leaf dome.
   */
  _buildOakGeometry() {
    const rng = createRng(5202);
    const barkParts = [];
    const foliageParts = [];
    const H = 13.8;
    const canopyCenter = new THREE.Vector3(0.0, 9.2, 0.0);

    const calcOakBarkWind = (x, y, z, u, v, i, out) => {
      const hNorm = clamp(y / H, 0, 1);
      const rDist = Math.hypot(x, z);
      out[0] = Math.pow(hNorm, 1.75) * 0.82;
      out[1] = clamp((rDist / 4.8) * smoothstep(0.25, 0.65, hNorm) * 0.86, 0, 0.92);
      out[2] = 0.0;
    };

    const calcOakBarkAO = (x, y, z) => {
      const distC = Math.hypot(x - canopyCenter.x, (y - canopyCenter.y) * 1.15, z - canopyCenter.z);
      const underVault = smoothstep(3.8, 7.2, y) * (1.0 - smoothstep(4.2, 6.2, distC));
      return clamp(0.84 - underVault * 0.36 + clamp(distC / 6.0, 0, 0.35), 0.44, 1.0);
    };

    const calcOakFoliageAO = (x, y, z) => {
      // Ellipsoidal distance from oak dome center -> deep rich AO inside, luminous sunlit outer dome!
      const dx = (x - canopyCenter.x) / 5.4;
      const dy = (y - canopyCenter.y) / 4.2;
      const dz = (z - canopyCenter.z) / 5.4;
      const ellipR = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const topSun = smoothstep(-0.75, 0.85, dy) * 0.30;
      return clamp(0.38 + clamp(ellipR, 0, 1.15) * 0.46 + topSun, 0.42, 1.08);
    };

    // Stout buttressed gnarled trunk (y = -0.65 to 4.75)
    const trunkPts = [];
    const trunkRadii = [];
    for (let i = 0; i <= 9; i++) {
      const t = i / 9;
      const y = lerp(-0.65, 4.75, t);
      const gx = Math.sin(t * Math.PI * 1.4 + 0.3) * 0.28 + t * 0.12;
      const gz = Math.cos(t * Math.PI * 1.2 - 0.6) * 0.24 - 0.16;
      const r = lerp(0.76, 0.44, Math.pow(t, 0.82)) + (t > 0.82 ? (t - 0.82) * 0.35 : 0);
      trunkPts.push(new THREE.Vector3(gx, y, gz));
      trunkRadii.push(r);
    }
    const crownFork = trunkPts[trunkPts.length - 1];

    barkParts.push(
      buildOrganicTube({
        points: trunkPts,
        radii: trunkRadii,
        radialSegs: 11,
        flareStrength: 1.06,
        flareLobes: 6,
        flareHeightFrac: 0.42,
        gnarlAmp: 0.092,
        gnarlPhase: 1.6,
        uvRepeatU: 2.2,
        uvScaleV: 0.42,
        capTip: true,
        windFn: calcOakBarkWind,
        aoFn: calcOakBarkAO,
      })
    );

    // 6 gnarled spreading oak buttress roots gripping visibly into forest soil
    const oakRootZeroWind = (_x, _y, _z, _u, _v, _i, out) => {
      out[0] = 0.0;
      out[1] = 0.0;
      out[2] = 0.0;
    };
    const oakBase = trunkPts[1];
    for (let rIdx = 0; rIdx < 6; rIdx++) {
      const rAz = (rIdx / 6) * Math.PI * 2 + 0.25 + (rng() - 0.5) * 0.26;
      const rdx = Math.cos(rAz);
      const rdz = Math.sin(rAz);
      const reach = 1.72 + rng() * 0.52;
      const kink = (rng() - 0.5) * 0.36;
      const rPts = [
        new THREE.Vector3(oakBase.x + rdx * 0.34, 1.28 + rng() * 0.28, oakBase.z + rdz * 0.34),
        new THREE.Vector3(oakBase.x + rdx * (reach * 0.38) - rdz * kink * 0.45, 0.58 + rng() * 0.14, oakBase.z + rdz * (reach * 0.38) + rdx * kink * 0.45),
        new THREE.Vector3(oakBase.x + rdx * (reach * 0.72) - rdz * kink, 0.12, oakBase.z + rdz * (reach * 0.72) + rdx * kink),
        new THREE.Vector3(oakBase.x + rdx * reach - rdz * kink * 1.15, -0.58, oakBase.z + rdz * reach + rdx * kink * 1.15),
      ];
      barkParts.push(
        buildOrganicTube({
          points: rPts,
          radii: [0.38, 0.28, 0.17, 0.065],
          radialSegs: 6,
          gnarlAmp: 0.11,
          gnarlPhase: rIdx * 2.1,
          uvRepeatU: 1.1,
          uvScaleV: 0.58,
          capTip: true,
          windFn: oakRootZeroWind,
          aoFn: (_x, y) => clamp(0.54 + smoothstep(-0.35, 1.0, y) * 0.30, 0.50, 0.86),
        })
      );
    }

    const clusterCenters = [];

    // 5 crooked spreading primary limbs + 1 ascending crown leader
    const limbSpecs = [
      { az: 0.18, reach: 5.05, rise: 4.5, r0: 0.34 },
      { az: 1.44, reach: 4.65, rise: 5.1, r0: 0.32 },
      { az: 2.68, reach: 5.20, rise: 4.1, r0: 0.35 },
      { az: 3.92, reach: 4.75, rise: 4.8, r0: 0.31 },
      { az: 5.18, reach: 4.45, rise: 5.4, r0: 0.30 },
    ];

    for (let li = 0; li < limbSpecs.length; li++) {
      const spec = limbSpecs[li];
      const az = spec.az + (rng() - 0.5) * 0.24;
      const dx = Math.cos(az);
      const dz = Math.sin(az);
      const startPt = crownFork.clone().add(new THREE.Vector3(dx * 0.16, -0.35 + (li % 2) * 0.22, dz * 0.16));

      const pPts = [startPt];
      const pRadii = [spec.r0];
      for (let k = 1; k <= 5; k++) {
        const f = k / 5;
        const elbow = Math.sin(f * Math.PI * 1.8 + li * 1.3) * 0.42;
        const lift = Math.pow(f, 0.78) * spec.rise + Math.sin(f * Math.PI) * 0.55;
        const dist = Math.pow(f, 0.92) * spec.reach;
        const px = startPt.x + dx * dist - dz * elbow;
        const py = startPt.y + lift;
        const pz = startPt.z + dz * dist + dx * elbow;
        pPts.push(new THREE.Vector3(px, py, pz));
        pRadii.push(lerp(spec.r0, 0.11, Math.pow(f, 0.85)));
      }

      barkParts.push(
        buildOrganicTube({
          points: pPts,
          radii: pRadii,
          radialSegs: 6,
          gnarlAmp: 0.06,
          gnarlPhase: li * 2.1,
          uvRepeatU: 1.3,
          uvScaleV: 0.52,
          capTip: true,
          windFn: calcOakBarkWind,
          aoFn: calcOakBarkAO,
        })
      );

      // Tip foliage cluster at end of primary limb
      clusterCenters.push({ pos: pPts[5].clone(), size: 2.75 });
      clusterCenters.push({ pos: pPts[3].clone().add(new THREE.Vector3(0, 0.85, 0)), size: 2.55 });

      // 3 crooked secondary sub-branches forking off each primary limb
      for (let s = 0; s < 3; s++) {
        const attachIdx = s === 0 ? 2 : s === 1 ? 3 : 4;
        const subStart = pPts[attachIdx].clone();
        const subAz = az + (s === 0 ? -0.78 : s === 1 ? 0.75 : (rng() - 0.5) * 0.55);
        const sdx = Math.cos(subAz);
        const sdz = Math.sin(subAz);
        const sReach = 1.65 + rng() * 1.15;
        const sRise = 1.15 + rng() * 1.45 + (s === 2 ? 0.85 : 0);

        const sPts = [subStart];
        const sRadii = [pRadii[attachIdx] * 0.68];
        for (let k = 1; k <= 3; k++) {
          const f = k / 3;
          const kink = Math.sin(f * Math.PI + s * 2.0) * 0.25;
          sPts.push(
            new THREE.Vector3(
              subStart.x + sdx * sReach * f - sdz * kink,
              subStart.y + sRise * Math.pow(f, 0.85),
              subStart.z + sdz * sReach * f + sdx * kink
            )
          );
          sRadii.push(lerp(sRadii[0], 0.045, f));
        }

        barkParts.push(
          buildOrganicTube({
            points: sPts,
            radii: sRadii,
            radialSegs: 4,
            gnarlAmp: 0.04,
            gnarlPhase: li * 3 + s,
            uvRepeatU: 1.0,
            uvScaleV: 0.65,
            capTip: true,
            windFn: calcOakBarkWind,
            aoFn: calcOakBarkAO,
          })
        );

        clusterCenters.push({ pos: sPts[3].clone(), size: 2.35 + rng() * 0.55 });
        if (s < 2) {
          clusterCenters.push({
            pos: sPts[2].clone().add(new THREE.Vector3(sdx * 0.35, 0.55, sdz * 0.35)),
            size: 2.25 + rng() * 0.45,
          });
        }
      }
    }

    // Central ascending upper crown leader branch
    const leaderPts = [
      crownFork.clone(),
      crownFork.clone().add(new THREE.Vector3(-0.22, 2.3, 0.18)),
      crownFork.clone().add(new THREE.Vector3(0.18, 4.7, -0.15)),
      crownFork.clone().add(new THREE.Vector3(-0.08, 6.8, 0.12)),
    ];
    barkParts.push(
      buildOrganicTube({
        points: leaderPts,
        radii: [0.30, 0.21, 0.13, 0.05],
        radialSegs: 5,
        uvRepeatU: 1.2,
        uvScaleV: 0.55,
        capTip: true,
        windFn: calcOakBarkWind,
        aoFn: calcOakBarkAO,
      })
    );

    // Upper dome crest clusters to complete a billowing natural crown silhouette
    clusterCenters.push({ pos: new THREE.Vector3(0.0, 12.1, 0.0), size: 3.1 });
    clusterCenters.push({ pos: new THREE.Vector3(1.6, 11.4, 1.1), size: 2.65 });
    clusterCenters.push({ pos: new THREE.Vector3(-1.7, 11.5, 0.8), size: 2.65 });
    clusterCenters.push({ pos: new THREE.Vector3(0.5, 11.3, -1.8), size: 2.65 });
    clusterCenters.push({ pos: new THREE.Vector3(-1.1, 11.1, -1.4), size: 2.55 });
    clusterCenters.push({ pos: new THREE.Vector3(0.1, 9.8, 0.2), size: 2.9 });

    // Build volumetric crossed/cupped foliage clusters around every branch tip & dome locus
    const mCard = new THREE.Matrix4();
    const qCard = new THREE.Quaternion();
    const sCard = new THREE.Vector3(1, 1, 1);
    const eul = new THREE.Euler();

    for (let ci = 0; ci < clusterCenters.length; ci++) {
      const c = clusterCenters[ci];
      // 2-3 intersecting angled cupped cards per cluster -> lush volumetric leaf mass from all angles
      const cardsPerCluster = ci % 3 === 0 ? 3 : 2;
      const baseYaw = rng() * Math.PI * 2;

      for (let k = 0; k < cardsPerCluster; k++) {
        const yaw = baseYaw + (k / cardsPerCluster) * Math.PI + (rng() - 0.5) * 0.4;
        const pitch = (k === 0 ? 0.35 : -0.45) + (rng() - 0.5) * 0.55;
        const roll = (rng() - 0.5) * 0.7;

        eul.set(pitch, yaw, roll, 'YXZ');
        qCard.setFromEuler(eul);

        const jitter = new THREE.Vector3(
          (rng() - 0.5) * 0.48,
          (rng() - 0.5) * 0.38,
          (rng() - 0.5) * 0.48
        );
        mCard.compose(c.pos.clone().add(jitter), qCard, sCard);

        const w = c.size * (0.9 + rng() * 0.24);
        const h = c.size * (0.86 + rng() * 0.24);

        foliageParts.push(
          buildCuppedFoliageCard({
            width: w,
            height: h,
            cupDepth: 0.28,
            archY: 0.16,
            anchor: 'center',
            matrix: mCard,
            canopyCenter,
            normalBlend: 0.68,
            windFn: (x, y, z, u, v, i, out) => {
              const hNorm = clamp(y / H, 0, 1);
              const rDist = Math.hypot(x, z);
              const edgeDist = Math.hypot(u * 2 - 1, v * 2 - 1) / 1.414;
              out[0] = Math.pow(hNorm, 1.75) * 0.82;
              out[1] = clamp((rDist / 5.2) * 0.88 + hNorm * 0.18, 0.12, 0.96);
              out[2] = clamp(0.24 + edgeDist * 0.72, 0.2, 0.98);
            },
            aoFn: calcOakFoliageAO,
          })
        );
      }
    }

    return {
      barkGeo: mergeTreeParts(barkParts),
      foliageGeo: mergeTreeParts(foliageParts),
    };
  }

  /**
   * 3. Silver Birch (~13.2 base height -> ~11-15 units scaled)
   * Slender gracefully arched papery-white trunk with ascending thin twigs
   * and airy, luminous yellow-green dappled leaf clusters.
   */
  _buildBirchGeometry() {
    const rng = createRng(5303);
    const barkParts = [];
    const foliageParts = [];
    const H = 13.4;
    const canopyCenter = new THREE.Vector3(0.62, 8.8, 0.25);

    const calcBirchBarkWind = (x, y, z, u, v, i, out) => {
      const hNorm = clamp(y / H, 0, 1);
      const rDist = Math.hypot(x - 0.5 * hNorm, z - 0.2 * hNorm);
      out[0] = Math.pow(hNorm, 1.45); // Supple flexible birch arch!
      out[1] = clamp((rDist / 2.8) * smoothstep(0.2, 0.55, hNorm) * 0.92, 0, 0.96);
      out[2] = 0.0;
    };

    const calcBirchBarkAO = (x, y, z) => {
      const hNorm = clamp(y / H, 0, 1);
      return clamp(0.86 - smoothstep(4.2, 8.5, y) * 0.18 + hNorm * 0.16, 0.64, 1.04);
    };

    const calcBirchFoliageAO = (x, y, z) => {
      const dx = (x - canopyCenter.x) / 2.9;
      const dy = (y - canopyCenter.y) / 4.4;
      const dz = (z - canopyCenter.z) / 2.9;
      const ellip = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Airy birch canopy lets dappled sky light filter deep inside
      return clamp(0.54 + clamp(ellip, 0, 1.1) * 0.34 + smoothstep(-0.8, 0.9, dy) * 0.24, 0.52, 1.08);
    };

    // Slender gracefully arched trunk (subtle lean & elegant S-bend)
    const trunkPts = [];
    const trunkRadii = [];
    const trunkSteps = 14;
    const trunkPosAt = (t) => {
      const y = lerp(-0.5, 12.6, t);
      const x = Math.pow(t, 1.35) * 0.78 + Math.sin(t * Math.PI) * 0.18;
      const z = Math.pow(t, 1.5) * 0.32 - Math.sin(t * Math.PI * 1.2) * 0.12;
      return new THREE.Vector3(x, y, z);
    };

    for (let i = 0; i <= trunkSteps; i++) {
      const t = i / trunkSteps;
      trunkPts.push(trunkPosAt(t));
      trunkRadii.push(lerp(0.25, 0.036, Math.pow(t, 0.85)));
    }

    barkParts.push(
      buildOrganicTube({
        points: trunkPts,
        radii: trunkRadii,
        radialSegs: 9,
        flareStrength: 0.68,
        flareLobes: 4,
        flareHeightFrac: 0.18,
        gnarlAmp: 0.032,
        gnarlPhase: 0.5,
        uvRepeatU: 1.5,
        uvScaleV: 0.48,
        capTip: true,
        windFn: calcBirchBarkWind,
        aoFn: calcBirchBarkAO,
      })
    );

    // 4 graceful anchoring birch buttress root spurs gripping the forest soil
    const birchRootZeroWind = (_x, _y, _z, _u, _v, _i, out) => {
      out[0] = 0.0;
      out[1] = 0.0;
      out[2] = 0.0;
    };
    const birchBase = trunkPosAt(0.04);
    for (let rIdx = 0; rIdx < 4; rIdx++) {
      const rAz = (rIdx / 4) * Math.PI * 2 + 0.35 + (rng() - 0.5) * 0.34;
      const rdx = Math.cos(rAz);
      const rdz = Math.sin(rAz);
      const reach = 0.78 + rng() * 0.28;
      const bend = (rng() - 0.5) * 0.14;
      const rPts = [
        new THREE.Vector3(birchBase.x + rdx * 0.12, 0.56 + rng() * 0.14, birchBase.z + rdz * 0.12),
        new THREE.Vector3(birchBase.x + rdx * (reach * 0.46) - rdz * bend * 0.5, 0.24, birchBase.z + rdz * (reach * 0.46) + rdx * bend * 0.5),
        new THREE.Vector3(birchBase.x + rdx * (reach * 0.78) - rdz * bend, 0.02, birchBase.z + rdz * (reach * 0.78) + rdx * bend),
        new THREE.Vector3(birchBase.x + rdx * reach - rdz * bend * 1.1, -0.45, birchBase.z + rdz * reach + rdx * bend * 1.1),
      ];
      barkParts.push(
        buildOrganicTube({
          points: rPts,
          radii: [0.15, 0.11, 0.07, 0.032],
          radialSegs: 5,
          gnarlAmp: 0.05,
          gnarlPhase: rIdx * 1.4,
          uvRepeatU: 1.0,
          uvScaleV: 0.7,
          capTip: true,
          windFn: birchRootZeroWind,
          aoFn: (_x, y) => clamp(0.62 + smoothstep(-0.3, 0.65, y) * 0.26, 0.58, 0.9),
        })
      );
    }

    // 14 ascending thin upper branches arching delicately outward + airy leaf clusters
    const mCard = new THREE.Matrix4();
    const qCard = new THREE.Quaternion();
    const sCard = new THREE.Vector3(1, 1, 1);
    const eul = new THREE.Euler();

    const twigCount = 14;
    for (let i = 0; i < twigCount; i++) {
      const fracH = 0.34 + (i / (twigCount - 1)) * 0.60;
      const origin = trunkPosAt(fracH);
      const az = i * 2.39996 + (rng() - 0.5) * 0.35; // Golden-angle spiral distribution!
      const dx = Math.cos(az);
      const dz = Math.sin(az);

      const heightEnv = Math.sin(remap(fracH, 0.30, 0.98, 0.18, 0.94) * Math.PI);
      const reach = (1.25 + heightEnv * 1.55) * (0.85 + rng() * 0.28);
      const rise = (1.35 + (1.0 - fracH) * 0.95) * (0.85 + rng() * 0.25);

      const bPts = [origin.clone()];
      const bRadii = [lerp(0.068, 0.026, remap(fracH, 0.34, 0.95, 0, 1))];
      for (let k = 1; k <= 4; k++) {
        const f = k / 4;
        // Ascends sharply first, then gently relaxes/weeps slightly at delicate outer tip
        const yArc = rise * Math.pow(f, 0.72) - Math.pow(f, 3.0) * 0.38;
        bPts.push(
          new THREE.Vector3(
            origin.x + dx * reach * f,
            origin.y + yArc,
            origin.z + dz * reach * f
          )
        );
        bRadii.push(lerp(bRadii[0], 0.014, f));
      }

      barkParts.push(
        buildOrganicTube({
          points: bPts,
          radii: bRadii,
          radialSegs: 4,
          uvRepeatU: 1.0,
          uvScaleV: 0.85,
          capTip: true,
          windFn: calcBirchBarkWind,
          aoFn: calcBirchBarkAO,
        })
      );

      // Attach 2 airy crossed birch foliage clusters along mid-branch and outer drooping tip
      const clusterLoci = [
        { pos: bPts[2].clone().add(new THREE.Vector3(0, 0.22, 0)), size: 1.58 + heightEnv * 0.42 },
        { pos: bPts[4].clone().add(new THREE.Vector3(0, -0.05, 0)), size: 1.48 + heightEnv * 0.38 },
      ];

      for (let clIdx = 0; clIdx < clusterLoci.length; clIdx++) {
        const cl = clusterLoci[clIdx];
        const baseYaw = az + clIdx * 1.1;
        for (let k = 0; k < 2; k++) {
          const yaw = baseYaw + k * 1.57 + (rng() - 0.5) * 0.45;
          const pitch = (k === 0 ? 0.36 : -0.32) + (rng() - 0.5) * 0.4;
          const roll = (rng() - 0.5) * 0.55;
          eul.set(pitch, yaw, roll, 'YXZ');
          qCard.setFromEuler(eul);
          mCard.compose(cl.pos, qCard, sCard);

          foliageParts.push(
            buildCuppedFoliageCard({
              width: cl.size * (0.9 + rng() * 0.22),
              height: cl.size * (0.95 + rng() * 0.22),
              cupDepth: 0.22,
              archY: 0.14,
              anchor: 'center',
              matrix: mCard,
              canopyCenter,
              normalBlend: 0.62,
              windFn: (x, y, z, u, v, i, out) => {
                const hNorm = clamp(y / H, 0, 1);
                const rDist = Math.hypot(x - 0.5 * hNorm, z - 0.2 * hNorm);
                const edgeDist = Math.hypot(u * 2 - 1, v * 2 - 1) / 1.414;
                out[0] = Math.pow(hNorm, 1.45);
                out[1] = clamp(0.18 + (rDist / 2.6) * 0.82, 0.16, 0.98);
                out[2] = clamp(0.32 + edgeDist * 0.68, 0.28, 1.0); // Shimmering birch leaves!
              },
              aoFn: calcBirchFoliageAO,
            })
          );
        }
      }
    }

    // Airy crown apex spray at top of birch trunk
    const crownTop = trunkPosAt(0.98);
    for (let k = 0; k < 3; k++) {
      eul.set(0.28, k * 2.09 + 0.3, (rng() - 0.5) * 0.3, 'YXZ');
      qCard.setFromEuler(eul);
      mCard.compose(crownTop.clone().add(new THREE.Vector3(0, 0.35, 0)), qCard, sCard);

      foliageParts.push(
        buildCuppedFoliageCard({
          width: 1.75,
          height: 2.05,
          cupDepth: 0.2,
          archY: 0.12,
          anchor: 'center',
          matrix: mCard,
          canopyCenter,
          normalBlend: 0.6,
          windFn: (x, y, z, u, v, i, out) => {
            const hNorm = clamp(y / H, 0, 1);
            out[0] = Math.pow(hNorm, 1.45);
            out[1] = 0.72 + v * 0.25;
            out[2] = 0.42 + v * 0.55;
          },
          aoFn: () => 1.04,
        })
      );
    }

    return {
      barkGeo: mergeTreeParts(barkParts),
      foliageGeo: mergeTreeParts(foliageParts),
    };
  }

  // =========================================================================
  // ECOLOGICAL PLACEMENT (Poisson-disk / spatial hash across [-108, 108])
  // =========================================================================

  _generateForestPlacements() {
    const rng = createRng(7741);
    const ecoNoise = createNoise2D(createRng(7742));

    const HALF_EXTENT = 108;
    const TARGET_COUNTS = { pine: 204, oak: 138, birch: 118 }; // 460 total max trees
    const TARGET_TOTAL = TARGET_COUNTS.pine + TARGET_COUNTS.oak + TARGET_COUNTS.birch;

    const CELL_SIZE = 7.5;
    const grid = new Map();
    const cellKey = (cx, cz) => `${cx},${cz}`;

    const isSeparated = (x, z, minSep) => {
      const cx = Math.floor(x / CELL_SIZE);
      const cz = Math.floor(z / CELL_SIZE);
      const range = Math.ceil(minSep / CELL_SIZE);
      for (let dz = -range; dz <= range; dz++) {
        for (let dx = -range; dx <= range; dx++) {
          const bucket = grid.get(cellKey(cx + dx, cz + dz));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const p = bucket[i];
            const distSq = (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z);
            const req = Math.max(minSep, p.sep);
            if (distSq < req * req) return false;
          }
        }
      }
      return true;
    };

    const registerPoint = (x, z, sep) => {
      const cx = Math.floor(x / CELL_SIZE);
      const cz = Math.floor(z / CELL_SIZE);
      const k = cellKey(cx, cz);
      let bucket = grid.get(k);
      if (!bucket) {
        bucket = [];
        grid.set(k, bucket);
      }
      bucket.push({ x, z, sep });
    };

    const speciesBuckets = { pine: [], oak: [], birch: [] };

    const makeTreeInstance = (species, x, y, z, heroPriority = false) => {
      let scaleY = 1.0;
      let scaleXZ = 1.0;
      let baseTrunkRadius = 0.5;
      let barkTint = [1, 1, 1];
      let leafTint = [1, 1, 1];

      if (species === 'pine') {
        scaleY = 0.84 + rng() * 0.34; // ~16.1 to 22.6 units
        scaleXZ = scaleY * (0.90 + rng() * 0.18);
        baseTrunkRadius = 0.56 * scaleXZ;
        const bv = 0.88 + rng() * 0.22;
        barkTint = [bv * (0.96 + rng() * 0.08), bv * (0.94 + rng() * 0.08), bv * (0.92 + rng() * 0.08)];
        const lv = 0.86 + rng() * 0.26;
        leafTint = [lv * (0.90 + rng() * 0.14), lv * (0.96 + rng() * 0.10), lv * (0.92 + rng() * 0.14)];
      } else if (species === 'oak') {
        scaleY = 0.80 + rng() * 0.36; // ~11.0 to 16.0 units
        scaleXZ = scaleY * (0.92 + rng() * 0.20);
        baseTrunkRadius = 0.72 * scaleXZ;
        const bv = 0.88 + rng() * 0.22;
        barkTint = [bv, bv * (0.98 + rng() * 0.05), bv * (0.95 + rng() * 0.06)];
        const warm = rng();
        const lv = 0.88 + rng() * 0.24;
        leafTint = [
          lv * lerp(0.90, 1.08, warm),
          lv * lerp(0.95, 1.06, warm),
          lv * lerp(0.92, 0.84, warm),
        ];
      } else {
        scaleY = 0.83 + rng() * 0.31; // ~11.0 to 15.2 units
        scaleXZ = scaleY * (0.90 + rng() * 0.18);
        baseTrunkRadius = 0.28 * scaleXZ;
        const bv = 0.93 + rng() * 0.12;
        barkTint = [bv, bv * 0.99, bv * 0.96];
        const sunGold = rng();
        const lv = 0.92 + rng() * 0.18;
        leafTint = [
          lv * lerp(0.94, 1.09, sunGold),
          lv * lerp(0.98, 1.05, sunGold),
          lv * lerp(0.92, 0.78, sunGold),
        ];
      }

      return {
        species,
        x,
        y,
        z,
        scale: scaleY,
        scaleY,
        scaleXZ,
        radius: baseTrunkRadius,
        yaw: rng() * Math.PI * 2,
        tiltX: (rng() - 0.5) * 0.065,
        tiltZ: (rng() - 0.5) * 0.065,
        barkTint,
        leafTint,
        heroPriority,
      };
    };

    const isValidSite = (x, z) => {
      if (Math.abs(x) > HALF_EXTENT || Math.abs(z) > HALF_EXTENT) return null;
      if (this._isInExclusionZone(x, z, 0.75)) return null;
      const distClearing = this.terrain.getClearingDistance(x, z);
      if (distClearing <= 11.4) return null;

      const distStream = this.terrain.getStreamDistance(x, z);
      const streamHalfW = this.terrain.getStreamHalfWidth(z);
      if (distStream <= streamHalfW + 2.0) return null;

      const y = this.terrain.getHeightAt(x, z);
      if (y <= 0.65) return null;

      const slope = this.terrain.getSlopeAt(x, z);
      if (slope >= 0.34) return null;

      return { y, distClearing, streamMargin: distStream - streamHalfW, slope };
    };

    // Ecological zoning classifier
    const pickSpeciesForSite = (x, z, site) => {
      const grovePatch = ecoNoise(x * 0.022 + 3.1, z * 0.022 - 5.4);
      const microPatch = ecoNoise(x * 0.055 - 8.2, z * 0.055 + 2.7);

      // Weight scores per species based on ecology
      let wBirch = 0.16;
      let wOak = 0.30;
      let wPine = 0.42;

      // Silver Birches cluster gracefully near sunlit clearing edges & meandering stream banks
      if (site.distClearing < 24.0) wBirch += smoothstep(24.0, 12.5, site.distClearing) * 1.15;
      if (site.streamMargin < 12.0) wBirch += smoothstep(12.0, 2.2, site.streamMargin) * 1.10;
      if (grovePatch < -0.22 && site.y < 6.5) wBirch += 0.55;

      // Gnarled Oaks anchor mossy mid-slopes & frame clearing edges
      if (site.y >= 1.8 && site.y <= 8.2) wOak += 0.55;
      if (site.distClearing >= 12.0 && site.distClearing < 34.0) wOak += 0.42;
      if (grovePatch > -0.15 && grovePatch < 0.35) wOak += 0.45;

      // Ancient Pines tower across ridges, rim hills, and deep forest groves
      if (site.y > 5.2) wPine += smoothstep(5.2, 13.5, site.y) * 1.65;
      if (Math.hypot(x, z) > 54.0) wPine += 0.65;
      if (grovePatch > 0.20) wPine += 0.72;

      // Respect remaining species quotas softly so total distribution hits target balance
      const remPine = Math.max(0, TARGET_COUNTS.pine - speciesBuckets.pine.length);
      const remOak = Math.max(0, TARGET_COUNTS.oak - speciesBuckets.oak.length);
      const remBirch = Math.max(0, TARGET_COUNTS.birch - speciesBuckets.birch.length);

      wPine = remPine > 0 ? wPine * (0.35 + (remPine / TARGET_COUNTS.pine)) : 0;
      wOak = remOak > 0 ? wOak * (0.35 + (remOak / TARGET_COUNTS.oak)) : 0;
      wBirch = remBirch > 0 ? wBirch * (0.35 + (remBirch / TARGET_COUNTS.birch)) : 0;

      // Micro patch adds organic cluster clumping
      if (microPatch > 0.32 && remBirch > 0 && site.y < 7.5) wBirch *= 1.35;
      if (microPatch < -0.30 && remPine > 0) wPine *= 1.25;

      const sum = wPine + wOak + wBirch;
      if (sum <= 0.0001) return null;
      const roll = rng() * sum;
      if (roll < wBirch) return 'birch';
      if (roll < wBirch + wOak) return 'oak';
      return 'pine';
    };

    // Pass 1: Curated Hero Framing Ring around the campfire clearing (12.2..20.5 units)
    // Guarantees the central clearing is magnificently framed on every quality preset!
    const clearingC = this.terrain.clearingCenter;
    const heroRingCount = 22;
    for (let i = 0; i < heroRingCount; i++) {
      const ang = (i / heroRingCount) * Math.PI * 2 + (rng() - 0.5) * 0.16;
      const dist = 12.6 + rng() * 6.8;
      const x = clearingC.x + Math.cos(ang) * dist;
      const z = clearingC.y + Math.sin(ang) * dist;
      const site = isValidSite(x, z);
      if (!site) continue;

      const species = i % 3 === 0 ? 'birch' : i % 3 === 1 ? 'oak' : 'pine';
      const sep = species === 'birch' ? 4.2 : species === 'oak' ? 6.4 : 5.8;
      if (!isSeparated(x, z, sep)) continue;

      registerPoint(x, z, sep);
      speciesBuckets[species].push(makeTreeInstance(species, x, site.y, z, true));
    }

    // Pass 2: Jittered stratified spatial grid across [-108, 108]
    const step = 8.4;
    const candidates = [];
    for (let gz = -HALF_EXTENT + 2; gz <= HALF_EXTENT - 2; gz += step) {
      for (let gx = -HALF_EXTENT + 2; gx <= HALF_EXTENT - 2; gx += step) {
        candidates.push([gx + (rng() - 0.5) * step * 0.88, gz + (rng() - 0.5) * step * 0.88]);
      }
    }
    // Shuffle candidate grid cells for unbiased ecological sampling
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = candidates[i];
      candidates[i] = candidates[j];
      candidates[j] = tmp;
    }

    const totalPlaced = () =>
      speciesBuckets.pine.length + speciesBuckets.oak.length + speciesBuckets.birch.length;

    for (let i = 0; i < candidates.length && totalPlaced() < TARGET_TOTAL; i++) {
      const [x, z] = candidates[i];
      const site = isValidSite(x, z);
      if (!site) continue;

      const species = pickSpeciesForSite(x, z, site);
      if (!species) break;

      const sep = species === 'birch' ? 4.2 : species === 'oak' ? 6.6 : 5.8;
      if (!isSeparated(x, z, sep)) continue;

      registerPoint(x, z, sep);
      speciesBuckets[species].push(makeTreeInstance(species, x, site.y, z, false));

      // Birches naturally form graceful multi-stem / companion groves of 2-3 near banks & edges
      if (species === 'birch' && speciesBuckets.birch.length < TARGET_COUNTS.birch && rng() < 0.36) {
        const compAng = rng() * Math.PI * 2;
        const compDist = 3.2 + rng() * 2.0;
        const cx = x + Math.cos(compAng) * compDist;
        const cz = z + Math.sin(compAng) * compDist;
        const cSite = isValidSite(cx, cz);
        if (cSite && isSeparated(cx, cz, 3.0)) {
          registerPoint(cx, cz, 3.2);
          speciesBuckets.birch.push(makeTreeInstance('birch', cx, cSite.y, cz, false));
        }
      }
    }

    // Pass 3: Poisson dart-throwing top-up so we cleanly reach ~460 trees across the map
    let attempts = 0;
    while (totalPlaced() < TARGET_TOTAL && attempts < 4500) {
      attempts++;
      const x = (rng() * 2 - 1) * HALF_EXTENT;
      const z = (rng() * 2 - 1) * HALF_EXTENT;
      const site = isValidSite(x, z);
      if (!site) continue;

      const species = pickSpeciesForSite(x, z, site);
      if (!species) break;

      const sep = species === 'birch' ? 3.8 : species === 'oak' ? 5.8 : 5.2;
      if (!isSeparated(x, z, sep)) continue;

      registerPoint(x, z, sep);
      speciesBuckets[species].push(makeTreeInstance(species, x, site.y, z, false));
    }

    // Stratify & shuffle each species array so changing `.count` via setQuality()
    // scales forest density uniformly across the entire map while keeping clearing framing intact
    for (const species of ['pine', 'oak', 'birch']) {
      const list = speciesBuckets[species];
      const heroes = list.filter((t) => t.heroPriority);
      const rest = list.filter((t) => !t.heroPriority);

      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = rest[i];
        rest[i] = rest[j];
        rest[j] = tmp;
      }
      speciesBuckets[species] = [...heroes, ...rest];
    }

    return speciesBuckets;
  }

  // =========================================================================
  // QUALITY SCALING, COLLIDERS & CLEANUP
  // =========================================================================

  setQuality(preset = 'High') {
    const ratio = QUALITY_RATIOS[preset] ?? QUALITY_RATIOS.High;
    this._currentQuality = preset in QUALITY_RATIOS ? preset : 'High';

    const activeColliders = [];
    const activeTrees = [];

    for (const species of ['pine', 'oak', 'birch']) {
      const data = this._speciesData[species];
      if (!data) continue;

      const count = Math.max(1, Math.min(data.maxCount, Math.round(data.maxCount * ratio)));
      data.barkMesh.count = count;
      data.foliageMesh.count = count;

      for (let i = 0; i < count; i++) {
        const t = data.placements[i];
        activeColliders.push({
          x: t.x,
          z: t.z,
          radius: t.radius,
          kind: 'tree',
        });
        activeTrees.push({
          x: t.x,
          y: t.y,
          z: t.z,
          species: t.species,
          scale: t.scale,
          radius: t.radius,
        });
      }
    }

    this.colliders = activeColliders;
    this.treePositions = activeTrees;
  }

  getActiveColliders() {
    return this.colliders;
  }

  dispose() {
    for (const species of Object.keys(this.meshes)) {
      const pair = this.meshes[species];
      if (pair.bark) this.group.remove(pair.bark);
      if (pair.foliage) this.group.remove(pair.foliage);
    }
    this.scene.remove(this.group);

    for (const g of this._geometries) g.dispose();
    for (const m of this._materials) m.dispose();
    for (const dm of this._depthMaterials) dm.dispose();
    for (const t of this._textures) t.dispose();

    this._geometries.length = 0;
    this._materials.length = 0;
    this._depthMaterials.length = 0;
    this._textures.length = 0;
    this.colliders.length = 0;
    this.treePositions.length = 0;
  }
}
