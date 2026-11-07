/**
 * 视频剪辑器端到端（素材用打包的 ffmpeg 现场生成：testsrc 画面 + sine 音频）：
 * 1. 真实模型：agent 调 create_video_project → 对话里的工程卡片 →「打开剪辑器」→ 三轨片段齐全，工程文件可解析；
 * 2. 工作区面板打开工程 → 改出点 / 原声音量 / 加字幕改文本 / 字幕样式 / 背景音乐淡入 → 自动保存落盘 → ⌘Z 撤销一步再落盘；
 * 3. 预览：播放 1 秒后暂停时间前进；<video>/<audio> 经 spark-preview:// 真正载入（含 Range 206）；字幕按时间显示；
 * 4. 导入本机音频为背景音乐：出现在音频轨，文件复制进 media/imports/；
 * 5. 外部修改：无本地改动时自动重载；有未保存改动时冲突提示条，「重新加载」/「保留我的修改」落盘正确；
 * 6. 损坏工程（非法 JSON / schema 不过）：报错页列出问题，不白屏；
 * 7. 导出 720p：进度走完，ffprobe 校验时长 / 音轨 / 高度；再导一次立即取消：状态已取消、无残留文件；
 * 8. 时间线直接编辑：缩放（按钮 / ⌘ 滚轮 / 适应宽度）、拖右边裁剪、拖音频吸附到片段边、拖拽换位 + ⌘Z、
 *    播放头处分割（S）、复制（⌘D）、删除（Delete），每步落盘且工程可解析；
 * 9. 字幕导出与预览一致：长中英混排字幕在三种样式下，导出成片的帧与预览画布截图逐行比对（行数、每行上下左右边界）。
 * 每个用例自建临时目录与素材（失败重跑时也是干净的前置状态）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseProject, type VideoProject } from '@agent-test/video-schema';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { z } from 'zod';
import { apiKey, launch, newChat, saveGoogleKey, screens, sendAndWait, stubOpenDialog, tempDirs } from './helpers';

const req = createRequire(__filename);
const FFMPEG = z.string().parse(req('ffmpeg-static'));
const FFPROBE = z.object({ path: z.string() }).parse(req('ffprobe-static')).path;

// ---------- 素材与工程文件 ----------

function ffmpeg(args: string[], out: string): void {
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
}

/** testsrc 画面 + 正弦原声的 mp4 */
function makeVideo(out: string, seconds: number, freq: number): void {
  ffmpeg(
    [
      '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=30:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${seconds}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    ],
    out,
  );
}

function makeAudio(out: string, seconds: number): void {
  ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${seconds}`, '-c:a', 'aac'], out);
}

const probeSchema = z.object({
  streams: z.array(z.object({ codec_type: z.string(), height: z.number().optional() })),
  format: z.object({ duration: z.string() }),
});

function ffprobe(file: string) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    encoding: 'utf8',
  });
  return probeSchema.parse(JSON.parse(out));
}

function durationOf(file: string): number {
  return Number(ffprobe(file).format.duration);
}

interface MediaSet {
  a: string;
  b: string;
  music: string;
}

/** 在工作区 media/ 下生成两段视频 + 一段音乐（秒数可调），返回工作区相对路径 */
function makeMedia(ws: string, sec: { a: number; b: number; music: number } = { a: 3, b: 2, music: 5 }): MediaSet {
  const media = { a: 'media/a.mp4', b: 'media/b.mp4', music: 'media/music.m4a' };
  makeVideo(join(ws, media.a), sec.a, 440);
  makeVideo(join(ws, media.b), sec.b, 660);
  makeAudio(join(ws, media.music), sec.music);
  return media;
}

/** 两段视频首尾相接 + 一段背景音乐 + 两条字幕（0–1.5 第一句、1.5–3 第二句）；出点按 ffprobe 读的真实时长 */
function demoProject(ws: string, media: MediaSet, name = '演示工程'): VideoProject {
  const da = durationOf(join(ws, media.a));
  const db = durationOf(join(ws, media.b));
  const dm = durationOf(join(ws, media.music));
  return {
    version: 1,
    name,
    canvas: { width: 320, height: 240, fps: 30 },
    video: [
      { id: 'v1', type: 'video', src: media.a, sourceDuration: da, inPoint: 0, outPoint: da, volume: 1, width: 320, height: 240 },
      { id: 'v2', type: 'video', src: media.b, sourceDuration: db, inPoint: 0, outPoint: db, volume: 1, width: 320, height: 240 },
    ],
    audio: [
      { id: 'a1', src: media.music, sourceDuration: dm, start: 0, inPoint: 0, outPoint: dm, volume: 0.6, fadeIn: 0, fadeOut: 0 },
    ],
    subtitles: {
      style: 'bottom-outline',
      cues: [
        { id: 's1', start: 0, end: 1.5, text: '第一句' },
        { id: 's2', start: 1.5, end: 3, text: '第二句' },
      ],
    },
  };
}

function writeProject(ws: string, rel: string, project: VideoProject | string): void {
  const abs = join(ws, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof project === 'string' ? project : `${JSON.stringify(project, null, 2)}\n`);
}

/** 读磁盘上的工程并校验（校验不过直接让断言失败） */
function readProject(ws: string, rel: string): VideoProject {
  const parsed = parseProject(JSON.parse(readFileSync(join(ws, rel), 'utf8')));
  if (!parsed.ok) throw new Error(`工程校验不通过：${parsed.issues.join('; ')}`);
  return parsed.project;
}

// ---------- 界面操作 ----------

const editor = (page: Page) => page.getByTestId('video-editor');
const timeline = (page: Page) => page.getByTestId('video-timeline');
const inspector = (page: Page) => page.getByTestId('video-inspector');
const saveState = (page: Page) => page.getByTestId('video-save-state');
const title = (page: Page) => editor(page).getByRole('heading', { level: 1 });
const clipBlock = (page: Page, label: string): Locator => timeline(page).getByRole('button', { name: label, exact: true });

/** 新建对话 → 工作区文件面板 → 逐级点开目录 → 点工程文件，进入剪辑器视图 */
async function openFromPanel(page: Page, rel: string): Promise<void> {
  await page.getByRole('button', { name: '工作区文件', exact: true }).click();
  const sheet = page.getByRole('dialog');
  const parts = rel.split('/');
  for (const dir of parts.slice(0, -1)) await sheet.getByRole('button', { name: dir, exact: true }).click();
  await sheet.getByRole('button', { name: parts[parts.length - 1], exact: true }).click();
  await expect(page.locator('main[data-view]')).toHaveAttribute('data-view', `video:${rel}`);
  await expect(editor(page)).toBeVisible();
}

/** 准备好工作区（素材 + 工程）后启动、新建对话并从面板打开工程 */
async function openEditor(
  prefix: string,
  setup: (ws: string) => string,
): Promise<{ app: ElectronApplication; page: Page; ws: string; root: string; rel: string }> {
  const dirs = tempDirs(prefix);
  mkdirSync(dirs.workspace, { recursive: true });
  const rel = setup(dirs.workspace);
  const { app, page } = await launch(dirs);
  await newChat(page);
  await openFromPanel(page, rel);
  return { app, page, ws: dirs.workspace, root: dirs.root, rel };
}

/** 等这次编辑写回磁盘：先离开「已保存」，再回到「已保存」 */
async function waitSaved(page: Page): Promise<void> {
  await expect(saveState(page)).toHaveText('已保存', { timeout: 10_000 });
}

/** 播放控件里的当前时间（秒）：「m:ss.s / m:ss.s」的前半 */
async function currentTime(page: Page): Promise<number> {
  const text = (await page.getByTestId('video-time').textContent()) ?? '';
  const m = /^(\d+):(\d+(?:\.\d+)?)/.exec(text.trim());
  if (!m) throw new Error(`读不出当前时间：${text}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 时间线的每秒像素（缩放） */
async function timelinePps(page: Page): Promise<number> {
  return Number(await page.getByTestId('video-timeline-content').getAttribute('data-pps'));
}

/** 点时间线刻度行的 t 秒处 seek（按当前缩放换算横坐标） */
async function seekTimeline(page: Page, t: number): Promise<void> {
  const box = await page.getByTestId('video-timeline-content').boundingBox();
  if (!box) throw new Error('时间线不可见');
  await page.mouse.click(box.x + t * (await timelinePps(page)), box.y + 6);
}

/** 按住目标中心横向拖 dx 像素（分步移动，触发拖拽阈值）；alt = 按住 Alt 关闭吸附 */
async function dragBy(page: Page, target: Locator, dx: number, opts: { alt?: boolean; beforeUp?: () => Promise<void> } = {}): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('拖拽目标不可见');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  if (opts.alt) await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 5 });
  await page.mouse.move(x + dx, y, { steps: 5 });
  await opts.beforeUp?.();
  await page.mouse.up();
  if (opts.alt) await page.keyboard.up('Alt');
}

function exportsOf(ws: string): string[] {
  const dir = join(ws, 'exports');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** 纯色画面（便于从像素里抠出白色字幕）+ 正弦原声的 mp4 */
function makeSolidVideo(out: string, seconds: number, size: string): void {
  ffmpeg(
    [
      '-f', 'lavfi', '-i', `color=c=0x305090:size=${size}:rate=30:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    ],
    out,
  );
}

/** 一张图（png / mp4 的 at 秒那帧）解码成 w×h 灰度像素 */
function grayPixels(file: string, w: number, h: number, at?: number): Buffer {
  return execFileSync(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error',
      ...(at === undefined ? [] : ['-ss', String(at)]),
      '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

interface TextBand {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 白字（灰度 > 200）按行聚成文字行：相邻有字的像素行（间隔 ≤ 3）算一行，返回每行的上下左右边界 */
function textBands(px: Buffer, w: number, h: number): TextBand[] {
  const bands: TextBand[] = [];
  let cur: TextBand | null = null;
  let gap = 0;
  for (let y = 0; y < h; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < w; x++) {
      if ((px[y * w + x] ?? 0) > 200) {
        if (left < 0) left = x;
        right = x;
      }
    }
    if (left < 0) {
      if (cur && ++gap > 3) {
        bands.push(cur);
        cur = null;
      }
      continue;
    }
    gap = 0;
    if (cur) {
      cur.bottom = y;
      cur.left = Math.min(cur.left, left);
      cur.right = Math.max(cur.right, right);
    } else cur = { top: y, bottom: y, left, right };
  }
  if (cur) bands.push(cur);
  // 去掉零星噪点（抗锯齿、视频压缩），以及贴着上下边的条带（预览画布圆角外露出的页面底色）
  return bands.filter((b) => b.bottom - b.top >= 3 && b.top > 0 && b.bottom < h - 1);
}

// ---------- 用例 ----------

test('真实模型：create_video_project → 工程卡片 → 打开剪辑器，三轨齐全、工程文件可解析', async () => {
  test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');
  const dirs = tempDirs('video-tool');
  mkdirSync(dirs.workspace, { recursive: true });
  makeMedia(dirs.workspace);
  const { app, page } = await launch(dirs);
  await saveGoogleKey(page);
  await newChat(page);

  await sendAndWait(
    page,
    '请只调用一次 create_video_project 工具，参数：name 为「E2E 宣传片」；clips 依次为 {path: "media/a.mp4"} 和 {path: "media/b.mp4"}；' +
      'audio 为 [{path: "media/music.m4a", start: 0}]；subtitles 两条：{start: 0, end: 1.5, text: "第一句"} 和 {start: 1.5, end: 3, text: "第二句"}。' +
      '不要调用其它工具，完成后简单回复即可。',
  );

  const card = page.getByTestId('video-project-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('E2E 宣传片');
  await expect(card).toContainText('0:05.0');
  await expect(card).toContainText('视频 2 段');
  await expect(card).toContainText('音频 1 段');
  await expect(card).toContainText('字幕 2 条');

  // 工程文件落在 videos/ 下且能被 parseProject 解析
  const files = readdirSync(join(dirs.workspace, 'videos')).filter((f) => f.endsWith('.sparkvideo.json'));
  expect(files).toHaveLength(1);
  const project = readProject(dirs.workspace, `videos/${files[0]}`);
  expect(project.name).toBe('E2E 宣传片');
  expect(project.video.map((c) => c.src)).toEqual(['media/a.mp4', 'media/b.mp4']);
  expect(project.audio.map((c) => c.src)).toEqual(['media/music.m4a']);
  expect(project.subtitles.cues.map((c) => c.text)).toEqual(['第一句', '第二句']);

  await card.getByRole('button', { name: '打开剪辑器' }).click();
  await expect(page.locator('main[data-view]')).toHaveAttribute('data-view', `video:videos/${files[0]}`);
  await expect(title(page)).toHaveText('E2E 宣传片');
  await expect(page.getByTestId('video-timeline-content').getByRole('button')).toHaveCount(5);
  for (const label of ['a.mp4', 'b.mp4', 'music.m4a', '第一句', '第二句']) await expect(clipBlock(page, label)).toBeVisible();

  // 返回对话
  await editor(page).getByRole('button', { name: '返回对话' }).click();
  await expect(page.locator('main[data-view]')).toHaveAttribute('data-view', /^chat:/);
  await app.close();
});

test('工作区面板打开工程：裁剪 / 原声音量 / 字幕 / 字幕样式 / 淡入，自动保存落盘；⌘Z 撤销一步后再落盘', async () => {
  const { app, page, ws, rel } = await openEditor('video-edit', (ws) => {
    writeProject(ws, 'videos/demo.sparkvideo.json', demoProject(ws, makeMedia(ws)));
    return 'videos/demo.sparkvideo.json';
  });
  await expect(title(page)).toHaveText('演示工程');
  await expect(saveState(page)).toHaveText('已保存');

  // 第一段：出点 2.5、原声音量 0.5
  await clipBlock(page, 'a.mp4').click();
  await inspector(page).getByRole('spinbutton', { name: '出点（秒）' }).fill('2.5');
  await inspector(page).getByRole('spinbutton', { name: '音量' }).fill('0.5');
  // 在播放头（0 秒）处加字幕并改文本
  await editor(page).getByRole('button', { name: '在播放头处添加字幕' }).click();
  await inspector(page).getByRole('textbox', { name: '文本' }).fill('端到端字幕');
  // 字幕样式
  await inspector(page).getByRole('combobox', { name: '字幕样式' }).click();
  await page.getByRole('option', { name: '底部 · 白字半透明底' }).click();
  // 背景音乐淡入 1.5 秒
  await clipBlock(page, 'music.m4a').click();
  await inspector(page).getByRole('spinbutton', { name: '淡入（秒）' }).fill('1.5');

  await expect
    .poll(() => {
      const p = readProject(ws, rel);
      return {
        out: p.video[0].type === 'video' ? p.video[0].outPoint : null,
        volume: p.video[0].type === 'video' ? p.video[0].volume : null,
        cues: p.subtitles.cues.map((c) => c.text),
        style: p.subtitles.style,
        fadeIn: p.audio[0].fadeIn,
      };
    }, { timeout: 10_000 })
    .toEqual({ out: 2.5, volume: 0.5, cues: ['第一句', '端到端字幕', '第二句'], style: 'bottom-box', fadeIn: 1.5 });
  await waitSaved(page);
  await expect(clipBlock(page, '端到端字幕')).toBeVisible();
  await page.screenshot({ path: join(screens, 'video-1-editor.png') });

  // 焦点离开输入框后 ⌘Z：撤销最后一步（淡入），其余改动保留
  await page.getByTestId('video-canvas').click();
  await page.keyboard.press('Meta+z');
  await expect(inspector(page).getByRole('spinbutton', { name: '淡入（秒）' })).toHaveValue('0');
  await expect.poll(() => readProject(ws, rel).audio[0].fadeIn, { timeout: 10_000 }).toBe(0);
  await waitSaved(page);
  const after = readProject(ws, rel);
  expect(after.subtitles.style).toBe('bottom-box');
  expect(after.subtitles.cues).toHaveLength(3);
  expect(after.video[0].type === 'video' && after.video[0].outPoint).toBe(2.5);
  await app.close();
});

test('预览：播放 1 秒后暂停时间前进；<video>/<audio> 经 spark-preview:// 载入（支持 Range）；字幕按时间显示', async () => {
  const { app, page } = await openEditor('video-preview', (ws) => {
    writeProject(ws, 'videos/demo.sparkvideo.json', demoProject(ws, makeMedia(ws)));
    return 'videos/demo.sparkvideo.json';
  });
  const canvas = page.getByTestId('video-canvas');
  // 0 秒：第一条字幕
  await expect(page.getByTestId('video-subtitle')).toHaveText('第一句');

  await editor(page).getByRole('button', { name: '播放', exact: true }).click();
  await page.waitForTimeout(1000);
  await editor(page).getByRole('button', { name: '暂停', exact: true }).click();
  const t = await currentTime(page);
  expect(t).toBeGreaterThanOrEqual(0.5);
  expect(t).toBeLessThan(2);

  // 当前槽的 <video> 与背景音乐 <audio> 真正载入了 spark-preview:// 的素材，且可 seek（服务端支持 Range）
  const media = await canvas.evaluate((root) =>
    [...root.querySelectorAll('video, audio')]
      .filter((el): el is HTMLMediaElement => el instanceof HTMLMediaElement && el.currentSrc !== '')
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        src: el.currentSrc,
        readyState: el.readyState,
        seekableEnd: el.seekable.length ? el.seekable.end(0) : 0,
      })),
  );
  const video = media.find((m) => m.tag === 'video' && m.src.endsWith('/media/a.mp4'));
  const audio = media.find((m) => m.tag === 'audio');
  expect(video?.src).toMatch(/^spark-preview:\/\/w-[a-f0-9]{16}\/media\/a\.mp4$/);
  expect(video?.readyState).toBeGreaterThanOrEqual(2);
  expect(video?.seekableEnd).toBeGreaterThan(2.5);
  expect(audio?.src).toMatch(/\/media\/music\.m4a$/);
  expect(audio?.readyState).toBeGreaterThanOrEqual(2);
  expect(audio?.seekableEnd).toBeGreaterThan(4);

  // 协议层：Range 请求返回 206 与正好请求的字节数
  const range = await app.evaluate(async ({ net }, url) => {
    const res = await net.fetch(url, { headers: { Range: 'bytes=0-99' } });
    return { status: res.status, bytes: (await res.arrayBuffer()).byteLength, contentRange: res.headers.get('content-range') };
  }, video?.src ?? '');
  expect(range.status).toBe(206);
  expect(range.bytes).toBe(100);
  expect(range.contentRange).toMatch(/^bytes 0-99\//);

  // seek 到 2 秒：第二条字幕；4 秒：无字幕（工程总长 5 秒）
  await seekTimeline(page, 2);
  await expect(page.getByTestId('video-subtitle')).toHaveText('第二句');
  expect(Math.abs((await currentTime(page)) - 2)).toBeLessThan(0.25);
  await seekTimeline(page, 4);
  await expect(page.getByTestId('video-subtitle')).toHaveCount(0);
  // 4 秒在第二段里：切到另一个槽播 b.mp4
  await expect
    .poll(() =>
      canvas.evaluate((root) =>
        [...root.querySelectorAll('video')].some(
          (v) => v.style.visibility === 'visible' && v.currentSrc.endsWith('/media/b.mp4') && v.readyState >= 2,
        ),
      ),
    )
    .toBe(true);
  await app.close();
});

test('导入本机音频为背景音乐：出现在音频轨，文件复制进 media/imports/，工程落盘', async () => {
  const { app, page, ws, root, rel } = await openEditor('video-import', (ws) => {
    writeProject(ws, 'videos/demo.sparkvideo.json', demoProject(ws, makeMedia(ws)));
    return 'videos/demo.sparkvideo.json';
  });
  const external = join(root, 'outside', 'BGM Track.m4a');
  makeAudio(external, 4);
  await stubOpenDialog(app, [external]);

  await editor(page).getByRole('button', { name: '添加音频' }).click();
  await expect(clipBlock(page, 'bgm-track.m4a')).toBeVisible();
  expect(existsSync(join(ws, 'media/imports/bgm-track.m4a'))).toBe(true);
  await expect
    .poll(() => readProject(ws, rel).audio.map((a) => a.src), { timeout: 10_000 })
    .toEqual(['media/music.m4a', 'media/imports/bgm-track.m4a']);
  await waitSaved(page);
  const imported = readProject(ws, rel).audio[1];
  expect(imported.start).toBe(0);
  expect(imported.outPoint).toBeCloseTo(durationOf(external), 2);
  await app.close();
});

test('外部修改：无本地改动自动重载；有未保存改动出冲突提示，「重新加载」/「保留我的修改」落盘正确', async () => {
  const { app, page, ws, rel } = await openEditor('video-external', (ws) => {
    writeProject(ws, 'videos/demo.sparkvideo.json', demoProject(ws, makeMedia(ws)));
    return 'videos/demo.sparkvideo.json';
  });
  const base = readProject(ws, rel);
  const nameField = () => inspector(page).getByRole('textbox', { name: '工程名' });
  const banner = page.getByTestId('video-conflict');

  // a) 没有本地改动：外部改名 → 静默重载
  writeProject(ws, rel, { ...base, name: '外部改名一' });
  await expect(title(page)).toHaveText('外部改名一');
  await expect(banner).toHaveCount(0);

  // b) 本地改名（还在 1 秒防抖里）时外部又改 → 冲突提示 →「重新加载」：丢弃本地改动，磁盘仍是外部版本
  await nameField().fill('本地改名二');
  writeProject(ws, rel, { ...base, name: '外部改名二' });
  await expect(banner).toBeVisible();
  await page.screenshot({ path: join(screens, 'video-2-conflict.png') });
  await banner.getByRole('button', { name: '重新加载' }).click();
  await expect(banner).toHaveCount(0);
  await expect(title(page)).toHaveText('外部改名二');
  await expect(nameField()).toHaveValue('外部改名二');
  await page.waitForTimeout(1500); // 越过自动保存的防抖：确认不会把丢弃的改动写回
  expect(readProject(ws, rel).name).toBe('外部改名二');
  await expect(saveState(page)).toHaveText('已保存');

  // c) 再来一次 →「保留我的修改」：强制写回本地版本
  await nameField().fill('本地改名三');
  writeProject(ws, rel, { ...base, name: '外部改名三' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: '保留我的修改' }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => readProject(ws, rel).name, { timeout: 10_000 }).toBe('本地改名三');
  await waitSaved(page);
  await expect(title(page)).toHaveText('本地改名三');

  // d) 之后照常：再改名能自动保存（没有残留的冲突 / 过期 mtime）
  await nameField().fill('本地改名四');
  await expect.poll(() => readProject(ws, rel).name, { timeout: 10_000 }).toBe('本地改名四');
  await expect(banner).toHaveCount(0);
  await app.close();
});

test('损坏工程：非法 JSON 与 schema 不过都显示报错页并列出问题，不白屏', async () => {
  const { app, page } = await openEditor('video-invalid', (ws) => {
    writeProject(ws, 'videos/broken.sparkvideo.json', '{ "version": 1, "name": ');
    const bad = demoProject(ws, makeMedia(ws), '坏工程');
    const first = bad.video[0];
    if (first.type === 'video') first.outPoint = first.sourceDuration + 5;
    writeProject(ws, 'videos/bad.sparkvideo.json', bad);
    return 'videos/broken.sparkvideo.json';
  });
  const invalid = page.getByTestId('video-invalid');
  await expect(invalid).toBeVisible();
  await expect(invalid).toContainText('工程文件有问题，无法在剪辑器里打开');
  await expect(invalid).toContainText('JSON');
  await expect(invalid.getByRole('button', { name: '重试' })).toBeVisible();

  await editor(page).getByRole('button', { name: '返回对话' }).click();
  await expect(page.locator('main[data-view]')).toHaveAttribute('data-view', /^chat:/);
  await openFromPanel(page, 'videos/bad.sparkvideo.json');
  await expect(invalid).toBeVisible();
  await expect(invalid).toContainText('video.0.outPoint: 出点不能超过素材时长');
  await page.screenshot({ path: join(screens, 'video-3-invalid.png') });
  await app.close();
});

test('导出 720p：进度走完，成片时长 / 音轨 / 高度正确；再导一次立即取消，状态已取消且无残留', async () => {
  const { app, page, ws } = await openEditor('video-export', (ws) => {
    // 素材长一些，保证第二次导出在点「取消」时仍在进行
    const media = makeMedia(ws, { a: 10, b: 8, music: 12 });
    const project = demoProject(ws, media, '导出测试');
    const first = project.video[0];
    if (first.type === 'video') {
      first.inPoint = 1;
      first.outPoint = 9;
    }
    project.audio[0].fadeIn = 1;
    project.audio[0].fadeOut = 1;
    writeProject(ws, 'videos/export.sparkvideo.json', project);
    return 'videos/export.sparkvideo.json';
  });
  const total = 8 + durationOf(join(ws, 'media/b.mp4'));

  await editor(page).getByRole('button', { name: '导出', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: '720p' }).click();
  await dialog.getByRole('button', { name: '开始导出' }).click();
  await expect(dialog.getByTestId('video-export-progress')).toBeVisible();
  await expect(dialog.getByText('导出完成')).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: join(screens, 'video-4-export-done.png') });

  const outputs = exportsOf(ws);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toMatch(/^导出测试-\d{8}-\d{6}\.mp4$/);
  await expect(dialog).toContainText(`exports/${outputs[0]}`);
  const info = ffprobe(join(ws, 'exports', outputs[0]));
  expect(Math.abs(Number(info.format.duration) - total)).toBeLessThanOrEqual(0.3);
  expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(true);
  expect(info.streams.find((s) => s.codec_type === 'video')?.height).toBe(720);

  // 再导一次，立刻取消
  await dialog.getByRole('button', { name: '重新导出' }).click();
  await dialog.getByRole('radio', { name: '720p' }).click();
  await dialog.getByRole('button', { name: '开始导出' }).click();
  await dialog.getByRole('button', { name: '取消导出' }).click();
  await expect(dialog.getByText('已取消导出')).toBeVisible({ timeout: 20_000 });
  // 取消后半成品被删掉：exports/ 里仍只有第一次的成片
  await expect.poll(() => exportsOf(ws), { timeout: 5_000 }).toEqual(outputs);
  await page.waitForTimeout(500);
  expect(exportsOf(ws)).toEqual(outputs);
  await app.close();
});

test('时间线编辑：缩放 / 拖边裁剪 / 拖动吸附 / 拖拽换位与撤销 / 分割 / 复制 / 删除，每步落盘', async () => {
  const { app, page, ws, rel } = await openEditor('video-timeline', (ws) => {
    writeProject(ws, 'videos/tl.sparkvideo.json', demoProject(ws, makeMedia(ws)));
    return 'videos/tl.sparkvideo.json';
  });
  await expect(saveState(page)).toHaveText('已保存');
  const ids = () => readProject(ws, rel).video.map((c) => c.id);
  const da = durationOf(join(ws, 'media/a.mp4'));

  // 缩放：放大一档 ×1.5；⌘ + 滚轮继续放大，内容可横向滚动；「适应宽度」回到初始
  const fit = await timelinePps(page);
  await editor(page).getByRole('button', { name: '放大', exact: true }).click();
  await expect.poll(() => timelinePps(page)).toBeCloseTo(fit * 1.5, 3);
  const scroller = page.getByTestId('video-timeline-scroll');
  await scroller.hover();
  await page.keyboard.down('Meta');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Meta');
  await expect.poll(() => timelinePps(page)).toBeGreaterThan(fit * 1.6);
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await editor(page).getByRole('button', { name: '适应宽度', exact: true }).click();
  await expect.poll(() => timelinePps(page)).toBeCloseTo(fit, 3);
  expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(0);
  const pps = await timelinePps(page);

  // 拖 a.mp4 右边往左 1 秒（按住 Alt 不吸附）：出点 = 时长 - 1，后面的 b 顺延
  await dragBy(page, clipBlock(page, 'a.mp4').getByTestId('clip-handle-end'), -pps, { alt: true });
  await expect
    .poll(() => {
      const c = readProject(ws, rel).video[0];
      return c.type === 'video' ? c.outPoint : -1;
    }, { timeout: 10_000 })
    .toBeCloseTo(da - 1, 1);
  await waitSaved(page);
  const aEnd = (() => {
    const c = readProject(ws, rel).video[0];
    return c.type === 'video' ? c.outPoint - c.inPoint : 0;
  })();

  // 拖背景音乐本体到 a 结束处附近（差 4px）：吸附到 a 的结束点，拖动中显示吸附辅助线
  await dragBy(page, clipBlock(page, 'music.m4a'), aEnd * pps + 4, {
    beforeUp: () => expect(page.getByTestId('video-snap-guide')).toBeVisible(),
  });
  await expect.poll(() => readProject(ws, rel).audio[0].start, { timeout: 10_000 }).toBe(aEnd);
  await waitSaved(page);

  // 拖 b.mp4 到 a 前面：换位落盘；⌘Z 撤销这一次拖拽
  await dragBy(page, clipBlock(page, 'b.mp4'), -(aEnd + 0.5) * pps);
  await expect.poll(ids, { timeout: 10_000 }).toEqual(['v2', 'v1']);
  await waitSaved(page);
  await page.keyboard.press('Meta+z');
  await expect.poll(ids, { timeout: 10_000 }).toEqual(['v1', 'v2']);
  await waitSaved(page);
  await page.screenshot({ path: join(screens, 'video-8-timeline.png') });

  // 播放头移到 1 秒，选中 a.mp4，按 S 分割：两半入出点在 1 秒相接，后半段被选中
  await seekTimeline(page, 1);
  await clipBlock(page, 'a.mp4').first().click();
  await page.keyboard.press('s');
  await expect
    .poll(() => readProject(ws, rel).video.map((c) => (c.type === 'video' ? [c.id === 'v2' ? 'v2' : 'a', c.inPoint, c.outPoint] : [])), { timeout: 10_000 })
    .toEqual([['a', 0, 1], ['a', 1, aEnd], ['v2', 0, durationOf(join(ws, 'media/b.mp4'))]]);
  await waitSaved(page);
  await expect(timeline(page).getByRole('button', { name: 'a.mp4', exact: true })).toHaveCount(2);

  // ⌘D 复制选中（后半段）→ 4 段；Delete 删掉副本 → 3 段；工程始终可解析（readProject 内校验）
  await page.keyboard.press('Meta+d');
  await expect.poll(() => readProject(ws, rel).video.length, { timeout: 10_000 }).toBe(4);
  await waitSaved(page);
  await page.keyboard.press('Delete');
  await expect.poll(() => readProject(ws, rel).video.length, { timeout: 10_000 }).toBe(3);
  await waitSaved(page);
  await expect(timeline(page).getByRole('button', { name: 'a.mp4', exact: true })).toHaveCount(2);
  await app.close();
});

test('字幕导出与预览一致：长中英混排字幕自动换行，三种样式下成片帧与预览逐行比对', async () => {
  test.setTimeout(240_000);
  const W = 640;
  const H = 360;
  const text = (style: string) =>
    `【${style}】这是一条很长的字幕，用来检查导出成片时会不会自动换行，并且和预览里看到的行数、位置保持一致。Mixed English words should wrap the same way too.`;
  const projectFor = (style: VideoProject['subtitles']['style']): VideoProject => ({
    version: 1,
    name: '字幕一致性',
    canvas: { width: W, height: H, fps: 30 },
    video: [
      { id: 'v1', type: 'video', src: 'media/solid.mp4', sourceDuration: 3, inPoint: 0, outPoint: 3, volume: 1, width: W, height: H },
    ],
    audio: [],
    subtitles: { style, cues: [{ id: 's1', start: 0, end: 3, text: text(style) }] },
  });
  const rel = 'videos/subtitle.sparkvideo.json';
  const { app, page, ws, root } = await openEditor('video-subtitle-match', (ws) => {
    makeSolidVideo(join(ws, 'media/solid.mp4'), 3, `${W}x${H}`);
    writeProject(ws, rel, projectFor('bottom-outline'));
    return rel;
  });

  for (const style of ['bottom-outline', 'bottom-box', 'top'] as const) {
    if (style !== 'bottom-outline') writeProject(ws, rel, projectFor(style)); // 无本地改动 → 剪辑器自动重载
    const subtitle = page.getByTestId('video-subtitle');
    await seekTimeline(page, 1.5);
    await expect(subtitle).toContainText(`【${style}】`, { timeout: 10_000 });
    await page.waitForTimeout(300);
    const shot = join(root, `preview-${style}.png`);
    await page.getByTestId('video-canvas').screenshot({ path: shot });
    const preview = textBands(grayPixels(shot, W, H), W, H);

    await editor(page).getByRole('button', { name: '导出', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const before = exportsOf(ws);
    await dialog.getByRole('button', { name: before.length ? '重新导出' : '开始导出' }).click();
    if (before.length) await dialog.getByRole('button', { name: '开始导出' }).click();
    await expect(dialog.getByText('导出完成')).toBeVisible({ timeout: 60_000 });
    const out = exportsOf(ws).find((f) => !before.includes(f));
    if (!out) throw new Error('没找到新导出的成片');
    const exported = textBands(grayPixels(join(ws, 'exports', out), W, H, 1.5), W, H);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    console.log(style, JSON.stringify({ preview, exported }));
    // 长字幕确实折成多行，且没有冲出画面（左右都留在边距里）
    expect(preview.length).toBeGreaterThanOrEqual(2);
    expect(String(preview.length)).toBe(await subtitle.getAttribute('data-lines'));
    expect(exported).toHaveLength(preview.length);
    for (const [i, e] of exported.entries()) {
      const p = preview[i];
      expect(e.left).toBeGreaterThan(W * 0.03);
      expect(e.right).toBeLessThan(W * 0.97);
      // 每行上下边界差 ≤ 画布高 1%，左右边界差 ≤ 画布宽 2%（实测都在 3px 内）
      expect(Math.abs(e.top - p.top)).toBeLessThanOrEqual(H * 0.01);
      expect(Math.abs(e.bottom - p.bottom)).toBeLessThanOrEqual(H * 0.01);
      expect(Math.abs(e.left - p.left)).toBeLessThanOrEqual(W * 0.02);
      expect(Math.abs(e.right - p.right)).toBeLessThanOrEqual(W * 0.02);
    }
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.5', '-i', join(ws, 'exports', out), '-frames:v', '1', join(screens, `video-9-export-${style}.png`)]);
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', shot, '-vf', `scale=${W}:${H}`, join(screens, `video-9-preview-${style}.png`)]);
  }
  await app.close();
});
