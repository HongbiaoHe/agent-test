/**
 * decideExt 纯函数测试（processor 落盘后缀决策）。
 * processor 主流程与 google client 都要打云端/文件系统，不做单测（设计 M2）。
 */
import { decideExt } from './media.processor';

describe('decideExt', () => {
  it('image/jpeg → jpg', () => expect(decideExt('image/jpeg')).toBe('jpg'));
  it('image/png → png', () => expect(decideExt('image/png')).toBe('png'));
  it('video/mp4 → mp4', () => expect(decideExt('video/mp4')).toBe('mp4'));
  it('未知图像类型兜底 png', () => expect(decideExt('image/webp')).toBe('png'));
});
