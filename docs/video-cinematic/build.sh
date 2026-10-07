#!/bin/sh
# 一键重建《从一个像素开始》：时间表 → 旁白 → 画面（字幕按旁白实测时长）→ 配乐+音效 → 混音 → 核对 → 压缩发布到 public/videos
set -e
cd "$(dirname "$0")"
node render.mjs plan plan.json
node tts.mjs plan.json
node render.mjs video cine-silent.mp4
node audio.mjs plan.json
node mix.mjs cine-silent.mp4 canvas-agent-cinematic.mp4
node analyze.mjs
# 发布到 /canvas 页面：原片带逐帧随机的胶片颗粒，crf 17 有 ~37MB；crf 26 降到 ~11MB，SSIM 0.992，肉眼无差
PUB=../../apps/frontend/public/videos
ffmpeg -y -loglevel error -i canvas-agent-cinematic.mp4 -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -c:a copy -movflags +faststart "$PUB/canvas-agent-cinematic.mp4"
ffmpeg -y -loglevel error -ss 58.5 -i "$PUB/canvas-agent-cinematic.mp4" -frames:v 1 -q:v 3 "$PUB/canvas-agent-cinematic-poster.jpg"
