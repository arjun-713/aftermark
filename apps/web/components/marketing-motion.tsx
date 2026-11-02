"use client";
import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

export function MarketingMotion({
  children,
  className = "marketing",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const context = gsap.context(() => {
        gsap.from(".hero-line > span", {
          yPercent: 105,
          duration: 0.85,
          stagger: 0.1,
          ease: "power4.out",
          clearProps: "transform",
        });
        gsap.from(".hero-context > *", {
          y: 18,
          opacity: 0.25,
          duration: 0.65,
          delay: 0.18,
          stagger: 0.08,
          ease: "power3.out",
          clearProps: "all",
        });
        gsap.utils
          .toArray<HTMLElement>("[data-reveal]")
          .forEach((element, index) => {
            gsap.from(element, {
              y: index % 3 === 0 ? 26 : 18,
              duration: index % 2 === 0 ? 0.7 : 0.55,
              ease: "power3.out",
              scrollTrigger: { trigger: element, start: "top 94%", once: true },
              clearProps: "all",
            });
          });
        gsap.fromTo(
          ".evidence-window",
          { y: 22 },
          {
            y: -12,
            ease: "none",
            scrollTrigger: {
              trigger: ".evidence-showcase",
              start: "top bottom",
              end: "bottom top",
              scrub: true,
            },
          },
        );
      }, root);
      return () => context.revert();
    });
    return () => media.revert();
  }, []);
  return (
    <div ref={root} className={className}>
      {children}
    </div>
  );
}
