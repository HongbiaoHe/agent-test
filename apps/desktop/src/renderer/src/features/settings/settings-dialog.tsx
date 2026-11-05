/**
 * 设置弹窗：左侧分类导航（同 Web /settings 的 SettingsNav 样式），右侧当前分类的内容。
 * 分类：账号（Web 账号 / 后端地址）、外观（主题）、模型（Key / 默认模型）、工作区、技能、连接器。
 * 内容区用原生 overflow-y-auto（弹窗里 ScrollArea 遇到不确定高度会失效，见项目记忆）。
 */
import { Bot, CircleUserRound, FolderOpen, type LucideIcon, Palette, Plug, Wrench } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { McpSettings } from '../mcp/mcp-view';
import { SkillsSettings } from '../skills/skills-view';
import { AccountSection } from './sections/account-section';
import { AppearanceSection } from './sections/appearance-section';
import { ModelsSection } from './sections/models-section';
import { WorkspaceSection } from './sections/workspace-section';

export type SettingsSection = 'account' | 'appearance' | 'models' | 'workspace' | 'skills' | 'connectors';

const SECTIONS: { key: SettingsSection; label: string; icon: LucideIcon; description: string }[] = [
  { key: 'account', label: '账号', icon: CircleUserRound, description: 'Web 账号：登录后可以生图、生视频、配音和克隆音色。' },
  { key: 'appearance', label: '外观', icon: Palette, description: '界面主题：跟随系统，或固定浅色 / 深色。' },
  { key: 'models', label: '模型', icon: Bot, description: '模型 Key 加密保存在本机钥匙串，只交给本机的 agent 进程。' },
  { key: 'workspace', label: '工作区', icon: FolderOpen, description: '新对话默认使用的目录；每个对话开始前也能另选目录和权限。' },
  { key: 'skills', label: '技能', icon: Wrench, description: '内置技能、从 GitHub 安装的开源技能和你自己写的技能。' },
  { key: 'connectors', label: '连接器', icon: Plug, description: '连接远程 MCP server，agent 就能用它们的工具；带交互界面的工具会在对话里显示成卡片。' },
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
  const current = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(720px,85vh)] gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <nav aria-label="设置分类" className="flex w-48 shrink-0 flex-col gap-1 border-r border-border bg-muted/40 p-3">
          <DialogTitle className="px-3 pt-1 pb-3 text-base font-semibold">设置</DialogTitle>
          {SECTIONS.map(({ key, label, icon: Icon }) => (
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
              {label}
            </button>
          ))}
        </nav>
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="shrink-0 space-y-1 border-b border-border px-6 py-4 pr-12">
            <h2 className="text-lg font-semibold">{current.label}</h2>
            <DialogDescription>{current.description}</DialogDescription>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {section === 'account' && <AccountSection onSignIn={onSignIn} />}
            {section === 'appearance' && <AppearanceSection />}
            {section === 'models' && <ModelsSection />}
            {section === 'workspace' && <WorkspaceSection />}
            {section === 'skills' && <SkillsSettings />}
            {section === 'connectors' && <McpSettings />}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
