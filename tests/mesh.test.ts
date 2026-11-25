import { describe, expect, it } from 'vitest';
import { isBinaryMesh, OgreMeshError, parseMesh, parseMeshXml } from '../src/index.js';
import { binaryMesh, QUAD } from './helpers.js';

const POSITION = 1;
const NORMAL = 4;
const DIFFUSE = 5;
const TEXCOORD = 7;
const FLOAT2 = 1;
const FLOAT3 = 2;

const quadElements = [
  { semantic: POSITION, type: FLOAT3, values: QUAD.positions },
  { semantic: NORMAL, type: FLOAT3, values: QUAD.normals },
  { semantic: TEXCOORD, type: FLOAT2, values: QUAD.uvs },
];

describe('binary meshes', () => {
  it('reads shared geometry, submeshes, names, bounds and the skeleton link', () => {
    const bytes = binaryMesh({
      shared: { count: 4, elements: quadElements },
      subMeshes: [
        { material: 'Red', shared: true, indices: [0, 1, 2] },
        { material: 'Blue', shared: true, indices: [0, 2, 3], aliases: [['diffuseMap', 'blue.png']] },
      ],
      names: ['first', 'second'],
      skeleton: 'quad.skeleton',
      extraChunk: true,
    });
    expect(isBinaryMesh(bytes)).toBe(true);
    const mesh = parseMesh(bytes);
    expect(mesh.version).toBe('MeshSerializer_v1.100');
    expect(mesh.subMeshes.map((s) => [s.name, s.material])).toEqual([
      ['first', 'Red'],
      ['second', 'Blue'],
    ]);
    expect(mesh.subMeshes[0]!.vertices).toBe(mesh.sharedVertices);
    expect(Array.from(mesh.sharedVertices!.position!)).toEqual(QUAD.positions.flat());
    expect(Array.from(mesh.sharedVertices!.normal!)).toEqual(QUAD.normals.flat());
    expect(Array.from(mesh.sharedVertices!.uvs[0]!)).toEqual(QUAD.uvs.flat());
    expect(Array.from(mesh.subMeshes[1]!.indices!)).toEqual([0, 2, 3]);
    expect(mesh.subMeshes[1]!.textureAliases).toEqual({ diffuseMap: 'blue.png' });
    expect(mesh.bounds?.radius).toBeCloseTo(1.7);
    expect(mesh.skeleton).toBe('quad.skeleton');
    expect(mesh.warnings.some((w) => w.includes('bind pose'))).toBe(true);
  });

  it('reads big-endian meshes with their own vertices and 32-bit indices', () => {
    const bytes = binaryMesh({
      le: false,
      version: 'MeshSerializer_v1.8',
      subMeshes: [{ material: 'M', shared: false, wide: true, indices: QUAD.indices, vertices: { count: 4, elements: quadElements } }],
    });
    const mesh = parseMesh(bytes);
    expect(mesh.sharedVertices).toBeNull();
    const sub = mesh.subMeshes[0]!;
    expect(sub.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(sub.indices!)).toEqual(QUAD.indices);
    expect(Array.from(sub.vertices.position!)).toEqual(QUAD.positions.flat());
  });

  it('reads vertices from several buffers and packed colours', () => {
    const bytes = binaryMesh({
      subMeshes: [
        {
          material: 'M',
          shared: false,
          indices: [0, 1, 2],
          vertices: {
            count: 3,
            elements: [
              { semantic: POSITION, type: FLOAT3, values: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] },
              { semantic: DIFFUSE, type: 10, source: 1, values: [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 0.2]] },
              { semantic: TEXCOORD, type: FLOAT2, index: 1, source: 1, values: [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]] },
            ],
          },
        },
      ],
    });
    const v = parseMesh(bytes).subMeshes[0]!.vertices;
    expect(Array.from(v.colour!.slice(0, 8))).toEqual([1, 0, 0, 1, 0, 1, 0, 1]);
    expect(v.colour![11]).toBeCloseTo(0.2, 2);
    // Set 0 is missing, so it is filled with zeros to keep set 1 in place.
    expect(v.uvs).toHaveLength(2);
    expect(Array.from(v.uvs[1]!.slice(0, 2))).toEqual([0.5, 0.5]);
  });

  it('converts triangle strips and fans to lists', () => {
    const strip = parseMesh(
      binaryMesh({ shared: { count: 4, elements: quadElements }, subMeshes: [{ material: 'M', shared: true, indices: [0, 1, 3, 2], operation: 5 }] }),
    ).subMeshes[0]!;
    expect(Array.from(strip.indices!)).toEqual([0, 1, 3, 3, 1, 2]);
    const fan = parseMesh(
      binaryMesh({ shared: { count: 4, elements: quadElements }, subMeshes: [{ material: 'M', shared: true, indices: [0, 1, 2, 3], operation: 6 }] }),
    ).subMeshes[0]!;
    expect(Array.from(fan.indices!)).toEqual([0, 1, 2, 0, 2, 3]);
    const lines = parseMesh(
      binaryMesh({ shared: { count: 4, elements: quadElements }, subMeshes: [{ material: 'M', shared: true, indices: [0, 1, 2], operation: 3 }] }),
    ).subMeshes[0]!;
    expect(lines.operation).toBe('lines');
    expect(Array.from(lines.indices!)).toEqual([0, 1, 1, 2]);
  });

  it('notes bone assignments, which are not read', () => {
    const mesh = parseMesh(binaryMesh({ shared: { count: 4, elements: quadElements }, subMeshes: [{ material: 'M', shared: true, indices: QUAD.indices, bones: 4 }] }));
    expect(mesh.subMeshes[0]!.indices).toHaveLength(6);
    expect(mesh.warnings.some((w) => w.startsWith('Bone assignments'))).toBe(true);
  });

  it('refuses Ogre-Next meshes and other files', () => {
    expect(() => parseMesh(binaryMesh({ version: 'MeshSerializer_v2.1 R2', subMeshes: [] }))).toThrow(/Ogre-Next/);
    expect(() => parseMesh(new TextEncoder().encode('<mesh/>'))).toThrow(OgreMeshError);
  });
});

describe('XML meshes', () => {
  const xml = `<?xml version="1.0"?>
  <!-- exported -->
  <mesh>
    <sharedgeometry vertexcount="4">
      <vertexbuffer positions="true" normals="true">
        ${QUAD.positions.map((p) => `<vertex><position x="${p[0]}" y="${p[1]}" z="${p[2]}"/><normal x="0" y="0" z="1"/></vertex>`).join('\n')}
      </vertexbuffer>
      <vertexbuffer texture_coords="1" colours_diffuse="true">
        ${QUAD.uvs.map((uv) => `<vertex><texcoord u="${uv[0]}" v="${uv[1]}"/><colour_diffuse value="1 0.5 0 1"/></vertex>`).join('\n')}
      </vertexbuffer>
    </sharedgeometry>
    <submeshes>
      <submesh material="Quad/Front" usesharedvertices="true" use32bitindexes="false" operationtype="triangle_list">
        <faces count="2"><face v1="0" v2="1" v3="2"/><face v1="0" v2="2" v3="3"/></faces>
        <textures><texture alias="diffuseMap" name="front.png"/></textures>
      </submesh>
      <submesh material="Strip" usesharedvertices="false" operationtype="triangle_strip">
        <faces count="2"><face v1="0" v2="1" v3="2"/><face v1="3"/></faces>
        <geometry vertexcount="4"><vertexbuffer positions="true">
          ${QUAD.positions.map((p) => `<vertex><position x="${p[0]}" y="${p[1]}" z="${p[2]}"/></vertex>`).join('')}
        </vertexbuffer></geometry>
      </submesh>
    </submeshes>
    <skeletonlink name="quad.skeleton"/>
    <submeshnames><submeshname name="front" index="0"/></submeshnames>
  </mesh>`;

  it('reads vertices split over buffers, faces, aliases and names', () => {
    const mesh = parseMeshXml(xml);
    expect(mesh.version).toBe('xml');
    const [front, strip] = mesh.subMeshes;
    expect(front!.name).toBe('front');
    expect(front!.material).toBe('Quad/Front');
    expect(Array.from(front!.indices!)).toEqual(QUAD.indices);
    expect(Array.from(front!.vertices.uvs[0]!)).toEqual(QUAD.uvs.flat());
    expect(Array.from(front!.vertices.colour!.slice(0, 4))).toEqual([1, 0.5, 0, 1]);
    expect(front!.textureAliases).toEqual({ diffuseMap: 'front.png' });
    expect(strip!.name).toBe('1');
    expect(strip!.sharedVertices).toBe(false);
    expect(Array.from(strip!.indices!)).toEqual([0, 1, 2, 2, 1, 3]);
    expect(mesh.skeleton).toBe('quad.skeleton');
  });
});
