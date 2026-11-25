import type { CoaApi } from '../shared/types';

declare global {
  interface Window {
    coa: CoaApi;
  }
}

/** The only door to the main process. */
export const api = (): CoaApi => window.coa;
