"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import Link from "@tiptap/extension-link";
import { Markdown } from "tiptap-markdown";
import { Bold, Italic, Code, List, ListOrdered, Quote } from "lucide-react";
import { cn } from "@/lib/cn";

export interface RichTextEditorHandle {
  insertText: (text: string) => void;
  focus: () => void;
}

interface MentionMember {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

interface Props {
  value: string;
  onChange: (markdown: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  compact?: boolean;
  enterSends?: boolean;
  disabled?: boolean;
  members?: MentionMember[];
}

function ToolbarBtn({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={title}
      className={cn(
        "rounded p-1 text-muted transition hover:bg-panel hover:text-text",
        active && "bg-panel text-accent",
      )}
    >
      {children}
    </button>
  );
}

function buildMentionSuggestion(membersRef: React.RefObject<MentionMember[]>) {
  return {
    items: ({ query }: { query: string }) => {
      const q = query.toLowerCase();
      return (membersRef.current ?? [])
        .filter((m) => m.displayName.toLowerCase().includes(q))
        .slice(0, 8);
    },
    render: () => {
      let el: HTMLDivElement | null = null;
      let selectedIndex = 0;
      let currentItems: MentionMember[] = [];
      let currentCommand: ((props: { id: string; label: string }) => void) | null = null;

      function renderItems() {
        if (!el) return;
        el.innerHTML = "";
        if (currentItems.length === 0) {
          el.style.display = "none";
          return;
        }
        el.style.display = "";
        currentItems.forEach((item, i) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = [
            "w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition cursor-pointer",
            i === selectedIndex
              ? "bg-[color:var(--ch-panel2,#1e2130)] text-[color:var(--ch-text,#e8eaf2)]"
              : "text-[color:var(--ch-muted,#6b7280)] hover:bg-[color:var(--ch-panel2,#1e2130)] hover:text-[color:var(--ch-text,#e8eaf2)]",
          ].join(" ");

          const avatar = document.createElement("div");
          avatar.className = "h-6 w-6 rounded-full bg-[color:var(--ch-accent2,#7c3aed)] flex items-center justify-center text-xs text-white font-semibold shrink-0 overflow-hidden";
          if (item.avatarUrl) {
            const img = document.createElement("img");
            img.src = item.avatarUrl;
            img.alt = "";
            img.className = "h-full w-full object-cover";
            avatar.appendChild(img);
          } else {
            avatar.textContent = item.displayName.slice(0, 1).toUpperCase();
          }

          const name = document.createElement("span");
          name.textContent = item.displayName;

          btn.appendChild(avatar);
          btn.appendChild(name);
          btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            currentCommand?.({ id: item.id, label: item.displayName });
          });
          el!.appendChild(btn);
        });
      }

      function position(clientRect: (() => DOMRect | null) | null | undefined) {
        if (!el || !clientRect) return;
        const rect = clientRect();
        if (!rect) return;
        const vvh = window.visualViewport?.height ?? window.innerHeight;
        const vvy = window.visualViewport?.offsetTop ?? 0;
        const estimatedH = Math.min(currentItems.length * 44 + 8, 320);
        const viewportBottom = vvy + vvh;
        const spaceBelow = viewportBottom - rect.bottom;
        const top = spaceBelow >= estimatedH
          ? rect.bottom + 4
          : Math.max(vvy + 4, rect.top - estimatedH - 4);
        el.style.top = `${top}px`;
        el.style.left = `${rect.left}px`;
        el.style.maxWidth = `${window.innerWidth - rect.left - 8}px`;
      }

      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onStart(props: any) {
          currentItems = props.items as MentionMember[];
          currentCommand = (item: { id: string; label: string }) => (props.command as (p: { id: string; label: string }) => void)(item);
          selectedIndex = 0;

          el = document.createElement("div");
          el.className = "fixed z-[9999] min-w-[180px] rounded-xl border border-[color:var(--ch-border,#2a2d3e)] bg-[color:var(--ch-panel,#141721)] shadow-2xl py-1 overflow-y-auto";
          el.style.maxHeight = "320px";
          document.body.appendChild(el);
          position(props.clientRect as (() => DOMRect | null) | null | undefined);
          renderItems();
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onUpdate(props: any) {
          currentItems = props.items as MentionMember[];
          currentCommand = (item: { id: string; label: string }) => (props.command as (p: { id: string; label: string }) => void)(item);
          selectedIndex = 0;
          position(props.clientRect as (() => DOMRect | null) | null | undefined);
          renderItems();
        },
        onKeyDown({ event }: { event: KeyboardEvent }) {
          if (!currentItems.length) return false;
          if (event.key === "ArrowDown") {
            selectedIndex = (selectedIndex + 1) % currentItems.length;
            renderItems();
            return true;
          }
          if (event.key === "ArrowUp") {
            selectedIndex = (selectedIndex - 1 + currentItems.length) % currentItems.length;
            renderItems();
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            const item = currentItems[selectedIndex];
            if (item) currentCommand?.({ id: item.id, label: item.displayName });
            return true;
          }
          return false;
        },
        onExit() {
          el?.remove();
          el = null;
        },
      };
    },
  };
}

export const RichTextEditor = forwardRef<RichTextEditorHandle, Props>(function RichTextEditor(
  { value, onChange, onSubmit, placeholder, compact, enterSends, disabled, members },
  ref,
) {
  const sendOnEnter = enterSends !== undefined ? enterSends : !!compact;

  const membersRef = useRef<MentionMember[]>(members ?? []);
  useEffect(() => { membersRef.current = members ?? []; }, [members]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: { languageClassPrefix: "language-" } }),
      Placeholder.configure({ placeholder: placeholder ?? "Write a message…" }),
      Markdown.configure({ html: false, tightLists: true }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }),
      Mention.configure({
        HTMLAttributes: { class: "mention-tag" },
        suggestion: buildMentionSuggestion(membersRef),
      }),
    ],
    content: value ? { type: "doc", content: [] } : undefined,
    editorProps: {
      attributes: {
        class: "outline-none min-h-[1.5rem] text-sm text-text",
        autocomplete: "off",
        autocorrect: "off",
        autocapitalize: "off",
        spellcheck: "false",
      },
      handleKeyDown(_, event) {
        if (!editor) return false;
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          onSubmit();
          return true;
        }
        if (sendOnEnter && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          onSubmit();
          return true;
        }
        return false;
      },
    },
    onUpdate({ editor }) {
      onChange(// eslint-disable-next-line @typescript-eslint/no-explicit-any
(editor.storage as any).markdown.getMarkdown() as string);
    },
    immediatelyRender: false,
  });

  useEffect(() => {
    if (!editor) return;
    if (value === "" && // eslint-disable-next-line @typescript-eslint/no-explicit-any
(editor.storage as any).markdown.getMarkdown() as string !== "") {
      editor.commands.clearContent();
    }
  }, [value, editor]);

  useEffect(() => {
    if (!editor || !value) return;
    const current = // eslint-disable-next-line @typescript-eslint/no-explicit-any
(editor.storage as any).markdown.getMarkdown() as string;
    if (!current && value) {
      editor.commands.setContent(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useImperativeHandle(ref, () => ({
    insertText(text: string) {
      editor?.chain().focus().insertContent(text).run();
    },
    focus() {
      editor?.commands.focus();
    },
  }), [editor]);

  if (!editor) return null;

  return (
    <div className={cn("flex flex-col gap-1", disabled && "opacity-50 pointer-events-none")}>
      {!compact && (
        <div className="flex items-center gap-0.5 border-b border-border pb-1">
          <ToolbarBtn active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
            <Bold className="h-3.5 w-3.5" />
          </ToolbarBtn>
          <ToolbarBtn active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
            <Italic className="h-3.5 w-3.5" />
          </ToolbarBtn>
          <ToolbarBtn active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()} title="Inline code">
            <Code className="h-3.5 w-3.5" />
          </ToolbarBtn>
          <ToolbarBtn active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
            <List className="h-3.5 w-3.5" />
          </ToolbarBtn>
          <ToolbarBtn active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered list">
            <ListOrdered className="h-3.5 w-3.5" />
          </ToolbarBtn>
          <ToolbarBtn active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote">
            <Quote className="h-3.5 w-3.5" />
          </ToolbarBtn>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
});
