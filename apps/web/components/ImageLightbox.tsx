"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

interface Props {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: Props) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const lastPinch = useRef<number | null>(null);
  const lastTap = useRef<number>(0);
  const dragStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  function pinchDistance(touches: React.TouchList) {
    const t0 = touches.item(0)!;
    const t1 = touches.item(1)!;
    return Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
  }

  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2) {
      lastPinch.current = pinchDistance(e.touches);
    } else if (e.touches.length === 1) {
      const t = e.touches.item(0)!;
      const now = Date.now();
      if (now - lastTap.current < 300) {
        setScale(1);
        setOffset({ x: 0, y: 0 });
      }
      lastTap.current = now;
      dragStart.current = { x: t.clientX, y: t.clientY, ox: offset.x, oy: offset.y };
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    e.stopPropagation();
    if (e.touches.length === 2 && lastPinch.current !== null) {
      const newDist = pinchDistance(e.touches);
      const ratio = newDist / lastPinch.current;
      setScale((s) => Math.min(Math.max(s * ratio, 1), 6));
      lastPinch.current = newDist;
    } else if (e.touches.length === 1 && dragStart.current && scale > 1) {
      const t = e.touches.item(0)!;
      const dx = t.clientX - dragStart.current.x;
      const dy = t.clientY - dragStart.current.y;
      setOffset({ x: dragStart.current.ox + dx, y: dragStart.current.oy + dy });
    }
  }

  function onTouchEnd() {
    lastPinch.current = null;
    dragStart.current = null;
    if (scale < 1.05) { setScale(1); setOffset({ x: 0, y: 0 }); }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ touchAction: "none" }}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 z-10 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
      >
        <X className="h-5 w-5" />
      </button>
      <div
        className="relative max-h-screen max-w-full overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{ touchAction: "none" }}
      >
        <img
          src={src}
          alt={alt ?? ""}
          className="max-h-screen max-w-screen object-contain select-none"
          style={{
            transform: `scale(${scale}) translate(${offset.x / scale}px, ${offset.y / scale}px)`,
            transformOrigin: "center",
            transition: scale === 1 ? "transform 0.2s" : "none",
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}
