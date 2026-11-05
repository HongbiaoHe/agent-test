/**
 * preload：把有限的原生能力以 window.desktop 暴露给 renderer（contextIsolation 下唯一的桥）。
 * agent-host 的 MessagePort 不能经 contextBridge 传递，改用 window.postMessage 转交（Electron 官方做法）。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { AGENT_PORT_CLOSED_MESSAGE, AGENT_PORT_MESSAGE, type DesktopApi } from '../shared/desktop';

const api: DesktopApi = {
  getSettings: () => ipcRenderer.invoke('desktop:getSettings'),
  updateSettings: (patch) => ipcRenderer.invoke('desktop:updateSettings', patch),
  getKeyStatus: () => ipcRenderer.invoke('desktop:getKeyStatus'),
  setKey: (provider, value) => ipcRenderer.invoke('desktop:setKey', provider, value),
  pickFolder: () => ipcRenderer.invoke('desktop:pickFolder'),
  pickFiles: () => ipcRenderer.invoke('desktop:pickFiles'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openExternal: (url) => ipcRenderer.invoke('desktop:openExternal', url),
  showInFolder: (path) => ipcRenderer.invoke('desktop:showInFolder', path),
  fetchText: (url) => ipcRenderer.invoke('desktop:fetchText', url),
  getWebAccount: () => ipcRenderer.invoke('desktop:getWebAccount'),
  sendWebCode: (email, apiUrl) => ipcRenderer.invoke('desktop:sendWebCode', email, apiUrl),
  signInWeb: (email, code, apiUrl) => ipcRenderer.invoke('desktop:signInWeb', email, code, apiUrl),
  signOutWeb: () => ipcRenderer.invoke('desktop:signOutWeb'),
};

contextBridge.exposeInMainWorld('desktop', api);
contextBridge.exposeInMainWorld('desktopAgent', {
  /** renderer 挂好 message 监听后调用：请 main 建一条直连 agent-host 的端口 */
  requestPort: () => ipcRenderer.send('desktop:requestAgentPort'),
});

ipcRenderer.on(AGENT_PORT_MESSAGE, (e) => {
  window.postMessage(AGENT_PORT_MESSAGE, '*', e.ports);
});

ipcRenderer.on(AGENT_PORT_CLOSED_MESSAGE, () => {
  window.postMessage(AGENT_PORT_CLOSED_MESSAGE, '*');
});
