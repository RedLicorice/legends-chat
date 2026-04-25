"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import data from "@emoji-mart/data";

const Picker = dynamic(() => import("@emoji-mart/react").then((m) => m.default ?? m), { ssr: false });

interface Props {
  onSelect: (emoji: string, key: string) => void;
  onClose: () => void;
  /** Element the picker anchors to. If omitted, picker floats at pointer position. */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export function EmojiPickerPopover({ onSelect, onClose, anchorRef }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  // Position after mount so we can clamp to viewport
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pickerW = 352;
    const pickerH = 435;
    const margin = 8;

    let x = 0;
    let y = 0;

    if (anchorRef?.current) {
      const r = anchorRef.current.getBoundingClientRect();
      x = r.left;
      y = r.bottom + margin;
      // Flip above if not enough room below
      if (y + pickerH > vh - margin) y = r.top - pickerH - margin;
    } else {
      x = margin;
      y = vh - pickerH - margin;
    }

    // Clamp horizontally
    if (x + pickerW > vw - margin) x = vw - pickerW - margin;
    if (x < margin) x = margin;

    el.style.position = "fixed";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.zIndex = "9999";
  }, [anchorRef]);

  const picker = (
    <div ref={wrapRef} style={{ position: "fixed", zIndex: 9999 }}>
      <Picker
        data={data}
        theme="dark"
        set="native"
        onEmojiSelect={(emoji: { native: string; id: string }) => {
          onSelect(emoji.native, emoji.id);
          onClose();
        }}
        previewPosition="none"
        skinTonePosition="none"
        maxFrequentRows={1}
      />
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(picker, document.body);
}
