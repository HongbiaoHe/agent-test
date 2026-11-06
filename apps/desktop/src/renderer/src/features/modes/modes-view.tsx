/**
 * 设置 → 模式（对应 Web /settings/modes）：通用卡片 + 列表 + 新建 / 从通用复制 / 编辑 / 删除，编辑器里可预览最终提示词。
 */
import { useQuery } from '@tanstack/react-query';
import { Copy, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { getModeCatalog, MODE_CATALOG_KEY } from '@/lib/api';
import { ModeEditor, type ModeEditorTarget } from './components/mode-editor';
import { ModeList } from './components/mode-list';

export function ModesSettings() {
  const { t } = useTranslation();
  const [editor, setEditor] = useState<ModeEditorTarget | null>(null);
  const catalog = useQuery({ queryKey: MODE_CATALOG_KEY, queryFn: getModeCatalog });

  /** 从通用复制：生效的通用提示词（目录里已含用户覆盖）+ 全部工具 / 连接器 / 技能勾上 */
  const duplicateGeneral = () => {
    const c = catalog.data;
    if (!c) return;
    setEditor({
      kind: 'create',
      initial: {
        name: t('settings.modes.general'),
        systemPrompt: c.generalPrompt,
        toolNames: c.tools.map((x) => x.name),
        mcpServerIds: c.mcpServers.map((x) => x.id),
        skillNames: c.skills.map((x) => x.name),
        defaultModel: null,
        defaultThinkingLevel: null,
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t('settings.modes.intro')}</p>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={duplicateGeneral} disabled={!catalog.data}>
            <Copy /> {t('settings.modes.duplicateGeneral')}
          </Button>
          <Button onClick={() => setEditor({ kind: 'create' })}>
            <Plus /> {t('settings.modes.newMode')}
          </Button>
        </div>
      </div>
      <ModeList
        onEdit={(mode) => setEditor({ kind: 'edit', mode })}
        onEditGeneral={(general) => setEditor({ kind: 'general', general })}
      />
      <ModeEditor target={editor} onClose={() => setEditor(null)} />
    </div>
  );
}
