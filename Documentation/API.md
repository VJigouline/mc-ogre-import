# API

## Loading

### `loadOgre(files, options?)`

Reads an Ogre scene or meshes from a set of files, and returns `Promise<OgreLoadResult>`.

`files` is a file or an iterable of files. Each is either:

- a browser `File`, or another `Blob` with a `name`, or
- `{ name, data }`, where `data` is a string, `ArrayBuffer`, `Uint8Array` or `Blob`.

Zip archives are opened, and their files are used as if they had been given one by one.

`options` is an `OgreLoadOptions`: every option of [`OgreThreeOptions`](#ogrethreeoptions), and these:

| Option | Meaning |
| --- | --- |
| `main` | The file to open: a `.scene`, `.mesh` or `.mesh.xml` file. By default, the first `.scene` file; without one, every mesh. |
| `resolve` | `(name) => Promise<data \| null>`. It fetches files that aren't among `files`. |

It throws `OgreImportError` if there's nothing to open. It throws the parser's error if the main file can't be read. Problems with other files become warnings.

### `loadOgreFromUrl(url, options?)`

Fetches a `.scene`, `.mesh` or `.mesh.xml` file, then the files it refers to from the same folder. It also tries to fetch the material scripts that the [getting started guide](GettingStarted.md#open-a-scene-from-a-url) lists. It takes the [`OgreThreeOptions`](#ogrethreeoptions), and `fetch` to use instead of the global `fetch`.

### `OgreLoadResult`

| Field | Type | Meaning |
| --- | --- | --- |
| `group` | `THREE.Group` | The model, in metres with Y up. |
| `scene` | `OgreSceneData \| null` | The dotScene data, if a scene was opened. |
| `meshes` | `Map<string, OgreMeshData>` | The meshes that were read, by the file name they were referred to by. |
| `materials` | `OgreMaterialLibrary` | The materials of every script that was read. |
| `missing` | `string[]` | Meshes, textures and scripts that were referred to but not found. |
| `warnings` | `string[]` | Problems that didn't stop the import. |
| `stats` | `OgreBuildStats` | Counts: `entities`, `subMeshes`, `triangles`, `materials`, `textures`, `lights` and `cameras`. |

### `OgreThreeOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `materialType` | `'standard'` | `'standard'` makes `MeshStandardMaterial`, with roughness from the shininess. `'phong'` makes `MeshPhongMaterial`, which keeps Ogre's specular colour and shininess. |
| `lightIntensity` | `Math.PI` | Multiplies every light's intensity. |
| `ambientLight` | `true` | Adds the scene's ambient colour as an `AmbientLight`. |
| `cameras` | `true` | Adds the scene's cameras. |
| `unitsPerMeter` | the scene's | Ogre units per metre. The group is scaled by its inverse. |
| `textures` | `true` | Loads textures. |
| `textureLoader` | `defaultTextureLoader` | `(name, bytes) => Promise<THREE.Texture \| null>`. Decodes a texture file. |

### `OgreUserData`

Each object the importer makes has `userData.ogre`, with these fields:

| Field | Meaning |
| --- | --- |
| `kind` | `scene`, `node`, `entity`, `submesh`, `light` or `camera`. |
| `name` | The Ogre name. |
| `meshFile` | Set on entities and submeshes. |
| `subMesh` | Set on submeshes. |
| `material` | Set on submeshes. |

Materials have `userData.ogre = { material, file }`.

## Readers

These return plain data and use no three.js.

### `parseMesh(bytes)` → `OgreMeshData`

Reads a binary `.mesh` file. It throws `OgreMeshError` for:

- files that aren't Ogre meshes,
- Ogre-Next (v2) meshes,
- meshes older than v1.30.

`isBinaryMesh(bytes)` tells whether bytes start like a binary mesh.

### `parseMeshXml(text)` → `OgreMeshData`

Reads a `.mesh.xml` file. It throws `OgreMeshXmlError` or `XmlSyntaxError`.

### `OgreMeshData`

| Field | Meaning |
| --- | --- |
| `version` | Such as `MeshSerializer_v1.100`, or `xml`. |
| `sharedVertices` | `OgreVertexData \| null`. |
| `subMeshes` | `OgreSubMesh[]`. |
| `skeleton` | The linked skeleton's file name, or null. |
| `bounds` | `{ min, max, radius }`, or null. |
| `warnings` | `string[]`. |

`OgreSubMesh` has these fields:

| Field | Meaning |
| --- | --- |
| `name` | The submesh's name. |
| `material` | The material's name. |
| `sharedVertices` | True if it uses the mesh's shared vertices. |
| `vertices` | The vertices it uses: the mesh's shared vertices or its own. |
| `operation` | `'triangles'`, `'lines'` or `'points'`. Strips and fans are converted to lists. |
| `indices` | `Uint16Array \| Uint32Array \| null`. |
| `textureAliases` | Texture aliases, from alias to texture. |

`OgreVertexData` has `count`, `position`, `normal`, `colour` (RGBA, 0 to 1, sRGB) and `uvs`, an array of texture coordinate sets.

### `parseMaterialScript(text, file?)` → `OgreMaterial[]`

Reads the materials of one script. For materials that inherit from another script, use `OgreMaterialLibrary`:

```ts
const library = new OgreMaterialLibrary();
library.add(baseScript, 'base.material');
library.add(script, 'house.material');
const brick = library.get('Brick');    // OgreMaterial | null
```

| Member | Meaning |
| --- | --- |
| `add(text, file?)` | Adds a script and returns the names of its materials. |
| `get(name)` | The material, with inheritance and variables resolved. The name is matched with its case, or without it if there's no exact match. |
| `has(name)` | Whether the library has that material. |
| `names` | Every material's name. |
| `imports` | Scripts named by `import` directives. |
| `warnings` | Problems the library found. |

`mainTechnique(material)` returns the technique Ogre would normally use: the first in the Default scheme at LOD 0.

An `OgreMaterial` has `name`, `file`, `receiveShadows`, `textureAliases` and `techniques`. Each `OgreTechnique` has `name`, `scheme`, `lodIndex` and `passes`.

Each `OgrePass` holds the pass's settings, with Ogre's defaults for anything the script leaves out:

- **Colours:** `ambient`, `diffuse`, `specular`, `shininess` and `emissive`. Each colour is an `OgreColour` `[r, g, b, a]` or `'vertexcolour'`.
- **Blending and depth:** `sceneBlend`, `depthWrite`, `depthCheck`, `colourWrite`, `cullHardware`, `alphaRejection`.
- **Lighting and drawing:** `lighting`, `shading`, `polygonMode`.
- **Textures:** `textureUnits`.
- **Shaders:** `vertexProgram`, `fragmentProgram`, and from the RTSS, `normalMap` and `metalRoughness`.

Each `OgreTextureUnit` has these fields:

- **Texture:** `name`, `alias`, `texture`, `type` and `contentType`.
- **Sampling:** `addressMode` and `texCoordSet`.
- **Combining:** `colourOp` and `manualColour`.
- **Transform:** `scale`, `scroll` and `rotate`.
- **Environment map:** `envMap`.

`parseScript(text)` and `ScriptRegistry` give the script tree itself: objects with `type`, `name`, `parent` and `children`, and properties with `name` and `values`.

### `parseDotScene(text)` → `OgreSceneData`

Reads a `.scene` file. It throws `OgreSceneError` or `XmlSyntaxError`.

| Field | Meaning |
| --- | --- |
| `upAxis` | `'y'` or `'z'`. |
| `unitsPerMeter` | Ogre units per metre. |
| `ambient`, `background` | `[r, g, b]` or null. |
| `fog` | `{ mode, start, end, density, colour }` or null. |
| `roots` | `OgreSceneNode[]`. |
| `externals` | `{ type, file }[]`. |
| `warnings` | `string[]`. |

An `OgreSceneNode` has these fields:

- **Transform:** `name`, `position`, `rotation` (a quaternion: x, y, z, w), `scale` and `visible`.
- **Contents:** `entities`, `lights`, `cameras` and `children`.
- **Properties:** `userData`.

`OgreEntity`, `OgreLight` and `OgreCamera` hold what the scene says about each. Angles are in radians.

## Building three.js objects yourself

`OgreBuilder` turns the readers' data into three.js objects. It takes an `OgreSource`, which supplies meshes, textures and materials by name, and the `OgreThreeOptions`. Its main methods are these:

- `buildScene(sceneData, name)`
- `buildMeshes(files, name)`
- `buildEntity(entity)`
- `buildLight(light)`
- `buildCamera(camera)`

`loadOgre` is a thin layer over it.

## Utilities

| Export | Meaning |
| --- | --- |
| `OgreResources` | A set of files looked up by name the way Ogre does, by file name ignoring case. |
| `readZip(bytes)`, `isZip(bytes)` | List and inflate zip archives (stored and deflated entries). |
| `defaultTextureLoader` | The default texture decoder. |
| `parseXml(text)` | The small XML reader the package uses. |
