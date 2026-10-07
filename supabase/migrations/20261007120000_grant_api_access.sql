-- swiss-grocery: let the Supabase API use the swiss-grocery tables.
--
-- Supabase no longer gives its API roles access to new tables automatically
-- (new projects since 30 May 2026, every project from 30 October 2026). Without
-- these grants `swiss-grocery sync` fails with "permission denied for table
-- products" (HTTP 403). Safe to run again.

-- service_role is the database role behind your secret key (sb_secret_...), the
-- key `swiss-grocery sync` uses. It bypasses Row Level Security but still needs
-- these privileges.
grant usage on schema public to service_role;
grant select, insert, update, delete
  on table public.products, public.prices, public.price_history
  to service_role;
grant select on table public.current_prices to service_role;

-- Optional, for a public website: let anyone read (never write) the data with
-- your publishable key. Uncomment these lines together.
-- grant usage on schema public to anon;
-- grant select on table public.products, public.prices, public.price_history,
--   public.current_prices to anon;
-- create policy "Public read" on public.products for select to anon using (true);
-- create policy "Public read" on public.prices for select to anon using (true);
-- create policy "Public read" on public.price_history for select to anon using (true);

-- Make the API pick up the change right away.
notify pgrst, 'reload schema';
