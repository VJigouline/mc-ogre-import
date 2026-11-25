// Reads dotScene files (.scene), the XML scene format of Ogre's DotScene plugin and of exporters
// such as blender2ogre: a node tree with entities, lights and cameras.

import { attr, boolAttr, child, childrenNamed, numAttr, parseXml, type XmlElement } from './xml.js';

export type Vec3 = [number, number, number];
/** x, y, z, w. */
export type Quat = [number, number, number, number];
export type Rgb = [number, number, number];

export interface OgreEntity {
  name: string;
  meshFile: string;
  /** Material for every submesh, if the entity sets one. */
  materialName: string | null;
  /** Materials for particular submeshes, by submesh index. */
  subEntities: { index: number; materialName: string }[];
  castShadows: boolean;
  receiveShadows: boolean;
  visible: boolean;
}

export interface OgreLight {
  name: string;
  type: 'point' | 'directional' | 'spot' | 'rect';
  position: Vec3;
  /** Direction in the node's space; Ogre's default is -Z. */
  direction: Vec3;
  diffuse: Rgb;
  specular: Rgb;
  /** Spotlight cone: inner and outer angles in radians (full cone), and falloff. */
  range: { inner: number; outer: number; falloff: number } | null;
  attenuation: { range: number; constant: number; linear: number; quadratic: number } | null;
  powerScale: number;
  castShadows: boolean;
  visible: boolean;
}

export interface OgreCamera {
  name: string;
  /** Vertical field of view, in radians. */
  fov: number;
  aspectRatio: number;
  projection: 'perspective' | 'orthographic';
  near: number;
  far: number;
  position: Vec3;
  rotation: Quat;
}

export interface OgreSceneNode {
  name: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  visible: boolean;
  entities: OgreEntity[];
  lights: OgreLight[];
  cameras: OgreCamera[];
  children: OgreSceneNode[];
  /** Properties from the node's userData. */
  userData: Record<string, string>;
}

export interface OgreSceneData {
  formatVersion: string;
  /** y (the default) or z. */
  upAxis: 'y' | 'z';
  unitsPerMeter: number;
  author: string;
  ambient: Rgb | null;
  background: Rgb | null;
  fog: { mode: string; start: number; end: number; density: number; colour: Rgb } | null;
  roots: OgreSceneNode[];
  /** Files the scene names as externals, such as material scripts. */
  externals: { type: string; file: string }[];
  warnings: string[];
}

export class OgreSceneError extends Error {
  override name = 'OgreSceneError';
}

function vec(element: XmlElement | undefined, fallback: Vec3): Vec3 {
  if (!element) return [...fallback];
  return [numAttr(element, 'x', fallback[0]), numAttr(element, 'y', fallback[1]), numAttr(element, 'z', fallback[2])];
}

function rgb(element: XmlElement | undefined, fallback: Rgb | null): Rgb | null {
  if (!element) return fallback ? [...fallback] : null;
  const f = fallback ?? [1, 1, 1];
  return [numAttr(element, ['r', 'red'], f[0]), numAttr(element, ['g', 'green'], f[1]), numAttr(element, ['b', 'blue'], f[2])];
}

function quatFromAxisAngle(x: number, y: number, z: number, angle: number): Quat {
  const len = Math.hypot(x, y, z) || 1;
  const s = Math.sin(angle / 2) / len;
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Reads <rotation> or <quaternion> as qx/qy/qz/qw, x/y/z/w, axis and angle, or Euler angles in radians. */
function rotation(element: XmlElement | undefined): Quat {
  if (!element) return [0, 0, 0, 1];
  const a = (names: string[]) => attr(element, ...names);
  if (a(['qw', 'w']) !== undefined) {
    const q: Quat = [numAttr(element, ['qx', 'x'], 0), numAttr(element, ['qy', 'y'], 0), numAttr(element, ['qz', 'z'], 0), numAttr(element, ['qw', 'w'], 1)];
    const len = Math.hypot(...q);
    return len > 0 ? (q.map((v) => v / len) as Quat) : [0, 0, 0, 1];
  }
  if (a(['angle']) !== undefined) {
    return quatFromAxisAngle(numAttr(element, 'axisX', 0), numAttr(element, 'axisY', 1), numAttr(element, 'axisZ', 0), numAttr(element, 'angle', 0));
  }
  if (a(['angleX', 'angleY', 'angleZ']) !== undefined) {
    // Applied in X, Y, Z order.
    const qx = quatFromAxisAngle(1, 0, 0, numAttr(element, 'angleX', 0));
    const qy = quatFromAxisAngle(0, 1, 0, numAttr(element, 'angleY', 0));
    const qz = quatFromAxisAngle(0, 0, 1, numAttr(element, 'angleZ', 0));
    return multiply(qz, multiply(qy, qx));
  }
  return [0, 0, 0, 1];
}

function readUserData(element: XmlElement): Record<string, string> {
  const result: Record<string, string> = {};
  const data = child(element, 'userData', 'user_data');
  for (const p of data ? childrenNamed(data, 'property') : []) {
    const name = attr(p, 'name');
    if (name) result[name] = attr(p, 'data', 'value') ?? p.text;
  }
  return result;
}

function readEntity(element: XmlElement): OgreEntity {
  const subs = child(element, 'subentities');
  return {
    name: attr(element, 'name') ?? '',
    meshFile: attr(element, 'meshFile', 'mesh') ?? '',
    materialName: attr(element, 'materialName', 'material') ?? null,
    subEntities: (subs ? childrenNamed(subs, 'subentity') : []).flatMap((s) => {
      const materialName = attr(s, 'materialName', 'material');
      return materialName ? [{ index: numAttr(s, 'index', 0), materialName }] : [];
    }),
    castShadows: boolAttr(element, 'castShadows', true),
    receiveShadows: boolAttr(element, 'receiveShadows', true),
    visible: boolAttr(element, 'visible', true),
  };
}

function readLight(element: XmlElement, warnings: string[]): OgreLight {
  const rawType = (attr(element, 'type') ?? 'point').toLowerCase();
  let type: OgreLight['type'] = 'point';
  if (rawType === 'directional') type = 'directional';
  else if (rawType === 'spot' || rawType === 'spotlight') type = 'spot';
  else if (rawType === 'rect' || rawType === 'area') type = 'rect';
  else if (rawType !== 'point' && rawType !== 'radpoint') warnings.push(`Light ${attr(element, 'name') ?? ''} has unknown type ${rawType}; it is read as a point light`);
  const range = child(element, 'lightRange');
  const attenuation = child(element, 'lightAttenuation');
  return {
    name: attr(element, 'name') ?? '',
    type,
    position: vec(child(element, 'position'), [0, 0, 0]),
    direction: vec(child(element, 'directionVector', 'direction', 'normal'), [0, 0, -1]),
    diffuse: rgb(child(element, 'colourDiffuse', 'colorDiffuse'), [1, 1, 1])!,
    specular: rgb(child(element, 'colourSpecular', 'colorSpecular'), [1, 1, 1])!,
    range: range ? { inner: numAttr(range, 'inner', 0.5236), outer: numAttr(range, 'outer', 0.7854), falloff: numAttr(range, 'falloff', 1) } : null,
    attenuation: attenuation
      ? { range: numAttr(attenuation, 'range', 100000), constant: numAttr(attenuation, 'constant', 1), linear: numAttr(attenuation, 'linear', 0), quadratic: numAttr(attenuation, 'quadratic', 0) }
      : null,
    powerScale: numAttr(element, ['powerScale', 'power'], 1),
    castShadows: boolAttr(element, 'castShadows', true),
    visible: boolAttr(element, 'visible', true),
  };
}

function readCamera(element: XmlElement): OgreCamera {
  const clipping = child(element, 'clipping', 'clipPlane');
  return {
    name: attr(element, 'name') ?? '',
    fov: numAttr(element, ['fov', 'FOVy'], Math.PI / 4),
    aspectRatio: numAttr(element, 'aspectRatio', 4 / 3),
    projection: (attr(element, 'projectionType') ?? '').toLowerCase() === 'orthographic' ? 'orthographic' : 'perspective',
    near: clipping ? numAttr(clipping, ['near', 'nearPlaneDist'], 0.1) : 0.1,
    far: clipping ? numAttr(clipping, ['far', 'farPlaneDist'], 10000) : 10000,
    position: vec(child(element, 'position'), [0, 0, 0]),
    rotation: rotation(child(element, 'rotation', 'quaternion')),
  };
}

function readNode(element: XmlElement, warnings: string[]): OgreSceneNode {
  const node: OgreSceneNode = {
    name: attr(element, 'name') ?? '',
    position: vec(child(element, 'position'), [0, 0, 0]),
    rotation: rotation(child(element, 'rotation', 'quaternion')),
    scale: vec(child(element, 'scale'), [1, 1, 1]),
    visible: (attr(element, 'visibility') ?? 'visible').toLowerCase() !== 'hidden',
    entities: [],
    lights: [],
    cameras: [],
    children: [],
    userData: readUserData(element),
  };
  const skipped = new Set<string>();
  for (const c of element.children) {
    const name = c.name.toLowerCase();
    if (name === 'entity') node.entities.push(readEntity(c));
    else if (name === 'light') node.lights.push(readLight(c, warnings));
    else if (name === 'camera') node.cameras.push(readCamera(c));
    else if (name === 'node') node.children.push(readNode(c, warnings));
    else if (['particlesystem', 'billboardset', 'plane', 'staticgeometry', 'instancedgeometry', 'terrain'].includes(name)) skipped.add(c.name);
  }
  for (const name of skipped) warnings.push(`Node ${node.name}: <${name}> is not read`);
  return node;
}

/** Reads a dotScene (.scene) file. */
export function parseDotScene(source: string): OgreSceneData {
  const root = parseXml(source);
  if (root.name.toLowerCase() !== 'scene') throw new OgreSceneError(`Not a dotScene file: the root element is <${root.name}>`);
  const warnings: string[] = [];
  const up = (attr(root, 'upAxis') ?? 'y').toLowerCase();
  const environment = child(root, 'environment');
  const fog = environment ? child(environment, 'fog') : undefined;
  const scene: OgreSceneData = {
    formatVersion: attr(root, 'formatVersion') ?? '',
    upAxis: up === 'z' ? 'z' : 'y',
    unitsPerMeter: numAttr(root, 'unitsPerMeter', 1) || 1,
    author: attr(root, 'author') ?? '',
    ambient: environment ? rgb(child(environment, 'colourAmbient', 'colorAmbient'), null) : null,
    background: environment ? rgb(child(environment, 'colourBackground', 'colorBackground'), null) : null,
    fog: fog
      ? {
          mode: (attr(fog, 'mode') ?? 'linear').toLowerCase(),
          start: numAttr(fog, ['linearStart', 'start'], 0),
          end: numAttr(fog, ['linearEnd', 'end'], 1),
          density: numAttr(fog, ['expDensity', 'density'], 0.001),
          colour: rgb(child(fog, 'colourDiffuse', 'colorDiffuse', 'colour'), [1, 1, 1])!,
        }
      : null,
    roots: [],
    externals: [],
    warnings,
  };
  const nodes = child(root, 'nodes');
  if (nodes) {
    // Lights and cameras may sit directly in <nodes>; they become nodes of their own.
    for (const c of nodes.children) {
      const name = c.name.toLowerCase();
      if (name === 'node') scene.roots.push(readNode(c, warnings));
      else if (name === 'light' || name === 'camera' || name === 'entity') {
        scene.roots.push(readNode({ name: 'node', attributes: { name: attr(c, 'name') ?? '' }, children: [c], text: '' }, warnings));
      }
    }
  }
  for (const c of root.children) {
    const name = c.name.toLowerCase();
    if (name === 'light' || name === 'camera') scene.roots.push(readNode({ name: 'node', attributes: { name: attr(c, 'name') ?? '' }, children: [c], text: '' }, warnings));
  }
  const externals = child(root, 'externals');
  for (const item of externals ? childrenNamed(externals, 'item') : []) {
    const file = child(item, 'file');
    const name = file ? attr(file, 'name') : undefined;
    if (name) scene.externals.push({ type: attr(item, 'type') ?? '', file: name });
  }
  if (child(root, 'terrain', 'terrainGroup')) warnings.push('Terrain is not read');
  return scene;
}
