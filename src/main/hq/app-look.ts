// `departments/<id>/app-look.yaml`: an optional file from a design department that gives the department tiles an icon
// and a glyph colour (org chart spec section 6). Pure parsing; never throws. A bad item falls back to initials on its
// own and adds a warning; the user sees no error.
import { parse as parseYaml } from 'yaml';
import { DEPARTMENT_COLOURS, DEPARTMENT_ICONS } from '../../shared/app-look';
import type { DepartmentColour, DepartmentLook } from '../../shared/types';

export interface LookFile {
  /** The department whose folder holds the file. */
  department: string;
  text: string;
}

export interface LookResult {
  /** By department id (a Map: ids such as `constructor` are plain keys); a department missing here shows paper initials. */
  look: Map<string, DepartmentLook>;
  /** Why something fell back, for one console warning. */
  warnings: string[];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A named field of a parsed YAML mapping, own properties only. */
const field = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

/** The first department, in org.yaml order, whose folder has the file; ids of departments not in org.yaml never match. */
export function pickLookFile(departmentIds: string[], files: LookFile[]): LookFile | null {
  for (const id of departmentIds) {
    const f = files.find((x) => x.department === id);
    if (f) return f;
  }
  return null;
}

export function parseAppLook(file: LookFile | null, departmentIds: string[]): LookResult {
  const out: LookResult = { look: new Map(), warnings: [] };
  if (!file) return out;
  const where = `departments/${file.department}/app-look.yaml`;
  let doc: unknown;
  try {
    doc = parseYaml(file.text);
  } catch {
    out.warnings.push(`${where}: not valid YAML`);
    return out;
  }
  const root = obj(doc);
  if (field(root, 'version') !== 1) {
    out.warnings.push(`${where}: version ${String(field(root, 'version'))} is not supported`);
    return out;
  }
  for (const [id, raw] of Object.entries(obj(field(root, 'departments')))) {
    if (!departmentIds.includes(id)) {
      out.warnings.push(`${where}: "${id}" is not a department in org.yaml`);
      continue;
    }
    const entry = obj(raw);
    const rawIcon = field(entry, 'icon');
    const rawColour = field(entry, 'colour');
    const icon = rawIcon === undefined || rawIcon === null ? null : String(rawIcon).trim();
    const colour = rawColour === undefined || rawColour === null ? 'neutral' : String(rawColour).trim();
    if (icon !== null && !(DEPARTMENT_ICONS as readonly string[]).includes(icon)) {
      out.warnings.push(`${where}: unknown icon "${icon}" for ${id}`);
      continue;
    }
    if (!(DEPARTMENT_COLOURS as readonly string[]).includes(colour)) {
      out.warnings.push(`${where}: unknown colour "${colour}" for ${id}`);
      continue;
    }
    out.look.set(id, { icon, colour: colour as DepartmentColour });
  }
  return out;
}
