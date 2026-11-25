// Plain mesh data read from Ogre .mesh and .mesh.xml files, before it becomes three.js geometry.

export interface OgreVertexData {
  count: number;
  /** x, y, z per vertex. */
  position: Float32Array | null;
  /** x, y, z per vertex. */
  normal: Float32Array | null;
  /** Diffuse vertex colour: r, g, b, a per vertex, 0 to 1, as stored (sRGB). */
  colour: Float32Array | null;
  /** Texture coordinate sets in order: u, v per vertex, with v down as in Ogre. */
  uvs: Float32Array[];
}

export type OgreOperation = 'points' | 'lines' | 'triangles';

export interface OgreSubMesh {
  /** Name from the submesh name table, or the submesh's index. */
  name: string;
  material: string;
  /** True if the submesh uses the mesh's shared vertices. */
  sharedVertices: boolean;
  /** The vertices it uses: the mesh's shared vertices or its own. */
  vertices: OgreVertexData;
  /** Strips and fans are converted to lists. */
  operation: OgreOperation;
  /** Vertex indices of the points, lines or triangles; null for vertices in order. */
  indices: Uint16Array | Uint32Array | null;
  /** Texture aliases for the material: alias name to texture name. */
  textureAliases: Record<string, string>;
}

export interface OgreMeshData {
  /** The serializer version, such as "MeshSerializer_v1.100", or "xml". */
  version: string;
  sharedVertices: OgreVertexData | null;
  subMeshes: OgreSubMesh[];
  /** The skeleton file the mesh is linked to, if any. Skeletons are not read. */
  skeleton: string | null;
  bounds: { min: [number, number, number]; max: [number, number, number]; radius: number } | null;
  /** Problems that didn't stop the import. */
  warnings: string[];
}

export function emptyVertexData(count = 0): OgreVertexData {
  return { count, position: null, normal: null, colour: null, uvs: [] };
}

/** Converts strip and fan indices to list indices. Returns sequential indices if `indices` is null. */
export function toList(kind: 'line_strip' | 'triangle_strip' | 'triangle_fan', indices: ArrayLike<number> | null, count: number): Uint32Array {
  const at = (i: number) => (indices ? indices[i]! : i);
  const n = indices ? indices.length : count;
  const out: number[] = [];
  if (kind === 'line_strip') {
    for (let i = 0; i + 1 < n; i++) out.push(at(i), at(i + 1));
  } else if (kind === 'triangle_strip') {
    for (let i = 0; i + 2 < n; i++) {
      // Every second triangle is flipped to keep the winding.
      if (i % 2 === 0) out.push(at(i), at(i + 1), at(i + 2));
      else out.push(at(i + 1), at(i), at(i + 2));
    }
  } else {
    for (let i = 1; i + 1 < n; i++) out.push(at(0), at(i), at(i + 1));
  }
  return Uint32Array.from(out);
}

export function sequential(count: number): Uint32Array {
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = i;
  return out;
}
