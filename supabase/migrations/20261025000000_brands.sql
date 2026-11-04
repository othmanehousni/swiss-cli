-- swiss-grocery: where each product's brand comes from, and a key to filter brands by.
--
--   brand         the brand, written the same way in every store ("Coca-Cola")
--   brand_source  'store': the store publishes it; 'name': recognised at the start of the
--                 product name (Denner and Coop's wines publish no brand field)
--   brand_key     lowercase, accent-free brand, e.g. 'coca cola' or 'nestle':
--                 select * from products where brand_key = 'nestle';
--
-- Safe to run again. After running it, `swiss-grocery sync` fills the new columns.

alter table public.products add column if not exists brand_source text
  check (brand_source in ('store', 'name'));
alter table public.products add column if not exists brand_key text;
create index if not exists products_brand_key_idx on public.products (brand_key)
  where brand_key is not null;

-- Make the API pick up the new columns right away.
notify pgrst, 'reload schema';
