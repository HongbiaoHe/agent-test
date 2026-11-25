import { describe, expect, it } from 'vitest';
import type { PreviewSpec } from '../viewer/preview-target';
import {
  activateTab,
  closeTab,
  EMPTY_SIDE_PANEL,
  hidePanel,
  openItem,
  openNewTab,
  type SidePanelTabs,
  tabId,
  togglePanel,
} from './side-panel-tabs';

const site = (path: string, title = path): PreviewSpec => ({ kind: 'file', path, title });
const ids = (s: SidePanelTabs) => s.tabs.map((t) => t.id);

describe('侧栏标签', () => {
  it('依次打开网页、剪辑工程、画布：各占一个标签，都留着，最后打开的是当前标签', () => {
    let s = openItem(EMPTY_SIDE_PANEL, { kind: 'site', spec: site('a/index.html'), openCount: 0 });
    s = openItem(s, { kind: 'video', path: 'videos/demo.sparkvideo.json' });
    s = openItem(s, { kind: 'canvas', canvasId: 'c1' });
    expect(ids(s)).toEqual(['site:/a/index.html', 'video:videos/demo.sparkvideo.json', 'canvas:c1']);
    expect(s.activeId).toBe('canvas:c1');
    expect(s.open).toBe(true);
  });

  it('再次打开已经开着的内容：切到那个标签，不新开；网页会重新加载（openCount + 1）并换成新的标题', () => {
    let s = openItem(EMPTY_SIDE_PANEL, { kind: 'site', spec: site('a/index.html', '旧标题'), openCount: 0 });
    s = openItem(s, { kind: 'canvas', canvasId: 'c1' });
    s = openItem(s, { kind: 'site', spec: site('a/index.html', '新标题'), openCount: 0 });
    expect(ids(s)).toEqual(['site:/a/index.html', 'canvas:c1']);
    expect(s.activeId).toBe('site:/a/index.html');
    const tab = s.tabs[0];
    expect(tab.kind === 'site' && tab.openCount).toBe(1);
    expect(tab.kind === 'site' && tab.spec.title).toBe('新标题');
    // 剪辑工程 / 画布再次打开只是切过去
    s = openItem(s, { kind: 'canvas', canvasId: 'c1' });
    expect(ids(s)).toEqual(['site:/a/index.html', 'canvas:c1']);
    expect(s.activeId).toBe('canvas:c1');
  });

  it('加号：打开「新建标签页」；在它上面打开内容就地换掉它（位置不变）；已有一个新建标签页时只是切过去', () => {
    let s = openItem(EMPTY_SIDE_PANEL, { kind: 'canvas', canvasId: 'c1' });
    s = openNewTab(s);
    expect(ids(s)).toEqual(['canvas:c1', 'launcher']);
    expect(s.activeId).toBe('launcher');
    s = activateTab(s, 'canvas:c1');
    s = openNewTab(s);
    expect(ids(s)).toEqual(['canvas:c1', 'launcher']);
    expect(s.activeId).toBe('launcher');

    s = openItem(s, { kind: 'video', path: 'v.sparkvideo.json' });
    expect(ids(s)).toEqual(['canvas:c1', 'video:v.sparkvideo.json']);
    expect(s.activeId).toBe('video:v.sparkvideo.json');
  });

  it('在新建标签页上打开一个已经开着的内容：切到原来那个标签，新建标签页收掉', () => {
    let s = openItem(EMPTY_SIDE_PANEL, { kind: 'canvas', canvasId: 'c1' });
    s = openNewTab(s);
    s = openItem(s, { kind: 'canvas', canvasId: 'c1' });
    expect(ids(s)).toEqual(['canvas:c1']);
    expect(s.activeId).toBe('canvas:c1');
  });

  it('关标签：关的是当前标签就切到右边那个（没有就左边）；关的不是当前标签不影响当前；全关完侧栏收起', () => {
    let s = openItem(EMPTY_SIDE_PANEL, { kind: 'canvas', canvasId: 'a' });
    s = openItem(s, { kind: 'canvas', canvasId: 'b' });
    s = openItem(s, { kind: 'canvas', canvasId: 'c' });
    s = activateTab(s, 'canvas:b');
    s = closeTab(s, 'canvas:b');
    expect(ids(s)).toEqual(['canvas:a', 'canvas:c']);
    expect(s.activeId).toBe('canvas:c');
    s = closeTab(s, 'canvas:a');
    expect(s.activeId).toBe('canvas:c');
    s = { ...s, expanded: true };
    s = closeTab(s, 'canvas:c');
    expect(s).toEqual({ tabs: [], activeId: null, open: false, expanded: false });
    // 关一个不存在的标签：原样返回
    expect(closeTab(s, 'nope')).toBe(s);
  });

  it('收起侧栏：全部标签一起收起但都留着，再打开回到原来的当前标签；一个标签都没有时打开的是新建标签页', () => {
    let s = openItem(EMPTY_SIDE_PANEL, { kind: 'canvas', canvasId: 'a' });
    s = openItem(s, { kind: 'video', path: 'v.sparkvideo.json' });
    s = activateTab(s, 'canvas:a');
    s = hidePanel({ ...s, expanded: true });
    expect(s.open).toBe(false);
    expect(s.expanded).toBe(false);
    expect(ids(s)).toEqual(['canvas:a', 'video:v.sparkvideo.json']);
    s = togglePanel(s);
    expect(s.open).toBe(true);
    expect(s.activeId).toBe('canvas:a');
    expect(togglePanel(s).open).toBe(false);

    const fresh = togglePanel(EMPTY_SIDE_PANEL);
    expect(ids(fresh)).toEqual(['launcher']);
    expect(fresh.open).toBe(true);
  });

  it('收起着的时候打开内容（agent 调了 preview_page）：侧栏重新出现并切到它', () => {
    let s = openItem(EMPTY_SIDE_PANEL, { kind: 'canvas', canvasId: 'a' });
    s = hidePanel(s);
    s = openItem(s, { kind: 'site', spec: site('p/index.html'), openCount: 0 });
    expect(s.open).toBe(true);
    expect(ids(s)).toEqual(['canvas:a', 'site:/p/index.html']);
    expect(s.activeId).toBe('site:/p/index.html');
  });

  it('tabId：端口预览与文件预览、不同端口各是各的标签', () => {
    const port = (p: number): PreviewSpec => ({ kind: 'port', port: p, path: '/', title: 't' });
    expect(tabId({ kind: 'site', spec: port(3000), openCount: 0 })).not.toBe(
      tabId({ kind: 'site', spec: port(5173), openCount: 0 }),
    );
    expect(tabId({ kind: 'launcher' })).toBe('launcher');
  });
});
