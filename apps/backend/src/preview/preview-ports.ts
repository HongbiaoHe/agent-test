/**
 * 不允许预览的沙箱端口：提供方自己的控制面，暴露到浏览器等于把沙箱控制接口交给一个 URL。
 * 来源：e2b SDK 的 Sandbox 类（envdPort = 49983、mcpPort = 50005，node_modules/e2b/dist/index.d.ts）。
 */
export const RESERVED_PREVIEW_PORTS = new Set([49983, 50005]);

export function isPreviewablePort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    !RESERVED_PREVIEW_PORTS.has(port)
  );
}
