import type * as THREE from 'three';
import { parseDotScene, type OgreSceneData } from './dotscene.js';
import { OgreMaterialLibrary, type OgreMaterial } from './material.js';
import { isBinaryMesh, parseMesh } from './mesh-binary.js';
import { parseMeshXml } from './mesh-xml.js';
import type { OgreMeshData } from './mesh.js';
import { decodeText, extension, OgreResources, type OgreFile, type OgreResolver } from './resources.js';
import { OgreBuilder, type OgreBuildStats, type OgreThreeOptions } from './three.js';

export { parseMesh, isBinaryMesh, OgreMeshError } from './mesh-binary.js';
export { parseMeshXml, OgreMeshXmlError } from './mesh-xml.js';
export type { OgreMeshData, OgreSubMesh, OgreVertexData, OgreOperation } from './mesh.js';
export { parseMaterialScript, OgreMaterialLibrary, mainTechnique } from './material.js';
export type { OgreMaterial, OgreTechnique, OgrePass, OgreTextureUnit, OgreColour } from './material.js';
export { parseScript, ScriptRegistry } from './script.js';
export type { ScriptNode, ScriptObject, ScriptProperty } from './script.js';
export { parseDotScene, OgreSceneError } from './dotscene.js';
export type { OgreSceneData, OgreSceneNode, OgreEntity, OgreLight, OgreCamera, Vec3, Quat, Rgb } from './dotscene.js';
export { OgreResources } from './resources.js';
export type { OgreFile, OgreData, OgreResolver } from './resources.js';
export { OgreBuilder } from './three.js';
export type { OgreThreeOptions, OgreUserData, OgreBuildStats, OgreSource } from './three.js';
export { defaultTextureLoader, TextureFormatError } from './textures.js';
export type { OgreTextureLoader } from './textures.js';
export { readZip, isZip, ZipError } from './zip.js';
export type { ZipEntry } from './zip.js';
export { parseXml, XmlSyntaxError } from './xml.js';
export type { XmlElement } from './xml.js';

export interface OgreLoadOptions extends OgreThreeOptions {
  /**
   * The file to open: a .scene, .mesh or .mesh.xml file. By default, the first .scene file;
   * without one, every mesh file.
   */
  main?: string;
  /** Fetches resources that aren't among the files, such as from a server. */
  resolve?: OgreResolver;
}

export interface OgreLoadResult {
  /** The scene for three.js, in metres, Y up. */
  group: THREE.Group;
  /** The dotScene data, if a scene was opened. */
  scene: OgreSceneData | null;
  /** The meshes that were read, by file name. */
  meshes: Map<string, OgreMeshData>;
  /** The materials of every .material script. */
  materials: OgreMaterialLibrary;
  /** Files that were referred to but not found: meshes, textures and scripts. */
  missing: string[];
  /** Problems that didn't stop the import. */
  warnings: string[];
  stats: OgreBuildStats;
}

export class OgreImportError extends Error {
  override name = 'OgreImportError';
}

const MESH = ['mesh', 'mesh.xml'];

function readMeshFile(name: string, bytes: Uint8Array): OgreMeshData {
  if (isBinaryMesh(bytes)) return parseMesh(bytes);
  const text = decodeText(bytes);
  if (/^\s*</.test(text)) return parseMeshXml(text);
  throw new OgreImportError(`${name} is neither a binary nor an XML Ogre mesh`);
}

const stem = (file: string) => file.replace(/\\/g, '/').split('/').pop()!.replace(/\.(mesh\.xml|mesh|scene|xml)$/i, '');

/**
 * Reads an Ogre scene or meshes from a set of files: .scene, .mesh, .mesh.xml and .material
 * files and their textures, loose or in zip archives. Returns the model as a three.js group.
 */
export async function loadOgre(files: Iterable<OgreFile> | OgreFile, options: OgreLoadOptions = {}): Promise<OgreLoadResult> {
  const resources = await OgreResources.from(files, options.resolve);
  return loadFromResources(resources, options);
}

/**
 * Reads an Ogre scene or mesh from a URL. The files it refers to are fetched from beside it,
 * as are material scripts named in the scene, named after the scene or meshes, or after the
 * missing material itself.
 */
export async function loadOgreFromUrl(url: string | URL, options: OgreThreeOptions & { fetch?: typeof fetch } = {}): Promise<OgreLoadResult> {
  const get = options.fetch ?? fetch;
  const base = new URL(url, typeof location !== 'undefined' ? location.href : undefined);
  const resolve: OgreResolver = async (name) => {
    const response = await get(new URL(name, base));
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  };
  const name = decodeURIComponent(base.pathname.split('/').pop() ?? 'model');
  const data = await resolve(name);
  if (!data) throw new OgreImportError(`${base.href} could not be fetched`);
  const resources = await OgreResources.from([{ name, data }], resolve);
  return loadFromResources(resources, { ...options, main: name, resolve });
}

async function loadFromResources(resources: OgreResources, options: OgreLoadOptions): Promise<OgreLoadResult> {
  const warnings: string[] = [];
  const missing = new Set<string>();
  const library = new OgreMaterialLibrary();
  const scripts = new Set<string>();
  const tried = new Set<string>();

  async function addScript(name: string, required: boolean): Promise<boolean> {
    const key = name.toLowerCase();
    if (scripts.has(key) || tried.has(key)) return scripts.has(key);
    tried.add(key);
    const text = await resources.text(name);
    if (text === null) {
      if (required) missing.add(name);
      return false;
    }
    scripts.add(key);
    library.add(text, name);
    for (const imported of library.imports) await addScript(imported, true);
    return true;
  }

  for (const file of resources.withExtension('material')) await addScript(file, true);

  // The main file.
  let main = options.main ? resources.resolveName(options.main) ?? options.main : resources.withExtension('scene')[0];
  let scene: OgreSceneData | null = null;
  let meshFiles: string[] = [];
  if (main && extension(main) === 'scene') {
    const text = await resources.text(main);
    if (text === null) throw new OgreImportError(`${main} was not found`);
    scene = parseDotScene(text);
    warnings.push(...scene.warnings);
    for (const external of scene.externals) if (extension(external.file) === 'material' || external.type === 'material') await addScript(external.file, true);
    if (options.resolve) await addScript(`${stem(main)}.material`, false);
  } else if (main) {
    meshFiles = [main];
  } else {
    meshFiles = resources.names.filter((n) => MESH.includes(extension(n)));
    // A mesh given both as .mesh and .mesh.xml is read once, from the binary file.
    const binary = new Set(meshFiles.filter((n) => extension(n) === 'mesh').map((n) => stem(n).toLowerCase()));
    meshFiles = meshFiles.filter((n) => extension(n) === 'mesh' || !binary.has(stem(n).toLowerCase()));
    main = meshFiles[0];
  }
  if (!scene && !meshFiles.length) throw new OgreImportError('There is no .scene, .mesh or .mesh.xml file to open');

  const meshes = new Map<string, OgreMeshData>();
  const meshPromises = new Map<string, Promise<OgreMeshData | null>>();
  const readMesh = async (file: string): Promise<OgreMeshData | null> => {
    const candidates = [file, ...(extension(file) === 'mesh' ? [`${file}.xml`] : []), ...(extension(file) === 'mesh.xml' ? [file.slice(0, -4)] : [])];
    for (const candidate of candidates) {
      const bytes = await resources.bytes(candidate);
      if (!bytes) continue;
      try {
        const mesh = readMeshFile(candidate, bytes);
        meshes.set(file, mesh);
        for (const w of mesh.warnings) warnings.push(`${file}: ${w}`);
        if (options.resolve) await addScript(`${stem(file)}.material`, false);
        return mesh;
      } catch (error) {
        warnings.push(`${candidate} could not be read: ${(error as Error).message}`);
        return null;
      }
    }
    return null;
  };

  const builder = new OgreBuilder(
    {
      library,
      mesh: (file) => {
        const key = file.toLowerCase();
        let p = meshPromises.get(key);
        if (!p) {
          p = readMesh(file);
          meshPromises.set(key, p);
        }
        return p;
      },
      texture: (name) => resources.bytes(name),
      material: async (name, meshFile): Promise<OgreMaterial | null> => {
        if (!library.has(name) && options.resolve) {
          for (const script of [`${stem(meshFile)}.material`, `${name.replace(/[\\/:*?"<>|]/g, '_')}.material`]) {
            if ((await addScript(script, false)) && library.has(name)) break;
          }
        }
        return library.get(name);
      },
    },
    options,
  );

  const name = stem(main ?? 'Ogre');
  const group = scene ? await builder.buildScene(scene, name) : await builder.buildMeshes(meshFiles, name);
  for (const m of builder.missing) missing.add(m);
  warnings.push(...library.warnings, ...builder.warnings);
  return { group, scene, meshes, materials: library, missing: [...missing], warnings: [...new Set(warnings)], stats: builder.stats };
}
