import { describe, expect, it } from 'vitest';
import {
  canGoBack,
  canGoForward,
  currentUrl,
  displayAddress,
  EMPTY_HISTORY,
  navigated,
  resolveAddress,
  step,
  visit,
} from './site-browser';

const FILE = 'spark-preview://w-0123456789abcdef/site/index.html';
const PORT = 'http://localhost:3000/about?tab=1#top';

describe('地址栏', () => {
  it('显示：静态页给工作区路径，本机服务给 主机:端口/路径（带查询串与锚点）；中文路径解码', () => {
    expect(displayAddress(FILE)).toBe('/site/index.html');
    expect(displayAddress(PORT)).toBe('localhost:3000/about?tab=1#top');
    expect(displayAddress('spark-preview://w-0123456789abcdef/%E9%A1%B5%E9%9D%A2/a.html')).toBe('/页面/a.html');
    expect(displayAddress('not a url')).toBe('not a url');
  });

  it('输入本机服务地址：带不带 http:// 都行；/ 开头是当前站点下的路径；相对路径相对当前页面', () => {
    expect(resolveAddress('localhost:5173/app', PORT)).toBe('http://localhost:5173/app');
    expect(resolveAddress('http://127.0.0.1:8080/', PORT)).toBe('http://127.0.0.1:8080/');
    expect(resolveAddress('  /users  ', PORT)).toBe('http://localhost:3000/users');
    expect(resolveAddress('contact', PORT)).toBe('http://localhost:3000/contact');
    // 从静态页也能去本机服务
    expect(resolveAddress('localhost:3000', FILE)).toBe('http://localhost:3000/');
  });

  it('输入静态页路径：只在当前工作区里跳', () => {
    expect(resolveAddress('/docs/a.html', FILE)).toBe('spark-preview://w-0123456789abcdef/docs/a.html');
    expect(resolveAddress('other.html', FILE)).toBe('spark-preview://w-0123456789abcdef/site/other.html');
    expect(resolveAddress('spark-preview://w-ffffffffffffffff/x.html', FILE)).toBeNull();
  });

  it('不能预览的地址：外网、https、别的协议、空', () => {
    expect(resolveAddress('https://example.com', PORT)).toBeNull();
    expect(resolveAddress('http://example.com/', PORT)).toBeNull();
    expect(resolveAddress('https://localhost:3000/', PORT)).toBeNull();
    expect(resolveAddress('file:///etc/hosts', FILE)).toBeNull();
    expect(resolveAddress('javascript:alert(1)', PORT)).toBeNull();
    expect(resolveAddress('   ', PORT)).toBeNull();
  });
});

describe('浏览历史', () => {
  const A = 'http://localhost:3000/';
  const B = 'http://localhost:3000/b';
  const C = 'http://localhost:3000/c';

  it('首次加载落地 → 页面里点链接新增 → 后退 / 前进 → 后退后再点链接丢掉前进记录', () => {
    let h = navigated(EMPTY_HISTORY, A, true);
    expect(h).toEqual({ entries: [A], index: 0 });
    expect(canGoBack(h)).toBe(false);
    h = navigated(h, B, false);
    h = navigated(h, C, false);
    expect(h).toEqual({ entries: [A, B, C], index: 2 });
    h = step(h, -1);
    expect(currentUrl(h)).toBe(B);
    expect(canGoBack(h)).toBe(true);
    expect(canGoForward(h)).toBe(true);
    // 后退触发的那次加载落地：地址就是当前这条，不动
    expect(navigated(h, B, true)).toBe(h);
    h = step(h, 1);
    expect(currentUrl(h)).toBe(C);
    h = step(step(h, -1), -1);
    h = navigated(h, C, false);
    expect(h).toEqual({ entries: [A, C], index: 1 });
    expect(canGoForward(h)).toBe(false);
  });

  it('自己发起的加载被重定向：替换当前这条，不新增（否则后退永远回到会重定向的地址）', () => {
    let h = navigated(EMPTY_HISTORY, A, true);
    h = visit(h, B);
    h = navigated(h, C, true);
    expect(h).toEqual({ entries: [A, C], index: 1 });
  });

  it('刷新、重复的导航事件（地址没变）不动；到头了后退 / 前进不动；地址栏回车当成新的访问', () => {
    const h = navigated(EMPTY_HISTORY, A, true);
    expect(navigated(h, A, false)).toBe(h);
    expect(step(h, -1)).toBe(h);
    expect(step(h, 1)).toBe(h);
    expect(visit(h, A)).toBe(h);
    expect(visit(h, B)).toEqual({ entries: [A, B], index: 1 });
  });
});
