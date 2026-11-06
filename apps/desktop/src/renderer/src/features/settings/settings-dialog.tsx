/**
 * 设置弹窗：左侧分类导航（同 Web /settings 的 SettingsNav 样式），右侧当前分类的内容。
 * 分类：账号（Web 账号 / 后端地址）、外观（主题 / 语言）、模型（Key / 默认模型）、工作区、技能、连接器、模式。
 * 内容区用原生 overflow-y-auto（弹窗里 ScrollArea 遇到不确定高度会失效，见项目记忆）。
 */
import { Bot, CircleUserRound, FolderOpen, type LucideIcon, Palette, Plug, SlidersHorizontal, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { McpSettings } from '../mcp/mcp-view';
import { ModesSettings } from '../modes/modes-view';
import { SkillsSettings } from '../skills/skills-view';
import { AccountSection } from './sections/account-section';
import { AppearanceSection } from './sections/appearance-section';
import { ModelsSection } from './sections/models-section';
import { WorkspaceSection } from './sections/workspace-section';

export type SettingsSection = 'account' | 'appearance' | 'models' | 'workspace' | 'skills' | 'connectors' | 'modes';

/** 名称与说明见字典 settings.sections.<key> */
const SECTIONS: { key: SettingsSection; icon: LucideIcon }[] = [
  { key: 'account', icon: CircleUserRound },
  { key: 'appearance', icon: Palette },
  { key: 'models', icon: Bot },
  { key: 'workspace', icon: FolderOpen },
  { key: 'skills', icon: Wrench },
  { key: 'connectors', icon: Plug },
  { key: 'modes', icon: SlidersHorizontal },
];

export function SettingsDialog({
  open,
  section,
  onOpenChange,
  onSectionChange,
  onSignIn,
}: {
  open: boolean;
  section: SettingsSection;
  onOpenChange: (open: boolean) => void;
  onSectionChange: (section: SettingsSection) => void;
  /** 账号分类里点「登录」：关掉弹窗、回到登录页 */
  onSignIn: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(720px,85vh)] gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <nav aria-label={t('settings.nav')} className="flex w-48 shrink-0 flex-col gap-1 border-r border-border bg-muted/40 p-3">
          <DialogTitle className="px-3 pt-1 pb-3 text-base font-semibold">{t('settings.title')}</DialogTitle>
          {SECTIONS.map(({ key, icon: Icon }) => (
            <button
              key={key}
              type="button"
              aria-current={key === section ? 'page' : undefined}
              onClick={() => onSectionChange(key)}
              className={cn(
                'flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                key === section
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <Icon className="size-4" />
              {t(`settings.sections.${key}.label`)}
            </button>
          ))}
        </nav>
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="shrink-0 space-y-1 border-b border-border px-6 py-4 pr-12">
            <h2 className="text-lg font-semibold">{t(`settings.sections.${section}.label`)}</h2>
            <DialogDescription>{t(`settings.sections.${section}.description`)}</DialogDescription>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {section === 'account' && <AccountSection onSignIn={onSignIn} />}
            {section === 'appearance' && <AppearanceSection />}
            {section === 'models' && <ModelsSection />}
            {section === 'workspace' && <WorkspaceSection />}
            {section === 'skills' && <SkillsSettings />}
            {section === 'connectors' && <McpSettings />}
            {section === 'modes' && <ModesSettings />}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
