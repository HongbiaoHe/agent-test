"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 节点产出的大图 / 播放窗。
 *
 * 卡片上的主视觉宽度只有 256px，且为了排布整齐会裁到 224px 高——真要看清一张图或者
 * 看一段视频，只能靠把整块画布放大，放大完还得再缩回来。这里给一个就地打开的灯箱：
 * 图按原始比例铺满可视区（不裁切），视频带原生控件可以直接播。
 */
export function NodeMediaDialog({
  open,
  onOpenChange,
  url,
  kind,
  title,
  onDownload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** blob object URL（资产接口带鉴权，见 use-media-asset） */
  url: string;
  kind: "image" | "video";
  title: string;
  onDownload: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 比默认弹窗宽得多：这里的主角是素材本身，文字只是注脚。
          高度按视口留白，超出的部分交给素材自己的 object-contain 缩放 */}
      <DialogContent className="w-auto max-w-[min(92vw,1100px)] gap-3 sm:max-w-[min(92vw,1100px)]">
        <DialogHeader className="gap-1 text-left">
          <DialogTitle className="truncate text-sm">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Full-size preview of this node&apos;s output
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[70vh] items-center justify-center overflow-hidden rounded-lg bg-muted">
          {kind === "image" ? (
            // 用原生 img：blob 源 next/image 无法优化
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={title}
              className="max-h-[70vh] w-auto max-w-full object-contain"
            />
          ) : (
            <video
              src={url}
              controls
              autoPlay
              playsInline
              className="max-h-[70vh] w-auto max-w-full"
            />
          )}
        </div>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onDownload}>
            <Download className="size-3.5" />
            Download
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
