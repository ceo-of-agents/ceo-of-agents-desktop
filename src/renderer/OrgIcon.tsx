import { useState } from 'react';
import { initials } from './logic';
import { useOrgIcon } from './org-icon-cache';

/** The org's icon image when there is one and it shows, else its initials. Used inside a tile that owns the border and size. */
export function OrgIconOrInitials({ orgId, iconStamp, name }: { orgId: string; iconStamp: string | null | undefined; name: string }) {
  const url = useOrgIcon(orgId, iconStamp);
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url) return <img className="org-icon-img" src={url} alt="" draggable={false} onError={() => setFailed(url)} />;
  return <>{initials(name)}</>;
}
