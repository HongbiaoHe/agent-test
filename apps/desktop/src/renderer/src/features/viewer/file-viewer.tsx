/**
 * 全屏预览弹窗：图片 / 视频 / 音频 / Markdown / 文本 / 网页。
 * 关闭方式：右上角关闭按钮、点内容以外的空白（蒙层）、Esc。
 *
 * - 远程链接（http/https）：媒体直接用原生 <img>/<video>/<audio>；md / 文本经 main 取（renderer 跨域受限）；
 * - 工作区文件：经 workspace.read（同右侧工作区面板），图片 / 文本可看，音视频等二进制给「在访达中显示」；
 * - 网页（agent 的 preview_page、本机服务链接、工作区 .html）：iframe 加载，隔离策略见 SITE_SANDBOX。
 * FileViewerProvider 放在 App 根部（无会话，只能看远程链接与本机服务）和 ChatView（带会话，能看工作区文件）两处。
 */
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileWarning, FolderOpen, Loader2, RotateCw, X } from 'lucide-react';
import { type MouseEvent, type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { CodeViewer } from '@/features/chat/components/highlight';
import { Markdown } from '@/features/chat/components/markdown';
import { fetchSandboxFile } from '@/lib/api';
import {
  isMarkdownName,
  type PreviewSpec,
  type PreviewTarget,
  previewLocation,
  previewTargetOf,
} from './preview-target';
import { type FileViewerApi, FileViewerContext } from './viewer-context';

export function FileViewerProvider({
  conversationId = null,
  workspaceDir = null,
  children,
}: {
  conversationId?: string | null;
  workspaceDir?: string | null;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  // 每次打开都换 key：agent 改完页面再调 preview_page 时，同一目标也要重新加载
  const [openCount, setOpenCount] = useState(0);
  const api = useMemo<FileViewerApi>(() => {
    const show = (t: PreviewTarget) => {
      setTarget(t);
      setOpenCount((n) => n + 1);
    };
    return {
      openHref(href) {
        const t = previewTargetOf(href, workspaceDir);
        // 没有会话（如设置里的技能详情）就读不了工作区文件
        if (!t || (t.source === 'workspace' && !conversationId)) return false;
        if (t.source === 'site' && t.spec.kind === 'file' && !workspaceDir) return false;
        show(t);
        return true;
      },
      show,
    };
  }, [conversationId, workspaceDir]);
  return (
    <FileViewerContext.Provider value={api}>
      {children}
      <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        {target && (
          <FileViewerContent
            key={openCount}
            target={target}
            conversationId={conversationId}
            workspaceDir={workspaceDir}
            onClose={() => setTarget(null)}
          />
        )}
      </Dialog>
    </FileViewerContext.Provider>
  );
}

function FileViewerContent({
  target,
  conversationId,
  workspaceDir,
  onClose,
}: {
  target: PreviewTarget;
  conversationId: string | null;
  workspaceDir: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // 点到内容本身不关；点到空白（事件目标就是这一层容器）才关
  const closeOnBlank = (e: MouseEvent<HTMLElement>) => {
    if (e.target === e.currentTarget) onClose();
  };
  // 网页预览的「刷新」：换 key 让 iframe 重新加载（spark-preview 响应 no-store，拿到的是最新文件）
  const [reloadKey, setReloadKey] = useState(0);
  const wsPath =
    target.source === 'workspace' ? target.path : target.source === 'site' && target.spec.kind === 'file' ? target.spec.path : null;
  const absPath = wsPath && workspaceDir ? `${workspaceDir.replace(/\/+$/, '')}/${wsPath}` : null;
  const externalUrl =
    target.source === 'url' ? target.url : target.source === 'site' && target.spec.kind === 'port' ? portUrl(target.spec) : null;
  const name = target.source === 'site' ? target.spec.title : target.name;

  return (
    <DialogContent
      showCloseButton={false}
      data-testid="file-viewer"
      onClick={closeOnBlank}
      className="top-0 left-0 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background/95 p-0 ring-0 backdrop-blur-sm sm:max-w-none"
    >
      {/* pl-20：给 macOS 左上角的红绿灯留位置 */}
      <header className="flex h-12 shrink-0 items-center gap-2 pr-3 pl-20" onClick={closeOnBlank}>
        <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium">
          {name}
          {target.source === 'site' && (
            <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{previewLocation(target.spec)}</span>
          )}
        </DialogTitle>
        {target.source === 'site' && (
          <Button variant="ghost" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
            <RotateCw />
            {t('common.refresh')}
          </Button>
        )}
        {externalUrl && (
          <Button variant="ghost" size="sm" onClick={() => void window.desktop.openExternal(externalUrl)}>
            <ExternalLink />
            {t('common.openInBrowser')}
          </Button>
        )}
        {absPath && (
          <Button variant="ghost" size="sm" onClick={() => void window.desktop.showInFolder(absPath)}>
            <FolderOpen />
            {t('common.showInFinder')}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={t('viewer.closePreview')} onClick={onClose}>
          <X />
        </Button>
      </header>
      {/* 子元素用 m-auto 居中：内容比视口高时仍能从顶部开始滚动（justify-center 会把顶部裁掉） */}
      <div className="flex min-h-0 flex-1 overflow-auto px-6 pb-6" onClick={closeOnBlank} data-testid="file-viewer-backdrop">
        {target.source === 'url' ? (
          <RemoteBody key={target.url} target={target} />
        ) : target.source === 'site' ? (
          <SiteBody key={reloadKey} spec={target.spec} workspaceDir={workspaceDir} />
        ) : conversationId ? (
          <WorkspaceBody conversationId={conversationId} path={target.path} name={target.name} absPath={absPath} />
        ) : null}
      </div>
    </DialogContent>
  );
}

/**
 * iframe sandbox：两种网页都与主窗口不同源（工作区页面在 spark-preview://w-<hash>，本机服务在 http://localhost:端口），
 * 所以给 allow-same-origin——页面能正常用**自己的** localStorage / IndexedDB / cookie（agent 写的应用普遍依赖），
 * 却拿不到主窗口的 window.desktop 与存储。不给 allow-top-navigation：预览页不能把应用窗口跳走
 * （弹出的新窗口由 main 的 setWindowOpenHandler 交给系统浏览器）。同 Web 的 PREVIEW_SANDBOX。
 */
const SITE_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-same-origin';

function portUrl(spec: Extract<PreviewSpec, { kind: 'port' }>): string {
  return `http://localhost:${spec.port}${spec.path}`;
}

function SiteBody({ spec, workspaceDir }: { spec: PreviewSpec; workspaceDir: string | null }) {
  const { t } = useTranslation();
  const fileRoot = spec.kind === 'file' ? workspaceDir : null;
  const origin = useQuery({
    queryKey: ['site-preview-origin', fileRoot],
    queryFn: () => window.desktop.sitePreviewOrigin(fileRoot ?? ''),
    enabled: fileRoot !== null,
    staleTime: Infinity,
    retry: false,
  });
  let src: string;
  if (spec.kind === 'port') {
    src = portUrl(spec);
    // 开发模式下 renderer 自己就跑在 localhost 的某个端口上：同源页面 + allow-same-origin 等于把主窗口交出去
    if (new URL(src).origin === window.location.origin) return <Unavailable message={t('viewer.cannotPreviewSelf')} />;
  } else {
    if (!workspaceDir) return <Unavailable message={t('viewer.noWorkspace')} />;
    if (origin.isPending) return <Loading />;
    if (origin.error || !origin.data) {
      return <Unavailable message={origin.error instanceof Error ? origin.error.message : t('viewer.loadFailed')} />;
    }
    src = `${origin.data}/${spec.path.split('/').map(encodeURIComponent).join('/')}`;
  }
  return (
    <iframe
      src={src}
      title={spec.title}
      sandbox={SITE_SANDBOX}
      // 页面没设背景时 iframe 默认透明，会透出深色蒙层：让 iframe 的配色方案与页面不同，
      // Chromium 就按页面自己的画布色铺一层不透明背景（同浏览器里打开时的样子）
      style={{ colorScheme: 'dark' }}
      className="min-h-0 flex-1 self-stretch rounded-lg border border-border shadow-sm"
    />
  );
}

function RemoteBody({ target }: { target: Extract<PreviewTarget, { source: 'url' }> }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (failed) return <Unavailable message={t('viewer.loadFailed')} url={target.url} />;
  switch (target.kind) {
    case 'image':
      // 远程图片走 CSP img-src https:；运行时 URL，用原生 <img>
      return (
        <img
          src={target.url}
          alt={target.name}
          onError={() => setFailed(true)}
          className="m-auto max-h-full max-w-full rounded-lg object-contain shadow-sm"
        />
      );
    case 'video':
      return (
        <video
          src={target.url}
          controls
          autoPlay
          onError={() => setFailed(true)}
          className="m-auto max-h-full max-w-full rounded-lg"
        />
      );
    case 'audio':
      return (
        <div className="m-auto w-full max-w-lg rounded-xl border border-border bg-card p-4">
          <audio src={target.url} controls autoPlay onError={() => setFailed(true)} className="w-full" />
        </div>
      );
    case 'markdown':
    case 'text':
      return <RemoteText url={target.url} name={target.name} markdown={target.kind === 'markdown'} />;
  }
}

function RemoteText({ url, name, markdown }: { url: string; name: string; markdown: boolean }) {
  const { t } = useTranslation();
  const { data, error, isLoading } = useQuery({
    queryKey: ['remote-text', url],
    queryFn: () => window.desktop.fetchText(url),
    staleTime: 60_000,
    retry: false,
  });
  if (isLoading) return <Loading />;
  if (error || !data) return <Unavailable message={error instanceof Error ? error.message : t('viewer.loadFailed')} url={url} />;
  return <TextDocument text={data.text} name={name} markdown={markdown} truncated={data.truncated} />;
}

function WorkspaceBody({
  conversationId,
  path,
  name,
  absPath,
}: {
  conversationId: string;
  path: string;
  name: string;
  absPath: string | null;
}) {
  const { t } = useTranslation();
  const { data, error, isLoading } = useQuery({
    queryKey: ['sandbox-file', conversationId, path],
    queryFn: () => fetchSandboxFile(conversationId, path),
    staleTime: 30_000,
    retry: false,
  });
  if (isLoading) return <Loading />;
  if (error || !data) return <Unavailable message={error instanceof Error ? error.message : t('viewer.loadFailed')} />;
  if (data.kind === 'image') {
    return <img src={data.dataUrl} alt={name} className="m-auto max-h-full max-w-full rounded-lg object-contain shadow-sm" />;
  }
  if (data.kind === 'binary') {
    return (
      <Unavailable message={t('viewer.unsupportedFile')}>
        {absPath && (
          <Button variant="outline" size="sm" onClick={() => void window.desktop.showInFolder(absPath)}>
            <FolderOpen />
            {t('common.showInFinder')}
          </Button>
        )}
      </Unavailable>
    );
  }
  return <TextDocument text={data.content} name={name} markdown={isMarkdownName(name)} truncated={data.truncated} />;
}

function TextDocument({ text, name, markdown, truncated }: { text: string; name: string; markdown: boolean; truncated: boolean }) {
  const { t } = useTranslation();
  return (
    <article className="m-auto w-full max-w-3xl space-y-3 rounded-xl border border-border bg-card p-8 shadow-sm">
      {markdown ? <Markdown>{text}</Markdown> : <CodeViewer text={text} path={name} strip={false} />}
      {truncated && <p className="text-xs text-muted-foreground">{t('viewer.truncated')}</p>}
    </article>
  );
}

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="m-auto flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {t('common.loading')}
    </div>
  );
}

function Unavailable({ message, url, children }: { message: string; url?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="m-auto flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-8 py-6 text-center text-sm text-muted-foreground">
      <FileWarning className="size-5" />
      <p>{message}</p>
      {url && (
        <Button variant="outline" size="sm" onClick={() => void window.desktop.openExternal(url)}>
          <ExternalLink />
          {t('common.openInBrowser')}
        </Button>
      )}
      {children}
    </div>
  );
}
