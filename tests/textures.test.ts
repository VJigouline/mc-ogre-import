import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { defaultTextureLoader, TextureFormatError } from '../src/index.js';

/** An uncompressed 2 x 1 true-colour TGA, stored top row first: red, then green. */
function tga(): Uint8Array {
  const header = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 24, 0x20];
  const pixels = [0, 0, 255, 0, 255, 0]; // BGR
  return Uint8Array.from([...header, ...pixels]);
}

describe('default texture loader', () => {
  it('decodes TGA without a DOM', async () => {
    const texture = (await defaultTextureLoader('red.tga', tga())) as THREE.DataTexture;
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    expect(texture.image.width).toBe(2);
    expect(Array.from((texture.image.data as Uint8Array).slice(0, 8))).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('refuses formats it has no decoder for', async () => {
    await expect(defaultTextureLoader('x.ktx2', new Uint8Array(4))).rejects.toThrow(TextureFormatError);
  });
});
