-- swiss-grocery: one view per store, so each shop has its own "table" in the
-- Supabase Table Editor (aldi_products, coop_products, ...).
--
-- The views read the shared tables: nothing is copied, they always show the
-- latest sync, and they follow Row Level Security (security_invoker). Each row
-- is a product the store currently lists, with its current price. Safe to run again.

create or replace view public.aldi_products with (security_invoker = true) as
  select id, name, brand, size_text, category_path, price, regular_price, loyalty_price,
         unit_price, unit_price_basis, promo_label, valid_from, valid_until, observed_at,
         url, image_url, gtin
  from public.current_prices where store = 'aldi';

create or replace view public.coop_products with (security_invoker = true) as
  select id, name, brand, size_text, category_path, price, regular_price, loyalty_price,
         unit_price, unit_price_basis, promo_label, valid_from, valid_until, observed_at,
         url, image_url, gtin
  from public.current_prices where store = 'coop';

create or replace view public.denner_products with (security_invoker = true) as
  select id, name, brand, size_text, category_path, price, regular_price, loyalty_price,
         unit_price, unit_price_basis, promo_label, valid_from, valid_until, observed_at,
         url, image_url, gtin
  from public.current_prices where store = 'denner';

create or replace view public.lidl_products with (security_invoker = true) as
  select id, name, brand, size_text, category_path, price, regular_price, loyalty_price,
         unit_price, unit_price_basis, promo_label, valid_from, valid_until, observed_at,
         url, image_url, gtin
  from public.current_prices where store = 'lidl';

create or replace view public.migros_products with (security_invoker = true) as
  select id, name, brand, size_text, category_path, price, regular_price, loyalty_price,
         unit_price, unit_price_basis, promo_label, valid_from, valid_until, observed_at,
         url, image_url, gtin
  from public.current_prices where store = 'migros';

-- Your secret key (service_role) may read them through the API, like the tables.
grant select on table public.aldi_products, public.coop_products, public.denner_products,
  public.lidl_products, public.migros_products to service_role;

-- Optional, for a public website (together with the "Public read" block of the
-- previous migration): let anyone read the views with your publishable key.
-- grant select on table public.aldi_products, public.coop_products,
--   public.denner_products, public.lidl_products, public.migros_products to anon;

-- Make the API pick up the change right away.
notify pgrst, 'reload schema';
