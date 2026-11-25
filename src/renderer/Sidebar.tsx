import { useState } from 'react';
import type { OrgSummary } from '../shared/types';
import { t } from '../shared/strings';
import { OrgIconOrInitials } from './OrgIcon';
import { Settings } from './icons';
import { stripMarkdown } from './markdown-safety';
import { AddOrgMenu } from './AddOrgMenu';
import { OrgRailMenu } from './OrgRailMenu';
import { Button } from './ui/Button';
import { LogoMark } from './ui/LogoMark';
import { Tooltip } from './ui/Tooltip';

interface Props {
  orgs: OrgSummary[];
  activeOrgId: string | null;
  onSelect(orgId: string): void;
  /** Open an existing org. */
  onAdd(): void;
  onCreate(): void;
  onSettings(): void;
  onAbout(): void;
  /** "Set icon…" in an org's right-click menu (the same picker as Settings). */
  onSetIcon(orgId: string): void;
  /** "Remove icon" in an org's right-click menu. */
  onRemoveIcon(orgId: string): void;
}

// The org list starts 4 px below its top edge (room for the waiting badge, which sticks out above the first tile), so the marker (20 px) centred on a 40 px tile sits at 4 + 10.
const RAIL_MARKER_OFFSET = 14;

export function Sidebar({ orgs, activeOrgId, onSelect, onAdd, onCreate, onSettings, onAbout, onSetIcon, onRemoveIcon }: Props) {
  const [menu, setMenu] = useState<{ orgId: string; x: number; y: number } | null>(null);
  const menuOrg = menu ? orgs.find((o) => o.id === menu.orgId) : undefined;
  // One marker slides between tiles: tiles are 40 px tall with an 8 px gap, the marker is 20 px tall.
  const activeIndex = orgs.findIndex((o) => o.id === activeOrgId);
  // Both bottom buttons open a view of the open org: without one (Welcome) they are disabled, not just silent.
  const noOrg = activeOrgId === null;
  return (
    <nav className="sidebar">
      <div className="sidebar-top" />
      <h2 className="sidebar-title" id="sidebar-orgs-title">
        {t('sidebar.myOrgs')}
      </h2>
      <div className="sidebar-orgs" role="list" aria-labelledby="sidebar-orgs-title">
        <span className="rail-marker" aria-hidden="true" style={{ transform: `translateY(${Math.max(activeIndex, 0) * 48 + RAIL_MARKER_OFFSET}px)`, opacity: activeIndex < 0 ? 0 : 1 }} />
        {orgs.map((o) => {
          const name = stripMarkdown(o.name);
          const tip = [o.available ? name : t('sidebar.unavailable', { name }), o.waitingCount > 0 ? t('sidebar.waiting', { count: o.waitingCount }) : ''].filter(Boolean).join('\n');
          return (
            <div key={o.id} role="listitem" className="rail-item">
              <Tooltip label={tip} placement="right">
                <button className={`org-icon${o.id === activeOrgId ? ' active' : ''}${o.available ? '' : ' unavailable'}`} aria-label={name} aria-current={o.id === activeOrgId ? 'true' : undefined} onClick={() => onSelect(o.id)} onContextMenu={(e) => { e.preventDefault(); setMenu({ orgId: o.id, x: e.clientX, y: e.clientY }); }}>
                  <OrgIconOrInitials orgId={o.id} iconStamp={o.iconStamp} name={name} />
                  {o.waitingCount > 0 && (
                    <span className="badge" key={o.waitingCount}>
                      {o.waitingCount}
                    </span>
                  )}
                </button>
              </Tooltip>
            </div>
          );
        })}
        <div role="listitem" className="rail-item">
          <AddOrgMenu onCreate={onCreate} onOpen={onAdd} />
        </div>
      </div>
      {menu && menuOrg && <OrgRailMenu name={stripMarkdown(menuOrg.name)} hasIcon={menuOrg.iconStamp !== null && menuOrg.iconStamp !== undefined} x={menu.x} y={menu.y} onSet={() => onSetIcon(menu.orgId)} onRemove={() => onRemoveIcon(menu.orgId)} onClose={() => setMenu(null)} />}
      <div className="sidebar-bottom">
        <hr className="sidebar-divider" />
        <Tooltip label={t('sidebar.about')} placement="right">
          <button className="app-identity" aria-label={t('sidebar.aboutLabel')} onClick={onAbout} disabled={noOrg}>
            <LogoMark size={32} />
            <span className="app-identity-name">{t('sidebar.appName')}</span>
          </button>
        </Tooltip>
        <Tooltip label={t('sidebar.settings')} placement="right">
          <button className="icon-btn" aria-label={t('sidebar.settings')} onClick={onSettings} disabled={noOrg}>
            <Settings />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}

export function Welcome({ onOpen, onCreate }: { onOpen(): void; onCreate(): void }) {
  return (
    <div className="welcome">
      <LogoMark size={48} className="welcome-mark" />
      <h1>{t('welcome.title')}</h1>
      <p className="muted">{t('welcome.subtitle')}</p>
      <div className="welcome-actions">
        <Button variant="primary" onClick={onCreate}>
          {t('welcome.create')}
        </Button>
        <Button onClick={onOpen}>{t('welcome.open')}</Button>
      </div>
      <p className="hint">{t('welcome.hint')}</p>
    </div>
  );
}
