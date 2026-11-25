// Loads real Ogre files from Ogre's sample media (see samples/README.md).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { loadOgre, parseMesh, type OgreTextureLoader } from '../src/index.js';

const dir = fileURLToPath(new URL('./samples/', import.meta.url));
const read = (name: string) => ({ name, data: new Uint8Array(readFileSync(dir + name)) });

/** Records the textures asked for and gives each a 1 x 1 texture, as Node can't decode JPEG or PNG. */
function recordingLoader(): { loader: OgreTextureLoader; names: string[] } {
  const names: string[] = [];
  const loader: OgreTextureLoader = async (name) => {
    names.push(name);
    return new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  };
  return { loader, names };
}

const meshes = (group: THREE.Object3D) => {
  const out: THREE.Mesh[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
};

describe('Ogre sample media', () => {
  it('reads the binary meshes', () => {
    const cases: [string, number[], string[]][] = [
      ['robot.mesh', [924], ['Examples/Robot']],
      ['ninja.mesh', [2712, 312], ['Examples/Ninja', 'Examples/Ninja']],
      ['knot.mesh', [8640], ['2 - Default']],
      ['ogrehead.mesh', [246, 9534, 1200, 2028], ['Ogre/Eyes', 'Ogre/Skin', 'Ogre/Earring', 'Ogre/Tusks']],
    ];
    for (const [file, indices, materials] of cases) {
      const mesh = parseMesh(read(file).data);
      expect(mesh.version, file).toBe('MeshSerializer_v1.100');
      expect(mesh.subMeshes.map((s) => s.indices?.length), file).toEqual(indices);
      expect(mesh.subMeshes.map((s) => s.material), file).toEqual(materials);
      for (const sub of mesh.subMeshes) {
        const v = sub.vertices;
        expect(v.position!.length, file).toBe(v.count * 3);
        expect(v.normal, file).not.toBeNull();
        expect(v.uvs, file).toHaveLength(1);
        expect(Array.from(v.position!).every(Number.isFinite), file).toBe(true);
        expect(Math.max(...sub.indices!), file).toBeLessThan(v.count);
      }
      // Every vertex lies in the bounds the mesh records.
      const b = mesh.bounds!;
      for (const sub of mesh.subMeshes) {
        const p = sub.vertices.position!;
        for (let i = 0; i < p.length; i++) {
          expect(p[i]!).toBeGreaterThanOrEqual(b.min[i % 3]! - 1e-3);
          expect(p[i]!).toBeLessThanOrEqual(b.max[i % 3]! + 1e-3);
        }
      }
    }
    expect(parseMesh(read('robot.mesh').data).skeleton).toBe('robot.skeleton');
  });

  it('loads the Ogre head with its materials and textures', async () => {
    const { loader, names } = recordingLoader();
    const result = await loadOgre(['ogrehead.mesh', 'Ogre.material', 'GreenSkin.jpg', 'spheremap.png', 'tusk.jpg'].map(read), {
      textureLoader: loader,
    });
    const parts = meshes(result.group);
    expect(parts.map((m) => m.name)).toEqual(['Ogre/Eyes', 'Ogre/Skin', 'Ogre/Earring', 'Ogre/Tusks']);
    const skin = parts[1]!.material as THREE.MeshStandardMaterial;
    expect(skin.name).toBe('Ogre/Skin');
    expect(skin.map?.name).toBe('GreenSkin.jpg');
    expect(skin.map?.wrapS).toBe(THREE.MirroredRepeatWrapping);
    expect((parts[3]!.material as THREE.MeshStandardMaterial).map?.name).toBe('tusk.jpg');
    // The earring's only texture is a sphere map, which isn't used.
    expect((parts[2]!.material as THREE.MeshStandardMaterial).map).toBeNull();
    expect(names.sort()).toEqual(['GreenSkin.jpg', 'tusk.jpg']);
    expect(result.missing).toEqual([]);
    expect(result.stats.triangles).toBe(4336);
  });

  it('loads Sinbad and his swords from the zip, decoding the TGA textures', async () => {
    const result = await loadOgre([read('Sinbad.zip')]);
    expect(result.stats).toMatchObject({ entities: 2, subMeshes: 11, triangles: 7934, textures: 3 });
    expect(result.missing).toEqual([]);
    const body = result.group.getObjectByName('Sinbad/Body') as THREE.Mesh;
    const material = body.material as THREE.MeshStandardMaterial;
    expect(material.map?.name).toBe('sinbad_body.tga');
    expect((material.map?.image as { width: number }).width).toBe(512);
    expect(material.map?.flipY).toBe(false);
    // About 9 units tall, standing around the origin.
    const size = new THREE.Box3().setFromObject(result.group).getSize(new THREE.Vector3());
    expect(size.y).toBeCloseTo(8.93, 1);
    expect(result.warnings.some((w) => w.includes('Sinbad.skeleton'))).toBe(true);
  });

  it('loads several meshes with a shared script and reports their missing textures', async () => {
    const result = await loadOgre(['robot.mesh', 'ninja.mesh', 'knot.mesh', 'Examples.material'].map(read), { textureLoader: recordingLoader().loader });
    expect(result.group.children.map((c) => c.name)).toEqual(['robot', 'ninja', 'knot']);
    expect(result.missing.sort()).toEqual(['MtlPlat2.jpg', 'nskingr.jpg', 'r2skin.jpg']);
    expect(result.warnings.some((w) => w.includes('not found, so a plain white one'))).toBe(false);
  });
});
