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

  it('工作区外的绝对路径、锚点、其它协议不预览', () => {
    expect(previewTargetOf('/etc/passwd', WS)).toBeNull();
    expect(previewTargetOf('/Users/me/project-other/a.md', WS)).toBeNull();
    expect(previewTargetOf(`${WS}/a.md`, null)).toBeNull();
    expect(previewTargetOf('#section', WS)).toBeNull();
    expect(previewTargetOf('mailto:a@b.test', WS)).toBeNull();
    expect(previewTargetOf('', WS)).toBeNull();
  });
});
