/**
 * 全屏预览弹窗：图片 / 视频 / 音频 / Markdown / 文本。
 * 关闭方式：右上角关闭按钮、点内容以外的空白（蒙层）、Esc。
 *
 * - 远程链接（http/https）：媒体直接用原生 <img>/<video>/<audio>；md / 文本经 main 取（renderer 跨域受限）；
 * - 工作区文件：经 workspace.read（同右侧工作区面板），图片 / 文本可看，音视频等二进制给「在访达中显示」。
 * FileViewerProvider 放在 App 根部（无会话，只能看远程链接）和 ChatView（带会话，能看工作区文件）两处。
 */
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileWarning, FolderOpen, Loader2, X } from 'lucide-react';
import { type MouseEvent, type ReactNode, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { CodeViewer } from '@/features/chat/components/highlight';
import { Markdown } from '@/features/chat/components/markdown';
import { fetchSandboxFile } from '@/lib/api';
import { isMarkdownName, type PreviewTarget, previewTargetOf } from './preview-target';
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
  const api = useMemo<FileViewerApi>(
    () => ({
      openHref(href) {
        const t = previewTargetOf(href, workspaceDir);
        // 没有会话（如设置里的技能详情）就读不了工作区文件
        if (!t || (t.source === 'workspace' && !conversationId)) return false;
        setTarget(t);
        return true;
      },
      show: setTarget,
    }),
    [conversationId, workspaceDir],
  );
  return (
    <FileViewerContext.Provider value={api}>
      {children}
      <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        {target && (
          <FileViewerContent
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
  // 点到内容本身不关；点到空白（事件目标就是这一层容器）才关
  const closeOnBlank = (e: MouseEvent<HTMLElement>) => {
    if (e.target === e.currentTarget) onClose();
  };
  const absPath = target.source === 'workspace' && workspaceDir ? `${workspaceDir.replace(/\/+$/, '')}/${target.path}` : null;

  return (
    <DialogContent
      showCloseButton={false}
      data-testid="file-viewer"
      onClick={closeOnBlank}
      className="top-0 left-0 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background/95 p-0 ring-0 backdrop-blur-sm sm:max-w-none"
    >
      {/* pl-20：给 macOS 左上角的红绿灯留位置 */}
      <header className="flex h-12 shrink-0 items-center gap-2 pr-3 pl-20" onClick={closeOnBlank}>
        <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium">{target.name}</DialogTitle>
        {target.source === 'url' && (
          <Button variant="ghost" size="sm" onClick={() => void window.desktop.openExternal(target.url)}>
            <ExternalLink />
            在浏览器中打开
          </Button>
        )}
        {absPath && (
          <Button variant="ghost" size="sm" onClick={() => void window.desktop.showInFolder(absPath)}>
            <FolderOpen />
            在访达中显示
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="关闭预览" onClick={onClose}>
          <X />
        </Button>
      </header>
      {/* 子元素用 m-auto 居中：内容比视口高时仍能从顶部开始滚动（justify-center 会把顶部裁掉） */}
      <div className="flex min-h-0 flex-1 overflow-auto px-6 pb-6" onClick={closeOnBlank} data-testid="file-viewer-backdrop">
        {target.source === 'url' ? (
          <RemoteBody key={target.url} target={target} />
        ) : conversationId ? (
          <WorkspaceBody conversationId={conversationId} path={target.path} name={target.name} absPath={absPath} />
        ) : null}
      </div>
    </DialogContent>
  );
}

function RemoteBody({ target }: { target: Extract<PreviewTarget, { source: 'url' }> }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Unavailable message="加载失败" url={target.url} />;
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
  const { data, error, isLoading } = useQuery({
    queryKey: ['remote-text', url],
    queryFn: () => window.desktop.fetchText(url),
    staleTime: 60_000,
    retry: false,
  });
  if (isLoading) return <Loading />;
  if (error || !data) return <Unavailable message={error instanceof Error ? error.message : '加载失败'} url={url} />;
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
  const { data, error, isLoading } = useQuery({
    queryKey: ['sandbox-file', conversationId, path],
    queryFn: () => fetchSandboxFile(conversationId, path),
    staleTime: 30_000,
    retry: false,
  });
  if (isLoading) return <Loading />;
  if (error || !data) return <Unavailable message={error instanceof Error ? error.message : '加载失败'} />;
  if (data.kind === 'image') {
    return <img src={data.dataUrl} alt={name} className="m-auto max-h-full max-w-full rounded-lg object-contain shadow-sm" />;
  }
  if (data.kind === 'binary') {
    return (
      <Unavailable message="这个文件不能在这里预览">
        {absPath && (
          <Button variant="outline" size="sm" onClick={() => void window.desktop.showInFolder(absPath)}>
            <FolderOpen />
            在访达中显示
          </Button>
        )}
      </Unavailable>
    );
  }
  return <TextDocument text={data.content} name={name} markdown={isMarkdownName(name)} truncated={data.truncated} />;
}

function TextDocument({ text, name, markdown, truncated }: { text: string; name: string; markdown: boolean; truncated: boolean }) {
  return (
    <article className="m-auto w-full max-w-3xl space-y-3 rounded-xl border border-border bg-card p-8 shadow-sm">
      {markdown ? <Markdown>{text}</Markdown> : <CodeViewer text={text} path={name} strip={false} />}
      {truncated && <p className="text-xs text-muted-foreground">文件较大，只显示了开头部分。</p>}
    </article>
  );
}

function Loading() {
  return (
    <div className="m-auto flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      加载中…
    </div>
  );
}

function Unavailable({ message, url, children }: { message: string; url?: string; children?: ReactNode }) {
  return (
    <div className="m-auto flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-8 py-6 text-center text-sm text-muted-foreground">
      <FileWarning className="size-5" />
      <p>{message}</p>
      {url && (
        <Button variant="outline" size="sm" onClick={() => void window.desktop.openExternal(url)}>
          <ExternalLink />
          在浏览器中打开
        </Button>
      )}
      {children}
    </div>
  );
}
