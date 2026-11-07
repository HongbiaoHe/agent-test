/** 视频剪辑器模块的对外入口 */
export { VideoEditorView } from './video-editor-view';
export { VideoProjectCard } from './components/video-project-card';
export { VideoEditorOpenerContext, useOpenVideoEditor, type VideoEditorTarget } from './open-editor-context';
export { isVideoProjectPath, parseVideoProjectResult, VIDEO_PROJECT_TOOL, type VideoProjectCardInfo } from './lib/tool-result';
