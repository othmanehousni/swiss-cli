# swiss-grocery

**Migros, Coop, Denner, Aldi Suisse and Lidl Suisse in one place.**
`swiss-grocery` is a command-line tool that downloads the products and prices these
Swiss supermarkets publish online, stores them in one normalized database on your
computer, and lets you search, compare and export them.

```console
$ swiss-grocery fetch coop aldi lidl
$ swiss-grocery search "coca cola" --sort unit-price --limit 8

38 products match "coca cola" · cheapest per kg / litre / piece first

  Store  Product                            Size        Price    Per unit  Offer                ID
  Aldi   COCA-COLA Original                 1.25 l   CHF 1.40  CHF 1.12/l  -31% · was CHF 2.04  aldi:202753
  Aldi   COCA-COLA Original                 1.25 l   CHF 1.40  CHF 1.12/l  -31% · was CHF 2.04  aldi:480112001
  Aldi   COCA-COLA Zero                     1.25 l   CHF 1.40  CHF 1.12/l  -31% · was CHF 2.04  aldi:202755002
  Coop   Coca-Cola 6x2l                     6x2l    CHF 15.60  CHF 1.30/l                       coop:3050530
  Coop   Coca-Cola Zero 6x2l                6x2l    CHF 15.60  CHF 1.30/l                       coop:3822147
  Coop   Coca Cola light 6x1.5l             6x1.5l  CHF 14.35  CHF 1.59/l  -31% ab 2            coop:3374915
  Coop   Coca Cola zero koffeinfrei 6x1.5l  6x1.5l  CHF 14.35  CHF 1.59/l  -31% ab 2            coop:7268205
  Coop   Coca-Cola 6x1.5l                   6x1.5l  CHF 14.35  CHF 1.59/l  -31% ab 2            coop:3374743

Showing 8 of 38. Use --limit 38 to see more.
More about a product: swiss-grocery show aldi:202753
```

(Real output from 7 October 2026. Prices change every week; Aldi really lists the
1.25 l bottle under two article numbers.)

- **Compare** prices across stores, per kg, per litre or per piece.
- **Track** prices over time: every price change and promotion is kept in a history.
- **Export** everything to CSV (opens in Excel), JSON or JSON Lines.
- **Keep it fresh** cheaply: after the first download, `update` only re-reads listings.
- **Optional:** copy your data to a [Supabase](https://supabase.com) (Postgres) database.

Your data stays on your computer. The tool is polite to the stores: it identifies
itself, follows `robots.txt`, and sends about one or two requests per second.

---

## Contents

1. [What each store publishes](#what-each-store-publishes)
2. [Install](#install)
3. [Quick start](#quick-start)
4. [Everyday use](#everyday-use)
5. [Reading the results](#reading-the-results)
6. [All commands](#all-commands)
7. [How it works](#how-it-works)
8. [The data](#the-data)
9. [Supabase (optional)](#supabase-optional)
10. [Settings](#settings)
11. [Troubleshooting](#troubleshooting)
12. [Responsible use](#responsible-use)
13. [For developers](#for-developers)

---

## What each store publishes

Stores do not all put the same things online. `swiss-grocery` can only collect what a
store publishes, so coverage differs:

| Store | What you get | Size | First download | Status |
|---|---|---|---|---|
| **Coop** | Full online supermarket: groceries and the wine shop | ~16,300 products | ~3 min | ready |
| **Aldi Suisse** | Full regular assortment and current special buys | ~2,300 products | ~40 s | ready |
| **Denner** | Current promotions and the wine shop (no full grocery list online) | ~800 products | ~5 s | ready |
| **Lidl Suisse** | Current weekly offers and online-shop items (no permanent food list online) | ~750 products | ~10 s | ready |
| **Migros** | Full assortment (110 categories) | not measured yet | ~2 s per 100 products | ready (see below) |

*Times measured in October 2026 at the default polite speed.*

**About Migros:** in 2026 Migros replaced the category list and the product listing of
its website API. `swiss-grocery` follows the requests the migros.ch website makes for a
category page: the category search (100 products per page) and the product cards (100 per
request). It finds the categories through the sitemap that Migros publishes for crawlers,
because the website's own category list is closed to tools by migros.ch's `robots.txt`.
Verified in October 2026 from a home connection. migros.ch blocks many cloud and VPN
networks; check yours with `swiss-grocery doctor migros`.

Run `swiss-grocery stores` to see this list with what you have already downloaded.

---

## Install

### 1. Install Node.js (once)

`swiss-grocery` runs on [Node.js](https://nodejs.org), version **22.13 or newer**.

- **Windows / macOS:** download the "LTS" installer from <https://nodejs.org> and run it.
- **Linux:** use your package manager or <https://nodejs.org/en/download>.

Check it worked by opening a terminal (macOS: *Terminal*; Windows: *PowerShell*) and typing:

```console
$ node --version
v22.20.0
```

### 2. Install swiss-grocery

```console
$ npm install -g github:othmanehousni/swiss-cli
```

Then check it:

```console
$ swiss-grocery --version
```

> Prefer not to install it globally? From a copy of this repository:
> `npm install && npm run build && node dist/cli.js --help` (or `npm link`).

---

## Quick start

```console
$ swiss-grocery fetch aldi          # 1. download Aldi Suisse's products (~40 seconds)
$ swiss-grocery search "milch"      # 2. find products and compare prices
$ swiss-grocery update              # 3. later on (e.g. every day): refresh prices
```

That's it. Add more stores whenever you like (`swiss-grocery fetch coop lidl denner`), or
everything at once with `swiss-grocery fetch all`.

Every command explains itself: `swiss-grocery --help` and `swiss-grocery <command> --help`
show what it does, with examples.

---

## Everyday use

### Download a store

```console
$ swiss-grocery fetch coop                      # everything Coop publishes
$ swiss-grocery fetch migros --all              # the whole catalog (--all is the default)
$ swiss-grocery fetch coop --category food      # only groceries
$ swiss-grocery fetch coop --category Milch     # one category (accents optional)
$ swiss-grocery fetch aldi --limit 100          # a quick sample to try things out
```

To see which categories a store has: `swiss-grocery categories coop`.
`--category food` selects all grocery sections of a store (no household, cosmetics…).

**Stopping is safe.** Press `Ctrl+C` at any time: progress is saved after every page,
and running the same command again continues exactly where it stopped.

### Keep prices up to date

```console
$ swiss-grocery update               # every store you have downloaded
$ swiss-grocery update coop          # one store
```

An update re-reads the stores' listings (one request per 50–200 products), records price
changes and promotions, adds new products and marks the ones that disappeared as
"no longer listed". It is much cheaper than the first download.

### Ingredients, nutrition, barcodes… (`--details`)

Listings contain names, prices, sizes and promotions. Extra information needs one more
request per product, so it is only fetched when you ask:

```console
$ swiss-grocery fetch coop --category Milch --details    # details for one category
$ swiss-grocery update --details                          # details for new products only
```

| Store | Extra details |
|---|---|
| Coop | description, ingredients, allergens, nutrition per 100 g/ml, origin, storage, **barcode (EAN)**, rating, Eco-Score |
| Aldi Suisse | description, ingredients, allergens, origin, storage and usage instructions |
| Denner | description, rating, labels (Bio, Vegan…), wine tasting notes, box size |
| Lidl Suisse | none: the listing already contains everything lidl.ch publishes |

Details for a whole large store take time at a polite speed (Coop: ~16,000 requests,
about 4.5 hours). They only need to be fetched once; the run can be interrupted and
resumed, and later updates only fetch details for new products.

### Search and compare

```console
$ swiss-grocery search "coca cola"
$ swiss-grocery search milch --sort unit-price          # cheapest per litre first
$ swiss-grocery search käse --store migros,coop         # only some stores
$ swiss-grocery search schokolade --promo               # only promotions
$ swiss-grocery search kaffee --fields brand,category,url
```

Every word must match, accents are optional (`kase`, `kaese` and `käse` all find "Käse"),
and brands are searched too. Sort orders: `relevance` (default), `price`, `unit-price`,
`discount`, `name`, `store`.

### Look at one product

```console
$ swiss-grocery show coop:4446520
```

Shows the price, offer, size, labels, barcode, link, details (if fetched) and the full
**price history**.

### Export

```console
$ swiss-grocery export products.csv                    # all products
$ swiss-grocery export coop.json --store coop
$ swiss-grocery export deals.csv --promo               # only promotions
$ swiss-grocery export full.csv --fields all           # every field, incl. ingredients
$ swiss-grocery export history.csv --history           # the whole price history
```

The format follows the file name (`.csv`, `.json`, `.jsonl`). See every available field
with `swiss-grocery fields`.

> **Excel tip:** if everything lands in one column, your Excel expects semicolons:
> `swiss-grocery export products.csv --delimiter ";"`

### Check your setup

```console
$ swiss-grocery status     # what you have, how fresh and how complete it is
$ swiss-grocery doctor     # tests your setup and each store from your connection
```

---

## Reading the results

| Column | Meaning |
|---|---|
| **Price** | What you pay today, promotions included. Green = on promotion. |
| **Per unit** | Price per kg, per litre or per piece (`pc`), to compare different sizes. |
| **was CHF …** | The regular price before the promotion. |
| **app CHF …** | Price with the store's app (Lidl Plus). The Price column stays the price without it. |
| **-31% ab 2** | Conditional offers (here: from 2 items). The shelf price is unchanged. |
| **from 08.10.** | Offer not valid yet: it starts on that date (weekly offers, special buys). |
| **until 12.10.** | Last day of the offer. |
| **ID** | Use it with `swiss-grocery show <ID>`. |

Sizes are normalized so that `6 x 1,5 l`, `75 cl`, `2,5 dl`, `per 100 g` and
`4 Stück à 125 g` all compare correctly.

---

## All commands

| Command | What it does |
|---|---|
| `fetch <stores…>` | Download products and prices (`--category`, `--details`, `--limit`, `--fresh`, `--rate`) |
| `update [stores…]` | Refresh prices and promotions, find new and removed products (`--details`) |
| `search <words…>` | Find and compare products (`--store`, `--sort`, `--promo`, `--category`, `--limit`, `--fields`, `--json`) |
| `show <id>` | Everything about one product, including its price history |
| `export <file>` | Save to CSV / JSON / JSON Lines (`--store`, `--promo`, `--fields`, `--history`, `--delimiter`) |
| `stores` | Supported stores and what each one publishes |
| `categories <store>` | A store's categories, for `--category` |
| `fields` | Fields available to `--fields` |
| `status` | What is in your database, freshness and completeness |
| `doctor [stores…]` | Check your setup and test each store |
| `sync` | Copy your data to Supabase (`--full`, `--dry-run`, `--print-schema`) |

Options for every command: `--lang de|fr|it` (product language), `--db <file>`,
`--verbose`, `--quiet`, `--no-color`. Most commands accept `--json` for scripts.

---

## How it works

```
 providers/        one file per store: its API, translated to the common format
   migros.ts  coop.ts  denner.ts  aldi.ts  lidl.ts
        │
 crawler/          category tree → pagination → product ids → (details)
   http.ts         robots.txt → per-store rate limit → request → retry with backoff
   rate-limiter.ts retry.ts  pagination.ts  checkpoint.ts (resume)  crawler.ts
        │
 normalization/    store-specific → common schema: sizes, unit prices, validation
        │
 storage/          SQLite: products, prices, price_history (+ crawl progress)
        │
 commands/  ui/    the CLI          sync/   optional copy to Supabase
```

**The crawl.** For each store, `swiss-grocery` reads the category tree, pages through
each category (50–200 products per request) and stores every product with its price.
Product details are a separate, optional step. Systematic enumeration, not thousands of
parallel requests: each store gets at most 1–2 requests per second.

**Being a good citizen.** Requests identify the tool
(`swiss-grocery/<version> (+repository URL)`) and respect `robots.txt` (including
`Crawl-delay`). Temporary errors (timeouts, HTTP 429/5xx) are retried with exponential
backoff and jitter, honouring `Retry-After`; on `429 Too Many Requests` the store's rate
is halved. Bot-protection pages (DataDome, Cloudflare, Akamai) are recognised and the
crawl stops with an explanation instead of retrying or trying to get around them.

**Checkpoint and resume.** Each page of products is saved together with the position of
the next page, in one transaction. A crash, a network loss or `Ctrl+C` therefore loses
nothing; the same command resumes. Two processes cannot crawl the same store at once.

**Cheap updates.** The expensive part (the first download, plus details if you want
them) happens once. Later runs re-read listings only, record what changed, and fetch
details only for products that are new.

**New and removed products.** A product the store lists again keeps its history. A
product missing from a *complete* crawl is marked "no longer listed", with safeguards:
- Only full, error-free crawls can mark products as removed (never `--category` or `--limit`).
- When the store's listing shifts while it is being read (it happens: products added
  mid-crawl move pages), affected products are not removed.
- Where possible (Coop), each missing product is checked with the store first and only
  removed if the store confirms it is gone.
- A stable catalog never loses more than 30% of its products in one go: if that
  seems to happen, nothing is removed and you are warned.

**Data quality.** Every product is validated before it is stored: implausible prices or
sizes (a "750 kg" muesli) are dropped, a "was" price that is not higher than the price is
ignored, and items the store returns in an unexpected format are counted and skipped,
not stored as garbage. `swiss-grocery status` shows how complete each store's data is.

---

## The data

The database is a single SQLite file (see where with `swiss-grocery status`; change it
with `--db` or `SWISS_GROCERY_DB`). Main tables:

**products** — one row per store product. `id` is `<store>:<store product number>`,
e.g. `coop:4446520`. Name, brand, category path, size as printed (`size_text`) and
normalized (`quantity_amount` in g/ml/pieces, `quantity_unit`, `pack_count`), labels,
URL, image, barcode (`gtin`), `details` (JSON), and `first_seen_at`, `last_seen_at`,
`removed_at`.

**prices** — the current price of each product: `price`, `regular_price` (before a
promotion), `loyalty_price` (app/card price), `promo_label`, `valid_from`/`valid_until`,
`unit_price` with `unit_price_basis` (`kg`, `l` or `piece`), `observed_at`.

**price_history** — one row per period during which the price stayed the same:
`price`, `regular_price`, `loyalty_price`, `promo_label`, `valid_until`, `first_seen_at`,
`last_seen_at`. A new row starts only when the price or promotion changes, so the history
stays small however often you update.

All prices are in CHF; timestamps are ISO 8601 (UTC).

---

## Supabase (optional)

You can copy your local database to a [Supabase](https://supabase.com) project, for
example to power a website. Your computer stays the source of truth; each `sync` sends
only what changed.

**1. Create the tables (once).** In the Supabase dashboard open *SQL Editor → New query*,
paste the schema and press *Run*. Print the schema with:

```console
$ swiss-grocery sync --print-schema
```

The schema creates the tables and gives your secret key access to them: since 2026,
Supabase no longer lets its API use new tables automatically, so this permission (a
`grant`) is part of the schema. It is safe to run again at any time and keeps your
data, so if you created the tables with an older version, simply run it once more.

(The same SQL is in [`supabase/migrations/`](supabase/migrations), for `supabase db push`.
Row Level Security stays on without public policies, so only your secret key can read or
write; to let a public website read the data, uncomment the block marked "Optional" in
the last migration.)

**2. Add your keys.** Create a file named `.env` in the folder where you run
`swiss-grocery` (see [`.env.example`](.env.example)):

```dotenv
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
```

The secret key is in *Project Settings → API Keys*. **Keep it private**: never commit it
or paste it anywhere public. `.env` is already in `.gitignore`.

**3. Sync.**

```console
$ swiss-grocery doctor          # shows "Supabase … connected, tables found"
$ swiss-grocery sync            # first time: everything; afterwards: only changes
$ swiss-grocery update && swiss-grocery sync
```

`fetch` and `update` only fill the database on your computer; `sync` is what copies it
to Supabase.

**4. Browse it.** In the Supabase *Table Editor* you find:

| Name | What it holds |
|---|---|
| `aldi_products`, `coop_products`, `denner_products`, `lidl_products`, `migros_products` | one per shop: its current products with their current price |
| `current_prices` | the same for every shop together, with a `store` column |
| `products`, `prices`, `price_history` | the underlying tables (see [The data](#the-data)) |

The per-shop entries are *views*: they read the shared tables, so nothing is stored
twice and they always show the latest sync. Comparing shops stays a simple query, e.g.
`select store, name, price, unit_price from current_prices where name ilike '%milch%' order by unit_price;`

---

## Settings

All optional, as environment variables or in a `.env` file:

| Variable | Meaning | Default |
|---|---|---|
| `SWISS_GROCERY_DB` | Database file | your user data folder |
| `SWISS_GROCERY_LANG` | Product language: `de`, `fr`, `it` | `de` |
| `SWISS_GROCERY_USER_AGENT` | User-Agent sent to stores | identifies this tool |
| `SWISS_GROCERY_MIGROS_REGION` | Migros price region (`national`, `gmz`, `gmaa`…) | `national` |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | For `sync` | — |
| `HTTPS_PROXY`, `NO_PROXY` | Company proxy | none |

Default database location: `~/.local/share/swiss-grocery/` (Linux),
`~/Library/Application Support/swiss-grocery/` (macOS),
`%LOCALAPPDATA%\swiss-grocery\` (Windows).

---

## Troubleshooting

**"… blocked the request (… bot protection)".** Some stores block traffic that looks
automated, especially from cloud servers, VPNs or after many requests. Wait a while and
try again from a normal home or mobile connection. Progress is saved. `swiss-grocery`
deliberately does not try to get around such protections.

**"Unexpected response from …: … has an unexpected format".** The store changed its
website. Please [open an issue](https://github.com/othmanehousni/swiss-cli/issues) with
the message so the store's provider can be updated.

**Supabase: "your key has no access to the swiss-grocery tables (permission denied for
table products)".** Your tables were created without the permission Supabase stopped
adding by itself in 2026. Run the schema again (`swiss-grocery sync --print-schema`, then
SQL Editor → Run). It keeps your data.

**Supabase: "Supabase rejected the key".** Copy the **secret** key (`sb_secret_…`) again from
*Project Settings → API Keys*, and check that `SUPABASE_URL` is the same project. The
publishable key (`sb_publishable_…`) cannot write data.

**Behind a company proxy?** Set `HTTPS_PROXY=http://proxy:port`.

**Something looks wrong?** Run the command again with `--verbose` to see every request.
`swiss-grocery doctor` tests each store from your connection.

**Start a download over** (instead of resuming): add `--fresh`.

---

## Responsible use

This tool reads public product pages and the public APIs behind them, slowly, as an
identified client, and respects `robots.txt`. Prices and product information belong to
the stores; check each store's terms of use before using the data beyond personal price
comparison, and do not republish it commercially without permission. Keep the default
speed: the stores' websites serve real shoppers.

---

## For developers

```console
$ npm install            # also builds dist/
$ npm run dev -- search milch   # run from source (tsx)
$ npm run check          # typecheck + lint (Biome) + unit tests
$ npm run test:live      # smoke tests against the real stores (network)
```

- TypeScript, Node.js ≥ 22.13, ES modules. Storage uses Node's built-in `node:sqlite`
  (nothing native to compile). Runtime dependencies: `commander`, `zod`, `undici`,
  `robots-parser`, `picocolors`.
- Tests (`test/unit`) run offline. Store tests use trimmed real API responses recorded
  in `test/fixtures`, so they check the real response shapes.
- **Adding a store:** create `src/providers/<store>.ts` implementing the `Provider`
  interface in `src/providers/types.ts` (`categories`, `sources`, `fetchPage`, and
  optionally `fetchDetails` / `isStillListed`), validate the store's responses with zod,
  map them to `NormalizedProduct`, and register it in `src/providers/index.ts`. The
  crawler, storage, search, export and sync work unchanged.
