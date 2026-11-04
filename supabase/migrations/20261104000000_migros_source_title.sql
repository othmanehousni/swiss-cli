-- swiss-grocery: preserve a store's original product title separately from its canonical name.
--
-- Migros can publish both `name` and `title`. The sync keeps `name` backward-compatible and
-- stores the cleaned `title` here when present. Existing rows stay null until a later crawl.
--
-- Safe to run again. This is separate from the earlier variant migration so that installations
-- which may already have applied that unpublished migration can add the title column safely.

alter table public.products add column if not exists source_title text;

-- Make the API pick up the new column right away.
notify pgrst, 'reload schema';
