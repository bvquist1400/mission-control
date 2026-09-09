"use client";

import { useState, useCallback } from "react";
import type { TaskComment } from "@/types/database";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";

interface TaskCommentsProps {
  taskId: string;
  comments: TaskComment[];
  onCommentAdded?: (comment: TaskComment) => void;
  onCommentUpdated?: (comment: TaskComment) => void;
  onCommentDeleted?: (commentId: string) => void;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}

const sourceLabels: Record<string, string> = {
  manual: "",
  system: "System",
  llm: "AI",
};

export function TaskComments({
  taskId,
  comments,
  onCommentAdded,
  onCommentUpdated,
  onCommentDeleted,
}: TaskCommentsProps) {
  const [newComment, setNewComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    const content = newComment.trim();
    if (!content) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Failed to add comment" }));
        throw new Error(typeof data.error === "string" ? data.error : "Failed to add comment");
      }

      const comment = (await response.json()) as TaskComment;
      onCommentAdded?.(comment);
      setNewComment("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add comment");
    } finally {
      setIsSubmitting(false);
    }
  }, [taskId, newComment, onCommentAdded]);

  const handleUpdate = useCallback(async (commentId: string) => {
    const content = editContent.trim();
    if (!content) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}/comments`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commentId, content }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Failed to update comment" }));
        throw new Error(typeof data.error === "string" ? data.error : "Failed to update comment");
      }

      const comment = (await response.json()) as TaskComment;
      onCommentUpdated?.(comment);
      setEditingId(null);
      setEditContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update comment");
    } finally {
      setIsSubmitting(false);
    }
  }, [taskId, editContent, onCommentUpdated]);

  const handleDelete = useCallback(async (commentId: string) => {
    setError(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}/comments?commentId=${commentId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Failed to delete comment" }));
        throw new Error(typeof data.error === "string" ? data.error : "Failed to delete comment");
      }

      onCommentDeleted?.(commentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete comment");
    }
  }, [taskId, onCommentDeleted]);

  const startEditing = useCallback((comment: TaskComment) => {
    setEditingId(comment.id);
    setEditContent(comment.content);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingId(null);
    setEditContent("");
  }, []);

  return (
    <div className="space-y-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Comments ({comments.length})
      </h4>

      {comments.length > 0 && (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <li key={comment.id} className="rounded-lg border border-stroke bg-panel-muted p-3">
              {editingId === comment.id ? (
                <div className="space-y-2">
                  <Textarea
                    className="resize-none"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    disabled={isSubmitting}
                    rows={2}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={isSubmitting}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleUpdate(comment.id)}
                      disabled={isSubmitting || !editContent.trim()}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-foreground whitespace-pre-wrap">{comment.content}</p>
                    {comment.source !== "system" && (
                      <div className="flex shrink-0 gap-1">
                        <Button variant="ghost" size="icon"
                          onClick={() => startEditing(comment)}
                         
                          title="Edit">
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </Button>
                        <button
                          type="button"
                          onClick={() => handleDelete(comment.id)}
                          className="rounded p-1 text-muted-foreground transition hover:bg-danger-soft hover:text-danger"
                          title="Delete"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatRelativeTime(comment.created_at)}</span>
                    {sourceLabels[comment.source] && (
                      <span className="rounded bg-panel px-1.5 py-0.5 text-xs font-semibold uppercase">
                        {sourceLabels[comment.source]}
                      </span>
                    )}
                    {comment.updated_at !== comment.created_at && (
                      <span className="italic">(edited)</span>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        <Textarea
          className="resize-none"
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); handleSubmit(); } }}
          placeholder="Add a comment..."
          disabled={isSubmitting}
          rows={2}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            <kbd className="rounded border border-stroke bg-panel-muted px-1 py-0.5 font-mono text-xs">⌘</kbd>+<kbd className="rounded border border-stroke bg-panel-muted px-1 py-0.5 font-mono text-xs">Enter</kbd> to submit
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={isSubmitting || !newComment.trim()}
          >
            {isSubmitting ? "Adding..." : "Add Comment"}
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
