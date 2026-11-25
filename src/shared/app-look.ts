// The optional look file of a design department (`departments/<id>/app-look.yaml`, org chart spec section 6).
// The names the file may use; the parser is in `src/main/hq/app-look.ts`, the icons in `src/renderer/icons.tsx`.
import type { DepartmentColour } from './types';

/** Lucide names a department tile may use (no spark or star shapes). */
export const DEPARTMENT_ICONS = [
  'code', 'pen-tool', 'palette', 'megaphone', 'scale', 'wallet', 'calculator', 'chart-line', 'users', 'wrench', 'book-open', 'shield-check', 'briefcase', 'search', 'flask-conical', 'headphones',
] as const;

export const DEPARTMENT_COLOURS: readonly DepartmentColour[] = ['neutral', 'blue', 'pink'];
