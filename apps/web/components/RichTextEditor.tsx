"use client";

import { forwardRef, useEffect, useImperativeHandle } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { Bold, Italic, Code, List, ListOrdered, Quote } from "lucide-react";
import { cn } from "@/lib/cn";

export interface RichTextEditorHandle {
  insertText: (text: string) => void;
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (markdown: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  compact?: boolean; // chat mode: enter=send, shift+enter=newline
  disabled?: boolean;
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

export const RichTextEditor = forwardRef<RichTextEditorHandle, Props>(function RichTextEditor(
  { value, onChange, onSubmit, placeholder, compact, disabled },
  ref,
) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: { languageClassPrefix: "language-" } }),
      Placeholder.configure({ placeholder: placeholder ?? "Write a message…" }),
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: value ? { type: "doc", content: [] } : undefined,
    editorProps: {
      attributes: {
        class: "outline-none min-h-[1.5rem] text-sm text-text",
      },
      handleKeyDown(_, event) {
        if (!editor) return false;
        if (compact) {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
            return true;
          }
        } else {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onSubmit();
            return true;
          }
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

  // Sync external value clears (after send)
  useEffect(() => {
    if (!editor) return;
    if (value === "" && // eslint-disable-next-line @typescript-eslint/no-explicit-any
(editor.storage as any).markdown.getMarkdown() as string !== "") {
      editor.commands.clearContent();
    }
  }, [value, editor]);

  // Sync initial value on mount (e.g. draft restore)
  useEffect(() => {
    if (!editor || !value) return;
    // Only set if editor is empty and value is non-empty
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
