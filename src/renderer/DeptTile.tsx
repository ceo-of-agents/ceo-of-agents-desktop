import type { DepartmentLook } from '../shared/types';
import { DEPARTMENT_ICON_COMPONENTS } from './icons';
import { initials } from './logic';

/**
 * A department's tile (org chart spec section 6): its icon, or its initials, in the glyph colour of `app-look.yaml`
 * (paper when there is none). The same tile in the chart (28 px) and in the side panel (24 px).
 */
export function DeptTile({ name, look, size }: { name: string; look: DepartmentLook | null | undefined; size: 'chart' | 'panel' }) {
  const Icon = look?.icon ? DEPARTMENT_ICON_COMPONENTS[look.icon] : undefined;
  return (
    <span className={`dept-tile ${size}`} data-colour={look?.colour ?? 'neutral'} aria-hidden="true">
      {Icon ? <Icon /> : initials(name)}
    </span>
  );
}
