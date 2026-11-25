import fs from 'node:fs';
import path from 'node:path';
import { orgIdFor } from './read';

export interface OrgEntry {
  id: string;
  path: string;
  lastOpened: string | null;
}

interface RegistryFile {
  orgs: OrgEntry[];
  activeId: string | null;
  scannedOnce: boolean;
}

export class OrgRegistry {
  private readonly file: string;
  private data: RegistryFile;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'orgs.json');
    this.data = this.load();
  }

  private load(): RegistryFile {
    const empty: RegistryFile = { orgs: [], activeId: null, scannedOnce: false };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<RegistryFile>;
      const orgs = Array.isArray(raw.orgs)
        ? raw.orgs
            .filter((o) => o && typeof o.id === 'string' && typeof o.path === 'string')
            .map((o) => ({ id: o.id, path: o.path, lastOpened: typeof o.lastOpened === 'string' ? o.lastOpened : null }))
        : [];
      return {
        orgs,
        activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
        scannedOnce: raw.scannedOnce === true,
      };
    } catch {
      return empty;
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list(): OrgEntry[] {
    return this.data.orgs.map((o) => ({ ...o }));
  }

  add(hqPath: string): OrgEntry {
    const id = orgIdFor(hqPath);
    const existing = this.data.orgs.find((o) => o.id === id);
    if (existing) return { ...existing };
    let p = hqPath;
    try {
      p = fs.realpathSync(hqPath);
    } catch {
      // keep as given
    }
    const entry: OrgEntry = { id, path: p, lastOpened: null };
    this.data.orgs.push(entry);
    this.save();
    return { ...entry };
  }

  get(id: string): OrgEntry | undefined {
    const e = this.data.orgs.find((o) => o.id === id);
    return e ? { ...e } : undefined;
  }

  touch(id: string): void {
    const e = this.data.orgs.find((o) => o.id === id);
    if (!e) return;
    e.lastOpened = new Date().toISOString();
    this.save();
  }

  setActive(id: string): void {
    if (!this.data.orgs.some((o) => o.id === id)) return;
    this.data.activeId = id;
    this.save();
  }

  activeId(): string | null {
    return this.data.activeId && this.data.orgs.some((o) => o.id === this.data.activeId) ? this.data.activeId : null;
  }

  lastUsed(): string | null {
    const active = this.activeId();
    if (active) return active;
    let best: OrgEntry | null = null;
    for (const o of this.data.orgs) {
      if (o.lastOpened && (!best || o.lastOpened > (best.lastOpened ?? ''))) best = o;
    }
    return best ? best.id : null;
  }

  scannedOnce(): boolean {
    return this.data.scannedOnce;
  }

  markScanned(): void {
    this.data.scannedOnce = true;
    this.save();
  }
}
