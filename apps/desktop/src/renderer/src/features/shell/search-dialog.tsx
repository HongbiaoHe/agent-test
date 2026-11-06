/**
 * 会话搜索弹窗（侧栏「搜索」/ ⌘K）：按标题与消息正文搜（agent-host conversations.search），
 * 空输入时列出最近的会话。↑↓ 选择、回车打开，命中片段里高亮关键词。
 */
import { useQuery } from '@tanstack/react-query';
import { Loader2, MessageSquare, Search } from 'lucide-react';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationSearchHit } from '../../../../shared/rpc';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { agent } from '@/lib/agent-client';
import { cn } from '@/lib/utils';
import { conversationTitle } from '../conversations/conversation-title';

const RECENT_LIMIT = 10;
const DEBOUNCE_MS = 150;

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
  onSelect: (conversationId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 每次打开都是空输入框 */}
      {open && <SearchPanel onSelect={onSelect} />}
    </Dialog>
  );
}

function SearchPanel({ onSelect }: { onSelect: (conversationId: string) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  const recent = useQuery({
    queryKey: ['conversations'],
    queryFn: () => agent.call('conversations.list', {}),
    enabled: !debounced,
  });
  const search = useQuery({
    queryKey: ['conversation-search', debounced],
    queryFn: () => agent.call('conversations.search', { query: debounced }),
    enabled: !!debounced,
    staleTime: 10_000,
  });
  const hits: ConversationSearchHit[] = debounced
    ? (search.data ?? [])
    : (recent.data ?? []).slice(0, RECENT_LIMIT).map((conversation) => ({ conversation, snippet: null }));
  const loading = debounced ? search.isFetching && !search.data : recent.isPending;
  const index = Math.min(active, hits.length - 1);
  // 结果是否已对上当前输入（防抖中 / 请求在途时列表还是上一次的结果，回车不能打开它）
  const fresh = query.trim() === debounced && !(debounced && search.isPending);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((index + step + hits.length) % hits.length);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      if (!fresh) return;
      const hit = hits[index];
      if (hit) onSelect(hit.conversation.id);
    }
  };

  return (
    <DialogContent
      showCloseButton={false}
      className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      data-testid="search-dialog"
    >
      <DialogTitle className="sr-only">{t('shell.search.title')}</DialogTitle>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" />
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
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {loading && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>
      <div className="max-h-[50vh] overflow-y-auto p-1.5" role="listbox" aria-label={t('shell.search.results')}>
        {!debounced && hits.length > 0 && <p className="px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground">{t('shell.search.recent')}</p>}
        {hits.map((h, i) => (
          <button
            key={h.conversation.id}
            type="button"
            role="option"
            aria-selected={i === index}
            onMouseMove={() => setActive(i)}
            onClick={() => onSelect(h.conversation.id)}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm',
              i === index && 'bg-accent text-accent-foreground',
            )}
          >
            <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                <Highlight text={conversationTitle(h.conversation)} query={debounced} />
              </span>
              {h.snippet && (
                <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                  <Highlight text={h.snippet} query={debounced} />
                </span>
              )}
            </span>
          </button>
        ))}
        {!loading && hits.length === 0 && (
          <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">
            {debounced ? t('shell.search.noMatch') : t('shell.search.empty')}
          </p>
        )}
      </div>
    </DialogContent>
  );
}
