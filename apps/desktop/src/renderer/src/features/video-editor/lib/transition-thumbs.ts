/**
 * 转场选择面板的缩略图：用和预览同一套着色器（lib/transition-gl.ts）把两张示意帧合成出来，
 * 所见即实际效果。整个面板共用一个离屏 WebGL 上下文（浏览器对上下文个数有上限），画完拷到各自的 2D 画布。
 * 示意帧是「画面内容」（暖色带 A、冷色带 B），不是界面配色，所以直接写颜色、不用主题 token。
 */
import type { Transition } from '@agent-test/video-schema';
import { TransitionCompositor } from './transition-gl';

interface Shared {
  canvas: HTMLCanvasElement;
  compositor: TransitionCompositor;
  a: HTMLCanvasElement;
  b: HTMLCanvasElement;
}

let shared: Shared | null | undefined;

function sampleFrame(width: number, height: number, from: string, to: string, label: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = `600 ${Math.round(height * 0.5)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, width / 2, height / 2);
  return c;
}

function getShared(width: number, height: number): Shared | null {
  if (shared === undefined) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      shared = {
        canvas,
        compositor: new TransitionCompositor(canvas),
        a: sampleFrame(width, height, '#f59e0b', '#e11d48', 'A'),
        b: sampleFrame(width, height, '#0ea5e9', '#4338ca', 'B'),
      };
    } catch {
      shared = null;
    }
  }
  return shared;
}

/** 把 transition 在进度 progress（1 → 0）时的画面画到 target（2D 画布）上 */
export function drawTransitionThumb(target: HTMLCanvasElement, transition: Transition, progress: number): void {
  const s = getShared(target.width, target.height);
  const ctx = target.getContext('2d');
  if (!s || !ctx) return;
  if (s.canvas.width !== target.width || s.canvas.height !== target.height) {
    s.canvas.width = target.width;
    s.canvas.height = target.height;
  }
  s.compositor.draw({ a: s.a, b: s.b, transition, progress });
  ctx.drawImage(s.canvas, 0, 0);
}
