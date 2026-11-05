/**
 * main 进程：窗口、设置与 Key（经 IPC 给 renderer）、文件选择框、拉起 agent-host。
 * renderer 不开放 Node 能力（contextIsolation + sandbox），原生能力只经 preload 暴露的 window.desktop。
 */
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, shell } from 'electron';
import { z } from 'zod';
import { PROVIDER_KEYS, THEME_PREFERENCES } from '../shared/desktop';
import { AgentHostManager } from './agent-host';
import { handleMcpSandboxProtocol, registerMcpSandboxScheme } from './mcp-sandbox';
import { DesktopStore } from './store';
import { normalizeApiUrl, sendCode, verifyCode } from './web-account';

// e2e / 多实例隔离：显式指定 userData 目录（必须在 ready 之前设置）
if (process.env.SPARK_USER_DATA_DIR) app.setPath('userData', process.env.SPARK_USER_DATA_DIR);

// MCP Apps 的 sandbox 源（spark-mcp://m-<hash>）：必须在 ready 之前注册为特权协议
registerMcpSandboxScheme();

const userData = app.getPath('userData');
const store = new DesktopStore(userData);
const host = new AgentHostManager(store, userData);

const settingsPatch = z
  .object({
    workspaceDir: z.string(),
    defaultModel: z.string(),
    webApiUrl: z.string(),
    loginSkipped: z.boolean(),
    theme: z.enum(THEME_PREFERENCES),
  })
  .partial();

function registerIpc(): void {
  ipcMain.handle('desktop:getSettings', () => store.getSettings());
  ipcMain.handle('desktop:updateSettings', (_e, patch: unknown) => {
    const next = store.updateSettings(settingsPatch.parse(patch));
    nativeTheme.themeSource = next.theme;
    host.sendConfig();
    return next;
  });
  ipcMain.handle('desktop:getKeyStatus', () => store.keyStatus());
  ipcMain.handle('desktop:setKey', async (_e, provider: unknown, value: unknown) => {
    const status = store.setKey(
      z.enum(PROVIDER_KEYS).parse(provider),
      z.string().nullable().parse(value),
    );
    await host.restart(); // Key 经 env 注入，重启 agent-host 才生效
    return status;
  });
  ipcMain.handle('desktop:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('desktop:pickFiles', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ['openFile' as const, 'multiSelections' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('desktop:openExternal', async (_e, url: unknown) => {
    // 只放行 http(s)：MCP 授权页等
    await shell.openExternal(z.url({ protocol: /^https?$/ }).parse(url));
  });
  ipcMain.handle('desktop:showInFolder', (_e, path: unknown) => {
    shell.showItemInFolder(z.string().parse(path));
  });
  ipcMain.handle('desktop:fetchText', async (_e, url: unknown) => {
    const res = await net.fetch(z.url({ protocol: /^https?$/ }).parse(url));
    if (!res.ok) throw new Error(`读取失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > FETCH_TEXT_MAX_BYTES;
    return { text: buf.subarray(0, FETCH_TEXT_MAX_BYTES).toString('utf8'), truncated };
  });
  ipcMain.on('desktop:requestAgentPort', (e) => host.connect(e.sender));
  ipcMain.handle('desktop:getWebAccount', () => store.webAccount());
  ipcMain.handle('desktop:sendWebCode', (_e, email: unknown, apiUrl: unknown) =>
    sendCode(normalizeApiUrl(z.string().parse(apiUrl)), z.email().parse(email)),
  );
  ipcMain.handle('desktop:signInWeb', async (_e, email: unknown, code: unknown, apiUrl: unknown) => {
    const url = normalizeApiUrl(z.string().parse(apiUrl));
    const mail = z.email().parse(email);
    const token = await verifyCode(url, mail, z.string().min(1).parse(code));
    store.setWebSession(mail, token, url);
    await host.restart(); // 令牌经 env 注入，重启 agent-host 后媒体工具生效
    return store.webAccount();
  });
  ipcMain.handle('desktop:signOutWeb', async () => {
    store.clearWebSession();
    await host.restart();
    return store.webAccount();
  });
}

/** 预览弹窗读远程文本的上限（md / txt 文档足够，防止误点大文件把内存吃满） */
const FETCH_TEXT_MAX_BYTES = 2 * 1024 * 1024;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Spark',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // 外链一律交给系统浏览器，不在应用窗口里打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // 应用是单页：窗口本身永不跳走（否则点了外链 / 图片地址就回不来了）。http(s) 交给系统浏览器
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

void app.whenReady().then(() => {
  // 外观：跟随系统 / 浅色 / 深色。页面靠 prefers-color-scheme 挂 .dark，原生标题栏、滚动条也一起变
  nativeTheme.themeSource = store.getSettings().theme;
  registerIpc();
  handleMcpSandboxProtocol();
  // 不等 agent-host 就绪就开窗口：renderer 的请求会排队，等端口到了再发
  void host.start();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void host.stop();
});
