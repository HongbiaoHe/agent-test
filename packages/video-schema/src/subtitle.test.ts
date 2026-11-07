import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subtitleLayout, wrapSubtitle } from './index';

/** 等宽量尺：每个字 1 个单位 */
const mono = (s: string) => [...s].length;

test('中文按字断行，每行不超宽', () => {
  assert.deepEqual(wrapSubtitle('一二三四五六七八九十', 4, mono), ['一二三四', '五六七八', '九十']);
});

test('英文按词断行，空格不留在行首行尾', () => {
  assert.deepEqual(wrapSubtitle('hello big world', 9, mono), ['hello big', 'world']);
  assert.deepEqual(wrapSubtitle('hello world', 5, mono), ['hello', 'world']);
});

test('单词超宽按字拆开', () => {
  assert.deepEqual(wrapSubtitle('abcdefghij', 4, mono), ['abcd', 'efgh', 'ij']);
});

test('避头尾：逗号句号不落到行首，左引号不留在行尾', () => {
  assert.deepEqual(wrapSubtitle('一二三四，五六', 4, mono), ['一二三', '四，五六']);
  assert.deepEqual(wrapSubtitle('一二三「四五」', 4, mono), ['一二三', '「四五」']);
});

test('中英混排与手动换行', () => {
  assert.deepEqual(wrapSubtitle('今天 AI 很强\n第二行', 6, mono), ['今天 AI', '很强', '第二行']);
});

test('放得下就不断', () => {
  assert.deepEqual(wrapSubtitle('短句', 10, mono), ['短句']);
});

test('排版尺寸按画布等比；底框样式行宽再减内边距', () => {
  const l = subtitleLayout('bottom-outline', { width: 1920, height: 1080 });
  assert.equal(l.fontSize, 54);
  assert.equal(l.margin, 1080 * 0.06);
  assert.equal(l.maxLineWidth, 1920 - 2 * 1080 * 0.06);
  const b = subtitleLayout('bottom-box', { width: 1920, height: 1080 });
  assert.equal(b.maxLineWidth, 1920 - 2 * 1080 * 0.06 - 2 * 54 * 0.25);
  assert.equal(b.outline, 0);
});
