import { describe, expect, it } from 'vitest';
import { parseRange } from './http-range';

describe('parseRange', () => {
  it('没有 Range 头 / 多区间 / 不认识的单位：整份', () => {
    expect(parseRange(null, 100)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-1,5-6', 100)).toEqual({ kind: 'full' });
    expect(parseRange('items=0-1', 100)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=-', 100)).toEqual({ kind: 'full' });
  });

  it('闭区间、开放结尾、后缀区间', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ kind: 'partial', start: 500, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  it('结尾超出文件时截到最后一个字节', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 });
  });

  it('起点在文件之外 / 倒置 / 空后缀：416', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=50-10', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});
