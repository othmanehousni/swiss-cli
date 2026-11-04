-- swiss-grocery: IKEA joins the stores. Safe to run again.

alter table public.products drop constraint if exists products_store_check;
alter table public.products add constraint products_store_check
  check (store in ('migros', 'coop', 'denner', 'aldi', 'lidl', 'volg', 'landi', 'ikea'));

create or replace view public.ikea_products with (security_invoker = true) as
  select id, name, brand, size_text, category_path, price, regular_price, loyalty_price,
         unit_price, unit_price_basis, promo_label, valid_from, valid_until, observed_at,
         url, image_url, gtin
  from public.current_prices where store = 'ikea';

grant select on table public.ikea_products to service_role;
