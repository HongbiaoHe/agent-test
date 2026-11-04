import { DEFAULT_FONT_FAMILY } from './fonts';
import type {
  DesignCanvas,
  DesignDocument,
  ImageLayer,
  Layer,
  TextLayer,
} from './layer';

/** 新建图层的 id：前端、后端、agent 都用它，不依赖数据库自增。 */
export function newLayerId(prefix: 'img' | 'txt' = 'img'): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export const CANVAS_PRESETS = [
  { key: 'portrait-4x5', label: '竖版 4:5', width: 1080, height: 1350 },
  { key: 'story-9x16', label: '快拍 9:16', width: 1080, height: 1920 },
  { key: 'square', label: '方形 1:1', width: 1080, height: 1080 },
  { key: 'landscape-16x9', label: '横版 16:9', width: 1920, height: 1080 },
  { key: 'poster-3x4', label: '海报 3:4', width: 1200, height: 1600 },
] as const;

export const DEFAULT_CANVAS: DesignCanvas = {
  width: 1080,
  height: 1350,
  background: '#F4F1EC',
};

export function emptyDocument(canvas: DesignCanvas = DEFAULT_CANVAS): DesignDocument {
  return { version: 1, canvas, layers: [] };
}

type LayerGeometry = Pick<Layer, 'x' | 'y' | 'width' | 'height'>;

export function createImageLayer(
  init: LayerGeometry & Partial<Omit<ImageLayer, 'type'>>,
): ImageLayer {
  return {
    id: newLayerId('img'),
    name: '图片',
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    src: null,
    flipX: false,
    flipY: false,
    role: 'element',
    status: 'ready',
    generation: null,
    history: [],
    ...init,
    type: 'image',
  };
}

export function createTextLayer(
  init: LayerGeometry & Partial<Omit<TextLayer, 'type'>>,
): TextLayer {
  return {
    id: newLayerId('txt'),
    name: '文字',
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    text: '双击编辑文字',
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: 64,
    fontWeight: 700,
    fontStyle: 'normal',
    fill: '#1F1B16',
    align: 'left',
    lineHeight: 1.2,
    letterSpacing: 0,
    textDecoration: 'none',
    textTransform: 'none',
    stroke: null,
    shadow: null,
    ...init,
    type: 'text',
  };
}
