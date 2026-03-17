"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { TaskChecklistItem } from "@/types/database";

interface ChecklistSectionProps {
  checklist: TaskChecklistItem[];
  onToggle: (item: TaskChecklistItem) => void;
  onAdd: (text: string) => void;
  onUpdate: (itemId: string, text: string) => void;
  onDelete: (itemId: string) => void;
}

interface ParsedChecklistText {
  badgeLabel: string | null;
  sectionLabel: string | null;
  content: string;
}

interface DecoratedChecklistItem {
  item: TaskChecklistItem;
  parsed: ParsedChecklistText;
}

interface ChecklistGroup {
  label: string;
  items: DecoratedChecklistItem[];
}

const TAG_PREFIX_RE = /^\[([^\]]+)\]\s*/;

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

function parseChecklistText(text: string): ParsedChecklistText {
  const match = text.match(TAG_PREFIX_RE);

  if (!match) {
    return {
      badgeLabel: null,
      sectionLabel: null,
      content: text,
    };
  }

  const sectionLabel = match[1]?.trim().toUpperCase() || null;
  return {
    badgeLabel: sectionLabel ? `[${sectionLabel}]` : null,
    sectionLabel,
    content: text.slice(match[0].length).trimStart(),
  };
}

function buildChecklistLayout(checklist: TaskChecklistItem[]) {
  const groupsByLabel = new Map<string, ChecklistGroup>();
  const ungroupedItems: DecoratedChecklistItem[] = [];
  const decoratedItems = checklist.map((item) => ({
    item,
    parsed: parseChecklistText(item.text),
  }));

  for (const decoratedItem of decoratedItems) {
    if (!decoratedItem.parsed.sectionLabel) {
      ungroupedItems.push(decoratedItem);
      continue;
    }

    const existingGroup = groupsByLabel.get(decoratedItem.parsed.sectionLabel);
    if (existingGroup) {
      existingGroup.items.push(decoratedItem);
      continue;
    }

    groupsByLabel.set(decoratedItem.parsed.sectionLabel, {
      label: decoratedItem.parsed.sectionLabel,
      items: [decoratedItem],
    });
  }

  const groups = Array.from(groupsByLabel.values());
  const defaultExpandedGroup =
    decoratedItems.find((decoratedItem) => decoratedItem.parsed.sectionLabel && !decoratedItem.item.is_done)?.parsed
      .sectionLabel ??
    groups[0]?.label ??
    null;

  return {
    groups,
    ungroupedItems,
    hasTaggedItems: groups.length > 0,
    defaultExpandedGroup,
  };
}

export function ChecklistSection({ checklist, onToggle, onAdd, onUpdate, onDelete }: ChecklistSectionProps) {
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [pendingDeleteItemId, setPendingDeleteItemId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<{
    checklistKey: string;
    values: Record<string, boolean>;
  }>({
    checklistKey: "",
    values: {},
  });
  const skipBlurSaveRef = useRef(false);

  const { groups, ungroupedItems, hasTaggedItems, defaultExpandedGroup } = buildChecklistLayout(checklist);
  const checklistKey = checklist.map((item) => item.id).join("|");
  const groupDefaults = Object.fromEntries(
    groups.map((group) => [group.label, group.label === defaultExpandedGroup])
  ) as Record<string, boolean>;
  const hasStableGroupState =
    hasTaggedItems &&
    expandedGroups.checklistKey === checklistKey &&
    Object.keys(expandedGroups.values).length === groups.length &&
    groups.every((group) => Object.prototype.hasOwnProperty.call(expandedGroups.values, group.label));
  const resolvedExpandedGroups = hasStableGroupState ? expandedGroups.values : groupDefaults;
  const activeEditingItemId =
    editingItemId && checklist.some((item) => item.id === editingItemId) ? editingItemId : null;
  const activePendingDeleteItemId =
    pendingDeleteItemId && checklist.some((item) => item.id === pendingDeleteItemId) ? pendingDeleteItemId : null;

  function beginEditing(item: TaskChecklistItem) {
    setPendingDeleteItemId(null);
    setEditingItemId(item.id);
    setEditText(item.text);
    skipBlurSaveRef.current = false;
  }

  function closeEditor() {
    setEditingItemId(null);
    setEditText("");
  }

  function saveEdit(item: TaskChecklistItem) {
    skipBlurSaveRef.current = false;
    const nextText = editText.trim();

    closeEditor();
    if (!nextText || nextText === item.text) {
      return;
    }

    onUpdate(item.id, nextText);
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>, item: TaskChecklistItem) {
    if (event.key === "Enter") {
      event.preventDefault();
      skipBlurSaveRef.current = true;
      saveEdit(item);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      skipBlurSaveRef.current = true;
      closeEditor();
    }
  }

  function handleDeleteClick(itemId: string) {
    if (activePendingDeleteItemId === itemId) {
      setPendingDeleteItemId(null);
      onDelete(itemId);
      return;
    }

    setEditingItemId(null);
    setEditText("");
    setPendingDeleteItemId(itemId);
  }

  function renderChecklistItem(decoratedItem: DecoratedChecklistItem) {
    const { item, parsed } = decoratedItem;
    const isEditing = activeEditingItemId === item.id;
    const isDeletePending = activePendingDeleteItemId === item.id;

    return (
      <li
        key={item.id}
        onMouseLeave={() => {
          if (isDeletePending) {
            setPendingDeleteItemId(null);
          }
        }}
        className="group flex items-start gap-2 rounded-lg px-2 py-1.5 transition hover:bg-panel-muted/70"
      >
        <input
          type="checkbox"
          checked={item.is_done}
          onChange={() => onToggle(item)}
          className="mt-0.5 h-4 w-4 rounded accent-accent"
        />

        {isEditing ? (
          <input
            type="text"
            value={editText}
            onChange={(event) => setEditText(event.target.value)}
            onKeyDown={(event) => handleEditKeyDown(event, item)}
            onBlur={() => {
              if (skipBlurSaveRef.current) {
                skipBlurSaveRef.current = false;
                return;
              }

              saveEdit(item);
            }}
            autoFocus
            className="flex-1 rounded-md border border-stroke bg-panel px-2 py-1.5 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-2">
            {parsed.badgeLabel ? (
              <span className="mt-0.5 inline-flex rounded-full bg-panel px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {parsed.badgeLabel}
              </span>
            ) : null}
            {parsed.content ? (
              <span
                className={`min-w-0 text-sm break-words ${
                  item.is_done ? "text-muted-foreground line-through" : "text-foreground"
                }`}
              >
                {parsed.content}
              </span>
            ) : null}
          </div>
        )}

        {!isEditing ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => beginEditing(item)}
              className="rounded p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-panel hover:text-foreground focus-visible:opacity-100"
              title="Edit checklist item"
              aria-label="Edit checklist item"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.862 3.487a2.1 2.1 0 1 1 2.97 2.97L8.12 18.17 4 19l.83-4.12L16.862 3.487Z"
                />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => handleDeleteClick(item.id)}
              className={`rounded px-1.5 py-1 text-xs font-semibold transition ${
                isDeletePending
                  ? "bg-red-500/15 text-red-500"
                  : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-500 focus-visible:opacity-100"
              }`}
              title={isDeletePending ? "Click again to confirm delete" : "Delete checklist item"}
              aria-label={isDeletePending ? "Confirm delete checklist item" : "Delete checklist item"}
            >
              {isDeletePending ? (
                "Confirm"
              ) : (
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 3h6m-7 4h8m-7 0v11m6-11v11M5 7h14l-1 13H6L5 7Z"
                  />
                </svg>
              )}
            </button>
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Checklist ({checklist.length})
      </h4>
      {checklist.length > 0 ? (
        hasTaggedItems ? (
          <div className="space-y-3">
            {ungroupedItems.length > 0 ? <ul className="space-y-1">{ungroupedItems.map(renderChecklistItem)}</ul> : null}

            {groups.map((group) => {
              const completedCount = group.items.filter(({ item }) => item.is_done).length;
              const isExpanded = resolvedExpandedGroups[group.label] ?? false;

              return (
                <div key={group.label} className="overflow-hidden rounded-lg border border-stroke/70 bg-panel/40">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedGroups((current) => {
                        const nextState =
                          current.checklistKey === checklistKey &&
                          Object.keys(current.values).length === groups.length &&
                          groups.every((candidateGroup) => Object.prototype.hasOwnProperty.call(current.values, candidateGroup.label))
                            ? current.values
                            : groupDefaults;

                        return {
                          checklistKey,
                          values: {
                            ...nextState,
                            [group.label]: !nextState[group.label],
                          },
                        };
                      })
                    }
                    aria-expanded={isExpanded}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-panel-muted/80"
                  >
                    <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      {group.label} ({completedCount}/{group.items.length})
                    </span>
                    <svg
                      className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
                    </svg>
                  </button>
                  {isExpanded ? <ul className="space-y-1 border-t border-stroke/60 px-2 py-2">{group.items.map(renderChecklistItem)}</ul> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <ul className="space-y-1">{checklist.map((item) => renderChecklistItem({ item, parsed: parseChecklistText(item.text) }))}</ul>
        )
      ) : (
        <p className="text-xs italic text-muted-foreground">No checklist items</p>
      )}
      <ChecklistAddForm onAdd={onAdd} />
    </div>
  );
}
