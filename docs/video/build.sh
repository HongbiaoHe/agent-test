#!/bin/sh
# 一键重建：画面 → 音效时间点 → 配乐+音效合成 → 旁白+混音 → 核对
set -e
cd "$(dirname "$0")"
node render.mjs video canvas-agent-intro-silent.mp4
node render.mjs cues plan.json
node audio.mjs plan.json
node mix.mjs canvas-agent-intro-silent.mp4 canvas-agent-intro.mp4
ffmpeg -y -loglevel error -i canvas-agent-intro.mp4 -ac 1 -ar 48000 stems/final.wav
node analyze.mjs
# /canvas 页面已换成 docs/video-cinematic/ 那支片子；这一版只在本目录产出，不再发布
