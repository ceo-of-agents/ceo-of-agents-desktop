import { t } from '../shared/strings';
import { ArrowLeft } from './icons';
import { OrgChart, type OrgChartProps } from './OrgChart';
import { Button } from './ui/Button';

/** The Org chart as a view in place of the thread: a quiet "Back to chat" at the top, then the chart. */
export function OrgChartView({ onBack, ...chart }: OrgChartProps & { onBack(): void }) {
  return (
    <div className="oc-view">
      <div className="oc-back">
        <Button variant="quiet" small icon={<ArrowLeft size={14} />} onClick={onBack}>
          {t('orgchart.back')}
        </Button>
      </div>
      <OrgChart {...chart} />
    </div>
  );
}
