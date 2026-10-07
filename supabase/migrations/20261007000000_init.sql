-- swiss-grocery: schema for the Supabase (Postgres) copy of your local database.
--
-- How to apply (once):
--   Supabase dashboard -> SQL Editor -> New query -> paste the output of
--   `swiss-grocery sync --print-schema` (every file in this folder, in order) -> Run.
--   Or with the Supabase CLI: supabase db push
--
-- Then fill it from your computer with:  swiss-grocery sync
-- (needs SUPABASE_URL and SUPABASE_SECRET_KEY in your environment or a .env file).

create extension if not exists pg_trgm;

-- One row per product and store. id = '<store>:<store product number>', e.g. 'aldi:288415'.
create table if not exists public.products (
  id                 text primary key,
  store              text not null check (store in ('migros', 'coop', 'denner', 'aldi', 'lidl')),
  store_product_id   text not null,
  name               text not null,
  brand              text,
  category_path      text,
  size_text          text,
  quantity_amount    double precision,          -- total in g, ml or pieces
  quantity_unit      text check (quantity_unit in ('g', 'ml', 'piece')),
  pack_count         integer,
  labels             jsonb not null default '[]'::jsonb,
  url                text,
  image_url          text,
  gtin               text,                      -- barcode, for matching across stores
  details            jsonb,                     -- ingredients, nutrition, origin, ...
  details_fetched_at timestamptz,
  first_seen_at      timestamptz not null,
  last_seen_at       timestamptz not null,
  removed_at         timestamptz,               -- the store no longer lists it
  updated_at         timestamptz not null,
  unique (store, store_product_id)
);
create index if not exists products_store_idx on public.products (store) where removed_at is null;
create index if not exists products_gtin_idx on public.products (gtin) where gtin is not null;
create index if not exists products_name_trgm_idx on public.products using gin (name gin_trgm_ops);

-- Current price per product.
create table if not exists public.prices (
  product_id        text primary key references public.products (id) on delete cascade,
  price             numeric(10, 2) not null check (price > 0),
  regular_price     numeric(10, 2),            -- crossed-out price during a promotion
  loyalty_price     numeric(10, 2),            -- price with the store app (Lidl Plus)
  promo_label       text,
  valid_from        timestamptz,
  valid_until       timestamptz,
  unit_price        numeric(12, 2),            -- CHF per kg / l / piece
  unit_price_basis  text check (unit_price_basis in ('kg', 'l', 'piece')),
  currency          text not null default 'CHF',
  observed_at       timestamptz not null
);

-- Price history: one row per period during which the price stayed the same.
create table if not exists public.price_history (
  id                bigint generated always as identity primary key,
  product_id        text not null references public.products (id) on delete cascade,
  price             numeric(10, 2) not null,
  regular_price     numeric(10, 2),
  loyalty_price     numeric(10, 2),
  promo_label       text,
  valid_until       timestamptz,
  first_seen_at     timestamptz not null,
  last_seen_at      timestamptz not null,
  unique (product_id, first_seen_at)
);
create index if not exists price_history_product_idx on public.price_history (product_id, first_seen_at);

-- Convenience view: active products with their current price.
create or replace view public.current_prices with (security_invoker = true) as
  select p.id, p.store, p.name, p.brand, p.size_text, p.category_path,
         pr.price, pr.regular_price, pr.loyalty_price, pr.unit_price, pr.unit_price_basis,
         pr.promo_label, pr.valid_from, pr.valid_until, pr.observed_at, p.url, p.image_url, p.gtin
  from public.products p
  join public.prices pr on pr.product_id = p.id
  where p.removed_at is null;

-- Row Level Security: with no policies, only your secret key (used by `sync`) can
-- read or write. The grants the API needs, and an optional public read access,
-- are in the next migration (20261007120000_grant_api_access.sql).
alter table public.products enable row level security;
alter table public.prices enable row level security;
alter table public.price_history enable row level security;
