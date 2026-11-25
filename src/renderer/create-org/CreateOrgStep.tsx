// The body of one question step: picks the step's component. The folder step has its own props and is rendered by the view.
import type { StepId } from '../create-org-logic';
import { SummaryStep } from './SummaryStep';
import { DepartmentsStep, NamesStep } from './steps-departments';
import { GatesStep, ModelsStep } from './steps-gates-models';
import { AboutStep, FileLanguageStep, LanguageProfileStep, NameIdStep, PurposeLevelStep } from './steps-basic';
import { PolicyStep, ReposAttributionStep } from './steps-policy-repos';
import type { StepProps } from './types';

export function CreateOrgStep({ step, onEdit, ...p }: { step: Exclude<StepId, 'folder'>; onEdit(step: StepId): void } & StepProps) {
  switch (step) {
    case 'language-profile':
      return <LanguageProfileStep {...p} />;
    case 'purpose-level':
      return <PurposeLevelStep {...p} />;
    case 'name-id':
      return <NameIdStep {...p} />;
    case 'about':
      return <AboutStep {...p} />;
    case 'file-language':
      return <FileLanguageStep {...p} />;
    case 'departments':
      return <DepartmentsStep {...p} />;
    case 'names':
      return <NamesStep {...p} />;
    case 'gates':
      return <GatesStep {...p} />;
    case 'models':
      return <ModelsStep {...p} />;
    case 'policy':
      return <PolicyStep {...p} />;
    case 'repos-attribution':
      return <ReposAttributionStep {...p} />;
    case 'summary':
      return <SummaryStep {...p} onEdit={onEdit} />;
  }
}
