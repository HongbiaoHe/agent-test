"use client"

import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

/** 单值滑块（shadcn/ui base-ui 版的精简：只有一个 thumb） */
function Slider({ className, ...props }: SliderPrimitive.Root.Props<number>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      thumbAlignment="edge"
      className={cn("relative w-full touch-none select-none data-disabled:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex h-4 w-full items-center">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <SliderPrimitive.Indicator data-slot="slider-range" className="h-full bg-primary" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          className="block size-3 shrink-0 rounded-full border border-primary bg-background shadow-sm transition-[color,box-shadow] outline-none hover:ring-3 hover:ring-ring/50 focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
