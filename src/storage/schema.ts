/**
 * Database migrations, applied in order. `PRAGMA user_version` records how many
 * have run. Never edit a released migration; append a new one instead.
 *
 * Timestamps are ISO 8601 UTC strings, which sort correctly as text.
 */
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE products (
    id                 TEXT PRIMARY KEY,          -- '<store>:<store_product_id>'
    store              TEXT NOT NULL,
    store_product_id   TEXT NOT NULL,
    name               TEXT NOT NULL,
    brand              TEXT,
    category_path      TEXT,                      -- 'Top level > Sub category'
    size_text          TEXT,
    quantity_amount    REAL,                      -- total in g / ml / pieces
    quantity_unit      TEXT CHECK (quantity_unit IN ('g', 'ml', 'piece')),
    pack_count         INTEGER,
    labels             TEXT NOT NULL DEFAULT '[]', -- JSON array
    url                TEXT,
    image_url          TEXT,
    source_ref         TEXT NOT NULL DEFAULT '{}', -- JSON: store ids for refreshes
    gtin               TEXT,
    details            TEXT,                      -- JSON: ingredients, nutrition, ...
    details_fetched_at TEXT,
    search_text        TEXT NOT NULL,             -- lowercase, accent-free brand + name
    content_hash       TEXT NOT NULL,             -- detects real changes between crawls
    first_seen_at      TEXT NOT NULL,
    last_seen_at       TEXT NOT NULL,
    removed_at         TEXT,                      -- set when a full crawl no longer lists it
    updated_at         TEXT NOT NULL,
    UNIQUE (store, store_product_id)
  );
  CREATE INDEX products_store_seen ON products (store, last_seen_at);
  CREATE INDEX products_updated ON products (updated_at);
  CREATE INDEX products_gtin ON products (gtin) WHERE gtin IS NOT NULL;

  -- Current price: one row per product.
  CREATE TABLE prices (
    product_id        TEXT PRIMARY KEY REFERENCES products (id) ON DELETE CASCADE,
    price             REAL NOT NULL CHECK (price > 0),
    regular_price     REAL,
    loyalty_price     REAL,
    promo_label       TEXT,
    valid_from  TEXT,
    valid_until TEXT,
    unit_price        REAL,
    unit_price_basis  TEXT CHECK (unit_price_basis IN ('kg', 'l', 'piece')),
    currency          TEXT NOT NULL DEFAULT 'CHF',
    observed_at       TEXT NOT NULL
  );
  CREATE INDEX prices_observed ON prices (observed_at);

  -- One row per distinct price period: a new row only when the price changes,
  -- otherwise last_seen_at moves forward. Compact, and answers "since when?".
  CREATE TABLE price_history (
    id                INTEGER PRIMARY KEY,
    product_id        TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    price             REAL NOT NULL,
    regular_price     REAL,
    loyalty_price     REAL,
    promo_label       TEXT,
    valid_until TEXT,
    first_seen_at     TEXT NOT NULL,
    last_seen_at      TEXT NOT NULL
  );
  CREATE INDEX price_history_product ON price_history (product_id, id);
  CREATE INDEX price_history_seen ON price_history (last_seen_at);

  CREATE TABLE categories (
    store         TEXT NOT NULL,
    id            TEXT NOT NULL,
    parent_id     TEXT,
    name          TEXT NOT NULL,
    path          TEXT NOT NULL,
    product_count INTEGER,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (store, id)
  );

  -- Crawl bookkeeping for checkpoint/resume.
  CREATE TABLE crawl_runs (
    id          INTEGER PRIMARY KEY,
    store       TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('fetch', 'update')),
    scope_key   TEXT NOT NULL,                    -- 'all' or sorted category ids
    full_scope  INTEGER NOT NULL,                 -- 1 when the whole catalog is listed
    details     INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL
                CHECK (status IN ('running', 'completed', 'failed', 'interrupted', 'abandoned')),
    started_at  TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,                   -- detects crashed or concurrent runs
    finished_at TEXT,
    stats       TEXT NOT NULL DEFAULT '{}',
    error       TEXT
  );
  CREATE INDEX crawl_runs_store ON crawl_runs (store, started_at);

  CREATE TABLE crawl_tasks (
    run_id     INTEGER NOT NULL REFERENCES crawl_runs (id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    label      TEXT NOT NULL,
    params     TEXT NOT NULL,                     -- JSON: what to list
    cursor     TEXT,                              -- JSON: next page, NULL = first page
    status     TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
    pages      INTEGER NOT NULL DEFAULT 0,
    products   INTEGER NOT NULL DEFAULT 0,
    total      INTEGER,
    error      TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, key)
  );

  CREATE TABLE sync_state (
    target    TEXT PRIMARY KEY,
    synced_at TEXT NOT NULL
  );
  `,
  /* 2: resumable syncs (a Firebase sync can stop at the daily write quota) */ `
  CREATE TABLE sync_progress (
    target     TEXT PRIMARY KEY,
    since      TEXT,              -- what the unfinished sync sends: changes after this (NULL = all)
    started_at TEXT NOT NULL,     -- becomes synced_at when it finishes
    after_id   TEXT NOT NULL      -- the last product already sent
  );
  `,
  /* 3: where each brand comes from, and a key to filter brands by */ `
  ALTER TABLE products ADD COLUMN brand_source TEXT
    CHECK (brand_source IN ('store', 'name'));  -- published by the store / recognised in the name
  ALTER TABLE products ADD COLUMN brand_key TEXT; -- lowercase, accent-free brand (set by the brand pass)
  -- Coop's wine shop gives the origin where other products give the brand
  -- ("Frankreich, 2022", or just "Frankreich"): those are not brands.
  UPDATE products SET brand = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE store = 'coop' AND (
    brand GLOB '*, [12][0-9][0-9][0-9]'
    OR brand IN (SELECT DISTINCT substr(brand, 1, length(brand) - 6) FROM products
                 WHERE store = 'coop' AND brand GLOB '*, [12][0-9][0-9][0-9]'));
  UPDATE products SET brand_source = 'store' WHERE brand IS NOT NULL;
  CREATE INDEX products_brand ON products (brand_key) WHERE brand_key IS NOT NULL;
  `,
];
