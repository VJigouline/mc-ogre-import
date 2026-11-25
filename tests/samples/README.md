# Ogre sample media

Real Ogre files that [samples.test.ts](../samples.test.ts) loads, so the importer is checked against files written by Ogre's own tools as well as the test files built in code.

They come unchanged from [Samples/Media](https://github.com/OGRECave/ogre/tree/master/Samples/Media) in the Ogre repository, as of commit `a3514de49f` (25 November 2026).

| File | From | Licence |
| --- | --- | --- |
| `Sinbad.zip` | `packs/` | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), by Zi Ye. See `README.txt` inside the zip. |
| `ogrehead.mesh`, `robot.mesh`, `ninja.mesh`, `knot.mesh` | `models/` | Ogre's [MIT licence](https://github.com/OGRECave/ogre/blob/master/LICENSE), copyright Torus Knot Software Ltd. |
| `Ogre.material`, `Examples.material` | `materials/scripts/` | Ogre's MIT licence |
| `GreenSkin.jpg`, `spheremap.png`, `tusk.jpg` | `materials/textures/` | Ogre's MIT licence |

These files keep their own licences. They are test data only, and are not part of the npm package, which includes only `dist`, `Documentation`, `README.md` and `LICENSE`.

The robot, ninja and knot textures (`r2skin.jpg`, `nskingr.jpg`, `MtlPlat2.jpg`) are left out, so the tests also cover textures that are missing.
