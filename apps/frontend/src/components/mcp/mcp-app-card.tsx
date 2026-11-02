"use client";

import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  CallToolResult,
  ContentBlock,
  EmbeddedResource,
  ResourceLink,
} from "@modelcontextprotocol/sdk/types.js";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, Maximize2, Minimize2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import {
  fetchMcpAppResource,
  type McpAppArtifact,
  type McpAppResource,
  mcpAppCallTool,
  mcpAppReadResource,
  mcpAppSetModelContext,
} from "./api";
import { currentTheme, hostContext, hostStyles, INLINE_MAX_HEIGHT } from "./host-context";

const HOST_INFO = { name: "Spark Agent", version: "1.0.0" };
/** 外层代理 iframe 的 sandbox：规范要求 allow-scripts + allow-same-origin（代理源本身已与主站隔离） */
const PROXY_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-downloads";
const PERMISSION_POLICY: Record<string, string> = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "geolocation",
  clipboardWrite: "clipboard-write",
};

type DisplayMode = "inline" | "fullscreen";

/** App 发起需审批的工具调用时，等用户在宿主弹窗里确认。 */
interface PendingConfirm {
  toolName: string;
  args: Record<string, unknown>;
  resolve: (ok: boolean) => void;
}

function textOf(blocks: ContentBlock[] | undefined): string {
  return (blocks ?? [])
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** ui/download-file：资源链接新标签打开（跨源无法强制下载），内嵌资源本地生成文件下载。 */
function downloadContents(contents: (EmbeddedResource | ResourceLink)[]): void {
  for (const c of contents) {
    if (c.type === "resource_link") {
      if (isHttpUrl(c.uri)) window.open(c.uri, "_blank", "noopener,noreferrer");
      continue;
    }
    const r = c.resource;
    const blob =
      "blob" in r
        ? new Blob([Uint8Array.from(atob(r.blob), (ch) => ch.charCodeAt(0))], {
            type: r.mimeType ?? "application/octet-stream",
          })
        : new Blob([r.text], { type: r.mimeType ?? "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = r.uri.split("/").pop() || "download";
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

function sandboxUrl(resource: McpAppResource): string {
  const csp = resource.meta?.ui?.csp;
  if (!csp) return `${resource.sandboxOrigin}/`;
  const bytes = new TextEncoder().encode(JSON.stringify(csp));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${resource.sandboxOrigin}/?csp=${b64}`;
}

/**
 * MCP App 卡片（设计 Q9 / Q10）：工具结果里带 UI 资源时，在聊天线程里渲染 App。
 *
 * 结构遵循规范 §Sandbox proxy：本页 →（不同源）外层代理 iframe（后端 m-<hash> 子域名）→ 内层 View。
 * 与 View 的协议交给 ext-apps 的 AppBridge：握手完成（initialized）后推 tool-input / tool-result；
 * View 发起的 tools/call、resources/read 经后端代理到所属 MCP server，需审批的先在宿主侧弹确认。
 */
export function McpAppCard({
  app,
  conversationId,
  toolCallId,
  busy,
  onSendMessage,
}: {
  app: McpAppArtifact;
  conversationId: string | undefined;
  toolCallId: string;
  busy: boolean;
  onSendMessage: (text: string) => void;
}) {
  const resource = useQuery({
    queryKey: ["mcp-app-resource", app.serverId, app.resourceUri],
    queryFn: () => fetchMcpAppResource(app.serverId, app.resourceUri),
    staleTime: Infinity,
    retry: 1,
  });

  if (resource.isLoading) return <Skeleton className="h-48 w-full rounded-xl" />;
  if (resource.isError || !resource.data) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>
          Couldn&apos;t load the {app.serverName} card
          {resource.error instanceof Error ? `: ${resource.error.message}` : "."}
        </span>
      </div>
    );
  }
  return (
    <McpAppFrame
      app={app}
      resource={resource.data}
      conversationId={conversationId}
      toolCallId={toolCallId}
      busy={busy}
      onSendMessage={onSendMessage}
    />
  );
}

function McpAppFrame({
  app,
  resource,
  conversationId,
  toolCallId,
  busy,
  onSendMessage,
}: {
  app: McpAppArtifact;
  resource: McpAppResource;
  conversationId: string | undefined;
  toolCallId: string;
  busy: boolean;
  onSendMessage: (text: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const [height, setHeight] = useState(240);
  const [mode, setMode] = useState<DisplayMode>("inline");
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  // 回调里要读最新值，但不能因它们变化而重建 bridge（重建 = iframe 重新加载）
  const live = useRef({ busy, onSendMessage, conversationId });
  useEffect(() => {
    live.current = { busy, onSendMessage, conversationId };
  });

  const permissions = resource.meta?.ui?.permissions;
  const allow = Object.keys(permissions ?? {})
    .map((k) => PERMISSION_POLICY[k])
    .filter(Boolean)
    .join("; ");
  const bordered = resource.meta?.ui?.prefersBorder !== false;

  useEffect(() => {
    const iframe = iframeRef.current;
    const win = iframe?.contentWindow;
    if (!iframe || !win) return;

    const bridge = new AppBridge(
      null,
      HOST_INFO,
      {
        openLinks: {},
        downloadFile: {},
        serverTools: {},
        serverResources: {},
        logging: {},
        updateModelContext: { text: {} },
        message: { text: {} },
        sandbox: { csp: resource.meta?.ui?.csp, permissions },
      },
      { hostContext: hostContext("inline", iframe.clientWidth || undefined) },
    );
    bridgeRef.current = bridge;
    const toolMeta = (name: string) => resource.tools.find((t) => t.name === name);
    const askUser = (toolName: string, args: Record<string, unknown>) =>
      new Promise<boolean>((resolve) => setConfirm({ toolName, args, resolve }));

    bridge.onsandboxready = () => {
      void bridge.sendSandboxResourceReady({
        html: resource.html,
        csp: resource.meta?.ui?.csp,
        permissions,
      });
    };
    let initialized = false;
    bridge.oninitialized = () => {
      initialized = true;
      void bridge.sendToolInput({ arguments: app.toolInput });
      void bridge.sendToolResult(app.toolResult);
    };
    bridge.oncalltool = async (params) => {
      const tool = toolMeta(params.name);
      const args = params.arguments ?? {};
      // 设计 Q10：需审批且模型也可见的工具，先在宿主侧确认；仅 App 可见的内部工具不打扰用户
      const needsConfirm = tool?.permission === "ask" && tool.visibility.includes("model");
      if (needsConfirm && !(await askUser(params.name, args))) {
        return errorResult("The user declined this action.");
      }
      try {
        return await mcpAppCallTool({
          serverId: app.serverId,
          name: params.name,
          arguments: args,
          confirmed: needsConfirm,
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : "Tool call failed");
      }
    };
    bridge.onreadresource = (params) => mcpAppReadResource(app.serverId, params.uri);
    bridge.onopenlink = async ({ url }) => {
      if (!isHttpUrl(url)) return { isError: true };
      window.open(url, "_blank", "noopener,noreferrer");
      return {};
    };
    bridge.ondownloadfile = async ({ contents }) => {
      downloadContents(contents);
      return {};
    };
    bridge.onmessage = async ({ content }) => {
      const text = textOf(content);
      const { busy: running, onSendMessage: send, conversationId: cid } = live.current;
      if (!text || !cid || running) return { isError: true };
      send(text);
      return {};
    };
    bridge.onupdatemodelcontext = async ({ content, structuredContent }) => {
      const cid = live.current.conversationId;
      if (!cid) return {};
      const text = [textOf(content), structuredContent ? JSON.stringify(structuredContent) : ""]
        .filter(Boolean)
        .join("\n");
      await mcpAppSetModelContext({
        serverId: app.serverId,
        conversationId: cid,
        toolCallId,
        text,
      });
      return {};
    };
    bridge.onrequestdisplaymode = async ({ mode: requested }) => {
      const next: DisplayMode = requested === "fullscreen" ? "fullscreen" : "inline";
      setMode(next);
      return { mode: next };
    };
    bridge.onsizechange = ({ height: h }) => {
      if (typeof h === "number" && h > 0) setHeight(Math.ceil(h));
    };
    bridge.onloggingmessage = (params) => {
      console.debug(`[mcp-app ${app.serverName}]`, params.data);
    };

    // 先连上 bridge 再加载代理页，保证 sandbox-proxy-ready 不会漏收；
    // 已拆除的 bridge（StrictMode 双跑 effect）不再去导航 iframe
    let disposed = false;
    void bridge.connect(new PostMessageTransport(win, win)).then(() => {
      if (!disposed) iframe.src = sandboxUrl(resource);
    });

    // 亮暗切换：重新计算主题变量推给 App
    const themeObserver = new MutationObserver(() => {
      void bridge.sendHostContextChange({ theme: currentTheme(), styles: hostStyles() });
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      disposed = true;
      themeObserver.disconnect();
      bridgeRef.current = null;
      if (!initialized) {
        // 还没握手完：没有可通知的 View，立刻断开，免得旧 bridge 继续响应代理页消息
        void bridge.close();
        return;
      }
      // 规范：拆除前通知 View；App 可能已无响应，不等它
      void bridge
        .teardownResource({})
        .catch(() => undefined)
        .finally(() => void bridge.close());
    };
    // bridge 与 iframe 生命周期绑定在资源上：只在换了资源 / 换了工具调用时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource, app, toolCallId]);

  // 显示模式变化通知 App（容器尺寸随之变化）
  useEffect(() => {
    const bridge = bridgeRef.current;
    const iframe = iframeRef.current;
    if (!bridge || !iframe) return;
    void bridge.sendHostContextChange(hostContext(mode, iframe.clientWidth || undefined));
  }, [mode]);

  // 全屏时 Esc 退出
  useEffect(() => {
    if (mode !== "fullscreen") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMode("inline");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const fullscreen = mode === "fullscreen";

  return (
    <>
      {/* 同一个 DOM 节点在内联 / 全屏间切换样式：iframe 一旦被移动（如进 Dialog portal）就会重新加载 */}
      <div
        className={cn(
          "flex flex-col overflow-hidden",
          // m-0：线程列表的 space-y-* 会给卡片加 margin，fixed 铺满时会被它从底部挤掉一截
          fullscreen
            ? "fixed inset-0 z-50 m-0 bg-background"
            : cn("rounded-xl", bordered && "border border-border bg-card"),
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground",
            (fullscreen || bordered) && "border-b border-border",
          )}
        >
          <AppWindow className="size-3.5 shrink-0" />
          <span className="truncate">{app.serverName}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            onClick={() => setMode(fullscreen ? "inline" : "fullscreen")}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </div>
        <iframe
          ref={iframeRef}
          title={`${app.serverName} app`}
          sandbox={PROXY_SANDBOX}
          allow={allow || undefined}
          className={cn("w-full border-0 bg-transparent", fullscreen && "flex-1")}
          style={fullscreen ? undefined : { height: Math.min(height, INLINE_MAX_HEIGHT) }}
        />
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && confirm) {
            confirm.resolve(false);
            setConfirm(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Allow {app.serverName} to run this?</AlertDialogTitle>
            <AlertDialogDescription>
              The card wants to call{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                {confirm?.toolName}
              </code>
              . This tool is set to require your approval.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm && Object.keys(confirm.args).length > 0 && (
            <pre className="max-h-48 overflow-auto rounded-lg bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-foreground/90">
              {JSON.stringify(confirm.args, null, 2)}
            </pre>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Deny</AlertDialogCancel>
            <Button
              onClick={() => {
                confirm?.resolve(true);
                setConfirm(null);
              }}
            >
              Allow
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
