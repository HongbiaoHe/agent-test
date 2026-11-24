/**
 * 全局搜索弹窗（侧栏「搜索」/ ⌘K）：搜桌面端的所有内容——会话（标题与消息正文）、画布、技能、模式、连接器、
 * 模型连接、设置页，以及常用操作。顶部按类型筛选，空输入时列出最近使用与操作。
 * 键盘：↑↓ 选择、↵ 打开、←→ 切换类型（输入框为空时）、Esc 关闭。条目与分组见 search-items.ts。
 */
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  CornerDownLeft,
  Loader2,
  MessageSquare,
  Network,
  Plug,
  Plus,
  Settings,
  SlidersHorizontal,
  Wrench,
  X,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { agent } from '@/lib/agent-client';
import { listModes, listSkills } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWebAccount } from '../auth/use-web-account';
import { conversationTitle } from '../conversations/conversation-title';
import {
  buildGroups,
  flatItems,
  type ItemType,
  nextType,
  SEARCH_TYPES,
  type SearchItem,
  type SearchTarget,
  type SearchType,
} from './search-items';
import { SETTINGS_SECTIONS } from '../settings/settings-dialog';

const DEBOUNCE_MS = 150;

const ICONS: Record<ItemType, typeof MessageSquare> = {
  conversation: MessageSquare,
  canvas: Network,
  skill: Wrench,
  mode: SlidersHorizontal,
  connector: Plug,
  model: Bot,
  setting: Settings,
  action: Plus,
};

/** 图标：按类型；操作按要做的事区分（新建 / 画布列表 / 设置） */
function iconOf(item: SearchItem): typeof MessageSquare {
  if (item.type !== 'action') return ICONS[item.type];
  if (item.target.kind === 'canvas-list') return Network;
  if (item.target.kind === 'settings') return Settings;
  return Plus;
}

/** 把 text 里第一处 query（不区分大小写）包成 <mark> */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-primary/10 px-0.5 font-medium text-foreground">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

export function SearchDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (target: SearchTarget) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 每次打开都是空输入框、「全部」 */}
      {open && <SearchPanel onSelect={onSelect} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

/** 本地数据源（会话列表、画布、技能、模式、连接器、模型连接）→ 条目；失败的源当作空 */
function useLocalItems(): { items: SearchItem[]; loading: boolean } {
  const { t } = useTranslation();
  const signedIn = useWebAccount().data?.signedIn ?? false;
  const opts = { staleTime: 30_000, retry: false } as const;
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => agent.call('conversations.list', {}), ...opts });
  const canvases = useQuery({
    queryKey: ['search', 'canvases'],
    queryFn: () => agent.call('canvas.list', {}),
    enabled: signedIn,
    ...opts,
  });
  const skills = useQuery({ queryKey: ['search', 'skills'], queryFn: listSkills, ...opts });
  const modes = useQuery({ queryKey: ['search', 'modes'], queryFn: listModes, ...opts });
  const mcp = useQuery({ queryKey: ['search', 'mcp'], queryFn: () => agent.call('mcp.list', {}), ...opts });
  const models = useQuery({ queryKey: ['search', 'models'], queryFn: () => agent.call('llm.connections.list', {}), ...opts });

  const items = useMemo((): SearchItem[] => {
    const out: SearchItem[] = [];
    for (const c of conversations.data ?? []) {
      out.push({
        key: `conversation:${c.id}`,
        type: 'conversation',
        title: conversationTitle(c),
        subtitle: c.workspaceDir.split('/').filter(Boolean).pop(),
        recency: c.updatedAt,
        target: { kind: 'chat', id: c.id },
      });
    }
    for (const v of canvases.data?.items ?? []) {
      out.push({
        key: `canvas:${v.id}`,
        type: 'canvas',
        title: v.title || t('canvas.list.untitled'),
        subtitle: t('shell.search.types.canvas'),
        recency: Date.parse(v.updatedAt) || undefined,
        target: { kind: 'canvas', canvasId: v.id },
      });
    }
    for (const s of skills.data ?? []) {
      out.push({ key: `skill:${s.name}`, type: 'skill', title: s.name, subtitle: s.description, target: { kind: 'settings', section: 'skills' } });
    }
    for (const m of modes.data ?? []) {
      out.push({
        key: `mode:${m.id}`,
        type: 'mode',
        title: m.name,
        subtitle: m.description ?? undefined,
        target: { kind: 'settings', section: 'modes' },
      });
    }
    for (const s of mcp.data?.servers ?? []) {
      out.push({ key: `connector:${s.id}`, type: 'connector', title: s.name, subtitle: s.url, target: { kind: 'settings', section: 'connectors' } });
    }
    for (const c of models.data ?? []) {
      out.push({ key: `model:${c.id}`, type: 'model', title: c.name, subtitle: c.baseUrl, target: { kind: 'settings', section: 'models' } });
    }
    for (const section of SETTINGS_SECTIONS) {
      out.push({
        key: `setting:${section}`,
        type: 'setting',
        title: t(`settings.sections.${section}.label`),
        subtitle: t(`settings.sections.${section}.description`),
        target: { kind: 'settings', section },
      });
    }
    out.push(
      { key: 'action:new-chat', type: 'action', title: t('shell.search.actions.newChat'), target: { kind: 'new-chat' } },
      { key: 'action:canvas-list', type: 'action', title: t('shell.search.actions.canvasList'), target: { kind: 'canvas-list' } },
      { key: 'action:settings', type: 'action', title: t('shell.search.actions.settings'), target: { kind: 'settings', section: 'account' } },
    );
    return out;
  }, [conversations.data, canvases.data, skills.data, modes.data, mcp.data, models.data, t]);

  return { items, loading: conversations.isPending };
}

function SearchPanel({ onSelect, onClose }: { onSelect: (target: SearchTarget) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [type, setType] = useState<SearchType>('all');
  const [active, setActive] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const local = useLocalItems();
  const searchConversations = !!debounced && (type === 'all' || type === 'conversation');
  const search = useQuery({
    queryKey: ['conversation-search', debounced],
    queryFn: () => agent.call('conversations.search', { query: debounced }),
    enabled: searchConversations,
    staleTime: 10_000,
  });
  const conversationHits = useMemo(
    (): SearchItem[] =>
      (search.data ?? []).map((h) => ({
        key: `conversation:${h.conversation.id}`,
        type: 'conversation',
        title: conversationTitle(h.conversation),
        subtitle: h.conversation.workspaceDir.split('/').filter(Boolean).pop(),
        snippet: h.snippet ?? undefined,
        target: { kind: 'chat', id: h.conversation.id },
      })),
    [search.data],
  );
  const groups = buildGroups({ query: debounced, type, items: local.items, conversationHits });
  const flat = flatItems(groups);
  const index = Math.min(active, flat.length - 1);
  const loading = searchConversations ? search.isFetching && !search.data : local.loading;
  // 结果是否已对上当前输入（防抖中 / 请求在途时列表还是上一次的结果，回车不能打开它）
  const fresh = query.trim() === debounced && !(searchConversations && search.isPending);

  const switchType = (next: SearchType) => {
    setType(next);
    setActive(0);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((index + step + flat.length) % flat.length);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && query === '') {
      e.preventDefault();
      switchType(nextType(type, e.key === 'ArrowRight' ? 1 : -1));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      if (!fresh) return;
      const item = flat[index];
      if (item) onSelect(item.target);
    }
  };

  let position = -1;
  return (
    <DialogContent
      showCloseButton={false}
      className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl"
      data-testid="search-dialog"
    >
      <DialogTitle className="sr-only">{t('shell.search.title')}</DialogTitle>
      <div className="flex items-center gap-2 px-4 pt-3">
        <input
          autoFocus
          aria-label={t('shell.search.title')}
          placeholder={t('shell.search.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-10 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
        {loading && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        <Button variant="ghost" size="icon-sm" aria-label={t('shell.search.hints.close')} onClick={onClose}>
          <X />
        </Button>
      </div>
      {/* 类型筛选 */}
      <div className="flex flex-wrap gap-1 border-b border-border px-3 pt-1 pb-3" role="tablist" aria-label={t('shell.search.typesLabel')}>
        {SEARCH_TYPES.map((st) => (
          <button
            key={st}
            type="button"
            role="tab"
            aria-selected={type === st}
            onClick={() => switchType(st)}
            className={cn(
              'rounded-lg px-2.5 py-1 text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
              type === st ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground',
            )}
          >
            {t(`shell.search.types.${st}`)}
          </button>
        ))}
      </div>

      <div className="max-h-[55vh] overflow-y-auto px-2 py-2" role="listbox" aria-label={t('shell.search.results')}>
        {groups.map((g) => (
          <div key={g.id} className="pb-1">
            <p className="px-3 pt-2 pb-1.5 text-xs font-medium text-muted-foreground">
              {g.id === 'recent' ? t('shell.search.recent') : g.id === 'actions' ? t('shell.search.actionsLabel') : t(`shell.search.types.${g.id}`)}
            </p>
            {g.items.map((item) => {
              position++;
              const i = position;
              const Icon = iconOf(item);
              const selected = i === index;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseMove={() => setActive(i)}
                  onClick={() => onSelect(item.target)}
                  data-testid="search-result"
                  data-type={item.type}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-sm',
                    selected && 'bg-accent text-accent-foreground',
                  )}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      <Highlight text={item.title} query={debounced} />
                      {item.subtitle && (
                        <span className="text-muted-foreground">
                          {' · '}
                          <Highlight text={item.subtitle} query={debounced} />
                        </span>
                      )}
                    </span>
                    {item.snippet && (
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                        <Highlight text={item.snippet} query={debounced} />
                      </span>
                    )}
                  </span>
                  {selected && <CornerDownLeft className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                </button>
              );
            })}
          </div>
        ))}
        {!loading && flat.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {debounced ? t('shell.search.noMatch') : t('shell.search.empty')}
          </p>
        )}
      </div>

      {/* 快捷键提示 */}
      <div className="flex items-center gap-4 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <Hint label={t('shell.search.hints.close')} keys={['Esc']} />
        <Hint label={t('shell.search.hints.switchType')} keys={['←', '→']} />
        <Hint label={t('shell.search.hints.move')} keys={['↑', '↓']} />
        <span className="flex-1" />
        <Hint label={t('shell.search.hints.open')} keys={['↵']} />
      </div>
    </DialogContent>
  );
}

function Hint({ label, keys }: { label: string; keys: string[] }) {
  return (
    <span className="flex items-center gap-1.5">
      {label}
      {keys.map((k) => (
        <kbd key={k} className="rounded border border-border px-1.5 py-px font-sans text-[11px] leading-4">
          {k}
        </kbd>
      ))}
    </span>
  );
}
