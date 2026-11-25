# Formats and support

## Meshes

### Binary `.mesh`

The reader handles meshes written by Ogre 1.x:

- **Versions:** MeshSerializer v1.30 (Ogre 1.0) to v1.100 (Ogre 1.10 and later).
- **Byte order:** little- and big-endian.
- **Chunks:** each is read in sequence, as Ogre's own reader does. Chunks that aren't needed are skipped by their length.

| Data | Support |
| --- | --- |
| Shared and per-submesh vertex data | Yes. Submeshes that share vertices share buffer attributes in three.js. |
| Vertex buffers | Any number, interleaved or not. |
| Vertex element formats | All Ogre 1.x formats: floats, doubles, signed and unsigned bytes, shorts and ints (normalised or not), packed colours (ARGB and ABGR), 10-10-10-2 and half floats. |
| Positions, normals | Yes. Missing normals are computed. |
| Diffuse vertex colours | Yes. They're converted from sRGB to linear. |
| Texture coordinates | Up to 4 sets. Only u and v are kept. |
| Tangents, binormals, specular colours | Not used. three.js derives tangents for normal maps. |
| Indices | 16- and 32-bit. |
| Operations | Triangle lists, strips and fans; line lists and strips; point lists. |
| Submesh names, texture aliases | Yes. |
| Bounds | Read into the data. |
| Skeleton link, bone assignments | The skeleton's name is recorded, with a warning. The mesh is shown in its bind pose. |
| LODs, edge lists, poses, animations, extremes | Skipped. |

Ogre-Next (Ogre 2.x) writes the MeshSerializer v2.1 format, which is not supported. Convert such meshes to the v1 format with Ogre-Next's OgreMeshTool, using `-v1`.

### XML `.mesh.xml`

The XML format holds the same data. It is read the same way, including vertices split over several `<vertexbuffer>` elements, `<submeshnames>` and `<textures>` aliases.

## Material scripts

### Script language

The reader follows Ogre's script compiler:

- **Syntax:** objects and properties, `//` and `/* */` comments, and quoted names with spaces.
- **Inheritance:** `material Child : Parent`, and objects that inherit from abstract objects, such as `technique : Base`. This works across scripts.
  - Child objects override the parent's objects of the same type: by name, or by position if they're unnamed.
  - Child properties are added after the parent's, so they win.
- **Variables:** `set $name value`, set in an object and used in it and its children.
- **Imports:** `import ... from "file.material"` fetches that file when it's missing and there's a resolver.
- **Texture aliases:** `set_texture_alias` on materials, and texture aliases from meshes.

### How a material is chosen

- **Technique:** the importer draws each material with its main technique, the first in the Default scheme at LOD 0.
- **Pass:** a three.js material is a single pass, so the first pass is used. If it has no textures, the first texture of a later pass is used.
- **Shaders:** vertex and fragment programs are not run. The pass's fixed-function settings are used, with a warning.

### Pass settings

| Pass setting | three.js |
| --- | --- |
| `diffuse` | `color`. Colours are converted from sRGB to linear. `vertexcolour` uses the vertex colours. |
| `specular`, `shininess` | Standard: `roughness = √(2 / (shininess + 2))`, or 1 if there's no specular colour; metalness 0. Phong: `specular` and `shininess`. |
| `emissive` | `emissive` |
| `ambient` | Not used. three.js lights ambient light with the material's colour. |
| `lighting off` | `MeshBasicMaterial`, white or vertex-coloured, as in Ogre. |
| `scene_blend` | `alpha_blend` sets `transparent`, with `opacity` from the diffuse alpha. `add` uses additive blending, `modulate` multiply blending, and `colour_blend` a custom blend. |
| `depth_write`, `depth_check`, `colour_write` | `depthWrite`, `depthTest`, `colorWrite` |
| `cull_hardware` | `clockwise` (the default) gives `FrontSide`, `anticlockwise` gives `BackSide` and `none` gives `DoubleSide`. |
| `alpha_rejection` | `alphaTest`, from the 0–255 value. |
| `shading flat`, `polygon_mode wireframe` | `flatShading`, `wireframe` |

### Texture units

Ogre's fixed-function texture units are layers, not named maps, so the importer guesses each unit's role from its name, its alias and the texture's file name:

| Name contains | Role |
| --- | --- |
| normal, nrm, norm, bump, or the file ends in `_n` | `normalMap` |
| spec, specular, gloss, or the file ends in `_s` | `specularMap`, with Phong materials only |
| emissive, emission, glow, illum | `emissiveMap` |
| ao, occlusion | `aoMap` |
| lightmap, baked; or a second colour unit with texture coordinate set 1 or more | `lightMap` |
| roughness, metallic, metalness, orm | `roughnessMap` and `metalnessMap` |
| anything else | `map`, for the first such unit |

Texture unit settings are converted as follows:

- **Address modes:** `wrap` becomes repeat wrapping and `mirror` mirrored repeat. `clamp` and `border` both become clamp to edge.
- **Transform:** `scale` sets the repeat (a scale of 2 makes the texture twice as large). `scroll` sets the offset and `rotate` the rotation.
- **Coordinates:** `tex_coord_set` selects the texture's UV channel.

Some units are not used:

- environment maps (`env_map`),
- cube maps,
- render-target and shadow units.

For `anim_texture`, the first frame is used.

Textures are not flipped (`flipY = false`), because Ogre's texture coordinates start at the top left, as glTF's do. As in three.js's glTF loader, normal maps have their green channel inverted (`normalScale.y = -1`), because three.js derives tangents from the screen.

### RTSS

The RTSS settings that change how a material looks are read:

- **`lighting_stage normal_map <texture>`:** gives `normalMap`.
- **`lighting_stage metal_roughness [texture <texture>]`:** roughness comes from the specular colour's green channel and metalness from its blue, as in the RTSS. The texture becomes the roughness and metalness map.

## dotScene

| Element | Support |
| --- | --- |
| `<scene upAxis unitsPerMeter>` | The group is rotated for a Z-up scene and scaled to metres. |
| `<environment>` | The ambient colour becomes an `AmbientLight`. The background and fog are returned in the scene data. |
| `<node>` | Position, rotation (quaternion, axis and angle, or Euler angles), scale, visibility and `<userData>` properties. |
| `<entity>` | `meshFile`, `materialName`, `<subentities>`, shadows and visibility. |
| `<light>` | See [Lights](#lights). |
| `<camera>` | Perspective or orthographic, with the field of view, aspect ratio and clipping planes. |
| `<externals>` | Material scripts are read or fetched. |
| `<particleSystem>`, `<billboardSet>`, `<plane>`, `<staticGeometry>`, terrain | Not read; each gives a warning. |

Lights and cameras directly inside `<nodes>`, or at the top of the scene, are put in nodes of their own.

## Lights

| Ogre | three.js |
| --- | --- |
| `point` | `PointLight` |
| `directional` | `DirectionalLight`, aimed along the light's direction by a target that is its child. |
| `spot` | `SpotLight`. Its `angle` is half the outer cone, and its `penumbra` is `1 - inner / outer`. |
| `rect` | `PointLight`, with a warning. |

Ogre attenuates light by `1 / (constant + linear·d + quadratic·d²)`. three.js attenuates it by `d^-decay`. The strongest term sets the `decay`:

- **Quadratic term:** decay 2, and intensity × 1/quadratic.
- **Linear term only:** decay 1, and intensity × 1/linear.
- **Constant term only:** no decay.

An Ogre range under 100 000 becomes the light's `distance`.

**Intensity:** in Ogre, a white light lights a white surface to full white. three.js's lighting divides diffuse light by π. So the importer multiplies intensities by π by default (`lightIntensity`), as well as by the light's `powerScale`. Set `lightIntensity` to 1 for three.js's physical units.

## Resources

- **Names:** files are found by name, ignoring case and folders, as Ogre does within a resource group. If two files have the same name, the first one given is used.
- **Mesh formats:** a mesh named `x.mesh` is also looked for as `x.mesh.xml`, and the other way round.
- **Archives:** zip archives can hold stored or deflated files. Encrypted and zip64 archives are not supported.
- **Textures:** the default loader decodes PNG, JPEG, GIF, BMP, WebP and AVIF with `createImageBitmap`, so only in browsers and workers. It decodes TGA and DDS with three.js's loaders, anywhere. Cube-map DDS files are not supported. For other formats such as KTX2, pass a `textureLoader`.
