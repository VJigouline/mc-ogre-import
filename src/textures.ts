// Default texture decoding: browser image formats with createImageBitmap, TGA and DDS with the
// three.js loaders. Ogre's texture coordinates start at the top left, as glTF's do, so textures
// are not flipped.

import * as THREE from 'three';
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';

/** Turns a texture file into a three.js texture; returns null if it can't. */
export type OgreTextureLoader = (name: string, data: Uint8Array) => Promise<THREE.Texture | null>;

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  avif: 'image/avif',
};

export class TextureFormatError extends Error {
  override name = 'TextureFormatError';
}

const arrayBuffer = (data: Uint8Array) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

/** Decodes PNG, JPEG, GIF, BMP, WebP and AVIF in browsers and workers, and TGA and DDS anywhere. */
export const defaultTextureLoader: OgreTextureLoader = async (name, data) => {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'tga') {
    const parsed = new TGALoader().parse(arrayBuffer(data)) as { data: Uint8Array; width: number; height: number };
    const texture = new THREE.DataTexture(parsed.data, parsed.width, parsed.height, THREE.RGBAFormat);
    texture.needsUpdate = true;
    return texture;
  }
  if (ext === 'dds') {
    const parsed = new DDSLoader().parse(arrayBuffer(data), true);
    if (parsed.isCubemap) throw new TextureFormatError('Cube map DDS textures are not supported');
    const texture = new THREE.CompressedTexture(parsed.mipmaps as unknown as ImageData[], parsed.width, parsed.height, parsed.format as THREE.CompressedPixelFormat);
    texture.minFilter = parsed.mipmapCount === 1 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    texture.needsUpdate = true;
    return texture;
  }
  const type = IMAGE_TYPES[ext];
  if (!type) throw new TextureFormatError(`.${ext} textures are not supported`);
  if (typeof createImageBitmap !== 'function') return null;
  const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type }), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement);
  texture.needsUpdate = true;
  return texture;
};
