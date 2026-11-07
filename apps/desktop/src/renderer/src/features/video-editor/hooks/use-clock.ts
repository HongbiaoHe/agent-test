/**
 * 播放时钟：预览的唯一时间源（墙钟驱动，不跟随某个 <video>，片段切换 / 图片片段 / 空隙都不受影响）。
 * 播放时每帧（rAF）推进并通知订阅者；播放器按它同步媒体元素，时间线播放头与时间显示订阅它重绘，
 * 编辑器其余部分不随每帧重渲染。
 */
import { useState, useSyncExternalStore } from 'react';

export interface PlaybackClock {
  time: () => number;
  playing: () => boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
  /** 成片时长变了（编辑后）：播放到头自动停，当前时间夹进范围 */
  setDuration: (d: number) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createClock(): PlaybackClock {
  let time = 0;
  let playing = false;
  let duration = 0;
  let anchorWall = 0;
  let anchorTime = 0;
  let raf = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };

  const tick = () => {
    if (!playing) return;
    time = anchorTime + (performance.now() - anchorWall) / 1000;
    if (time >= duration) {
      time = duration;
      playing = false;
    } else {
      raf = requestAnimationFrame(tick);
    }
    emit();
  };

  const clock: PlaybackClock = {
    time: () => time,
    playing: () => playing,
    play() {
      if (playing || duration <= 0) return;
      // 停在末尾时从头播
      if (time >= duration - 1e-3) time = 0;
      playing = true;
      anchorWall = performance.now();
      anchorTime = time;
      raf = requestAnimationFrame(tick);
      emit();
    },
    pause() {
      if (!playing) return;
      cancelAnimationFrame(raf);
      playing = false;
      emit();
    },
    toggle() {
      if (playing) clock.pause();
      else clock.play();
    },
    seek(t) {
      time = Math.min(Math.max(0, t), duration);
      anchorWall = performance.now();
      anchorTime = time;
      emit();
    },
    setDuration(d) {
      duration = Math.max(0, d);
      if (time > duration) clock.seek(duration);
      if (duration === 0) clock.pause();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return clock;
}

/** 编辑器生命周期内的一只时钟（卸载时停掉 rAF） */
export function useCreateClock(): PlaybackClock {
  const [clock] = useState(createClock);
  return clock;
}

export function useClockTime(clock: PlaybackClock): number {
  return useSyncExternalStore(clock.subscribe, clock.time);
}

export function useClockPlaying(clock: PlaybackClock): boolean {
  return useSyncExternalStore(clock.subscribe, clock.playing);
}

/** 只在 select(t) 的结果变化时重渲染（如当前字幕 id） */
export function useClockSelect<T extends string | number | boolean | null>(clock: PlaybackClock, select: (t: number) => T): T {
  return useSyncExternalStore(clock.subscribe, () => select(clock.time()));
}
