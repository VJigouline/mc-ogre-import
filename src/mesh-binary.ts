// Reads binary Ogre .mesh files (MeshSerializer v1.30 to v1.100, as written by Ogre 1.x), in
// either byte order. Each chunk is a 16-bit id and a 32-bit length that includes the 6-byte
// header. Like Ogre's own reader, nested chunks are read in sequence, and chunks that aren't
// needed (LODs, edge lists, poses, animations) are skipped by length.

import { emptyVertexData, toList, type OgreMeshData, type OgreOperation, type OgreSubMesh, type OgreVertexData } from './mesh.js';

export const CHUNK = {
  HEADER: 0x1000,
  MESH: 0x3000,
  SUBMESH: 0x4000,
  SUBMESH_OPERATION: 0x4010,
  SUBMESH_BONE_ASSIGNMENT: 0x4100,
  SUBMESH_TEXTURE_ALIAS: 0x4200,
  GEOMETRY: 0x5000,
  GEOMETRY_VERTEX_DECLARATION: 0x5100,
  GEOMETRY_VERTEX_ELEMENT: 0x5110,
  GEOMETRY_VERTEX_BUFFER: 0x5200,
  GEOMETRY_VERTEX_BUFFER_DATA: 0x5210,
  MESH_SKELETON_LINK: 0x6000,
  MESH_BONE_ASSIGNMENT: 0x7000,
  MESH_LOD_LEVEL: 0x8000,
  MESH_BOUNDS: 0x9000,
  SUBMESH_NAME_TABLE: 0xa000,
  SUBMESH_NAME_TABLE_ELEMENT: 0xa100,
  EDGE_LISTS: 0xb000,
  POSES: 0xc000,
  ANIMATIONS: 0xd000,
  TABLE_EXTREMES: 0xe000,
} as const;

const MESH_LEVEL = new Set<number>([
  CHUNK.GEOMETRY, CHUNK.SUBMESH, CHUNK.MESH_SKELETON_LINK, CHUNK.MESH_BONE_ASSIGNMENT, CHUNK.MESH_LOD_LEVEL,
  CHUNK.MESH_BOUNDS, CHUNK.SUBMESH_NAME_TABLE, CHUNK.EDGE_LISTS, CHUNK.POSES, CHUNK.ANIMATIONS, CHUNK.TABLE_EXTREMES,
]);

/** Vertex element semantics (VertexElementSemantic). */
const SEMANTIC = { POSITION: 1, BLEND_WEIGHTS: 2, BLEND_INDICES: 3, NORMAL: 4, DIFFUSE: 5, SPECULAR: 6, TEXCOORD: 7, BINORMAL: 8, TANGENT: 9 };

/** Operation types (RenderOperation::OperationType). */
const OPERATION: Record<number, string> = { 1: 'point_list', 2: 'line_list', 3: 'line_strip', 4: 'triangle_list', 5: 'triangle_strip', 6: 'triangle_fan' };

export class OgreMeshError extends Error {
  override name = 'OgreMeshError';
}

/** True if the bytes start like a binary Ogre mesh. */
export function isBinaryMesh(bytes: Uint8Array): boolean {
  if (bytes.length < 3) return false;
  const le = bytes[0]! | (bytes[1]! << 8);
  return (le === CHUNK.HEADER || le === 0x0010) && bytes[2] === 0x5b; // '['
}

class Reader {
  readonly view: DataView;
  pos = 0;
  constructor(readonly bytes: Uint8Array, public le: boolean) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }
  need(n: number): void {
    if (this.pos + n > this.bytes.length) throw new OgreMeshError(`Unexpected end of file at byte ${this.pos}`);
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, this.le);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, this.le);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, this.le);
    this.pos += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, this.le);
    this.pos += 4;
    return v;
  }
  string(): string {
    let end = this.pos;
    while (end < this.bytes.length && this.bytes[end] !== 0x0a) end++;
    const s = new TextDecoder().decode(this.bytes.subarray(this.pos, end));
    this.pos = Math.min(end + 1, this.bytes.length);
    return s;
  }
  /** Reads a chunk header and returns its id, length and start; null at the end of the data. */
  chunk(): { id: number; length: number; start: number } | null {
    if (this.pos + 6 > this.bytes.length) return null;
    const start = this.pos;
    const id = this.u16();
    const length = this.u32();
    return { id, length, start };
  }
  back(): void {
    this.pos -= 6;
  }
}

interface VertexElement {
  source: number;
  type: number;
  semantic: number;
  offset: number;
  index: number;
}

/** Component count and byte size of each vertex element type (VertexElementType). */
function typeInfo(type: number): { count: number; size: number } | null {
  if (type <= 3) return { count: type + 1, size: 4 * (type + 1) };
  if (type === 4 || type === 9 || type === 10 || type === 11 || (type >= 28 && type <= 30)) return { count: 4, size: 4 };
  if (type >= 5 && type <= 8) return { count: type - 4, size: 2 * (type - 4) };
  if (type >= 12 && type <= 15) return { count: type - 11, size: 8 * (type - 11) };
  if (type >= 16 && type <= 19) return { count: type - 15, size: 2 * (type - 15) };
  if (type >= 20 && type <= 23) return { count: type - 19, size: 4 * (type - 19) };
  if (type >= 24 && type <= 27) return { count: type - 23, size: 4 * (type - 23) };
  if (type === 31 || type === 33) return { count: 2, size: 4 };
  if (type === 32 || type === 34) return { count: 4, size: 8 };
  if (type === 35) return { count: 4, size: 4 };
  if (type >= 36 && type <= 39) return { count: type - 35, size: 2 * (type - 35) };
  return null;
}

function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/** Reads one element of one vertex as numbers; colours come out as r, g, b, a from 0 to 1. */
function readElement(view: DataView, at: number, type: number, le: boolean, out: number[]): void {
  out.length = 0;
  const info = typeInfo(type)!;
  const n = info.count;
  if (type <= 3) for (let i = 0; i < n; i++) out.push(view.getFloat32(at + 4 * i, le));
  else if (type === 4 || type === 10 || type === 11) {
    const v = view.getUint32(at, le);
    const a = (v >>> 24) / 255;
    const hi = ((v >>> 16) & 255) / 255;
    const mid = ((v >>> 8) & 255) / 255;
    const lo = (v & 255) / 255;
    // ARGB packs red high; ABGR (and the old platform colour, as on GL) packs red low.
    if (type === 10) out.push(hi, mid, lo, a);
    else out.push(lo, mid, hi, a);
  } else if (type >= 5 && type <= 8) for (let i = 0; i < n; i++) out.push(view.getInt16(at + 2 * i, le));
  else if (type === 9) for (let i = 0; i < 4; i++) out.push(view.getUint8(at + i));
  else if (type >= 12 && type <= 15) for (let i = 0; i < n; i++) out.push(view.getFloat64(at + 8 * i, le));
  else if (type >= 16 && type <= 19) for (let i = 0; i < n; i++) out.push(view.getUint16(at + 2 * i, le));
  else if (type >= 20 && type <= 23) for (let i = 0; i < n; i++) out.push(view.getInt32(at + 4 * i, le));
  else if (type >= 24 && type <= 27) for (let i = 0; i < n; i++) out.push(view.getUint32(at + 4 * i, le));
  else if (type === 28) for (let i = 0; i < 4; i++) out.push(view.getInt8(at + i));
  else if (type === 29) for (let i = 0; i < 4; i++) out.push(Math.max(-1, view.getInt8(at + i) / 127));
  else if (type === 30) for (let i = 0; i < 4; i++) out.push(view.getUint8(at + i) / 255);
  else if (type === 31 || type === 32) for (let i = 0; i < n; i++) out.push(Math.max(-1, view.getInt16(at + 2 * i, le) / 32767));
  else if (type === 33 || type === 34) for (let i = 0; i < n; i++) out.push(view.getUint16(at + 2 * i, le) / 65535);
  else if (type === 35) {
    const v = view.getUint32(at, le);
    const s10 = (x: number) => Math.max(-1, ((x << 22) >> 22) / 511);
    out.push(s10(v & 0x3ff), s10((v >>> 10) & 0x3ff), s10((v >>> 20) & 0x3ff), Math.max(-1, ((v >> 30) << 0) / 1));
  } else for (let i = 0; i < n; i++) out.push(half(view.getUint16(at + 2 * i, le)));
}

const isColourType = (type: number) => type === 4 || type === 10 || type === 11;

function readGeometry(r: Reader, warnings: string[]): OgreVertexData {
  const count = r.u32();
  const elements: VertexElement[] = [];
  const buffers = new Map<number, { size: number; data: Uint8Array }>();
  for (;;) {
    const c = r.chunk();
    if (!c) break;
    if (c.id === CHUNK.GEOMETRY_VERTEX_DECLARATION) {
      for (;;) {
        const e = r.chunk();
        if (!e) break;
        if (e.id !== CHUNK.GEOMETRY_VERTEX_ELEMENT) {
          r.back();
          break;
        }
        elements.push({ source: r.u16(), type: r.u16(), semantic: r.u16(), offset: r.u16(), index: r.u16() });
      }
    } else if (c.id === CHUNK.GEOMETRY_VERTEX_BUFFER) {
      const bind = r.u16();
      const size = r.u16();
      const d = r.chunk();
      if (!d || d.id !== CHUNK.GEOMETRY_VERTEX_BUFFER_DATA) throw new OgreMeshError('Vertex buffer without data');
      r.need(count * size);
      buffers.set(bind, { size, data: r.bytes.subarray(r.pos, r.pos + count * size) });
      r.pos += count * size;
    } else {
      r.back();
      break;
    }
  }

  const vertices = emptyVertexData(count);
  const value: number[] = [];
  const uvs: Float32Array[] = [];
  for (const element of elements) {
    const info = typeInfo(element.type);
    const buffer = buffers.get(element.source);
    if (!info) {
      warnings.push(`Vertex element type ${element.type} is not supported, so it was left out`);
      continue;
    }
    if (!buffer) {
      warnings.push(`Vertex element refers to missing buffer ${element.source}`);
      continue;
    }
    const view = new DataView(buffer.data.buffer, buffer.data.byteOffset, buffer.data.byteLength);
    const read = (components: number, fill = 0): Float32Array => {
      const out = new Float32Array(count * components);
      for (let v = 0; v < count; v++) {
        readElement(view, v * buffer.size + element.offset, element.type, r.le, value);
        for (let k = 0; k < components; k++) out[v * components + k] = value[k] ?? fill;
      }
      return out;
    };
    switch (element.semantic) {
      case SEMANTIC.POSITION:
        vertices.position = read(3);
        break;
      case SEMANTIC.NORMAL:
        vertices.normal = read(3);
        break;
      case SEMANTIC.DIFFUSE: {
        // Colours in a plain float or byte format are already r, g, b, a.
        const rgba = read(4, 1);
        if (!isColourType(element.type) && element.type === 9) for (let k = 0; k < rgba.length; k++) rgba[k]! /= 255;
        vertices.colour = rgba;
        break;
      }
      case SEMANTIC.TEXCOORD:
        uvs[element.index] = read(2);
        break;
      default:
        // Blend weights and indices, specular colours, tangents and binormals aren't used.
        break;
    }
  }
  vertices.uvs = Array.from(uvs, (uv) => uv ?? new Float32Array(count * 2));
  return vertices;
}

/** Reads a binary Ogre .mesh file. */
export function parseMesh(input: ArrayBuffer | Uint8Array): OgreMeshData {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isBinaryMesh(bytes)) throw new OgreMeshError('Not a binary Ogre mesh: it lacks the MeshSerializer header');
  const le = (bytes[0]! | (bytes[1]! << 8)) === CHUNK.HEADER;
  const r = new Reader(bytes, le);
  r.pos = 2;
  const version = r.string().replace(/^\[|\]$/g, '');
  if (/_v2\./.test(version)) {
    throw new OgreMeshError(`${version} meshes are written by Ogre-Next and are not supported. Convert them to the Ogre 1.x format (v1.10 or v1.8) with OgreMeshTool -v1.`);
  }
  if (!/^MeshSerializer_v1\.(\d+)/.test(version)) throw new OgreMeshError(`Unknown mesh format ${version}`);
  const minor = Number(/v1\.(\d+)/.exec(version)![1]);
  if (minor < 30 && minor !== 8 && minor !== 10) {
    throw new OgreMeshError(`${version} is too old to read; convert the mesh with OgreMeshUpgrader`);
  }

  const warnings: string[] = [];
  const mesh: OgreMeshData = { version, sharedVertices: null, subMeshes: [], skeleton: null, bounds: null, warnings };
  const names = new Map<number, string>();
  const meshChunk = r.chunk();
  if (!meshChunk || meshChunk.id !== CHUNK.MESH) throw new OgreMeshError('The mesh file has no mesh');
  r.bool(); // skeletally animated

  let skippedBones = false;
  for (;;) {
    const c = r.chunk();
    if (!c) break;
    if (!MESH_LEVEL.has(c.id)) {
      warnings.push(`Stopped at unknown chunk 0x${c.id.toString(16)} at byte ${c.start}`);
      break;
    }
    switch (c.id) {
      case CHUNK.GEOMETRY:
        mesh.sharedVertices = readGeometry(r, warnings);
        break;
      case CHUNK.SUBMESH:
        mesh.subMeshes.push(readSubMesh(r, mesh, warnings));
        break;
      case CHUNK.MESH_SKELETON_LINK:
        mesh.skeleton = r.string();
        break;
      case CHUNK.MESH_BOUNDS: {
        const min: [number, number, number] = [r.f32(), r.f32(), r.f32()];
        const max: [number, number, number] = [r.f32(), r.f32(), r.f32()];
        mesh.bounds = { min, max, radius: r.f32() };
        break;
      }
      case CHUNK.SUBMESH_NAME_TABLE:
        for (;;) {
          const e = r.chunk();
          if (!e) break;
          if (e.id !== CHUNK.SUBMESH_NAME_TABLE_ELEMENT) {
            r.back();
            break;
          }
          const index = r.u16();
          names.set(index, r.string());
        }
        break;
      default:
        if (c.id === CHUNK.MESH_BONE_ASSIGNMENT) skippedBones = true;
        if (!skip(r, c)) {
          warnings.push(`Could not skip chunk 0x${c.id.toString(16)} at byte ${c.start}`);
          finish();
          return mesh;
        }
    }
  }
  if (skippedBones) warnings.push('Bone assignments were left out: skeletons and animations are not read');
  finish();
  return mesh;

  function finish() {
    mesh.subMeshes.forEach((sub, i) => {
      if (names.has(i)) sub.name = names.get(i)!;
    });
    if (mesh.skeleton) warnings.push(`The mesh is linked to skeleton ${mesh.skeleton}, which is not read; it is shown in its bind pose`);
  }
}

/** Skips a chunk by its length. Returns false if the length doesn't lead to a known chunk. */
function skip(r: Reader, c: { id: number; length: number; start: number }): boolean {
  const end = c.start + c.length;
  if (end === r.bytes.length) {
    r.pos = end;
    return true;
  }
  for (const at of [end, end + 6]) {
    if (at + 2 <= r.bytes.length) {
      const id = r.view.getUint16(at, r.le);
      if (MESH_LEVEL.has(id) || at === r.bytes.length) {
        r.pos = at;
        return true;
      }
    }
  }
  return false;
}

function readSubMesh(r: Reader, mesh: OgreMeshData, warnings: string[]): OgreSubMesh {
  const material = r.string();
  const shared = r.bool();
  const indexCount = r.u32();
  const wide = r.bool();
  let indices: Uint16Array | Uint32Array | null = null;
  if (indexCount > 0) {
    const size = wide ? 4 : 2;
    r.need(indexCount * size);
    indices = wide ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    for (let i = 0; i < indexCount; i++) indices[i] = wide ? r.u32() : r.u16();
  }
  let vertices: OgreVertexData | null = null;
  if (!shared) {
    const c = r.chunk();
    if (!c || c.id !== CHUNK.GEOMETRY) throw new OgreMeshError(`Submesh ${mesh.subMeshes.length} has no geometry`);
    vertices = readGeometry(r, warnings);
  }
  let operation = 'triangle_list';
  const textureAliases: Record<string, string> = {};
  let bones = false;
  for (;;) {
    const c = r.chunk();
    if (!c) break;
    if (c.id === CHUNK.SUBMESH_OPERATION) operation = OPERATION[r.u16()] ?? 'triangle_list';
    else if (c.id === CHUNK.SUBMESH_TEXTURE_ALIAS) {
      const alias = r.string();
      textureAliases[alias] = r.string();
    } else if (c.id === CHUNK.SUBMESH_BONE_ASSIGNMENT) {
      bones = true;
      r.pos += 10; // vertex index, bone index, weight
    } else {
      r.back();
      break;
    }
  }
  if (bones && !warnings.some((w) => w.startsWith('Bone assignments'))) {
    warnings.push('Bone assignments were left out: skeletons and animations are not read');
  }
  const sub: OgreSubMesh = {
    name: String(mesh.subMeshes.length),
    material,
    sharedVertices: shared,
    vertices: vertices ?? mesh.sharedVertices ?? emptyVertexData(),
    operation: 'triangles',
    indices,
    textureAliases,
  };
  if (shared && !mesh.sharedVertices) warnings.push(`Submesh ${sub.name} uses shared vertices that come before none`);
  applyOperation(sub, operation);
  return sub;
}

export function applyOperation(sub: OgreSubMesh, operation: string): void {
  let kind: OgreOperation = 'triangles';
  if (operation === 'point_list') kind = 'points';
  else if (operation === 'line_list') kind = 'lines';
  else if (operation === 'line_strip') {
    kind = 'lines';
    sub.indices = toList('line_strip', sub.indices, sub.vertices.count);
  } else if (operation === 'triangle_strip' || operation === 'triangle_fan') {
    sub.indices = toList(operation, sub.indices, sub.vertices.count);
  }
  sub.operation = kind;
}
