#!/usr/bin/env node
// deepagents 参考文档分节抽取器。
// reference.md 有 2393 行 / 76KB —— 不要整篇 read_file 灌进上下文，按需取章节。
//
// 用法（在仓库任意目录都可，脚本自己定位同目录的 reference.md）：
//   node .claude/skills/deepagents-dev/section.mjs            列出全部章节（先看这个）
//   node .claude/skills/deepagents-dev/section.mjs 9          打印第 9 章全文
//   node .claude/skills/deepagents-dev/section.mjs 9 13 16    打印多章
//   node .claude/skills/deepagents-dev/section.mjs 记忆 流式   按标题关键词匹配
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DOC = join(here, 'reference.md');

const text = await readFile(DOC, 'utf8');
const lines = text.split('\n');

// 用二级标题(## ...)切章。每个 ## 到下一个 ## 之间是一章。
const heads = [];
lines.forEach((line, i) => {
  if (/^## /.test(line)) heads.push({ line: i, title: line.replace(/^##\s+/, '').trim() });
});

const range = (idx) => [
  heads[idx].line,
  idx + 1 < heads.length ? heads[idx + 1].line : lines.length,
];

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`deepagents 参考文档 reference.md —— 共 ${heads.length} 章：\n`);
  for (const h of heads) {
    const num = h.title.match(/^(\d+)\./);
    const tag = num ? num[1].padStart(2, ' ') : '  ';
    console.log(`  [${tag}] ${h.title}`);
  }
  console.log(`\n按号或关键词取章： node ${process.argv[1].split('/').slice(-1)[0]} 9 13   或   node … 记忆`);
  process.exit(0);
}

const hit = new Set();
for (const a of args) {
  if (/^\d+$/.test(a)) {
    const i = heads.findIndex((h) => new RegExp(`^${a}\\.`).test(h.title));
    if (i >= 0) hit.add(i);
    else console.error(`# 无章节号 ${a}`);
  } else {
    let matched = false;
    heads.forEach((h, i) => {
      if (h.title.toLowerCase().includes(a.toLowerCase())) {
        hit.add(i);
        matched = true;
      }
    });
    if (!matched) console.error(`# 无标题匹配 "${a}"`);
  }
}

if (hit.size === 0) process.exit(1);

for (const idx of [...hit].sort((x, y) => x - y)) {
  const [s, e] = range(idx);
  process.stdout.write(lines.slice(s, e).join('\n') + '\n');
}
