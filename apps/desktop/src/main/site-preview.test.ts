import { describe, expect, it, vi } from 'vitest';

// site-preview.ts 顶层引用 electron（protocol / net）：单测只测纯函数，桩掉模块
vi.mock('electron', () => ({ protocol: {}, net: {} }));
const { corsOrigin } = await import('./site-preview');

describe('corsOrigin', () => {
  it('只放行应用自己的界面：打包后的 file://、开发时的 electron-vite 地址', () => {
    expect(corsOrigin('file://', undefined)).toBe('file://');
    expect(corsOrigin('http://localhost:5173', 'http://localhost:5173/')).toBe('http://localhost:5173');
    expect(corsOrigin('http://localhost:5173', undefined)).toBeNull();
  });

  it('工作区网页预览、沙箱 iframe（null）、没有 Origin 的同源请求都不加头', () => {
    expect(corsOrigin('spark-preview://w-abc', 'http://localhost:5173')).toBeNull();
    expect(corsOrigin('null', 'http://localhost:5173')).toBeNull();
    expect(corsOrigin(null, 'http://localhost:5173')).toBeNull();
  });
});
