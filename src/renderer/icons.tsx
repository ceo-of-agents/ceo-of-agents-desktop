// The one stroke icon set (Lucide, ISC licence; see THIRD_PARTY_NOTICES.md): 16 px, 1.75 stroke, currentColor.
import type { ComponentType } from 'react';
import {
  AlertCircle as LAlertCircle,
  ArrowDown as LArrowDown,
  ArrowLeft as LArrowLeft,
  ArrowRightLeft as LArrowRightLeft,
  ArrowUp as LArrowUp,
  Check as LCheck,
  BookOpen as LBookOpen,
  Briefcase as LBriefcase,
  Calculator as LCalculator,
  ChartLine as LChartLine,
  ChevronLeft as LChevronLeft,
  ChevronRight as LChevronRight,
  CircleDot as LCircleDot,
  ExternalLink as LExternalLink,
  File as LFile,
  FileText as LFileText,
  Film as LFilm,
  Music as LMusic,
  Paperclip as LPaperclip,
  GitPullRequest as LGitPullRequest,
  Maximize2 as LMaximize2,
  Code as LCode,
  Copy as LCopy,
  Ellipsis as LEllipsis,
  FlaskConical as LFlaskConical,
  FolderOpen as LFolderOpen,
  FolderPlus as LFolderPlus,
  Headphones as LHeadphones,
  Info as LInfo,
  Megaphone as LMegaphone,
  Network as LNetwork,
  Palette as LPalette,
  PenTool as LPenTool,
  Scale as LScale,
  Search as LSearch,
  ShieldCheck as LShieldCheck,
  Users as LUsers,
  Wallet as LWallet,
  Wrench as LWrench,
  MessageSquare as LMessageSquare,
  PanelRight as LPanelRight,
  Plus as LPlus,
  RefreshCw as LRefreshCw,
  Settings as LSettings,
  X as LX,
  type LucideProps,
} from 'lucide-react';

export type IconProps = LucideProps;

function withDefaults(Icon: ComponentType<LucideProps>): ComponentType<LucideProps> {
  const Wrapped = (props: LucideProps) => <Icon size={16} strokeWidth={1.75} aria-hidden="true" {...props} />;
  Wrapped.displayName = `Icon(${Icon.displayName ?? 'icon'})`;
  return Wrapped;
}

export const ArrowUp = withDefaults(LArrowUp);
export const ArrowDown = withDefaults(LArrowDown);
export const ArrowLeft = withDefaults(LArrowLeft);
export const PanelRight = withDefaults(LPanelRight);
export const Settings = withDefaults(LSettings);
export const Plus = withDefaults(LPlus);
export const ChevronRight = withDefaults(LChevronRight);
export const ChevronLeft = withDefaults(LChevronLeft);
export const CircleDot = withDefaults(LCircleDot);
export const ExternalLink = withDefaults(LExternalLink);
export const GitPullRequest = withDefaults(LGitPullRequest);
export const Maximize2 = withDefaults(LMaximize2);
export const Check = withDefaults(LCheck);
export const Copy = withDefaults(LCopy);
export const X = withDefaults(LX);
export const File = withDefaults(LFile);
export const FileText = withDefaults(LFileText);
export const Film = withDefaults(LFilm);
export const Music = withDefaults(LMusic);
export const Paperclip = withDefaults(LPaperclip);
export const AlertCircle = withDefaults(LAlertCircle);
export const RefreshCw = withDefaults(LRefreshCw);
export const ArrowRightLeft = withDefaults(LArrowRightLeft);
export const MessageSquare = withDefaults(LMessageSquare);
export const Network = withDefaults(LNetwork);
export const Ellipsis = withDefaults(LEllipsis);
export const FolderPlus = withDefaults(LFolderPlus);
export const FolderOpen = withDefaults(LFolderOpen);
export const Info = withDefaults(LInfo);

/** The icons a department tile may use (`app-look.yaml`, `DEPARTMENT_ICONS` in `src/shared/app-look.ts`). */
export const DEPARTMENT_ICON_COMPONENTS: Record<string, ComponentType<LucideProps>> = {
  code: withDefaults(LCode),
  'pen-tool': withDefaults(LPenTool),
  palette: withDefaults(LPalette),
  megaphone: withDefaults(LMegaphone),
  scale: withDefaults(LScale),
  wallet: withDefaults(LWallet),
  calculator: withDefaults(LCalculator),
  'chart-line': withDefaults(LChartLine),
  users: withDefaults(LUsers),
  wrench: withDefaults(LWrench),
  'book-open': withDefaults(LBookOpen),
  'shield-check': withDefaults(LShieldCheck),
  briefcase: withDefaults(LBriefcase),
  search: withDefaults(LSearch),
  'flask-conical': withDefaults(LFlaskConical),
  headphones: withDefaults(LHeadphones),
};
