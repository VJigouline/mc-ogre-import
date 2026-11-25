// Reads Ogre XML meshes (.mesh.xml), as written by OgreXMLConverter, OgreMeshTool and exporters
// such as blender2ogre.

import { applyOperation } from './mesh-binary.js';
import { emptyVertexData, type OgreMeshData, type OgreSubMesh, type OgreVertexData } from './mesh.js';
import { attr, boolAttr, child, childrenNamed, numAttr, parseXml, type XmlElement } from './xml.js';

export class OgreMeshXmlError extends Error {
  override name = 'OgreMeshXmlError';
}

function readVertices(geometry: XmlElement): OgreVertexData {
  const count = numAttr(geometry, ['vertexcount', 'count'], 0);
  const vertices = emptyVertexData(count);
  const position: number[] = [];
  const normal: number[] = [];
  const colour: number[] = [];
  const uvs: number[][] = [];
  let index = 0;
  let hasPosition = false;
  let hasNormal = false;
  let hasColour = false;
  // Each vertex buffer holds some of the elements of every vertex, so all of them are read.
  for (const buffer of childrenNamed(geometry, 'vertexbuffer')) {
    index = 0;
    for (const vertex of childrenNamed(buffer, 'vertex')) {
      let uv = 0;
      for (const element of vertex.children) {
        const name = element.name.toLowerCase();
        if (name === 'position') {
          hasPosition = true;
          position[index * 3] = numAttr(element, 'x', 0);
          position[index * 3 + 1] = numAttr(element, 'y', 0);
          position[index * 3 + 2] = numAttr(element, 'z', 0);
        } else if (name === 'normal') {
          hasNormal = true;
          normal[index * 3] = numAttr(element, 'x', 0);
          normal[index * 3 + 1] = numAttr(element, 'y', 0);
          normal[index * 3 + 2] = numAttr(element, 'z', 0);
        } else if (name === 'colour_diffuse' || name === 'color_diffuse') {
          hasColour = true;
          const v = (attr(element, 'value') ?? '').trim().split(/\s+/).map(Number);
          for (let k = 0; k < 4; k++) colour[index * 4 + k] = Number.isFinite(v[k]) ? v[k]! : 1;
        } else if (name === 'texcoord') {
          const set = (uvs[uv] ??= []);
          set[index * 2] = numAttr(element, 'u', 0);
          set[index * 2 + 1] = numAttr(element, 'v', 0);
          uv++;
        }
      }
      index++;
    }
  }
  const n = Math.max(count, index);
  vertices.count = n;
  const fill = (values: number[], size: number, fallback: number) => {
    const out = new Float32Array(n * size);
    for (let i = 0; i < out.length; i++) out[i] = values[i] ?? fallback;
    return out;
  };
  if (hasPosition) vertices.position = fill(position, 3, 0);
  if (hasNormal) vertices.normal = fill(normal, 3, 0);
  if (hasColour) vertices.colour = fill(colour, 4, 1);
  vertices.uvs = Array.from(uvs, (set) => fill(set ?? [], 2, 0));
  return vertices;
}

/** Reads an Ogre XML mesh (.mesh.xml). */
export function parseMeshXml(source: string): OgreMeshData {
  const root = parseXml(source);
  if (root.name.toLowerCase() !== 'mesh') throw new OgreMeshXmlError(`Not an Ogre XML mesh: the root element is <${root.name}>`);
  const warnings: string[] = [];
  const shared = child(root, 'sharedgeometry');
  const mesh: OgreMeshData = {
    version: 'xml',
    sharedVertices: shared ? readVertices(shared) : null,
    subMeshes: [],
    skeleton: null,
    bounds: null,
    warnings,
  };
  const list = child(root, 'submeshes');
  for (const element of list ? childrenNamed(list, 'submesh') : []) {
    const usesShared = boolAttr(element, 'usesharedvertices', false);
    const geometry = child(element, 'geometry');
    let vertices: OgreVertexData;
    if (usesShared || !geometry) {
      if (!mesh.sharedVertices) warnings.push(`Submesh ${mesh.subMeshes.length} uses shared vertices, but the mesh has none`);
      vertices = mesh.sharedVertices ?? emptyVertexData();
    } else {
      vertices = readVertices(geometry);
    }
    const operation = (attr(element, 'operationtype') ?? 'triangle_list').toLowerCase();
    const faces = child(element, 'faces');
    const indices: number[] = [];
    const strip = operation.endsWith('strip') || operation.endsWith('fan');
    for (const face of faces ? childrenNamed(faces, 'face') : []) {
      // In strips and fans, only the first face lists all of v1, v2 and v3.
      for (const key of ['v1', 'v2', 'v3']) {
        const v = attr(face, key);
        if (v !== undefined && v !== '') indices.push(Number(v));
        else if (!strip && key !== 'v3') indices.push(0);
      }
    }
    const textureAliases: Record<string, string> = {};
    const aliases = child(element, 'textures');
    for (const alias of aliases ? childrenNamed(aliases, 'texture') : []) {
      const name = attr(alias, 'alias');
      const texture = attr(alias, 'name');
      if (name && texture) textureAliases[name] = texture;
    }
    if (child(element, 'boneassignments')) warnings.push('Bone assignments were left out: skeletons and animations are not read');
    const wide = indices.some((i) => i > 0xffff) || vertices.count > 0xffff;
    const sub: OgreSubMesh = {
      name: String(mesh.subMeshes.length),
      material: attr(element, 'material') ?? '',
      sharedVertices: usesShared,
      vertices,
      operation: 'triangles',
      indices: indices.length ? (wide ? Uint32Array.from(indices) : Uint16Array.from(indices)) : null,
      textureAliases,
    };
    applyOperation(sub, operation);
    mesh.subMeshes.push(sub);
  }
  const names = child(root, 'submeshnames');
  for (const entry of names ? childrenNamed(names, 'submeshname') : []) {
    const sub = mesh.subMeshes[numAttr(entry, 'index', -1)];
    const name = attr(entry, 'name');
    if (sub && name) sub.name = name;
  }
  const skeleton = child(root, 'skeletonlink');
  if (skeleton) {
    mesh.skeleton = attr(skeleton, 'name') ?? null;
    if (mesh.skeleton) warnings.push(`The mesh is linked to skeleton ${mesh.skeleton}, which is not read; it is shown in its bind pose`);
  }
  if (child(root, 'boneassignments') && !warnings.some((w) => w.startsWith('Bone'))) {
    warnings.push('Bone assignments were left out: skeletons and animations are not read');
  }
  // Deduplicate warnings about bones.
  mesh.warnings = [...new Set(warnings)];
  return mesh;
}
