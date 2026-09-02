import {
  concatArgs,
  concatListContent,
  ffmpegBin,
  ffmpegMessage,
} from './video-concat';

describe('concatListContent', () => {
  it('每行一个 file，路径用单引号包住', () => {
    expect(concatListContent(['/m/a.mp4', '/m/b.mp4'])).toBe(
      "file '/m/a.mp4'\nfile '/m/b.mp4'\n",
    );
  });

  it('路径里的单引号按 ffmpeg 的写法转义', () => {
    expect(concatListContent(["/m/it's.mp4"])).toBe("file '/m/it'\\''s.mp4'\n");
  });
});

describe('concatArgs', () => {
  it('流拷贝：不重编码', () => {
    expect(concatArgs('/t/l.txt', '/t/o.mp4', 'copy')).toEqual([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      '/t/l.txt',
      '-c',
      'copy',
      '/t/o.mp4',
    ]);
  });

  it('重编码：给定编码器与像素格式（各段参数不一致时的兜底）', () => {
    const args = concatArgs('/t/l.txt', '/t/o.mp4', 'encode');
    expect(args).toContain('libx264');
    expect(args).toContain('yuv420p');
    expect(args).toContain('aac');
    expect(args).not.toContain('copy');
  });
});

describe('ffmpegBin', () => {
  it('缺省 ffmpeg，可用 FFMPEG_PATH 指到别处', () => {
    const prev = process.env.FFMPEG_PATH;
    delete process.env.FFMPEG_PATH;
    expect(ffmpegBin()).toBe('ffmpeg');
    process.env.FFMPEG_PATH = '/opt/homebrew/bin/ffmpeg';
    expect(ffmpegBin()).toBe('/opt/homebrew/bin/ffmpeg');
    if (prev === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prev;
  });
});

describe('ffmpegMessage', () => {
  it('优先取 stderr 末尾几行（ffmpeg 的报错在最后）', () => {
    const err = { stderr: 'l1\nl2\nl3\nl4\nl5\nl6' };
    expect(ffmpegMessage(err)).toBe('l3\nl4\nl5\nl6');
  });

  it('没有 stderr 时退回 Error.message', () => {
    expect(ffmpegMessage(new Error('boom'))).toBe('boom');
  });
});
