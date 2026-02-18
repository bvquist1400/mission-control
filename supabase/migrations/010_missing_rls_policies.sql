-- Migration 010: Add missing RLS policies
--
-- inbox_items: missing DELETE policy
-- status_updates: missing UPDATE and DELETE policies

BEGIN;

-- inbox_items: add DELETE policy
CREATE POLICY "Users can delete own inbox_items"
  ON inbox_items FOR DELETE
  USING (auth.uid() = user_id);

-- status_updates: add UPDATE policy
CREATE POLICY "Users can update own status_updates"
  ON status_updates FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- status_updates: add DELETE policy
CREATE POLICY "Users can delete own status_updates"
  ON status_updates FOR DELETE
  USING (auth.uid() = user_id);

COMMIT;
