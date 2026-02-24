"use client";

import { useState } from "react";
import type { TaskChecklistItem } from "@/types/database";

interface ChecklistSectionProps {
  checklist: TaskChecklistItem[];
  onToggle: (item: TaskChecklistItem) => void;
  onAdd: (text: string) => void;
  onDelete: (itemId: string) => void;
}

function ChecklistAddForm({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  if (!isAdding) {
    return (
      <button
        type="button"
        onClick={() => setIsAdding(true)}
        className="text-xs font-semibold text-accent hover:underline"
      >
        + Add item
      </button>
    );
  }

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) {
            onAdd(text);
            setText("");
            setIsAdding(false);
          }
          if (e.key === "Escape") {
            setText("");
            setIsAdding(false);
          }
        }}
        placeholder="New checklist item..."
        autoFocus
        className="flex-1 rounded-lg border border-stroke bg-panel px-2 py-1.5 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      <button
        type="button"
        onClick={() => {
          if (text.trim()) {
            onAdd(text);
            setText("");
            setIsAdding(false);
          }
        }}
        className="rounded-lg bg-accent px-2 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
      >
        Add
      </button>
      <button
        type="button"
        onClick={() => {
          setText("");
          setIsAdding(false);
        }}
        className="rounded-lg px-2 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
        Cancel
      </button>
    </div>
  );
}

export function ChecklistSection({ checklist, onToggle, onAdd, onDelete }: ChecklistSectionProps) {
  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Checklist ({checklist.length})
      </h4>
      {checklist.length > 0 ? (
        <ul className="space-y-1">
          {checklist.map((item) => (
            <li key={item.id} className="group flex items-center gap-2">
              <input
                type="checkbox"
                checked={item.is_done}
                onChange={() => onToggle(item)}
                className="h-4 w-4 rounded accent-accent"
              />
              <span
                className={`flex-1 text-sm ${
                  item.is_done ? "text-muted-foreground line-through" : "text-foreground"
                }`}
              >
                {item.text}
              </span>
              <button
                type="button"
                onClick={() => onDelete(item.id)}
                className="rounded p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600"
                title="Delete"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs italic text-muted-foreground">No checklist items</p>
      )}
      <ChecklistAddForm onAdd={onAdd} />
    </div>
  );
}
