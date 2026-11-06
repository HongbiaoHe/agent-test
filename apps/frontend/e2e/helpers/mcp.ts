// mcp 用例专用：测试进程里的本地 MCP server + 连接器的接口工具。
import { createServer, type IncomingMessage } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Page } from "@playwright/test";

import type { McpPreset, McpServer as McpServerView } from "@/components/mcp";

import { apiOk } from "../helpers";

/** 卡片的 UI 资源地址（show_card 的 _meta.ui.resourceUri）。 */
export const CARD_URI = "ui://e2e/card";

/**
 * 最小 MCP App（不依赖 SDK，手写 JSON-RPC）：握手 → 显示工具结果 → 再由卡片自己调一次 get_secret。
 * 与 apps/desktop/e2e/skills-mcp.spec.ts 的卡片同款。
 */
const CARD_HTML = `<!doctype html><html><body>
<div id="out">waiting</div><div id="call"></div>
<script>
let seq = 0; const pending = {};
function req(method, params) {
  return new Promise((resolve) => { const id = ++seq; pending[id] = resolve; parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*'); });
}
const text = (r) => ((r && r.content) || []).map((c) => c.text).join('');
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== '2.0') return;
  if (m.id && !m.method && pending[m.id]) { pending[m.id](m.result || m.error); delete pending[m.id]; return; }
  if (m.method === 'ui/notifications/tool-result') {
    document.getElementById('out').textContent = 'APP-RESULT:' + text(m.params);
    req('tools/call', { name: 'get_secret', arguments: {} }).then((r) => {
      document.getElementById('call').textContent = 'APP-CALL:' + text(r);
    });
  }
  if (m.method && m.id) parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*');
});
req('ui/initialize', { appInfo: { name: 'e2e-card', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' })
  .then(() => parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*'));
</script></body></html>`;

/** 三个工具各自返回的标记串（每次运行随机，避免与历史数据混淆）。 */
export interface McpMarkers {
  secret: string;
  danger: string;
  card: string;
}

export interface LocalMcpServer {
  url: string;
  /** 每个工具被 tools/call 调用的次数（服务端视角，用来断言审批前没执行） */
  calls: Record<string, number>;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST") return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/**
 * 起一个无状态 Streamable HTTP MCP server（每个请求新建 server + transport，SDK 的 stateless 用法），
 * 监听 127.0.0.1 随机端口（后端同机，validateUrl 允许本机 http）。工具：
 * - get_secret：只读 → 默认 allow；
 * - danger_op：非只读 → 默认 ask（走审批）；
 * - show_card：只读，带 _meta.ui.resourceUri，并注册对应 ui:// 资源。
 */
export function startMcpServer(markers: McpMarkers): Promise<LocalMcpServer> {
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const http = createServer((req, res) => {
    void (async () => {
      const server = new McpServer({ name: "e2e-mcp", version: "1.0.0" });
      server.registerTool(
        "get_secret",
        { description: "Returns a test secret string.", annotations: { readOnlyHint: true } },
        () => {
          count("get_secret");
          return { content: [{ type: "text", text: markers.secret }] };
        },
      );
      server.registerTool(
        "danger_op",
        {
          description: "Performs a test operation that changes state.",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        () => {
          count("danger_op");
          return { content: [{ type: "text", text: markers.danger }] };
        },
      );
      server.registerTool(
        "show_card",
        {
          description: "Shows an interactive test card.",
          annotations: { readOnlyHint: true },
          _meta: { ui: { resourceUri: CARD_URI } },
        },
        () => {
          count("show_card");
          return { content: [{ type: "text", text: markers.card }] };
        },
      );
      server.registerResource(
        "e2e-card",
        CARD_URI,
        { mimeType: "text/html;profile=mcp-app" },
        (uri) => ({
          contents: [{ uri: uri.href, mimeType: "text/html;profile=mcp-app", text: CARD_HTML }],
        }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    })();
  });
  return new Promise((resolve) => {
    http.listen(0, "127.0.0.1", () => {
      const addr = http.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () =>
          new Promise<void>((done) => {
            http.closeAllConnections();
            http.close(() => done());
          }),
      });
    });
  });
}

// ---- 连接器接口 ----

export async function listConnectors(page: Page): Promise<McpServerView[]> {
  return (await apiOk<{ servers: McpServerView[]; presets: McpPreset[] }>(page, "/mcp/servers"))
    .servers;
}

export function getConnector(page: Page, id: string): Promise<McpServerView> {
  return apiOk<McpServerView>(page, `/mcp/servers/${id}`);
}

/** 清理：删掉测试账号下的全部连接器（账号专用，留下的只可能是本套用例建的）。 */
export async function deleteAllConnectors(page: Page): Promise<void> {
  for (const s of await listConnectors(page)) {
    await apiOk(page, `/mcp/servers/${s.id}`, { method: "DELETE" });
  }
}
