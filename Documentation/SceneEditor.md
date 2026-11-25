# Using it in SceneEditor

[SceneEditor](https://github.com/VJigouline/SceneEditor) opens Ogre resources with mc-ogre-import. An Ogre model is several files, so give SceneEditor all of them at once, in one of these ways:

- **A folder:** drop the folder that holds the model on the view.
- **Several files:** drop them together, or choose them together with **Open files** on the Scene tab.
- **A zip archive:** drop or open one, as Ogre resource packs are often shipped.

The files are the `.scene`, `.mesh` or `.mesh.xml` files, `.material` scripts and textures. The Open dialog lists `.scene`, `.mesh`, `.xml`, `.material`, `.zip`, `.png`, `.jpg`, `.jpeg`, `.tga` and `.dds` files, besides the other model formats.

## What is opened

- **A scene:** a `.scene` file is opened with the meshes, materials and textures among the other files. The meshes beside it are not opened separately.
- **Meshes:** without a scene, each `.mesh` or `.mesh.xml` file is opened on its own, using the material scripts and textures beside it. A mesh given as both `.mesh` and `.mesh.xml` is opened once, from the binary file.
- **A zip:** a zip archive is opened with only the files inside it.

`ThreeSceneService.addOgreFile` passes the files to `loadOgre` and adds the resulting group to the scene, then refits the view.

## Errors and warnings

- **Failure messages:** a scene whose meshes are all missing shows a **Failure** message naming them, and so does a file that can't be read. The scene is unaffected.
- **Console warnings:** files that are not found, such as textures, go to the browser console. So does anything else that isn't read, such as skeletons.

## The model in the editor

- **Units and axes:** the model comes in metres with Y up, like the other formats. A scene's `unitsPerMeter` and `upAxis` are applied.
- **Structure:** scene nodes are nested groups. Entities with several submeshes are groups of meshes, named after the submeshes, or after their materials if the mesh doesn't name them.
- **Materials:** these are MeshStandardMaterials, so they can be edited and reassigned on the Materials tab like any other.
- **Lights:** a scene's lights are added with the model, besides SceneEditor's own lights.

## Tested models

These models from Ogre's sample media load and display correctly:

- **Sinbad:** from `Sinbad.zip`, with its sword, TGA textures and 11 materials.
- **The Ogre head:** `ogrehead.mesh`, with `Ogre.material` and its JPEG and PNG textures.
- **Robot, ninja and knot:** `robot.mesh`, `ninja.mesh` and `knot.mesh`, with `Examples.material`.
