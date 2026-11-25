// Lists and inflates zip archives, as Ogre resource packs are often shipped, with the platform's
// DecompressionStream. Stored and deflated entries are supported, without encryption or zip64.

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  size: number;
  /** Inflates the entry. */
  read(): Promise<Uint8Array>;
}

export class ZipError extends Error {
  override name = 'ZipError';
}

/** True if the bytes start like a zip archive. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Lists the files in a zip archive. Directories are left out. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record is in the last 64 KiB plus 22 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a zip archive: no end of central directory');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (at === 0xffffffff) throw new ZipError('Zip64 archives are not supported');
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let k = 0; k < count; k++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new ZipError('Corrupt zip central directory');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, '/');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    entries.push({
      name,
      size,
      read: async () => {
        if (flags & 1) throw new ZipError(`${name} is encrypted`);
        if (view.getUint32(local, true) !== 0x04034b50) throw new ZipError(`Corrupt zip entry ${name}`);
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + compressed);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new ZipError(`${name} uses compression method ${method}, which is not supported`);
      },
    });
  }
  return entries;
}
