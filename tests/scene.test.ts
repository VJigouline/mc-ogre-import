import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { loadOgre, loadOgreFromUrl, OgreImportError, parseDotScene, type OgreTextureLoader } from '../src/index.js';
import { binaryMesh, QUAD, zip } from './helpers.js';

const quadMesh = (material: string) =>
  binaryMesh({
    shared: {
      count: 4,
      elements: [
        { semantic: 1, type: 2, values: QUAD.positions },
        { semantic: 4, type: 2, values: QUAD.normals },
        { semantic: 7, type: 1, values: QUAD.uvs },
      ],
    },
    subMeshes: [{ material, shared: true, indices: QUAD.indices }],
  });

const twoPartMesh = () =>
  binaryMesh({
    shared: { count: 4, elements: [{ semantic: 1, type: 2, values: QUAD.positions }] },
    subMeshes: [
      { material: 'Brick', shared: true, indices: [0, 1, 2] },
      { material: 'Glass', shared: true, indices: [0, 2, 3] },
    ],
    names: ['wall', 'window'],
  });

const MATERIALS = `
material Brick
{
  technique { pass {
    diffuse 0.8 0.4 0.2
    specular 0.5 0.5 0.5 30
    texture_unit { texture brick.png }
    texture_unit normalmap { texture brick_normal.png }
  } }
}
material Glass
{
  technique { pass {
    diffuse 0.6 0.8 1 0.3
    scene_blend alpha_blend
    depth_write off
    cull_hardware none
  } }
}
material Sign
{
  technique { pass {
    lighting off
    texture_unit { texture sign.tga }
  } }
}`;

const SCENE = `<scene formatVersion="1.1" upAxis="y" unitsPerMeter="100">
  <environment>
    <colourAmbient r="0.2" g="0.2" b="0.2"/>
    <colourBackground r="0" g="0" b="0.1"/>
  </environment>
  <nodes>
    <node name="House">
      <position x="100" y="0" z="0"/>
      <rotation qx="0" qy="0.7071068" qz="0" qw="0.7071068"/>
      <scale x="2" y="2" z="2"/>
      <entity name="Walls" meshFile="house.mesh" castShadows="true"/>
      <node name="Sign">
        <entity name="Board" meshFile="quad.mesh" materialName="Sign"/>
      </node>
      <userData><property type="str" name="owner" data="me"/></userData>
    </node>
    <node name="Lamp">
      <position x="0" y="300" z="0"/>
      <light name="Bulb" type="point" powerScale="2">
        <colourDiffuse r="1" g="0.5" b="0.25"/>
        <lightAttenuation range="1000" constant="1" linear="0" quadratic="0.25"/>
      </light>
    </node>
    <node name="Sun">
      <light name="Sun" type="directional">
        <directionVector x="0" y="-1" z="0"/>
        <colourDiffuse r="1" g="1" b="1"/>
      </light>
    </node>
    <node name="Spot">
      <light name="Spot" type="spot">
        <normal x="1" y="0" z="0"/>
        <lightRange inner="0.5" outer="1" falloff="1"/>
      </light>
    </node>
    <node name="Cam">
      <camera name="Main" fov="0.8" aspectRatio="1.5"><clipping near="1" far="5000"/></camera>
    </node>
    <node name="Missing"><entity name="Ghost" meshFile="ghost.mesh"/></node>
  </nodes>
  <externals><item type="material"><file name="house.material"/></item></externals>
</scene>`;

/** Gives every texture a 1 x 1 data texture, so materials can be checked in Node. */
const stubTextures: OgreTextureLoader = async () => new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);

describe('dotScene', () => {
  it('reads nodes, entities, lights, cameras and the environment', () => {
    const scene = parseDotScene(SCENE);
    expect(scene.unitsPerMeter).toBe(100);
    expect(scene.ambient).toEqual([0.2, 0.2, 0.2]);
    expect(scene.background).toEqual([0, 0, 0.1]);
    expect(scene.roots.map((n) => n.name)).toEqual(['House', 'Lamp', 'Sun', 'Spot', 'Cam', 'Missing']);
    const house = scene.roots[0]!;
    expect(house.position).toEqual([100, 0, 0]);
    expect(house.scale).toEqual([2, 2, 2]);
    expect(house.rotation[1]).toBeCloseTo(0.7071068);
    expect(house.entities[0]).toMatchObject({ name: 'Walls', meshFile: 'house.mesh' });
    expect(house.children[0]!.entities[0]!.materialName).toBe('Sign');
    expect(house.userData).toEqual({ owner: 'me' });
    expect(scene.roots[1]!.lights[0]).toMatchObject({ type: 'point', powerScale: 2, attenuation: { range: 1000, quadratic: 0.25 } });
    expect(scene.roots[3]!.lights[0]!.direction).toEqual([1, 0, 0]);
    expect(scene.roots[4]!.cameras[0]).toMatchObject({ fov: 0.8, near: 1, far: 5000 });
    expect(scene.externals).toEqual([{ type: 'material', file: 'house.material' }]);
  });
});

describe('loadOgre', () => {
  const files = () => [
    { name: 'house.scene', data: SCENE },
    { name: 'models/house.mesh', data: twoPartMesh() },
    { name: 'models/quad.mesh', data: quadMesh('Brick') },
    { name: 'materials/house.material', data: MATERIALS },
    { name: 'textures/Brick.PNG', data: new Uint8Array([1]) },
    { name: 'textures/brick_normal.png', data: new Uint8Array([1]) },
    { name: 'textures/sign.tga', data: new Uint8Array([1]) },
  ];

  it('builds the scene with meshes, materials, textures, lights and cameras', async () => {
    const result = await loadOgre(files(), { textureLoader: stubTextures });
    const { group } = result;
    expect(group.name).toBe('house');
    expect(group.scale.x).toBeCloseTo(0.01);

    const house = group.getObjectByName('House')!;
    expect(house.position.x).toBe(100);
    expect(house.userData.owner).toBe('me');
    const walls = house.getObjectByName('Walls')!;
    expect(walls).toBeInstanceOf(THREE.Group);
    const [wall, window] = walls.children as THREE.Mesh[];
    expect(wall!.name).toBe('wall');
    expect(wall!.castShadow).toBe(true);
    // Submeshes share the mesh's vertices.
    expect(wall!.geometry.getAttribute('position')).toBe(window!.geometry.getAttribute('position'));
    expect(wall!.geometry.getAttribute('normal')).toBeDefined();

    const brick = wall!.material as THREE.MeshStandardMaterial;
    expect(brick).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(brick.name).toBe('Brick');
    expect(brick.color.getHexString(THREE.SRGBColorSpace)).toBe('cc6633');
    expect(brick.roughness).toBeCloseTo(Math.sqrt(2 / 32));
    expect(brick.map?.name).toBe('brick.png');
    expect(brick.map?.flipY).toBe(false);
    expect(brick.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(brick.normalMap?.name).toBe('brick_normal.png');
    expect(brick.normalScale.y).toBe(-1);

    const glass = window!.material as THREE.MeshStandardMaterial;
    expect(glass.transparent).toBe(true);
    expect(glass.opacity).toBeCloseTo(0.3);
    expect(glass.depthWrite).toBe(false);
    expect(glass.side).toBe(THREE.DoubleSide);

    const board = group.getObjectByName('Board') as THREE.Mesh;
    expect(board.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((board.material as THREE.MeshBasicMaterial).map?.name).toBe('sign.tga');

    const ambient = group.children.find((c) => c instanceof THREE.AmbientLight) as THREE.AmbientLight;
    expect(ambient.intensity).toBeCloseTo(Math.PI);
    const bulb = group.getObjectByName('Bulb') as THREE.PointLight;
    expect(bulb.decay).toBe(2);
    expect(bulb.distance).toBe(1000);
    expect(bulb.intensity).toBeCloseTo(2 * Math.PI * 4);
    const sun = group.getObjectByName('Sun')!.children[0] as THREE.DirectionalLight;
    expect(sun).toBeInstanceOf(THREE.DirectionalLight);
    expect(sun.target.position.toArray()).toEqual([0, -1, 0]);
    const spot = group.getObjectByName('Spot')!.children[0] as THREE.SpotLight;
    expect(spot.angle).toBeCloseTo(0.5);
    expect(spot.penumbra).toBeCloseTo(0.5);
    const camera = group.getObjectByName('Main') as THREE.PerspectiveCamera;
    expect(camera.fov).toBeCloseTo(THREE.MathUtils.radToDeg(0.8));

    expect(result.missing).toEqual(['ghost.mesh']);
    expect(result.warnings.some((w) => w.includes('ghost.mesh'))).toBe(true);
    expect(result.stats).toMatchObject({ entities: 2, subMeshes: 3, triangles: 4, lights: 3, cameras: 1, textures: 3 });
    expect([...result.meshes.keys()]).toEqual(["house.mesh", "quad.mesh"]);
  });

  it('opens loose meshes without a scene, with a plain material for missing ones', async () => {
    const result = await loadOgre([{ name: 'quad.mesh', data: quadMesh('Nowhere') }]);
    const mesh = result.group.children[0] as THREE.Mesh;
    expect(mesh.name).toBe('quad');
    expect((mesh.material as THREE.Material).name).toBe('Nowhere');
    expect(result.warnings).toContain('Material Nowhere was not found, so a plain white one is used');
  });

  it('reads files from a zip archive, stored or deflated', async () => {
    for (const deflate of [false, true]) {
      const archive = await zip(files(), deflate);
      const result = await loadOgre({ name: 'house.zip', data: archive }, { textureLoader: stubTextures, materialType: 'phong' });
      const wall = result.group.getObjectByName('wall') as THREE.Mesh;
      const material = wall.material as THREE.MeshPhongMaterial;
      expect(material).toBeInstanceOf(THREE.MeshPhongMaterial);
      expect(material.shininess).toBe(30);
      expect(material.map?.name).toBe('brick.png');
    }
  });

  it('fetches the files a scene refers to from beside its URL', async () => {
    const served = new Map<string, string | Uint8Array>(files().map((f) => [f.name.split('/').pop()!.toLowerCase(), f.data]));
    const requested: string[] = [];
    const fakeFetch = (async (input: URL) => {
      const name = decodeURIComponent(input.pathname.split('/').pop()!).toLowerCase();
      requested.push(name);
      const body = served.get(name);
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body as BodyInit);
    }) as unknown as typeof fetch;
    const result = await loadOgreFromUrl('https://example.test/models/house.scene', { fetch: fakeFetch, textures: false });
    expect(requested).toContain('house.material');
    expect(((result.group.getObjectByName('wall') as THREE.Mesh).material as THREE.Material).name).toBe('Brick');
  });

  it('refuses a set of files with nothing to open', async () => {
    await expect(loadOgre([{ name: 'a.material', data: MATERIALS }])).rejects.toThrow(OgreImportError);
  });
});
