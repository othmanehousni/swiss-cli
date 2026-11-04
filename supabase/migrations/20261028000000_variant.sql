-- swiss-grocery: a product's variant, apart from its size.
--
--   variant       the variant as the store prints it ("doux", "001 noir extrême"), only when
--                 swiss-grocery is certain it is one; never guessed
--   version_text  the store's own variant or version line, unchanged even when unclear
--                 (Migros "versioning": "Lait", "24 pastilles", "175", ...)
--
-- Both start empty and are filled by the next crawl and `swiss-grocery sync`. The views are left
-- as they are: the first migration recreates current_prices with its own columns, which a wider
-- view would refuse. Read the new columns from public.products.
--
-- Safe to run again.

alter table public.products add column if not exists variant text;
alter table public.products add column if not exists version_text text;

-- Make the API pick up the new columns right away.
notify pgrst, 'reload schema';
