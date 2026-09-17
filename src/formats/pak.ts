import { BinaryReader } from './binary';

const ENTRY_SIZE = 64;
const NAME_SIZE = 56;

export interface PakEntry {
  name: string;
  offset: number;
  length: number;
}

/** Une archive .pak montée en mémoire. */
export class PakArchive {
  readonly entries = new Map<string, PakEntry>();
  private readonly data: Uint8Array;

  constructor(buffer: ArrayBuffer, readonly label = 'pak') {
    const reader = new BinaryReader(buffer);
    this.data = reader.bytes;

    const magic = reader.magic(4);
    if (magic !== 'PACK') throw new Error(`${label}: signature PACK attendue, reçu "${magic}"`);

    const dirOffset = reader.i32();
    const dirLength = reader.i32();
    const count = Math.floor(dirLength / ENTRY_SIZE);

    reader.seek(dirOffset);
    for (let i = 0; i < count; i++) {
      const name = reader.fixedString(NAME_SIZE).toLowerCase().replace(/\\/g, '/');
      const offset = reader.i32();
      const length = reader.i32();
      this.entries.set(name, { name, offset, length });
    }
  }

  has(path: string): boolean {
    return this.entries.has(path.toLowerCase());
  }

  read(path: string): Uint8Array | null {
    const entry = this.entries.get(path.toLowerCase());
    if (!entry) return null;
    return this.data.subarray(entry.offset, entry.offset + entry.length);
  }
}

/**
 * Système de fichiers virtuel : les archives montées en dernier gagnent,
 * comme l'ordre pak0 puis pak1 du jeu d'origine.
 */
export class VirtualFileSystem {
  private readonly archives: PakArchive[] = [];
  private readonly loose = new Map<string, Uint8Array>();

  mount(archive: PakArchive): void {
    this.archives.push(archive);
  }

  /** Fichier fourni seul, hors archive (une carte .bsp déposée à la main). */
  addFile(path: string, data: Uint8Array): void {
    this.loose.set(path.toLowerCase().replace(/\\/g, '/'), data);
  }

  read(path: string): Uint8Array | null {
    const key = path.toLowerCase().replace(/\\/g, '/');
    const direct = this.loose.get(key);
    if (direct) return direct;
    for (let i = this.archives.length - 1; i >= 0; i--) {
      const found = this.archives[i].read(key);
      if (found) return found;
    }
    return null;
  }

  readOrThrow(path: string): Uint8Array {
    const data = this.read(path);
    if (!data) throw new Error(`fichier absent des données montées : ${path}`);
    return data;
  }

  list(prefix: string, suffix = ''): string[] {
    const out = new Set<string>();
    const keep = (name: string) => {
      if (name.startsWith(prefix) && name.endsWith(suffix)) out.add(name);
    };
    for (const archive of this.archives) for (const name of archive.entries.keys()) keep(name);
    for (const name of this.loose.keys()) keep(name);
    return [...out].sort();
  }

  get isEmpty(): boolean {
    return this.archives.length === 0 && this.loose.size === 0;
  }
}
