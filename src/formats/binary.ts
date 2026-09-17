/** Petit lecteur séquentiel little-endian, utilisé par tous les parsers. */
export class BinaryReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  offset: number;

  constructor(source: ArrayBuffer | Uint8Array, offset = 0) {
    if (source instanceof Uint8Array) {
      this.bytes = source;
      this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    } else {
      this.bytes = new Uint8Array(source);
      this.view = new DataView(source);
    }
    this.offset = offset;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  seek(offset: number): this {
    this.offset = offset;
    return this;
  }

  skip(count: number): this {
    this.offset += count;
    return this;
  }

  u8(): number {
    return this.view.getUint8(this.offset++);
  }

  i8(): number {
    return this.view.getInt8(this.offset++);
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  vec3(): [number, number, number] {
    return [this.f32(), this.f32(), this.f32()];
  }

  /** Chaîne de taille fixe terminée par un zéro, le reste du bloc est ignoré. */
  fixedString(size: number): string {
    const start = this.offset;
    let end = start;
    while (end < start + size && this.bytes[end] !== 0) end++;
    const text = new TextDecoder('latin1').decode(this.bytes.subarray(start, end));
    this.offset = start + size;
    return text;
  }

  magic(size: number): string {
    const start = this.offset;
    this.offset += size;
    return new TextDecoder('latin1').decode(this.bytes.subarray(start, start + size));
  }

  slice(offset: number, length: number): Uint8Array {
    return this.bytes.subarray(offset, offset + length);
  }
}
