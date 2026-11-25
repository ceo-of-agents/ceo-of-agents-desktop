// Tips about the app itself, in the same shape as the plugin's. Texts are in en.json (`tips.app.*`); no translations yet, so
// they show in English whatever the chat language. Conditions use the app-side keys `always` and `org_icon_missing`.
import { t } from '../../shared/strings';
import type { Tip } from './tips';

export function appTips(): Tip[] {
  return [
    {
      id: 'app-org-icon',
      since: null,
      pending: false,
      when: { org_icon_missing: true },
      text: t('tips.app.orgIcon.text'),
      phrase: t('tips.app.orgIcon.phrase'),
      translations: {},
    },
    {
      id: 'app-paste-images',
      since: null,
      pending: false,
      when: { always: true },
      text: t('tips.app.images.text'),
      phrase: t('tips.app.images.phrase'),
      translations: {},
    },
  ];
}
