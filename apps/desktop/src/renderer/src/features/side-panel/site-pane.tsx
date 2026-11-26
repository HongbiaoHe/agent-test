/**
 * 侧栏里的网页预览（agent 的 preview_page、本机服务链接、工作区 .html）：做成浏览器的样子——
 * 工具栏（后退 / 前进 / 刷新 + 地址栏 + 在系统浏览器或访达里打开）+ 下面的页面。
 *
 * - 地址栏跟着页面走：iframe 是跨源的，界面自己看不到它跳到了哪，由 main 把它的每次导航报过来（onSiteNavigated）；
 * - 地址栏可以直接输入：本机服务（localhost:端口/路径）或当前工作区里的页面路径，回车加载；
 * - 后退 / 前进用这个标签自己记的历史重新加载那一页（见 site-browser.ts：多个网页标签共用窗口的会话历史，
 *   调 history.back() 可能退掉别的标签里的页面）。
 */
import { ArrowLeft, ArrowRight, ExternalLink, FolderOpen, RotateCw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SITE_FRAME_PREFIX } from '../../../../shared/desktop';
import { portUrl, SiteBody } from '../viewer/file-viewer';
import { type PreviewSpec, previewLocation } from '../viewer/preview-target';
import {
  canGoBack,
  canGoForward,
  currentUrl,
  displayAddress,
  EMPTY_HISTORY,
  navigated,
  resolveAddress,
  type SiteHistory,
  step,
  visit,
} from './site-browser';

export function SitePane({ spec, workspaceDir }: { spec: PreviewSpec; workspaceDir: string | null }) {
  const { t } = useTranslation();
  const frameName = `${SITE_FRAME_PREFIX}${useId()}`;
  const [history, setHistory] = useState<SiteHistory>(EMPTY_HISTORY);
  // 要加载的地址：null = spec 的初始地址；seq 变了就重新挂 iframe（刷新、后退 / 前进、地址栏回车都是重新加载那一页）
  const [load, setLoad] = useState<{ url: string | null; seq: number }>({ url: null, seq: 0 });
  // 地址栏里正在输入的内容；null = 没在改，显示当前页面的地址
  const [draft, setDraft] = useState<string | null>(null);
  // 下一次导航事件是不是我们自己发起的那次加载落地（见 site-browser.ts 的 navigated）
  const settling = useRef(true);

  useEffect(
    () =>
      window.desktop.onSiteNavigated((name, url) => {
        if (name !== frameName) return;
        const own = settling.current;
        settling.current = false;
        setHistory((h) => navigated(h, url, own));
      }),
    [frameName],
  );

  const current = currentUrl(history);
  const address = current ? displayAddress(current) : previewLocation(spec);
  const reload = (url: string | null) => {
    settling.current = true;
    setLoad((l) => ({ url, seq: l.seq + 1 }));
  };
  const go = (delta: -1 | 1) => {
    const next = step(history, delta);
    if (next === history) return;
    setHistory(next);
    reload(currentUrl(next));
  };
  /** 地址栏回车：能预览就加载并返回 true；不能预览的提示原因，留在编辑状态 */
  const submitAddress = (): boolean => {
    // 首次加载还没落地时本机服务也能算出当前地址；静态页要等它的源算出来
    const base = current ?? (spec.kind === 'port' ? portUrl(spec) : null);
    const target = base && draft !== null ? resolveAddress(draft, base) : null;
    if (!target) {
      toast.error(t('viewer.browser.invalidAddress'));
      return false;
    }
    setDraft(null);
    setHistory((h) => visit(h, target));
    reload(target);
    return true;
  };

  const http = current ? /^https?:/.test(current) : spec.kind === 'port';
  const external = http ? (current ?? (spec.kind === 'port' ? portUrl(spec) : null)) : null;
  // 静态页：地址就是工作区里的路径
  const absPath = !http && workspaceDir ? `${workspaceDir.replace(/\/+$/, '')}${address.split(/[?#]/)[0]}` : null;

  return (
    <section className="flex h-full min-w-0 flex-col bg-background" data-testid="site-pane">
      <header className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('viewer.browser.back')}
          title={t('viewer.browser.back')}
          disabled={!canGoBack(history)}
          onClick={() => go(-1)}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('viewer.browser.forward')}
          title={t('viewer.browser.forward')}
          disabled={!canGoForward(history)}
          onClick={() => go(1)}
        >
          <ArrowRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
          onClick={() => reload(current ?? load.url)}
        >
          <RotateCw />
        </Button>
        <Input
          aria-label={t('viewer.browser.address')}
          title={spec.title}
          value={draft ?? address}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              // 加载后像浏览器一样离开地址栏（回到居中显示当前地址）
              if (submitAddress()) e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              // 放弃修改；不让 Esc 冒到侧栏（那是收起侧栏）
              e.stopPropagation();
              setDraft(null);
              e.currentTarget.blur();
            }
          }}
          // 像浏览器的地址栏：平时居中显示，点进去靠左编辑
          className="mx-1.5 h-8 min-w-0 flex-1 rounded-lg border-transparent bg-muted text-center font-mono text-xs shadow-none focus-visible:text-left"
        />
        {external && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.openInBrowser')}
            title={t('common.openInBrowser')}
            onClick={() => void window.desktop.openExternal(external)}
          >
            <ExternalLink />
          </Button>
        )}
        {absPath && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.showInFinder')}
            title={t('common.showInFinder')}
            onClick={() => void window.desktop.showInFolder(absPath)}
          >
            <FolderOpen />
          </Button>
        )}
      </header>
      {/* 页面贴着工具栏和侧栏边缘铺满，四周不留白 */}
      <div className="flex min-h-0 flex-1">
        <SiteBody key={load.seq} spec={spec} workspaceDir={workspaceDir} url={load.url} frameName={frameName} flush />
      </div>
    </section>
  );
}
