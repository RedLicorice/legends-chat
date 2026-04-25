"use client";

import { useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";

interface Props {
  onSubmit: (data: {
    question: string;
    options: string[];
    isAnonymous: boolean;
    allowsMultiple: boolean;
  }) => void;
  onClose: () => void;
}

export function PollCreator({ onSubmit, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [allowsMultiple, setAllowsMultiple] = useState(false);

  const canSubmit =
    question.trim().length > 0 &&
    options.filter((o) => o.trim().length > 0).length >= 2;

  const addOption = () => {
    if (options.length < 10) setOptions((prev) => [...prev, ""]);
  };

  const removeOption = (i: number) => {
    if (options.length > 2) setOptions((prev) => prev.filter((_, idx) => idx !== i));
  };

  const updateOption = (i: number, val: string) => {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? val : o)));
  };

  const handleSubmit = () => {
    const cleanOptions = options.map((o) => o.trim()).filter((o) => o.length > 0);
    if (cleanOptions.length < 2) return;
    onSubmit({ question: question.trim(), options: cleanOptions, isAnonymous, allowsMultiple });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <span className="font-semibold">Create Poll</span>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-panel2 hover:text-text transition">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Question</label>
            <input
              autoFocus
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a question…"
              maxLength={300}
              className="w-full rounded-xl bg-panel2 px-3 py-2.5 text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-accent"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Options</label>
            <div className="space-y-2">
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={opt}
                    onChange={(e) => updateOption(i, e.target.value)}
                    placeholder={`Option ${i + 1}`}
                    maxLength={100}
                    className="flex-1 rounded-xl bg-panel2 px-3 py-2 text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-accent"
                  />
                  {options.length > 2 && (
                    <button type="button" onClick={() => removeOption(i)} className="shrink-0 text-muted hover:text-danger transition">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
              {options.length < 10 && (
                <button
                  type="button"
                  onClick={addOption}
                  className="flex items-center gap-1.5 text-xs text-muted hover:text-accent transition"
                >
                  <Plus className="h-3.5 w-3.5" /> Add option
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2.5 rounded-xl bg-panel2 p-3">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="text-sm">Anonymous voting</span>
              <button
                type="button"
                onClick={() => setIsAnonymous((v) => !v)}
                className={`relative h-5 w-9 rounded-full transition-colors ${isAnonymous ? "bg-accent" : "bg-border"}`}
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${isAnonymous ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="text-sm">Multiple answers</span>
              <button
                type="button"
                onClick={() => setAllowsMultiple((v) => !v)}
                className={`relative h-5 w-9 rounded-full transition-colors ${allowsMultiple ? "bg-accent" : "bg-border"}`}
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${allowsMultiple ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-border px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm hover:bg-panel2 transition">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="rounded-lg bg-accent px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40 transition"
          >
            Create Poll
          </button>
        </div>
      </div>
    </div>
  );
}
