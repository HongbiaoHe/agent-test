"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useRef, type ReactNode } from "react";

gsap.registerPlugin(useGSAP, ScrollTrigger);

interface ScrollRevealProps {
  children: ReactNode;
  className?: string;
  id?: string;
}

/**
 * 通用滚动揭示容器：节内带 data-reveal 的直接/后代元素，在区块进入视口时
 * GSAP stagger 上滑淡入。复用于多个落地页区块，避免重复 useGSAP 样板。
 *
 * - 单个 ScrollTrigger 挂在 timeline 上（符合 ScrollTrigger 规范）。
 * - gsap.matchMedia 包住：减弱动效时不建动画，元素保持自然可见态。
 * - useGSAP 自动 revert，scope 限定在本区块内，选择器不外泄。
 */
export function ScrollReveal({ children, className, id }: ScrollRevealProps) {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from("[data-reveal]", {
          y: 28,
          opacity: 0,
          duration: 0.6,
          stagger: 0.1,
          ease: "power3.out",
          scrollTrigger: { trigger: root.current, start: "top 80%" },
        });
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section ref={root} id={id} className={className}>
      {children}
    </section>
  );
}
