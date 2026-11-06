/**
 * 设置 → 连接器（内容拷自 Web /settings/mcp：已连接列表（启停 / 详情 / 工具权限）、推荐连接器一键连接、添加自定义 URL）。
 * 需要授权时在系统浏览器里完成 OAuth（见 components/mcp/use-mcp-connect.ts）。
 */
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { AddConnectorDialog } from './components/add-connector-dialog';
import { ConnectorList } from './components/connector-list';

export function McpSettings() {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button onClick={() => setAdding(true)}>
          <Plus /> {t('extensions.mcp.addConnector')}
        </Button>
      </div>
      <ConnectorList />
      <AddConnectorDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
