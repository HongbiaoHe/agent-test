#!/bin/sh
# 一键重建：画面 → 音效时间点 → 配乐+音效合成 → 旁白+混音 → 核对 → 发布到 public/videos
set -e
cd "$(dirname "$0")"
node render.mjs video canvas-agent-intro-silent.mp4
node render.mjs cues plan.json
node audio.mjs plan.json
node mix.mjs canvas-agent-intro-silent.mp4 canvas-agent-intro.mp4
ffmpeg -y -loglevel error -i canvas-agent-intro.mp4 -ac 1 -ar 48000 stems/final.wav
node analyze.mjs
# 发布到 /canvas 页面用的位置（仓库里只存这一份；本目录的 mp4 是构建产物，已 gitignore）
PUB=../../apps/frontend/public/videos
cp canvas-agent-intro.mp4 "$PUB/canvas-agent-intro.mp4"
ffmpeg -y -loglevel error -ss 53.5 -i canvas-agent-intro.mp4 -frames:v 1 -q:v 3 "$PUB/canvas-agent-intro-poster.jpg"
