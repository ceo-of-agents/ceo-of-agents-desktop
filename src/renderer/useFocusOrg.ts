import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { OrgId } from '../shared/types';

/**
 * Which org the "Waiting on you" focus view is open for, null when closed. The view is closed whenever
 * the active org changes, by any path, so coming back to an org never reopens it unprompted.
 */
export function useFocusOrg(orgId: OrgId | null): [OrgId | null, Dispatch<SetStateAction<OrgId | null>>] {
  const [focusOrg, setFocusOrg] = useState<OrgId | null>(null);
  useEffect(() => {
    setFocusOrg(null);
  }, [orgId]);
  return [focusOrg, setFocusOrg];
}
