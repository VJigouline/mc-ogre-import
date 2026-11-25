// The set of files an Ogre scene is read from. Ogre finds resources by file name alone, wherever
// they are in a resource location, so names are matched by their last path part, ignoring case.

import { isZip, readZip } from './zip.js';

export type OgreData = string | ArrayBuffer | Uint8Array | Blob;

/** A file to read: a browser File, or a name with its contents. */
export type OgreFile = { name: string; data: OgreData } | (Blob & { name: string });

/** Fetches a resource that isn't among the files, such as from a server; returns null if there is none. */
export type OgreResolver = (name: string) => Promise<OgreData | null | undefined>;

const basename = (name: string) => name.replace(/\\/g, '/').split('/').pop()!.toLowerCase();

export function extension(name: string): string {
  const base = basename(name);
  if (base.endsWith('.mesh.xml')) return 'mesh.xml';
  if (base.endsWith('.scene.xml')) return 'scene';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

async function toBytes(data: OgreData): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/^﻿/, '');
}

interface Entry {
  name: string;
  load: () => Promise<Uint8Array>;
  bytes?: Promise<Uint8Array>;
}

export class OgreResources {
  private readonly entries: Entry[] = [];
  private readonly byPath = new Map<string, Entry>();
  private readonly byBase = new Map<string, Entry>();
  private readonly missing = new Set<string>();

  constructor(private readonly resolver?: OgreResolver) {}

  /** Adds files. Zip archives are opened and their files added in their place. */
  static async from(files: Iterable<OgreFile> | OgreFile, resolver?: OgreResolver): Promise<OgreResources> {
    const resources = new OgreResources(resolver);
    const list = Symbol.iterator in Object(files) && !(files instanceof Blob) ? [...(files as Iterable<OgreFile>)] : [files as OgreFile];
    for (const file of list) {
      const data = file instanceof Blob ? file : file.data;
      await resources.add(file.name, data);
    }
    return resources;
  }

  async add(name: string, data: OgreData): Promise<void> {
    const ext = extension(name);
    if (ext === 'zip' || (typeof data !== 'string' && ext !== 'mesh' && isZip(await toBytes(data)))) {
      for (const entry of readZip(await toBytes(data))) this.put(entry.name, entry.read);
      return;
    }
    this.put(name, () => toBytes(data));
  }

  private put(name: string, load: () => Promise<Uint8Array>): void {
    const entry: Entry = { name, load };
    this.entries.push(entry);
    this.byPath.set(name.replace(/\\/g, '/').toLowerCase(), entry);
    const base = basename(name);
    if (!this.byBase.has(base)) this.byBase.set(base, entry);
  }

  /** Names of the files, in the order they were added. */
  get names(): string[] {
    return this.entries.map((e) => e.name);
  }

  /** Files with the extension, such as "material" or "mesh.xml". */
  withExtension(ext: string): string[] {
    return this.names.filter((name) => extension(name) === ext);
  }

  private find(name: string): Entry | undefined {
    return this.byPath.get(name.replace(/\\/g, '/').toLowerCase()) ?? this.byBase.get(basename(name));
  }

  /** The name the file is known by, if it is among the files. */
  resolveName(name: string): string | undefined {
    return this.find(name)?.name;
  }

  /** The file's bytes, from the files or the resolver; null if neither has it. */
  async bytes(name: string): Promise<Uint8Array | null> {
    let entry = this.find(name);
    if (!entry && this.resolver && !this.missing.has(name.toLowerCase())) {
      const data = await this.resolver(name).catch(() => null);
      if (data == null) {
        this.missing.add(name.toLowerCase());
        return null;
      }
      this.put(name, () => toBytes(data));
      entry = this.find(name);
    }
    if (!entry) return null;
    entry.bytes ??= entry.load();
    return entry.bytes;
  }

  async text(name: string): Promise<string | null> {
    const bytes = await this.bytes(name);
    return bytes ? decodeText(bytes) : null;
  }
}
