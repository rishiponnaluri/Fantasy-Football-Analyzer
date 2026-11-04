'use client';

import { useEffect } from 'react';
import { gsap } from 'gsap';

/** Desktop-only, delegated pointer lighting. CSS receives coordinates directly;
 * pointer movement never triggers React renders. */
export default function PointerInteractionLayer() {
  useEffect(() => {
    const media = gsap.matchMedia();
    media.add('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)', () => {
    const root = document.documentElement;
    const ambient = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    root.style.setProperty('--ambient-x', `${ambient.x}px`);
    root.style.setProperty('--ambient-y', `${ambient.y}px`);
    const moveX = gsap.quickTo(ambient, 'x', {
      duration: 0.24,
      ease: 'power2.out',
      onUpdate: () => root.style.setProperty('--ambient-x', `${ambient.x}px`),
    });
    const moveY = gsap.quickTo(ambient, 'y', {
      duration: 0.24,
      ease: 'power2.out',
      onUpdate: () => root.style.setProperty('--ambient-y', `${ambient.y}px`),
    });
    let active: HTMLElement | null = null;
    let frame = 0;
    let latest: PointerEvent | null = null;

    const update = () => {
      frame = 0;
      if (!latest) return;
      const event = latest;
      moveX(event.clientX);
      moveY(event.clientY);
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pointer-reactive]') : null;
      if (target !== active) {
        active?.removeAttribute('data-pointer-active');
        active = target;
        active?.setAttribute('data-pointer-active', 'true');
      }
      if (active) {
        const rect = active.getBoundingClientRect();
        active.style.setProperty('--spot-x', `${Math.max(0, Math.min(rect.width, event.clientX - rect.left))}px`);
        active.style.setProperty('--spot-y', `${Math.max(0, Math.min(rect.height, event.clientY - rect.top))}px`);
      }
      latest = null;
    };
    const onMove = (event: PointerEvent) => {
      latest = event;
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onLeave = () => {
      active?.removeAttribute('data-pointer-active');
      active = null;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      if (frame) cancelAnimationFrame(frame);
      gsap.killTweensOf(ambient);
      root.style.removeProperty('--ambient-x');
      root.style.removeProperty('--ambient-y');
      document.querySelectorAll<HTMLElement>('[data-pointer-active]').forEach(node => node.removeAttribute('data-pointer-active'));
    };
    });
    return () => media.revert();
  }, []);
  return <div className="ambient-pointer-field" aria-hidden="true"/>;
}
