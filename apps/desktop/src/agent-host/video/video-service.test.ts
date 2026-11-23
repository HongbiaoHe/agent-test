import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyProject, type ReviewFile, type VideoProject } from '@agent-test/video-schema';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { HostEvent } from '../../shared/rpc';
import { ffmpegBinaries } from './ffmpeg-paths';
import { makeFixtures, makeVideo } from './test-media';
import { VideoSnapshots } from './snapshots';
import { exportStamp, VideoService } from './video-service';

let ws: string;
let src: string;
let files: Awaited<ReturnType<typeof makeFixtures>>;
let events: HostEvent[];
let service: VideoService;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'spark-video-svc-'));
  src = await mkdtemp(join(tmpdir(), 'spark-video-src-'));
  files = await makeFixtures(ws);
}, 60_000);
afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
  await rm(src, { recursive: true, force: true });
});
afterEach(() => service?.dispose());

function newService() {
  events = [];
  service = new VideoService({
    workspaceOf: () => ws,
    emit: (e) => events.push(e),
    binaries: ffmpegBinaries,
    snapshots: new VideoSnapshots(join(src, 'snapshots')),
  });
  return service;
}

const exportEvents = () => events.flatMap((e) => (e.type === 'video-export' ? [e] : []));

async function waitFor(cond: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function project(name: string): VideoProject {
  return {
    ...emptyProject(name, { width: 320, height: 240 }),
    video: [
      { id: 'v1', type: 'video', src: files.clipA, sourceDuration: 3, inPoint: 0, outPoint: 2, volume: 1, width: 320, height: 240 },
      { id: 'v2', type: 'image', src: files.logo, duration: 1, width: 200, height: 100 },
    ],
    subtitles: { style: 'bottom-outline', cues: [{ id: 's1', start: 0, end: 1, text: 'hi' }] },
  };
}

describe('VideoService', () => {
  it('probe：视频 / 音频 / 图片的类型、时长、尺寸、音轨', async () => {
    const s = newService();
    const [a, b, music, logo] = await s.probe('c', [files.clipA, files.clipB, files.music, files.logo]);
    expect(a).toMatchObject({ path: files.clipA, kind: 'video', width: 320, height: 240, hasAudio: true });
    expect(a.duration).toBeCloseTo(3, 1);
    expect(b).toMatchObject({ kind: 'video', width: 640, height: 360, hasAudio: false });
    expect(music).toMatchObject({ kind: 'audio', width: null, height: null, hasAudio: true });
    expect(logo).toEqual({ path: files.logo, kind: 'image', duration: null, width: 200, height: 100, hasAudio: false });
  });

  it('read 后开始监听：外部修改防抖后广播 video-file-changed；自己 write 的不回声；close 后不再广播', async () => {
    const s = newService();
    const path = 'videos/watch.sparkvideo.json';
    const first = await s.write('c', path, project('watch'));
    await s.read('c', path);

    const own = await s.write('c', path, project('自己改'));
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toEqual([]);

    await writeFile(join(ws, path), JSON.stringify(project('agent 改')));
    await waitFor(() => events.length > 0);
    expect(events[0]).toMatchObject({ type: 'video-file-changed', conversationId: 'c', path });
    expect(first.ok && own.ok).toBe(true);

    s.close('c', path);
    events.length = 0;
    await writeFile(join(ws, path), JSON.stringify(project('再改')));
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toEqual([]);
  });

  it('审片文件：变化时广播 video-review-changed；readReview 只认合法内容', async () => {
    const s = newService();
    const path = 'videos/rev.sparkvideo.json';
    await s.write('c', path, project('rev'));
    await s.read('c', path);
    expect(await s.readReview('c', path)).toBeNull();

    const review: ReviewFile = {
      version: 1,
      reviewedAt: '2026-11-23T00:00:00.000Z',
      fingerprint: 'abcd1234',
      brief: '15 秒产品广告',
      summary: '整体顺',
      verdict: 'needs_work',
      strengths: [],
      issues: [
        { id: 'r1', start: 0, end: 1, severity: 'high', category: 'hook', problem: '开头平', suggestion: '换镜头', targets: [{ kind: 'video', id: 'v1' }] },
      ],
    };
    await writeFile(join(ws, 'videos/rev.review.json'), JSON.stringify(review));
    await waitFor(() => events.some((e) => e.type === 'video-review-changed'));
    expect(events.find((e) => e.type === 'video-review-changed')).toMatchObject({ conversationId: 'c', path });
    // 改审片文件不算工程变化
    expect(events.some((e) => e.type === 'video-file-changed')).toBe(false);
    expect(await s.readReview('c', path)).toEqual(review);

    await writeFile(join(ws, 'videos/rev.review.json'), '{"version":2}');
    expect(await s.readReview('c', path)).toBeNull();
  });

  it('撤销 agent 修改：每轮第一次写之前存快照，恢复最新一份并消耗掉', async () => {
    const s = newService();
    const snaps = new VideoSnapshots(join(src, 'snap-direct'));
    const path = 'videos/snap.sparkvideo.json';
    const abs = join(ws, path);
    // 新建（文件还不存在）不存快照
    await snaps.capture('c', ws, abs, 'run0');
    await s.write('c', path, project('v0'));
    // 第一轮：两次写只存第一次之前的 v0
    await snaps.capture('c', ws, abs, 'run1');
    await writeFile(abs, JSON.stringify(project('v1')));
    await snaps.capture('c', ws, abs, 'run1');
    await writeFile(abs, JSON.stringify(project('v1b')));
    // 第二轮
    await snaps.capture('c', ws, path, 'run2');
    await writeFile(abs, JSON.stringify(project('v2')));
    // 不是剪辑工程不存
    await snaps.capture('c', ws, join(ws, 'notes.txt'), 'run2');

    expect((await snaps.info('c', path)).count).toBe(2);
    const name = async () => z.object({ name: z.string() }).loose().parse(JSON.parse(await readFile(abs, 'utf8'))).name;
    expect((await snaps.restoreLatest('c', ws, path)).count).toBe(1);
    expect(await name()).toBe('v1b');
    expect((await snaps.restoreLatest('c', ws, path)).count).toBe(0);
    expect(await name()).toBe('v0');
    await expect(snaps.restoreLatest('c', ws, path)).rejects.toThrow();
  });

  it('importFiles：复制到 media/imports/（重名加后缀）并探测；不是文件报错', async () => {
    const s = newService();
    const local = join(src, 'My Clip.mp4');
    await makeVideo(local, { seconds: 1, width: 160, height: 120, audio: true });
    const [one] = await s.importFiles('c', [local]);
    const [two] = await s.importFiles('c', [local]);
    expect(one).toMatchObject({ path: 'media/imports/my-clip.mp4', kind: 'video', width: 160, hasAudio: true });
    expect(two.path).toBe('media/imports/my-clip-2.mp4');
    await expect(s.importFiles('c', [src])).rejects.toThrow(/不是文件/);
    await expect(s.importFiles('c', ['relative.mp4'])).rejects.toThrow(/不是文件/);
  });

  it('export：立即返回 jobId 与 exports/<slug>-<时间>.mp4，推 running → done，成片落盘', async () => {
    const s = newService();
    const path = 'videos/exp.sparkvideo.json';
    await s.write('c', path, project('导出 测试'));
    const { jobId, outputPath } = await s.startExport('c', path, null);
    expect(outputPath).toMatch(/^exports\/导出-测试-\d{8}-\d{6}\.mp4$/);
    await waitFor(() => exportEvents().some((e) => e.status !== 'running'));
    const evs = exportEvents();
    expect(evs.every((e) => e.jobId === jobId)).toBe(true);
    expect(evs[0]).toMatchObject({ status: 'running', progress: 0 });
    expect(evs.at(-1)).toMatchObject({ status: 'done', progress: 1, outputPath });
    const [probe] = await s.probe('c', [outputPath]);
    expect(probe).toMatchObject({ kind: 'video', width: 320, height: 240, hasAudio: true });
    expect(probe.duration).toBeCloseTo(3, 0);
  }, 60_000);

  it('exportCancel：kill ffmpeg、删半成品、推 cancelled；未知 jobId 报错', async () => {
    const s = newService();
    await makeVideo(join(ws, 'media/long.mp4'), { seconds: 30, width: 1280, height: 720, audio: true });
    const path = 'videos/cancel.sparkvideo.json';
    await s.write('c', path, {
      ...emptyProject('cancel', { width: 1920, height: 1080 }),
      video: [{ id: 'v1', type: 'video', src: 'media/long.mp4', sourceDuration: 30, inPoint: 0, outPoint: 30, volume: 1, width: 1280, height: 720 }],
    });
    const { jobId, outputPath } = await s.startExport('c', path, null);
    await waitFor(() => exportEvents().length > 0);
    s.cancelExport(jobId);
    await waitFor(() => exportEvents().some((e) => e.status === 'cancelled'));
    const name = outputPath.split('/').pop();
    expect(await readdir(join(ws, 'exports'))).not.toContain(name);
    expect(() => s.cancelExport(jobId)).toThrow(/导出任务不存在/);
  }, 60_000);

  it('export 前置校验：缺素材 / 空时间线直接报错', async () => {
    const s = newService();
    await s.write('c', 'videos/empty.sparkvideo.json', emptyProject('e', { width: 10, height: 10 }));
    await expect(s.startExport('c', 'videos/empty.sparkvideo.json', null)).rejects.toThrow(/还没有片段/);
    const p = project('missing');
    p.video[1] = { ...p.video[1], src: 'media/gone.png' };
    await s.write('c', 'videos/missing.sparkvideo.json', p);
    await expect(s.startExport('c', 'videos/missing.sparkvideo.json', 720)).rejects.toThrow(/media\/gone\.png/);
  });

  it('exportStamp：本地时间 YYYYMMDD-HHmmss', () => {
    expect(exportStamp(new Date(2026, 10, 7, 9, 5, 3))).toBe('20261107-090503');
  });
});
