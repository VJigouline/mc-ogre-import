# Getting started

## Install

```sh
npm install three github:VJigouline/mc-ogre-import
```

## Open files the user chooses

An Ogre scene is spread over several files: a `.scene` file, a `.mesh` or `.mesh.xml` file for each mesh, `.material` scripts and textures. Pass all of them to `loadOgre`, or a zip archive that holds them. Browser `File` objects can be passed as they are.

```ts
import * as THREE from 'three';
import { loadOgre } from 'mc-ogre-import';

const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
input.multiple = true;
input.accept = '.scene,.mesh,.xml,.material,.png,.jpg,.jpeg,.tga,.dds,.zip';

input.addEventListener('change', async () => {
  const result = await loadOgre(input.files!);
  scene.add(result.group);
  if (result.missing.length) console.warn('Not found:', result.missing);
  for (const warning of result.warnings) console.warn(warning);
});
```

What gets opened:

- **A scene:** the first `.scene` file, with the meshes, materials and textures it refers to.
- **Meshes:** without a `.scene` file, every mesh, each at the origin. If a mesh is given as both `.mesh` and `.mesh.xml`, the binary file is read.
- **A particular file:** name it with `main`, as in `loadOgre(files, { main: 'robot.mesh' })`.

Every `.material` script among the files is read, as Ogre makes all materials available to every mesh.

## Open a scene from a URL

`loadOgreFromUrl` fetches the scene or mesh, then each file it refers to from the same folder:

```ts
import { loadOgreFromUrl } from 'mc-ogre-import';

const result = await loadOgreFromUrl('/models/house/house.scene');
scene.add(result.group);
```

The material scripts aren't named in a mesh, so the loader tries these, in order:

1. Scripts listed in the scene's `<externals>`.
2. A script named after the scene: `house.material`.
3. A script named after each mesh: `walls.material` for `walls.mesh`.
4. A script named after a material that is still missing.

## Files from somewhere else

To fetch missing files your own way, pass `resolve`. It is asked for each file that isn't among the files given, and returns its contents or null:

```ts
const result = await loadOgre(files, {
  resolve: async (name) => {
    const response = await fetch(`/ogre-media/${name}`);
    return response.ok ? response.arrayBuffer() : null;
  },
});
```

## What you get

- **`group`:** a `THREE.Group` holding the model. Its scale and rotation convert from the scene's units and up axis to metres with Y up.
- **Inside the group:**
  - Each scene node is a `THREE.Group` with the node's name and transform.
  - Each entity is a `THREE.Mesh`. An entity with several submeshes is a group of meshes, one for each submesh.
  - Lights and cameras are children of their nodes.
- **`userData.ogre`** on each object records what it came from: its kind, name, mesh file, submesh and material. Node properties from the scene's `<userData>` are copied onto `userData`.
- **Materials** are `MeshStandardMaterial` by default, or `MeshBasicMaterial` for passes with `lighting off`. Meshes that use the same material share one material object.
- **Geometry:** submeshes that share an Ogre mesh's vertices share the same buffer attributes.

## Options

```ts
await loadOgre(files, {
  materialType: 'phong',   // MeshPhongMaterial, keeping Ogre's specular colour and shininess
  lightIntensity: Math.PI, // the default; see Support.md for why
  ambientLight: true,      // add the scene's ambient colour as an AmbientLight
  cameras: true,           // add the scene's cameras
  unitsPerMeter: 100,      // override the scene's units
  textures: true,          // load textures
});
```

To decode textures yourself, for example with an `ImageBitmapLoader` or a KTX2 loader, pass `textureLoader: async (name, bytes) => texture`. Return null for a texture you can't decode.

## Lower-level functions

The readers can be used on their own. They return plain data, with no three.js objects:

```ts
import { parseMesh, parseMeshXml, parseMaterialScript, parseDotScene } from 'mc-ogre-import';

const mesh = parseMesh(await file.arrayBuffer());   // OgreMeshData
const materials = parseMaterialScript(text);        // OgreMaterial[]
const sceneData = parseDotScene(xml);               // OgreSceneData
```

See the [API](API.md) for everything the package exports.
