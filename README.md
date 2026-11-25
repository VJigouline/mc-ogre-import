# mc-ogre-import

An importer for [Ogre 3D](https://www.ogre3d.org/) resources into [three.js](https://threejs.org/), written in TypeScript with no other dependencies. It reads Ogre's meshes, material scripts and dotScene files and builds a three.js scene with meshes, materials, textures, lights and cameras. It was made for [SceneEditor](https://github.com/VJigouline/SceneEditor), and works in any three.js application.

```ts
import { loadOgre } from 'mc-ogre-import';

// The files the user dropped or chose: a .scene, its meshes, materials and textures, or a .zip of them.
const result = await loadOgre(files);
scene.add(result.group);            // THREE.Group, in metres, Y up
console.log(result.missing);        // files the scene refers to that weren't given
console.log(result.warnings);       // anything that couldn't be read
```

## What it reads

- **Meshes:**
  - Binary `.mesh` files from Ogre 1.x (MeshSerializer v1.30 to v1.100), in either byte order.
  - XML `.mesh.xml` files, as written by OgreXMLConverter, OgreMeshTool and blender2ogre.
  - Shared and per-submesh vertices, any number of vertex buffers, and 16- or 32-bit indices.
  - Positions, normals, diffuse vertex colours and up to four texture coordinate sets, in every vertex element format.
  - Triangle lists, strips and fans, lines and points.
  - Submesh names and texture aliases.
- **Materials** from `.material` scripts:
  - Inheritance between materials, and from abstract materials, techniques and passes, across scripts.
  - Variables (`set $name value`), `import` directives and `set_texture_alias`.
  - Pass colours (ambient, diffuse, specular and shininess, emissive), vertex colour tracking, `lighting off`, scene blending, depth settings, culling, alpha rejection, flat shading and wireframe.
  - Texture units with address modes, scale, scroll, rotation and texture coordinate sets.
  - RTSS normal maps and the metal-roughness lighting stage.
- **Scenes** from dotScene `.scene` files: the node tree with positions, rotations and scales; entities with their material overrides; point, directional and spot lights with their attenuation and cone; cameras; the ambient colour; and the units and up axis.
- **Textures:** PNG, JPEG, GIF, BMP, WebP and AVIF in browsers, and TGA and DDS anywhere.
- **Zip archives**, as Ogre resource packs are often shipped, alone or with other files.

Ogre finds resources by file name alone, so files are matched by name wherever they are in a folder or archive, ignoring case.

Skeletons and animations, LODs, particle systems, terrain and shader programs are not read. See [Formats and support](Documentation/Support.md) for the details and the limits.

## Install

The package is not on the npm registry. Install it from GitHub:

```sh
npm install github:VJigouline/mc-ogre-import
```

`three` (r160 or later) is a peer dependency. The package builds itself on install.

## Documentation

- [Getting started](Documentation/GettingStarted.md)
- [API](Documentation/API.md)
- [Formats and support](Documentation/Support.md)
- [Using it in SceneEditor](Documentation/SceneEditor.md)

## Development

```sh
npm install
npm test           # unit tests, with Vitest
npm run typecheck
npm run build      # dist/
```

The tests also load real files from Ogre's sample media, kept in [`tests/samples`](tests/samples/README.md) with their licences.

It needs Node.js 22 or later.

## Licence

[MIT](LICENSE)
