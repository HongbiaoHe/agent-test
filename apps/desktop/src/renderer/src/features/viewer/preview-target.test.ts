import { describe, expect, it } from 'vitest';
import { previewTargetOf } from './preview-target';

const WS = '/Users/me/project';

describe('previewTargetOf', () => {
  it('http(s) 按扩展名识别媒体与文档', () => {
    const cdn = 'https://assets.presslogic.com/aigc/tasks/images/2026/a%20b.jpeg?x=1';
    expect(previewTargetOf(cdn, WS)).toEqual({ source: 'url', url: cdn, kind: 'image', name: 'a b.jpeg' });
    expect(previewTargetOf('https://x.test/v.MP4', WS)).toMatchObject({ kind: 'video' });
    expect(previewTargetOf('http://x.test/a.mp3', WS)).toMatchObject({ kind: 'audio' });
    expect(previewTargetOf('https://x.test/README.md', WS)).toMatchObject({ kind: 'markdown' });
    expect(previewTargetOf('https://x.test/log.txt', WS)).toMatchObject({ kind: 'text' });
  });

  it('认不出类型的网页链接不预览（交给系统浏览器）', () => {
    expect(previewTargetOf('https://example.com/', WS)).toBeNull();
    expect(previewTargetOf('https://example.com/docs/page', WS)).toBeNull();
  });

  it('相对路径 / 工作区内绝对路径 / file:// → 工作区文件', () => {
    expect(previewTargetOf('./out/report.md', WS)).toEqual({ source: 'workspace', path: 'out/report.md', name: 'report.md' });
    expect(previewTargetOf('out/%E5%9B%BE.png', WS)).toMatchObject({ path: 'out/图.png' });
    expect(previewTargetOf(`${WS}/a.png`, WS)).toMatchObject({ source: 'workspace', path: 'a.png' });
    expect(previewTargetOf(`file://${WS}/docs/x.md`, `${WS}/`)).toMatchObject({ path: 'docs/x.md' });
  });

  it('本机服务链接 → 端口网页预览（保留路径、查询串、锚点）', () => {
    expect(previewTargetOf('http://localhost:5173/', WS)).toEqual({
      source: 'site',
      spec: { kind: 'port', port: 5173, path: '/', title: 'localhost:5173' },
    });
    expect(previewTargetOf('http://127.0.0.1:3000/app?tab=1#top', WS)).toEqual({
      source: 'site',
      spec: { kind: 'port', port: 3000, path: '/app?tab=1#top', title: '127.0.0.1:3000' },
    });
    expect(previewTargetOf('http://localhost/', WS)).toMatchObject({ spec: { port: 80 } });
    // 本机服务上的媒体文件仍按媒体预览
    expect(previewTargetOf('http://localhost:3000/a.png', WS)).toMatchObject({ source: 'url', kind: 'image' });
    // https 本机 / 非本机网页仍交给系统浏览器
    expect(previewTargetOf('https://localhost:8443/', WS)).toBeNull();
    expect(previewTargetOf('http://example.com:8080/', WS)).toBeNull();
  });

  it('工作区里的 .html → 静态网页预览', () => {
    expect(previewTargetOf('./site/index.html', WS)).toEqual({
      source: 'site',
      spec: { kind: 'file', path: 'site/index.html', title: 'index.html' },
    });
    expect(previewTargetOf(`${WS}/a.HTM`, WS)).toMatchObject({ spec: { kind: 'file', path: 'a.HTM' } });
    expect(previewTargetOf('/etc/x.html', WS)).toBeNull();
  });

  it('工作区外的绝对路径、锚点、其它协议不预览', () => {
    expect(previewTargetOf('/etc/passwd', WS)).toBeNull();
    expect(previewTargetOf('/Users/me/project-other/a.md', WS)).toBeNull();
    expect(previewTargetOf(`${WS}/a.md`, null)).toBeNull();
    expect(previewTargetOf('#section', WS)).toBeNull();
    expect(previewTargetOf('mailto:a@b.test', WS)).toBeNull();
    expect(previewTargetOf('', WS)).toBeNull();
  });
});
