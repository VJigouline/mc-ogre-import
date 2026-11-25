// Ogre materials as plain data, read from .material scripts: the techniques, passes and texture
// units, with Ogre's defaults for anything a script leaves out.

import { ScriptRegistry, type ScriptNode, type ScriptObject, type ScriptProperty } from './script.js';

/** r, g, b, a from 0 to 1, as written in the script. */
export type OgreColour = [number, number, number, number];

export interface OgreTextureUnit {
  name: string;
  /** The unit's texture alias, which meshes and materials can point at another texture. */
  alias: string;
  /** The texture file name; null if the unit has none. */
  texture: string | null;
  /** 1d, 2d, 3d or cubic. */
  type: string;
  /** u, v and w address modes: wrap, clamp, mirror or border. */
  addressMode: [string, string, string];
  texCoordSet: number;
  /** How the unit combines with the colour so far: modulate, replace, add or alpha_blend. */
  colourOp: string;
  /** A manual colour from `colour_op_ex ... src_manual`, if any. */
  manualColour: OgreColour | null;
  /** Texture scale: values above 1 make the texture larger. */
  scale: [number, number];
  /** Texture offset, in texture widths. */
  scroll: [number, number];
  /** Rotation, in degrees anticlockwise. */
  rotate: number;
  /** spherical, planar, cubic_reflection or cubic_normal, if the unit is an environment map. */
  envMap: string | null;
  /** Content type such as named, shadow or compositor. */
  contentType: string;
}

export interface OgrePass {
  name: string;
  ambient: OgreColour | 'vertexcolour';
  diffuse: OgreColour | 'vertexcolour';
  specular: OgreColour | 'vertexcolour';
  shininess: number;
  emissive: OgreColour | 'vertexcolour';
  /** replace, alpha, add, modulate or colour, from scene_blend. */
  sceneBlend: 'replace' | 'alpha' | 'add' | 'modulate' | 'colour';
  depthWrite: boolean;
  depthCheck: boolean;
  colourWrite: boolean;
  /** Which triangles the hardware culls: clockwise (the default, back faces), anticlockwise or none. */
  cullHardware: 'clockwise' | 'anticlockwise' | 'none';
  lighting: boolean;
  shading: 'flat' | 'gouraud' | 'phong';
  polygonMode: 'solid' | 'wireframe' | 'points';
  /** Alpha test: pixels pass if their alpha, 0 to 255, compares with the value. */
  alphaRejection: { func: string; value: number } | null;
  textureUnits: OgreTextureUnit[];
  vertexProgram: string | null;
  fragmentProgram: string | null;
  /** From the RTSS: a normal map texture. */
  normalMap: string | null;
  /** From the RTSS metal_roughness lighting stage: an optional metal-roughness texture. */
  metalRoughness: { texture: string | null } | null;
}

export interface OgreTechnique {
  name: string;
  scheme: string;
  lodIndex: number;
  passes: OgrePass[];
}

export interface OgreMaterial {
  name: string;
  file: string;
  receiveShadows: boolean;
  /** Texture aliases set on the material with set_texture_alias. */
  textureAliases: Record<string, string>;
  techniques: OgreTechnique[];
}

const IMAGE = /\.(png|jpe?g|tga|dds|bmp|gif|webp|avif|tiff?|ktx2?|pvr|exr|hdr|psd)$/i;

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) ? n : fallback;
};

const onOff = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : ['on', 'true', 'yes', '1'].includes(value.toLowerCase()) ? true : ['off', 'false', 'no', '0'].includes(value.toLowerCase()) ? false : fallback;

function colour(values: string[], fallback: OgreColour): OgreColour | 'vertexcolour' {
  if (values[0] === 'vertexcolour' || values[0] === 'vertexcolor') return 'vertexcolour';
  const v = values.map(Number);
  if (!values.length || !Number.isFinite(v[0])) return fallback;
  const g = Number.isFinite(v[1]) ? v[1]! : v[0]!;
  const b = Number.isFinite(v[2]) ? v[2]! : v[0]!;
  return [v[0]!, g, b, Number.isFinite(v[3]) ? v[3]! : 1];
}

function blend(values: string[]): OgrePass['sceneBlend'] {
  const [a, b] = values;
  switch (a) {
    case 'alpha_blend':
      return 'alpha';
    case 'add':
      return 'add';
    case 'modulate':
      return 'modulate';
    case 'colour_blend':
      return 'colour';
    case 'replace':
      return 'replace';
  }
  if (a === 'one' && b === 'zero') return 'replace';
  if (a === 'one' && b === 'one') return 'add';
  if (a === 'src_alpha' && b === 'one') return 'add';
  if (a === 'dest_colour' && b === 'zero') return 'modulate';
  if (a === 'zero' && b === 'src_colour') return 'modulate';
  if (a === 'src_colour' && b === 'one_minus_src_colour') return 'colour';
  if (b === 'one_minus_src_alpha') return 'alpha';
  return 'replace';
}

const props = (object: ScriptObject) => object.children.filter((c): c is ScriptProperty => !c.object);
const objects = (object: ScriptObject, type: string) => object.children.filter((c): c is ScriptObject => c.object && c.type === type);

function readTextureUnit(unit: ScriptObject): OgreTextureUnit {
  const result: OgreTextureUnit = {
    name: unit.name,
    alias: '',
    texture: null,
    type: '2d',
    addressMode: ['wrap', 'wrap', 'wrap'],
    texCoordSet: 0,
    colourOp: 'modulate',
    manualColour: null,
    scale: [1, 1],
    scroll: [0, 0],
    rotate: 0,
    envMap: null,
    contentType: 'named',
  };
  for (const p of props(unit)) {
    const v = p.values;
    switch (p.name) {
      case 'texture':
        result.texture = v[0] ?? null;
        if (v[1] && /^(1d|2d|3d|cubic|2darray)$/.test(v[1])) result.type = v[1];
        break;
      case 'anim_texture':
        // The short form names frames base_0.ext, base_1.ext and so on; the long form lists them.
        if (v.length === 3 && /^\d+$/.test(v[1]!)) {
          const dot = v[0]!.lastIndexOf('.');
          result.texture = dot > 0 ? `${v[0]!.slice(0, dot)}_0${v[0]!.slice(dot)}` : `${v[0]}_0`;
        } else result.texture = v[0] ?? null;
        break;
      case 'cubic_texture':
        result.texture = v[0] ?? null;
        result.type = 'cubic';
        break;
      case 'texture_alias':
        result.alias = v[0] ?? '';
        break;
      case 'tex_coord_set':
        result.texCoordSet = num(v[0], 0);
        break;
      case 'tex_address_mode': {
        const u = v[0] ?? 'wrap';
        result.addressMode = [u, v[1] ?? u, v[2] ?? u];
        break;
      }
      case 'colour_op':
        result.colourOp = v[0] ?? 'modulate';
        break;
      case 'colour_op_ex': {
        const op = v[0] ?? 'modulate';
        result.colourOp = op === 'source1' ? 'replace' : op.startsWith('modulate') ? 'modulate' : op.startsWith('add') ? 'add' : op.startsWith('blend') ? 'alpha_blend' : op;
        // colour_op_ex source1 src_manual src_current r g b gives a flat colour.
        const manual = v.indexOf('src_manual');
        if (manual >= 0) {
          const numbers = v.slice(3).map(Number).filter(Number.isFinite);
          if (numbers.length >= 3) result.manualColour = [numbers[0]!, numbers[1]!, numbers[2]!, 1];
        }
        break;
      }
      case 'scale':
        result.scale = [num(v[0], 1), num(v[1], num(v[0], 1))];
        break;
      case 'scroll':
        result.scroll = [num(v[0], 0), num(v[1], 0)];
        break;
      case 'rotate':
        result.rotate = num(v[0], 0);
        break;
      case 'env_map':
        result.envMap = v[0] && v[0] !== 'off' ? v[0] : null;
        break;
      case 'content_type':
        result.contentType = v[0] ?? 'named';
        break;
    }
  }
  return result;
}

function readPass(pass: ScriptObject): OgrePass {
  const result: OgrePass = {
    name: pass.name,
    ambient: [1, 1, 1, 1],
    diffuse: [1, 1, 1, 1],
    specular: [0, 0, 0, 0],
    shininess: 0,
    emissive: [0, 0, 0, 0],
    sceneBlend: 'replace',
    depthWrite: true,
    depthCheck: true,
    colourWrite: true,
    cullHardware: 'clockwise',
    lighting: true,
    shading: 'gouraud',
    polygonMode: 'solid',
    alphaRejection: null,
    textureUnits: [],
    vertexProgram: null,
    fragmentProgram: null,
    normalMap: null,
    metalRoughness: null,
  };
  for (const p of props(pass)) {
    const v = p.values;
    switch (p.name) {
      case 'ambient':
        result.ambient = colour(v, [1, 1, 1, 1]);
        break;
      case 'diffuse':
        result.diffuse = colour(v, [1, 1, 1, 1]);
        break;
      case 'emissive':
      case 'self_illumination':
        result.emissive = colour(v, [0, 0, 0, 0]);
        break;
      case 'specular':
        if (v[0] === 'vertexcolour' || v[0] === 'vertexcolor') {
          result.specular = 'vertexcolour';
          result.shininess = num(v[1], result.shininess);
        } else if (v.length >= 5) {
          result.specular = [num(v[0], 0), num(v[1], 0), num(v[2], 0), num(v[3], 1)];
          result.shininess = num(v[4], 0);
        } else if (v.length === 4) {
          result.specular = [num(v[0], 0), num(v[1], 0), num(v[2], 0), 1];
          result.shininess = num(v[3], 0);
        } else {
          result.specular = colour(v, [0, 0, 0, 0]);
        }
        break;
      case 'shininess':
        result.shininess = num(v[0], result.shininess);
        break;
      case 'scene_blend':
        result.sceneBlend = blend(v);
        break;
      case 'separate_scene_blend':
        result.sceneBlend = blend(v.length >= 4 ? v.slice(0, 2) : v.slice(0, 1));
        break;
      case 'depth_write':
        result.depthWrite = onOff(v[0], true);
        break;
      case 'depth_check':
        result.depthCheck = onOff(v[0], true);
        break;
      case 'colour_write':
        result.colourWrite = onOff(v[0], true);
        break;
      case 'cull_hardware':
        result.cullHardware = v[0] === 'none' ? 'none' : v[0] === 'anticlockwise' ? 'anticlockwise' : 'clockwise';
        break;
      case 'lighting':
        result.lighting = onOff(v[0], true);
        break;
      case 'shading':
        result.shading = v[0] === 'flat' ? 'flat' : v[0] === 'phong' ? 'phong' : 'gouraud';
        break;
      case 'polygon_mode':
        result.polygonMode = v[0] === 'wireframe' ? 'wireframe' : v[0] === 'points' ? 'points' : 'solid';
        break;
      case 'alpha_rejection':
        result.alphaRejection = { func: v[0] ?? 'always_pass', value: num(v[1], 0) };
        break;
    }
  }
  for (const child of pass.children) {
    if (!child.object) continue;
    if (child.type === 'texture_unit') result.textureUnits.push(readTextureUnit(child));
    else if (child.type === 'vertex_program_ref') result.vertexProgram = child.name || null;
    else if (child.type === 'fragment_program_ref') result.fragmentProgram = child.name || null;
    else if (child.type === 'rtshader_system') readShaderSystem(child, result);
  }
  return result;
}

/** Reads the RTSS lighting stages that matter for the look: normal maps and metal-roughness. */
function readShaderSystem(object: ScriptObject, pass: OgrePass): void {
  for (const p of props(object)) {
    const v = p.name === 'lighting_stage' ? p.values : [p.name, ...p.values];
    if (v[0] === 'normal_map') {
      pass.normalMap = v.slice(1).find((x) => IMAGE.test(x)) ?? (v[1] === 'texture' ? v[2] : v[1]) ?? null;
    } else if (v[0] === 'metal_roughness') {
      const t = v.indexOf('texture');
      pass.metalRoughness = { texture: t >= 0 ? (v[t + 1] ?? null) : (v.slice(1).find((x) => IMAGE.test(x)) ?? null) };
    }
  }
}

function readMaterial(material: ScriptObject): OgreMaterial {
  const result: OgreMaterial = { name: material.name, file: material.file, receiveShadows: true, textureAliases: {}, techniques: [] };
  for (const p of props(material)) {
    if (p.name === 'receive_shadows') result.receiveShadows = onOff(p.values[0], true);
    else if (p.name === 'set_texture_alias' && p.values.length >= 2) result.textureAliases[p.values[0]!] = p.values[1]!;
  }
  for (const technique of objects(material, 'technique')) {
    const t: OgreTechnique = { name: technique.name, scheme: 'Default', lodIndex: 0, passes: [] };
    for (const p of props(technique)) {
      if (p.name === 'scheme') t.scheme = p.values[0] ?? 'Default';
      else if (p.name === 'lod_index') t.lodIndex = num(p.values[0], 0);
    }
    t.passes = objects(technique, 'pass').map(readPass);
    result.techniques.push(t);
  }
  return result;
}

/**
 * The materials of a set of .material scripts. Add every script first, as materials can inherit
 * from materials in other scripts; then look materials up by name.
 */
export class OgreMaterialLibrary {
  readonly registry = new ScriptRegistry();
  private readonly cache = new Map<string, OgreMaterial | null>();

  /** Adds a .material script and returns the names of the materials it defines. */
  add(source: string, file = ''): string[] {
    this.cache.clear();
    return this.registry.add(source, file).filter((o) => o.type === 'material' && !o.abstract && o.name).map((o) => o.name);
  }

  /** Names of all the materials that can be used, in the order they were defined. */
  get names(): string[] {
    return [...new Set(this.registry.objects.filter((o) => o.type === 'material' && !o.abstract && o.name).map((o) => o.name))];
  }

  /** Scripts named by import directives. */
  get imports(): string[] {
    return this.registry.imports;
  }

  get warnings(): string[] {
    return this.registry.warnings;
  }

  has(name: string): boolean {
    const object = this.registry.find('material', name);
    return !!object && !object.abstract;
  }

  /** The material, with inheritance and variables resolved; null if there is no such material. */
  get(name: string): OgreMaterial | null {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const object = this.registry.find('material', name);
    const material = object && !object.abstract ? readMaterial(this.registry.resolve(object)) : null;
    this.cache.set(name, material);
    return material;
  }
}

/** Reads the materials of one .material script. Use OgreMaterialLibrary for materials that inherit across scripts. */
export function parseMaterialScript(source: string, file = ''): OgreMaterial[] {
  const library = new OgreMaterialLibrary();
  return library.add(source, file).map((name) => library.get(name)!).filter(Boolean);
}

/**
 * The technique Ogre would normally use: the first in the Default scheme at LOD 0, or else the
 * first technique.
 */
export function mainTechnique(material: OgreMaterial): OgreTechnique | null {
  return material.techniques.find((t) => t.scheme === 'Default' && t.lodIndex === 0 && t.passes.length) ?? material.techniques[0] ?? null;
}

export type { ScriptNode };
