// Writes small binary Ogre meshes and zip archives for tests, following Ogre's MeshSerializer
// layout: chunks of a 16-bit id and a 32-bit length that includes the 6-byte header.

export class ChunkWriter {
  private parts: number[] = [];
  constructor(readonly le = true) {}
  u8(v: number) {
    this.parts.push(v & 255);
    return this;
  }
  bool(v: boolean) {
    return this.u8(v ? 1 : 0);
  }
  u16(v: number) {
    const b = new DataView(new ArrayBuffer(2));
    b.setUint16(0, v, this.le);
    this.parts.push(...new Uint8Array(b.buffer));
    return this;
  }
  u32(v: number) {
    const b = new DataView(new ArrayBuffer(4));
    b.setUint32(0, v, this.le);
    this.parts.push(...new Uint8Array(b.buffer));
    return this;
  }
  f32(v: number) {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, v, this.le);
    this.parts.push(...new Uint8Array(b.buffer));
    return this;
  }
  string(s: string) {
    this.parts.push(...new TextEncoder().encode(s), 0x0a);
    return this;
  }
  bytes(b: Uint8Array) {
    this.parts.push(...b);
    return this;
  }
  /** Writes a chunk whose body `body` writes. */
  chunk(id: number, body: (w: ChunkWriter) => void) {
    const inner = new ChunkWriter(this.le);
    body(inner);
    const data = inner.data();
    this.u16(id).u32(data.length + 6).bytes(data);
    return this;
  }
  data(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export interface TestElement {
  semantic: number;
  type: number;
  index?: number;
  values: number[][];
  source?: number;
}

/** Writes M_GEOMETRY with one interleaved buffer per source. */
export function geometry(w: ChunkWriter, count: number, elements: TestElement[]): void {
  w.chunk(0x5000, (g) => {
    g.u32(count);
    const offsets = new Map<number, number>();
    const layout = elements.map((e) => {
      const source = e.source ?? 0;
      const offset = offsets.get(source) ?? 0;
      const size = elementSize(e.type);
      offsets.set(source, offset + size);
      return { ...e, source, offset, size };
    });
    g.chunk(0x5100, (d) => {
      for (const e of layout) d.chunk(0x5110, (x) => x.u16(e.source).u16(e.type).u16(e.semantic).u16(e.offset).u16(e.index ?? 0));
    });
    for (const [source, size] of offsets) {
      g.chunk(0x5200, (b) => {
        b.u16(source).u16(size);
        b.chunk(0x5210, (data) => {
          for (let v = 0; v < count; v++) {
            for (const e of layout.filter((l) => l.source === source)) writeElement(data, e.type, e.values[v]!);
          }
        });
      });
    }
  });
}

function elementSize(type: number): number {
  if (type <= 3) return 4 * (type + 1);
  if (type === 10 || type === 11 || type === 30) return 4;
  if (type === 31) return 4;
  throw new Error(`test writer: type ${type}`);
}

function writeElement(w: ChunkWriter, type: number, values: number[]): void {
  if (type <= 3) for (let i = 0; i <= type; i++) w.f32(values[i] ?? 0);
  else if (type === 10) {
    // ARGB
    const [r, g, b, a] = values.map((v) => Math.round(v * 255));
    w.u32((((a! << 24) | (r! << 16) | (g! << 8) | b!) >>> 0));
  } else if (type === 11) {
    const [r, g, b, a] = values.map((v) => Math.round(v * 255));
    w.u32((((a! << 24) | (b! << 16) | (g! << 8) | r!) >>> 0));
  } else if (type === 30) for (const v of values) w.u8(Math.round(v * 255));
  else if (type === 31) for (const v of values) w.u16(Math.round(v * 32767) & 0xffff);
}

export interface TestSubMesh {
  material: string;
  shared: boolean;
  indices: number[];
  wide?: boolean;
  operation?: number;
  vertices?: { count: number; elements: TestElement[] };
  aliases?: [string, string][];
  bones?: number;
}

/** A whole binary .mesh file. */
export function binaryMesh(options: {
  le?: boolean;
  version?: string;
  shared?: { count: number; elements: TestElement[] };
  subMeshes: TestSubMesh[];
  names?: string[];
  skeleton?: string;
  extraChunk?: boolean;
}): Uint8Array {
  const w = new ChunkWriter(options.le ?? true);
  w.u16(0x1000).string(`[${options.version ?? 'MeshSerializer_v1.100'}]`);
  w.chunk(0x3000, (m) => {
    m.bool(false);
    if (options.shared) geometry(m, options.shared.count, options.shared.elements);
    for (const sub of options.subMeshes) {
      m.chunk(0x4000, (s) => {
        s.string(sub.material).bool(sub.shared).u32(sub.indices.length).bool(!!sub.wide);
        for (const i of sub.indices) {
          if (sub.wide) s.u32(i);
          else s.u16(i);
        }
        if (!sub.shared && sub.vertices) geometry(s, sub.vertices.count, sub.vertices.elements);
        if (sub.operation) s.chunk(0x4010, (o) => o.u16(sub.operation!));
        for (let b = 0; b < (sub.bones ?? 0); b++) s.chunk(0x4100, (x) => x.u32(b).u16(0).f32(1));
        for (const [alias, texture] of sub.aliases ?? []) s.chunk(0x4200, (a) => a.string(alias).string(texture));
      });
    }
    if (options.skeleton) m.chunk(0x6000, (s) => s.string(options.skeleton!));
    // An LOD chunk the reader must skip by its length.
    if (options.extraChunk) m.chunk(0x8000, (l) => l.u16(1).u32(0xdeadbeef).f32(10).u32(12345));
    m.chunk(0x9000, (b) => b.f32(-1).f32(-1).f32(-1).f32(1).f32(1).f32(1).f32(1.7));
    if (options.names) {
      m.chunk(0xa000, (t) => {
        options.names!.forEach((name, i) => t.chunk(0xa100, (e) => e.u16(i).string(name)));
      });
    }
  });
  return w.data();
}

/** A zip archive with the files stored (method 0) or deflated (method 8). */
export async function zip(files: { name: string; data: Uint8Array | string }[], deflate = false): Promise<Uint8Array> {
  const out: number[] = [];
  const central: number[] = [];
  const u16 = (a: number[], v: number) => a.push(v & 255, (v >> 8) & 255);
  const u32 = (a: number[], v: number) => a.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  for (const file of files) {
    const raw = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data;
    const data = deflate
      ? new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
      : raw;
    const name = new TextEncoder().encode(file.name);
    const offset = out.length;
    u32(out, 0x04034b50);
    u16(out, 20);
    u16(out, 0);
    u16(out, deflate ? 8 : 0);
    u16(out, 0);
    u16(out, 0);
    u32(out, 0); // crc, not checked
    u32(out, data.length);
    u32(out, raw.length);
    u16(out, name.length);
    u16(out, 0);
    out.push(...name, ...data);
    u32(central, 0x02014b50);
    u16(central, 20);
    u16(central, 20);
    u16(central, 0);
    u16(central, deflate ? 8 : 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, data.length);
    u32(central, raw.length);
    u16(central, name.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, offset);
    central.push(...name);
  }
  const start = out.length;
  out.push(...central);
  u32(out, 0x06054b50);
  u16(out, 0);
  u16(out, 0);
  u16(out, files.length);
  u16(out, files.length);
  u32(out, central.length);
  u32(out, start);
  u16(out, 0);
  return Uint8Array.from(out);
}

/** A unit quad in the XY plane facing +Z, as two triangles. */
export const QUAD = {
  positions: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  normals: [
    [0, 0, 1],
    [0, 0, 1],
    [0, 0, 1],
    [0, 0, 1],
  ],
  uvs: [
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
  ],
  indices: [0, 1, 2, 0, 2, 3],
};
