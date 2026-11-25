// Builds three.js objects from Ogre data: geometry from meshes, materials from material scripts,
// and the node tree, lights and cameras from dotScene files.

import * as THREE from 'three';
import type { OgreCamera, OgreEntity, OgreLight, OgreSceneData, OgreSceneNode } from './dotscene.js';
import { mainTechnique, type OgreColour, type OgreMaterial, type OgreMaterialLibrary, type OgrePass, type OgreTextureUnit } from './material.js';
import type { OgreMeshData, OgreSubMesh, OgreVertexData } from './mesh.js';
import { defaultTextureLoader, type OgreTextureLoader } from './textures.js';

export interface OgreThreeOptions {
  /**
   * standard (the default): MeshStandardMaterial, with roughness from Ogre's shininess.
   * phong: MeshPhongMaterial, which keeps Ogre's specular colour and shininess as they are.
   */
  materialType?: 'standard' | 'phong';
  /**
   * Multiplies the intensity of the lights. The default, π, makes a white Ogre light light a
   * white surface to full white, as it does in Ogre.
   */
  lightIntensity?: number;
  /** Adds the scene's ambient colour as an AmbientLight. Default true. */
  ambientLight?: boolean;
  /** Adds the scene's cameras. Default true. */
  cameras?: boolean;
  /** Ogre units per metre, overriding the scene's unitsPerMeter. The group is scaled to metres. */
  unitsPerMeter?: number;
  /** Loads textures. Default true. */
  textures?: boolean;
  /** Decodes texture files. The default handles PNG, JPEG, GIF, BMP, WebP and AVIF in browsers, and TGA and DDS. */
  textureLoader?: OgreTextureLoader;
}

/** userData on objects made from Ogre entities, lights and cameras. */
export interface OgreUserData {
  ogre: { kind: 'node' | 'entity' | 'submesh' | 'light' | 'camera' | 'scene'; name: string; meshFile?: string; subMesh?: string; material?: string };
  [key: string]: unknown;
}

/** Where the builder gets meshes and textures from. */
export interface OgreSource {
  mesh(file: string): Promise<OgreMeshData | null>;
  texture(name: string): Promise<Uint8Array | null>;
  /** The material, or null after trying any scripts the source can still fetch. */
  material(name: string, meshFile: string): Promise<OgreMaterial | null>;
  library: OgreMaterialLibrary;
}

export interface OgreBuildStats {
  entities: number;
  subMeshes: number;
  triangles: number;
  materials: number;
  textures: number;
  lights: number;
  cameras: number;
}

const BUILT_IN = new Set(['', 'basewhite', 'basewhitenolighting', 'default']);

const srgb = (c: ArrayLike<number>) => new THREE.Color().setRGB(c[0]!, c[1]!, c[2]!, THREE.SRGBColorSpace);

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function stem(file: string): string {
  const base = file.replace(/\\/g, '/').split('/').pop()!;
  return base.replace(/\.(mesh\.xml|mesh|scene|xml|zip)$/i, '');
}

const ROLE_TESTS: [RegExp, Role][] = [
  [/(^|[_\-.\s])(normal|normals|nrm|nor|norm|bump|nmap)([_\-.\s\d]|$)|_n\.\w+$/i, 'normal'],
  [/(^|[_\-.\s])(spec|specular|gloss)([_\-.\s\d]|$)|_s\.\w+$/i, 'specular'],
  [/(^|[_\-.\s])(emissive|emission|emit|glow|illum|illumination|selfillum)([_\-.\s\d]|$)/i, 'emissive'],
  [/(^|[_\-.\s])(ao|occlusion|ambientocclusion)([_\-.\s\d]|$)/i, 'ao'],
  [/(^|[_\-.\s])(lightmap|lightmaps|baked)([_\-.\s\d]|$)/i, 'light'],
  [/(^|[_\-.\s])(roughness|metallic|metalness|metalroughness|orm)([_\-.\s\d]|$)/i, 'metalRoughness'],
];

type Role = 'map' | 'normal' | 'specular' | 'emissive' | 'ao' | 'light' | 'metalRoughness';

/** Guesses what a texture unit is for from its name, alias and file name; the rest are colour maps. */
function role(unit: OgreTextureUnit, texture: string): Role {
  for (const text of [`${unit.name} ${unit.alias}`.trim(), texture.split('/').pop()!]) {
    if (!text) continue;
    for (const [test, r] of ROLE_TESTS) if (test.test(text)) return r;
  }
  return 'map';
}

export class OgreBuilder {
  readonly warnings: string[] = [];
  readonly stats: OgreBuildStats = { entities: 0, subMeshes: 0, triangles: 0, materials: 0, textures: 0, lights: 0, cameras: 0 };
  /** Files that were referred to but not found. */
  readonly missing = new Set<string>();
  private readonly options: Required<Omit<OgreThreeOptions, 'unitsPerMeter'>> & { unitsPerMeter?: number };
  private readonly attributes = new WeakMap<OgreVertexData, Record<string, THREE.BufferAttribute>>();
  private readonly geometries = new WeakMap<OgreSubMesh, THREE.BufferGeometry>();
  private readonly materials = new Map<string, Promise<THREE.Material>>();
  private readonly textures = new Map<string, Promise<THREE.Texture | null>>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly source: OgreSource,
    options: OgreThreeOptions = {},
  ) {
    this.options = {
      materialType: options.materialType ?? 'standard',
      lightIntensity: options.lightIntensity ?? Math.PI,
      ambientLight: options.ambientLight ?? true,
      cameras: options.cameras ?? true,
      textures: options.textures ?? true,
      textureLoader: options.textureLoader ?? defaultTextureLoader,
      ...(options.unitsPerMeter !== undefined ? { unitsPerMeter: options.unitsPerMeter } : {}),
    };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnings.push(message);
  }

  /** Builds the scene as a group, in metres, Y up. */
  async buildScene(scene: OgreSceneData, name: string): Promise<THREE.Group> {
    const group = new THREE.Group();
    group.name = name;
    (group.userData as OgreUserData).ogre = { kind: 'scene', name };
    this.place(group, scene.upAxis, this.options.unitsPerMeter ?? scene.unitsPerMeter);
    if (scene.ambient && this.options.ambientLight && scene.ambient.some((v) => v > 0)) {
      const ambient = new THREE.AmbientLight(srgb(scene.ambient), this.options.lightIntensity);
      ambient.name = 'Ambient';
      group.add(ambient);
    }
    for (const node of scene.roots) group.add(await this.buildNode(node));
    return group;
  }

  /** Builds loose meshes, each at the origin, as a group. */
  async buildMeshes(files: string[], name: string): Promise<THREE.Group> {
    const group = new THREE.Group();
    group.name = name;
    (group.userData as OgreUserData).ogre = { kind: 'scene', name };
    this.place(group, 'y', this.options.unitsPerMeter ?? 1);
    for (const file of files) {
      const object = await this.buildEntity({ name: stem(file), meshFile: file, materialName: null, subEntities: [], castShadows: true, receiveShadows: true, visible: true });
      if (object) group.add(object);
    }
    return group;
  }

  private place(group: THREE.Group, upAxis: 'y' | 'z', unitsPerMeter: number): void {
    if (upAxis === 'z') group.rotation.x = -Math.PI / 2;
    if (unitsPerMeter > 0 && unitsPerMeter !== 1) group.scale.setScalar(1 / unitsPerMeter);
  }

  private async buildNode(node: OgreSceneNode): Promise<THREE.Object3D> {
    const object = new THREE.Group();
    object.name = node.name;
    object.position.fromArray(node.position);
    object.quaternion.fromArray(node.rotation);
    object.scale.fromArray(node.scale);
    object.visible = node.visible;
    Object.assign(object.userData, node.userData);
    (object.userData as OgreUserData).ogre = { kind: 'node', name: node.name };
    for (const entity of node.entities) {
      const built = await this.buildEntity(entity);
      if (built) object.add(built);
    }
    for (const light of node.lights) object.add(this.buildLight(light));
    if (this.options.cameras) for (const camera of node.cameras) object.add(this.buildCamera(camera));
    for (const child of node.children) object.add(await this.buildNode(child));
    return object;
  }

  /** Builds an entity: a mesh for each submesh, in a group if there are several. */
  async buildEntity(entity: OgreEntity): Promise<THREE.Object3D | null> {
    const mesh = await this.source.mesh(entity.meshFile);
    if (!mesh) {
      this.missing.add(entity.meshFile);
      this.warnings.push(`Entity ${entity.name || entity.meshFile}: mesh ${entity.meshFile} was not found`);
      return null;
    }
    this.stats.entities++;
    const objects: THREE.Object3D[] = [];
    for (const [index, sub] of mesh.subMeshes.entries()) {
      if (!sub.vertices.position || sub.vertices.count === 0) continue;
      const materialName = entity.subEntities.find((s) => s.index === index)?.materialName ?? entity.materialName ?? sub.material;
      const geometry = this.geometry(sub);
      const hasColours = !!geometry.getAttribute('color');
      const material = await this.material(materialName, entity.meshFile, sub, hasColours);
      let object: THREE.Object3D;
      if (sub.operation === 'points') {
        object = new THREE.Points(geometry, this.simple(material, 'points'));
      } else if (sub.operation === 'lines') {
        object = new THREE.LineSegments(geometry, this.simple(material, 'lines'));
      } else {
        const m = new THREE.Mesh(geometry, material);
        m.castShadow = entity.castShadows;
        m.receiveShadow = entity.receiveShadows;
        object = m;
        const count = geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
        this.stats.triangles += Math.floor(count / 3);
      }
      // Submeshes without a name in the mesh are named after their material.
      const unnamed = sub.name === String(index);
      object.name = mesh.subMeshes.length === 1 ? entity.name || stem(entity.meshFile) : unnamed ? materialName || sub.name : sub.name;
      (object.userData as OgreUserData).ogre = { kind: 'submesh', name: entity.name, meshFile: entity.meshFile, subMesh: sub.name, material: materialName };
      this.stats.subMeshes++;
      objects.push(object);
    }
    let result: THREE.Object3D;
    if (objects.length === 1) {
      result = objects[0]!;
    } else {
      result = new THREE.Group();
      result.name = entity.name || stem(entity.meshFile);
      for (const o of objects) result.add(o);
    }
    result.visible = entity.visible;
    const userData = result.userData as OgreUserData;
    userData.ogre = { ...(userData.ogre ?? {}), kind: objects.length === 1 ? 'submesh' : 'entity', name: entity.name, meshFile: entity.meshFile };
    return result;
  }

  /** Line and point materials with the colour of the mesh material. */
  private simple(material: THREE.Material, kind: 'points' | 'lines'): THREE.Material {
    const colour = (material as THREE.MeshStandardMaterial).color ?? new THREE.Color(1, 1, 1);
    const params = { color: colour, vertexColors: (material as THREE.MeshStandardMaterial).vertexColors, transparent: material.transparent, opacity: material.opacity, name: material.name };
    return kind === 'points' ? new THREE.PointsMaterial({ ...params, size: 1, sizeAttenuation: false }) : new THREE.LineBasicMaterial(params);
  }

  private vertexAttributes(vertices: OgreVertexData): Record<string, THREE.BufferAttribute> {
    let attributes = this.attributes.get(vertices);
    if (attributes) return attributes;
    attributes = {};
    if (vertices.position) attributes.position = new THREE.BufferAttribute(vertices.position, 3);
    if (vertices.normal) attributes.normal = new THREE.BufferAttribute(vertices.normal, 3);
    if (vertices.colour) {
      const c = vertices.colour;
      const alpha = Array.from({ length: vertices.count }, (_, i) => c[i * 4 + 3]!).some((a) => a < 1);
      const size = alpha ? 4 : 3;
      const out = new Float32Array(vertices.count * size);
      for (let i = 0; i < vertices.count; i++) {
        for (let k = 0; k < 3; k++) out[i * size + k] = srgbToLinear(c[i * 4 + k]!);
        if (alpha) out[i * 4 + 3] = c[i * 4 + 3]!;
      }
      attributes.color = new THREE.BufferAttribute(out, size);
    }
    vertices.uvs.slice(0, 4).forEach((uv, i) => {
      attributes![i === 0 ? 'uv' : `uv${i}`] = new THREE.BufferAttribute(uv, 2);
    });
    this.attributes.set(vertices, attributes);
    return attributes;
  }

  private geometry(sub: OgreSubMesh): THREE.BufferGeometry {
    let geometry = this.geometries.get(sub);
    if (geometry) return geometry;
    geometry = new THREE.BufferGeometry();
    const attributes = this.vertexAttributes(sub.vertices);
    for (const [name, attribute] of Object.entries(attributes)) geometry.setAttribute(name, attribute);
    if (sub.indices) geometry.setIndex(new THREE.BufferAttribute(sub.indices, 1));
    if (!attributes.normal && sub.operation === 'triangles') geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    this.geometries.set(sub, geometry);
    return geometry;
  }

  private material(name: string, meshFile: string, sub: OgreSubMesh, hasColours: boolean): Promise<THREE.Material> {
    const aliases = Object.entries(sub.textureAliases).sort();
    const key = `${name}\u0000${hasColours}\u0000${JSON.stringify(aliases)}`;
    let material = this.materials.get(key);
    if (!material) {
      material = this.makeMaterial(name, meshFile, sub.textureAliases, hasColours);
      this.materials.set(key, material);
    }
    return material;
  }

  private async makeMaterial(name: string, meshFile: string, meshAliases: Record<string, string>, hasColours: boolean): Promise<THREE.Material> {
    const ogre = await this.source.material(name, meshFile);
    this.stats.materials++;
    const technique = ogre ? mainTechnique(ogre) : null;
    const pass = technique?.passes[0];
    if (!ogre || !pass) {
      if (!ogre && !BUILT_IN.has(name.toLowerCase())) this.warnOnce(`material:${name}`, `Material ${name} was not found, so a plain white one is used`);
      const material = this.options.materialType === 'phong' ? new THREE.MeshPhongMaterial({ color: 0xffffff }) : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
      material.name = name || 'BaseWhite';
      material.vertexColors = hasColours && name.toLowerCase() === 'basewhitenolighting';
      return material;
    }
    if (technique!.passes.length > 1) this.warnOnce(`passes:${name}`, `Material ${name} has ${technique!.passes.length} passes; it is drawn with the first`);
    if (pass.vertexProgram || pass.fragmentProgram) this.warnOnce(`shader:${name}`, `Material ${name} uses shader programs, which are not run; its fixed-function settings are used`);
    return this.convert(ogre, pass, technique!.passes.slice(1), { ...ogre.textureAliases, ...meshAliases }, hasColours);
  }

  private async convert(ogre: OgreMaterial, pass: OgrePass, laterPasses: OgrePass[], aliases: Record<string, string>, hasColours: boolean): Promise<THREE.Material> {
    const textured = (units: OgreTextureUnit[]) =>
      units.flatMap((unit) => {
        const texture = aliases[unit.alias] ?? (unit.alias ? undefined : aliases[unit.name]) ?? unit.texture;
        if (!texture || unit.contentType !== 'named') return [];
        if (unit.envMap || unit.type === 'cubic') {
          this.warnOnce(`env:${ogre.name}`, `Material ${ogre.name}: environment and cube maps are not used`);
          return [];
        }
        return [{ unit, texture }];
      });
    let units = textured(pass.textureUnits);
    // A multi-pass material may keep its colour texture in a later pass.
    if (!units.length) for (const later of laterPasses) if (!units.length) units = textured(later.textureUnits).slice(0, 1);

    const lit = pass.lighting;
    const phong = this.options.materialType === 'phong';
    const material: THREE.MeshStandardMaterial | THREE.MeshPhongMaterial | THREE.MeshBasicMaterial = !lit
      ? new THREE.MeshBasicMaterial()
      : phong
        ? new THREE.MeshPhongMaterial()
        : new THREE.MeshStandardMaterial();
    material.name = ogre.name;
    material.userData.ogre = { material: ogre.name, file: ogre.file };

    const colour = (c: OgreColour | 'vertexcolour') => (c === 'vertexcolour' ? null : c);
    const diffuse = colour(pass.diffuse);
    if (lit) {
      if (diffuse) material.color = srgb(diffuse);
      else material.vertexColors = hasColours;
    } else {
      // With lighting off, Ogre ignores the pass colours and uses vertex colours or white.
      material.vertexColors = hasColours;
      const manual = pass.textureUnits.find((u) => u.manualColour)?.manualColour;
      if (manual) material.color = srgb(manual);
    }
    if (lit && 'emissive' in material) {
      const emissive = colour(pass.emissive);
      if (emissive) material.emissive = srgb(emissive);
    }
    const specular = colour(pass.specular);
    if (material instanceof THREE.MeshPhongMaterial) {
      material.specular = specular ? srgb(specular) : new THREE.Color(0, 0, 0);
      material.shininess = pass.shininess;
    } else if (material instanceof THREE.MeshStandardMaterial) {
      const strength = specular ? Math.max(specular[0], specular[1], specular[2]) : 0;
      // Blinn-Phong shininess s matches a GGX roughness of about sqrt(2 / (s + 2)).
      material.roughness = strength > 0 && pass.shininess > 0 ? Math.min(1, Math.sqrt(2 / (pass.shininess + 2))) : 1;
      material.metalness = 0;
      if (pass.metalRoughness) {
        // RTSS metal_roughness reads roughness from the specular green and metalness from blue.
        const s = specular ?? [0, 1, 0, 1];
        material.roughness = s[1];
        material.metalness = s[2];
      }
    }

    // Blending and depth.
    switch (pass.sceneBlend) {
      case 'alpha':
        material.transparent = true;
        material.opacity = diffuse && lit ? diffuse[3] : 1;
        break;
      case 'add':
        material.transparent = true;
        material.blending = THREE.AdditiveBlending;
        break;
      case 'modulate':
        material.transparent = true;
        material.blending = THREE.MultiplyBlending;
        material.premultipliedAlpha = true;
        break;
      case 'colour':
        material.transparent = true;
        material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.SrcColorFactor;
        material.blendDst = THREE.OneMinusSrcColorFactor;
        break;
    }
    material.depthWrite = pass.depthWrite;
    material.depthTest = pass.depthCheck;
    material.colorWrite = pass.colourWrite;
    material.side = pass.cullHardware === 'none' ? THREE.DoubleSide : pass.cullHardware === 'anticlockwise' ? THREE.BackSide : THREE.FrontSide;
    material.wireframe = pass.polygonMode === 'wireframe';
    if (!(material instanceof THREE.MeshBasicMaterial)) material.flatShading = pass.shading === 'flat';
    if (pass.alphaRejection && pass.alphaRejection.func !== 'always_pass') material.alphaTest = Math.min(1, pass.alphaRejection.value / 255);

    if (!this.options.textures) return material;

    // Textures by role.
    const used = new Set<Role>();
    for (const { unit, texture } of units) {
      let r = role(unit, texture);
      if (r === 'map' && used.has('map')) {
        if (unit.texCoordSet > 0) r = 'light';
        else continue;
      }
      if (used.has(r)) continue;
      const map = await this.texture(texture, unit, r === 'map' || r === 'emissive');
      if (!map) continue;
      used.add(r);
      this.assign(material, r, map, ogre.name);
    }
    if (pass.normalMap && !used.has('normal')) {
      const map = await this.texture(pass.normalMap, null, false);
      if (map) this.assign(material, 'normal', map, ogre.name);
    }
    if (pass.metalRoughness?.texture && material instanceof THREE.MeshStandardMaterial) {
      const map = await this.texture(pass.metalRoughness.texture, null, false);
      if (map) this.assign(material, 'metalRoughness', map, ogre.name);
    }
    return material;
  }

  private assign(material: THREE.Material, role: Role, map: THREE.Texture, name: string): void {
    const m = material as THREE.MeshStandardMaterial & THREE.MeshPhongMaterial;
    switch (role) {
      case 'map':
        m.map = map;
        break;
      case 'normal':
        if (!('normalMap' in material)) return;
        m.normalMap = map;
        // As for glTF: with textures unflipped, tangents from derivatives need green inverted.
        m.normalScale = new THREE.Vector2(1, -1);
        break;
      case 'specular':
        if (material instanceof THREE.MeshPhongMaterial || material instanceof THREE.MeshBasicMaterial) m.specularMap = map;
        else this.warnOnce(`spec:${name}`, `Material ${name}: specular maps are used with materialType "phong" only`);
        break;
      case 'emissive':
        if ('emissiveMap' in material) {
          m.emissiveMap = map;
          if (m.emissive.equals(new THREE.Color(0, 0, 0))) m.emissive.set(1, 1, 1);
        }
        break;
      case 'ao':
        m.aoMap = map;
        break;
      case 'light':
        m.lightMap = map;
        break;
      case 'metalRoughness':
        if (material instanceof THREE.MeshStandardMaterial) {
          material.roughnessMap = map;
          material.metalnessMap = map;
        }
        break;
    }
    material.needsUpdate = true;
  }

  /** The texture for one use, sharing the decoded image with other uses. */
  private async texture(name: string, unit: OgreTextureUnit | null, colour: boolean): Promise<THREE.Texture | null> {
    const key = name.toLowerCase();
    let base = this.textures.get(key);
    if (!base) {
      base = this.loadTexture(name);
      this.textures.set(key, base);
    }
    const decoded = await base;
    if (!decoded) return null;
    const texture = decoded.clone();
    texture.name = name;
    texture.flipY = false;
    texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (unit) {
      const wrap = (mode: string) => (mode === 'mirror' ? THREE.MirroredRepeatWrapping : mode === 'clamp' || mode === 'border' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping);
      texture.wrapS = wrap(unit.addressMode[0]);
      texture.wrapT = wrap(unit.addressMode[1]);
      texture.repeat.set(1 / (unit.scale[0] || 1), 1 / (unit.scale[1] || 1));
      texture.offset.set(unit.scroll[0], unit.scroll[1]);
      texture.rotation = (unit.rotate * Math.PI) / 180;
      texture.channel = Math.min(3, unit.texCoordSet);
    } else {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    }
    texture.needsUpdate = true;
    return texture;
  }

  private async loadTexture(name: string): Promise<THREE.Texture | null> {
    const data = await this.source.texture(name);
    if (!data) {
      this.missing.add(name);
      this.warnOnce(`tex:${name.toLowerCase()}`, `Texture ${name} was not found`);
      return null;
    }
    try {
      const texture = await this.options.textureLoader(name, data);
      if (!texture) {
        this.warnOnce('tex:decode', 'Textures were not decoded: this environment has no createImageBitmap; pass a textureLoader');
        return null;
      }
      this.stats.textures++;
      return texture;
    } catch (error) {
      this.warnOnce(`tex:${name.toLowerCase()}`, `Texture ${name} could not be read: ${(error as Error).message}`);
      return null;
    }
  }

  buildLight(light: OgreLight): THREE.Light {
    const colour = srgb(light.diffuse);
    const scale = light.powerScale * this.options.lightIntensity;
    let object: THREE.Light;
    const a = light.attenuation;
    // Ogre attenuates by 1 / (constant + linear d + quadratic d²); three.js by distance^-decay.
    // The strongest term sets the decay, and its factor the intensity.
    let decay = 0;
    let factor = 1;
    if (a) {
      if (a.quadratic > 0) {
        decay = 2;
        factor = 1 / a.quadratic;
      } else if (a.linear > 0) {
        decay = 1;
        factor = 1 / a.linear;
      } else if (a.constant > 0) factor = 1 / a.constant;
    }
    const distance = a && a.range > 0 && a.range < 1e5 ? a.range : 0;
    const direction = new THREE.Vector3().fromArray(light.direction);
    if (direction.lengthSq() === 0) direction.set(0, 0, -1);
    direction.normalize();
    if (light.type === 'directional') {
      const d = new THREE.DirectionalLight(colour, scale);
      d.target.position.copy(direction);
      d.add(d.target);
      object = d;
    } else if (light.type === 'spot') {
      const outer = light.range?.outer ?? Math.PI / 4;
      const inner = light.range?.inner ?? outer * 0.75;
      const s = new THREE.SpotLight(colour, scale * factor, distance, Math.min(Math.PI / 2, outer / 2), outer > 0 ? Math.min(1, Math.max(0, 1 - inner / outer)) : 0, decay);
      s.target.position.copy(direction);
      s.add(s.target);
      object = s;
    } else {
      if (light.type === 'rect') this.warnOnce('rect', 'Rectangular area lights are read as point lights');
      object = new THREE.PointLight(colour, scale * factor, distance, decay);
    }
    object.name = light.name;
    object.position.fromArray(light.position);
    object.visible = light.visible;
    object.castShadow = light.castShadows;
    (object.userData as OgreUserData).ogre = { kind: 'light', name: light.name };
    this.stats.lights++;
    return object;
  }

  buildCamera(camera: OgreCamera): THREE.Camera {
    let object: THREE.Camera;
    if (camera.projection === 'orthographic') {
      const h = 1;
      object = new THREE.OrthographicCamera(-h * camera.aspectRatio, h * camera.aspectRatio, h, -h, camera.near, camera.far);
    } else {
      object = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(camera.fov), camera.aspectRatio, camera.near, camera.far);
    }
    object.name = camera.name;
    object.position.fromArray(camera.position);
    object.quaternion.fromArray(camera.rotation);
    (object.userData as OgreUserData).ogre = { kind: 'camera', name: camera.name };
    this.stats.cameras++;
    return object;
  }
}
