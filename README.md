# swiss

**Swiss data from the command line.** `swiss` brings together what Swiss companies and
federal offices publish: shop prices, health insurance premiums, public transport,
weather, charging stations, shared mobility, rivers and lakes, earthquakes, snow and
avalanches. Every answer comes from an official or public source, asked politely.

```console
$ swiss premiums 8001 --age 34 -d 2500 -n 3

  Health insurance 2027 · 8001 Zürich (ZH, premium region 1)
  Adult (26+), born 1992 · deductible CHF 2500 · with accident cover · 128 plans from 27 insurers

   #  Insurer   Plan          Model       CHF/month  CHF/year
   1  Atupri    HMO           Doctor/HMO     406.80   4881.60
   2  Sanitas   TelMed Basic  Telmed         412.50   4950.00
   3  Assura    QualiMed      Flex           413.10   4957.20

  Cheapest with free choice of doctor: SLKK Grundversicherung, CHF 504.70 a month.
  To switch for 2027, your notice must reach your insurer by Monday 30 November 2026.

$ swiss train Lausanne Zürich --at 7:30 --date tomorrow -n 1

  Lausanne → Zürich HB
  Tuesday 27 October 2026 · leaving from 07:30

  07:34 → 09:56   2h 22m   direct   IC 5
     07:34  Lausanne   platform 4   IC 5 → Rorschach
     09:56  Zürich HB  platform 33

$ swiss aare
  Aare in Bern: 13.2 °C, 80 m³/s (Aare - Bern, Schönau, 21:20)
```

(Real output from 26 October 2026.)

| Command | What it answers | Source |
|---|---|---|
| `swiss grocery …` | Prices of Migros, Coop, Denner, Aldi, Lidl, Volg, LANDI and IKEA, compared and tracked | the shops' websites |
| `swiss premiums <place>` | Health insurance premiums of every insurer and plan | priminfo.admin.ch (BAG) |
| `swiss train <from> <to>` | Connections with delays and platforms | transport.opendata.ch |
| `swiss departures <stop>` | A stop's departure board | transport.opendata.ch |
| `swiss weather <place>` | 9-day forecast and the latest measurement nearby | MeteoSwiss |
| `swiss charge near <place>` | EV charging stations, free right now | Swiss Federal Office of Energy |
| `swiss sharing near <place>` | Shared bikes, e-scooters and cars | sharedmobility.ch |
| `swiss rivers`, `swiss aare` | Water temperature, flow and flood danger | FOEN (hydrodaten.admin.ch) |
| `swiss quakes` | Recent earthquakes | Swiss Seismological Service |
| `swiss snow <place>`, `swiss avalanche` | Snow depth and the avalanche bulletin | SLF |

Places can be written the way you like: a postcode (`8001`), a town (`Lausanne`, `Davos
Platz`), an address (`"Bahnhofstrasse 1, Zürich"`) or a mountain (`Säntis`).

The shop part is also available as its own command, **`swiss-grocery`**, exactly as before:
it downloads the products and prices of the shops into a database on your computer, to
search, compare, export and sync them.

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
- **Your language:** product names in German, French or Italian, chosen per store.
- **Optional:** copy your data to [Supabase](https://supabase.com) (Postgres) or
  [Firebase](https://firebase.google.com) (Cloud Firestore), e.g. for a website.

Your data stays on your computer. The tool is polite: it identifies itself, follows
`robots.txt`, keeps answers for as long as the sources ask, and sends about one or two
requests per second.

---

## Contents

1. [Install](#install)
2. [Quick start](#quick-start)
3. [Everything else Swiss](#everything-else-swiss): premiums, trains, weather, charging,
   sharing, rivers, earthquakes, snow
4. [Shop prices](#shop-prices): [what each store publishes](#what-each-store-publishes),
   [language](#language), [everyday use](#everyday-use),
   [reading the results](#reading-the-results)
5. [All commands](#all-commands)
6. [How it works](#how-it-works)
7. [The data](#the-data)
8. [Supabase (optional)](#supabase-optional)
9. [Firebase (optional)](#firebase-optional)
10. [Settings](#settings)
11. [Troubleshooting](#troubleshooting)
12. [Responsible use](#responsible-use)
13. [For developers](#for-developers)

---

## Install

### 1. Install Node.js (once)

`swiss` runs on [Node.js](https://nodejs.org), version **22.13 or newer**.

- **Windows / macOS:** download the "LTS" installer from <https://nodejs.org> and run it.
- **Linux:** use your package manager or <https://nodejs.org/en/download>.

Check it worked by opening a terminal (macOS: *Terminal*; Windows: *PowerShell*) and typing:

```console
$ node --version
v22.20.0
```

### 2. Install swiss

```console
$ npm install -g github:othmanehousni/swiss-cli
```

This installs two commands: **`swiss`** (everything) and **`swiss-grocery`** (the shop
prices on their own, as before). Check them:

```console
$ swiss --version
$ swiss-grocery --version
```

> Prefer not to install it globally? From a copy of this repository:
> `npm install && npm run build && node dist/swiss.js --help`, or `npm link` to get both
> commands. **Already using `npm link`?** Run it again after updating, so that the new
> `swiss` command is linked too.

**Updating:** run the install command again, or in your copy of the repository
`git pull && npm install` (it rebuilds the tool). Your database is kept and upgraded
automatically.

---

## Quick start

```console
$ swiss premiums 1003 --age 40 --deductible 2500   # health insurance in Lausanne
$ swiss train Bern Genève --at 8:00                # connections
$ swiss weather Davos                              # MeteoSwiss forecast
$ swiss --help                                     # everything else
```

For shop prices, download a shop once, then search:

```console
$ swiss grocery fetch aldi          # 1. download Aldi Suisse's products (~40 seconds)
$ swiss grocery search "lait"       # 2. find products and compare prices
$ swiss grocery update              # 3. later on (e.g. every day): refresh prices
```

`swiss grocery …` and `swiss-grocery …` are the same commands. Add more stores whenever
you like (`swiss grocery fetch coop lidl denner`), or everything at once with
`swiss grocery fetch all`.

Product names come in German unless you choose another language. The examples in this
guide are in French; to get French names, first create a file named `.env` in the folder
where you run the tool, containing `SWISS_GROCERY_LANG=fr` (more in [Language](#language)).
The same setting gives weather and avalanche texts in French; without it they are in
English, like the rest of the tool.

Every command explains itself: `swiss --help` and `swiss <command> --help` show what it
does, with examples.

---

## Everything else Swiss

These commands ask the source when you run them and keep the answer for a while (as
long as the source asks: 30 seconds for timetables, a day for premiums), so repeating a
question is instant and works offline. Nothing needs to be downloaded first.

### Places

Every command that takes a place understands:

- a **postcode**: `8001`, `3920` (when a postcode covers several municipalities, the
  biggest one is used, and the others are named under the answer);
- a **town or village**: `Lausanne`, `Davos Platz`, `Genf` (German, French and Italian
  names, accents and umlauts optional: `Zurich` finds Zürich);
- an **address**, a **station** or a **mountain**: `"Bahnhofstrasse 1, Zürich"`,
  `"Lausanne gare"`, `Säntis`.

Places come from swisstopo: the official postcode directory (downloaded once, refreshed
monthly) and its search service for anything else. A search that matches nothing real
says so instead of guessing ("Atlantis" is not found, instead of a place called Atlanta).
Names shared by several municipalities are listed: `swiss weather Wil` uses Wil ZH and
tells you about `9500 Wil SG`.

### Health insurance premiums: `swiss premiums`

Every insurer's premium for the basic insurance (KVG/LAMal), for your municipality, age,
deductible and accident cover, cheapest first, with the model of each plan.

```console
$ swiss premiums 8001 --age 34 --deductible 2500 --current css -n 5

  Health insurance 2027 · 8001 Zürich (ZH, premium region 1)
  Adult (26+), born 1992 · deductible CHF 2500 · with accident cover · 128 plans from 27 insurers

  #  Insurer  Plan                             Model       CHF/month  CHF/year
  1  Atupri   HMO                              Doctor/HMO     406.80   4881.60
  2  Sanitas  TelMed Basic                     Telmed         412.50   4950.00
  3  Assura   QualiMed                         Flex           413.10   4957.20
  4  Avenir   SanaTel (Telemedizin)            Telmed         424.40   5092.80
  5  KPT      KPTwin.smart - Hausarzt mit App  Telmed         428.50   5142.00
  123 more: --limit 15 or --all

  Cheapest with free choice of doctor: SLKK Grundversicherung, CHF 504.70 a month.
  CSS: its cheapest plan here is Gesundheitspraxisversicherung at CHF 442.50 a month (#16). Switching to Atupri HMO saves CHF 428 a year.
  With CSS's standard plan (CHF 589.70 a month), switching to the cheapest standard plan, SLKK, saves CHF 1,020 a year.
  Bills are CHF 4.75 a month lower than the premium: the environmental levy refund, the same for everyone.
  To switch for 2027, your notice must reach your insurer by Monday 30 November 2026 (send it by registered letter).
```

- `--age 34` or `--born 1992` (without either: an adult); `--deductible` (300 to 2500,
  children 0 to 600); `--no-accident` if your employer insures you against accidents
  (8+ hours a week for one employer).
- `--model standard,doctor,telmed,flex,pharmacy`, `--insurer css,helsana`,
  `--current <your insurer>` (what switching saves).
- `--deductibles`: every plan at every deductible, and up to which medical bills the
  highest deductible pays off for the cheapest plan.
- `--history`: each insurer's standard premium since 2022, with its yearly increase.

Source: [priminfo.admin.ch](https://www.priminfo.admin.ch), the premium calculator of
the Federal Office of Public Health, one page per question. (The BAG's downloadable
premium files are on a server whose `robots.txt` turns all robots away, so they are not
used.)

### Public transport: `swiss train` and `swiss departures`

```console
$ swiss train Lausanne Zürich --at 7:30 --date tomorrow

  Lausanne → Zürich HB
  Tuesday 27 October 2026 · leaving from 07:30

  07:34 → 09:56   2h 22m   direct   IC 5
     07:34  Lausanne   platform 4   IC 5 → Rorschach
     09:56  Zürich HB  platform 33

  07:40 → 09:58   2h 18m   1 change   IR 15, IC 8
     07:40  Lausanne   platform 1   IR 15 → Luzern
     08:56  Bern       platform 10  change: 6 min
     09:02  Bern       platform 2   IC 8 → Romanshorn
     09:58  Zürich HB  platform 34

$ swiss departures Bern -n 4

  Departures · Bern
  Monday 26 October 2026 · from now

  Time       Line   To          Platform
  21:02      IC 8   Romanshorn  2
  21:02      S 3    Belp        1A-D
  21:04      IR 15  Lausanne    7
  21:04 +1'  IC 61  Basel SBB   5
```

- From and to: stops, addresses or postcodes (`swiss train "Bahnhofstrasse 1, Zürich" 3920`
  includes the walks).
- `--at 7:30`, `--date tomorrow` (also a weekday in English, German, French or Italian,
  `27.10.` or `2026-10-27`), `--arrive` (arrive by `--at`), `--via Bern` (twice for two),
  `--type train,tram,bus,ship,cableway`, `-n`, `--json`.
- Delays (`+3'`) and platform changes are shown when the operators report them.

Source: [transport.opendata.ch](https://transport.opendata.ch). It asks clients to cache:
answers are kept 30 seconds, stop searches a week.

### Weather: `swiss weather`

```console
$ swiss weather 1003

  Weather · 1003 Lausanne · VD · 488 m

  Now  9.9 °C · humidity 81% · wind 6 km/h from NE · dry
       at Pully (3 km away, 456 m), 21:00

  Day         Weather                             Low  High  Rain
  Mon 26.10.  variable clouds                      6°   11°     –
  Tue 27.10.  sunny                                8°   14°     –
  Wed 28.10.  overcast and dry                     9°   15°     –
  Thu 29.10.  partly sunny, thick passing clouds   7°   12°     –
  ...
```

- The forecast is MeteoSwiss's local forecast for your postcode (or for the station or
  mountain spot MeteoSwiss names as you typed it: `swiss weather Säntis`), 9 days, updated
  every hour; `--days 3` shows fewer.
- "Now" is the latest measurement of the MeteoSwiss station closest in distance and
  height (a valley town does not get a summit's temperature).

Source: [MeteoSwiss open data](https://opendatadocs.meteoswiss.ch). The day's forecast files
(about 1.3 MB each, for all of Switzerland) are downloaded at most every three hours and
then answer every place.

### Charging stations: `swiss charge`

```console
$ swiss charge 8001 --fast --plug ccs --available -n 4

  Charging stations · 8001 Zürich
  within 2 km · 50 kW and more · CCS or CCS1 · free now · availability at 21:19

  #  Distance  Station                      Operator                             Power  Plugs  Free
  1     280 m  ewz Uraniastrasse 2a Zürich  Elektrizitätswerk der Stadt Zürich   50 kW  CCS     1/1
  2    1.1 km  ewz Ausstellungsstrasse 17   Elektrizitätswerk der Stadt Zürich   50 kW  CCS     2/2
  3    1.7 km  Migros | Limmatplatz 1       M-Charge                            150 kW  CCS     4/4
  4    1.7 km  ewz Forchstrasse 95          Elektrizitätswerk der Stadt Zürich   50 kW  CCS     1/1
```

`--radius <km>`, `--available`, `--fast` (50 kW and more), `--min-power`, `--plug type2,ccs,
chademo,tesla,type1,socket`, `--private` (also stations for customers or guests only).

Source: the Swiss Federal Office of Energy (the data behind ich-tanke-strom.ch). The list
of stations (about 1 MB) is loaded at most once a day, availability every minute.

### Shared mobility: `swiss sharing`

```console
$ swiss sharing near Bern

  Distance  Provider  Vehicles                                      Where
      30 m  Voi       7 e-scooters                                  parked nearby
      30 m  Velospot  5 available (bikes, e-bikes, other vehicles)  Rossfeldstrasse - Bern
      30 m  Velospot  17 bikes                                      parked nearby
```

`--type e-scooter,e-bike,bike,cargo,moped,car,e-car`, `--radius <metres>` (default 300).
Source: [sharedmobility.ch](https://sharedmobility.ch), live.

### Rivers and lakes: `swiss rivers` and `swiss aare`

```console
$ swiss rivers --near Thun -n 3

  Distance  Station                           Water       24 h  Flow / level  Flood danger
    2.7 km  Aare - Thun                     14.0 °C  13.8–14.0       67 m³/s
    5.9 km  Thunersee - Spiez, Kraftwerk BKW        –                 557.82 m
    9.3 km  Simme - Latterbach                      –                 1.4 m³/s
```

`swiss rivers aare` lists one river or lake, `swiss aare` the Aare with Bern first. Flood
danger levels (2 moderate to 5 very high) appear where the FOEN publishes thresholds.
Source: the Federal Office for the Environment ([hydrodaten.admin.ch](https://www.hydrodaten.admin.ch)),
every 10 minutes.

### Earthquakes: `swiss quakes`

```console
$ swiss quakes --near Basel --radius 40 --days 365 --min 2 -n 3

  When          Mag.  Where            Depth  Distance
  03.10. 15:36   2.8  Liestal BL       19 km     15 km
  15.07. 13:10   2.5  Liestal BL       18 km     15 km
  13.06. 14:35   2.1  Gelterkinden BL   7 km     27 km
```

`--days`, `--min <magnitude>`, `--near <place>` with `--radius <km>`, `--blasts` (also
quarry blasts). Source: the Swiss Seismological Service at ETH Zürich.

### Snow and avalanches: `swiss snow` and `swiss avalanche`

```console
$ swiss snow Davos

  Station             Altitude  Distance   Snow   24 h     Air  Measured
  Davos Stilli (SLF)    1563 m    2.9 km   0 cm   0 cm  2.7 °C  21:00
  Hanengretji           2455 m    3.7 km   5 cm  -4 cm  2.0 °C  21:00
  Weissfluhjoch         2536 m    4.1 km  10 cm  -1 cm  1.6 °C  21:00
```

`swiss snow <place>` shows the snow depth now and over 24 hours at the nearest SLF
stations, and the avalanche danger of the place's warning region. `swiss avalanche
[place]` shows the avalanche bulletin: the danger level, the avalanche problems with their
elevations and aspects, or the whole country by danger level. The SLF publishes the
bulletin every day in winter; out of season the command says so. Always read
[slf.ch](https://www.slf.ch) before a tour.

### Where the data comes from

| Command | Source | Kept for |
|---|---|---|
| places | swisstopo: official postcode directory, search service | a month / a week |
| `premiums` | priminfo.admin.ch (Federal Office of Public Health) | a day |
| `train`, `departures` | transport.opendata.ch | 30 seconds (stops: a week) |
| `weather` | MeteoSwiss open data (local forecast, SwissMetNet) | 3 hours / 10 minutes |
| `charge` | Swiss Federal Office of Energy | a day (availability: a minute) |
| `sharing` | sharedmobility.ch (Swiss Federal Office of Energy) | a minute |
| `rivers`, `aare` | Federal Office for the Environment | 10 minutes |
| `quakes` | Swiss Seismological Service (ETH Zürich) | 5 minutes |
| `snow`, `avalanche` | WSL Institute for Snow and Avalanche Research SLF | 30 minutes |

`swiss doctor` tests each of them from your connection; `swiss status` shows how many
answers are kept and how much space they take (old ones are removed by themselves).

**Not included, on purpose:** electricity prices per municipality (ElCom). ElCom
publishes them only through LINDAS, the federal linked-data service, whose `robots.txt`
turns all robots away (it is aimed at search engines, but this tool follows it). Health
insurance premiums use the priminfo calculator for the same reason.

---

## Shop prices

The shop part downloads what the shops publish online into a database on your computer,
so you can search, compare, track and export prices. It is `swiss grocery …`, or
`swiss-grocery …` on its own.

### What each store publishes

Stores do not all put the same things online. `swiss-grocery` can only collect what a
store publishes, so coverage differs:

| Store | What you get | Size | First download | Status |
|---|---|---|---|---|
| **Coop** | Full online supermarket: groceries and the wine shop | ~16,300 products | ~3 min | ready |
| **Aldi Suisse** | Full regular assortment and current special buys | ~2,300 products | ~40 s | ready |
| **Denner** | Current promotions and the wine shop (no full grocery list online) | ~800 products | ~5 s | ready |
| **Lidl Suisse** | Current weekly offers and online-shop items (no permanent food list online) | ~750 products | ~10 s | ready |
| **Migros** | Full assortment (110 categories) | not measured yet | ~2 s per 100 products | ready (see below) |
| **Volg** | The offers of the week (no assortment online) | ~25 offers | ~2 s | ready |
| **LANDI** | The online shop: garden, DIY, household, pets, clothing, food and drinks | thousands | ~15 min | ready |
| **IKEA** | The whole range, every colour and size: furniture, kitchens, textiles, decoration and the Swedish food market | ~27,500 items | ~30 s | ready |

*Times measured in October 2026 at the default polite speed.*

**About Migros:** in 2026 Migros replaced the category list and the product listing of
its website API. `swiss-grocery` follows the requests the migros.ch website makes for a
category page: the category search (100 products per page) and the product cards (100 per
request). It finds the categories through the sitemap that Migros publishes for crawlers,
because the website's own category list is closed to tools by migros.ch's `robots.txt`.
Verified in October 2026 from a home connection. migros.ch blocks many cloud and VPN
networks; check yours with `swiss-grocery doctor migros`.

**About IKEA:** `swiss-grocery` asks the search service behind ikea.com/ch
(`sik.search.blue.cdtapps.com`, whose `robots.txt` allows all robots) for one listing of
the whole range, 1,000 items per request, with every colour and size as its own item. It
does so as itself: no website client id, no browser disguise. IKEA Family prices are kept
as the member price (`loyalty_price`, shown as "app"); the price is the normal price
everyone pays. `--category food` fetches the Swedish food market only.

**Spar** publishes no machine-readable prices.

Run `swiss-grocery stores` to see this list with what you have already downloaded.

---

## Language

Coop, Migros, Aldi, Lidl and Denner publish their products in German, French and Italian.
`swiss-grocery` downloads them in one language per store:

| Setting (in `.env`) | Effect |
|---|---|
| nothing | German for every store |
| `SWISS_GROCERY_LANG=fr` | French for every store (`it` for Italian) |
| `SWISS_GROCERY_MIGROS_LANG=fr` | French for Migros only; works for any store (`SWISS_GROCERY_COOP_LANG`, …) |

`--lang fr` on a command line applies to every store for that command only. The language
covers product names, categories, labels and details, so search in that language:
`lait` finds French names, `milch` German ones. Changing it later is safe: the next
`fetch` or `update` replaces the names; product numbers and price histories stay.

---

## Everyday use

### Download a store

```console
$ swiss-grocery fetch coop                      # everything Coop publishes
$ swiss-grocery fetch migros --all              # the whole catalog (--all is the default)
$ swiss-grocery fetch coop --category food      # only groceries
$ swiss-grocery fetch coop --category lait      # categories whose name contains "lait"
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
$ swiss-grocery fetch coop --category lait --details     # details for some categories
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
$ swiss-grocery search lait --sort unit-price           # cheapest per litre first
$ swiss-grocery search fromage --store migros,coop      # only some stores
$ swiss-grocery search chocolat --promo                 # only promotions
$ swiss-grocery search chocolat --brand lindt,cailler   # only these brands
$ swiss-grocery search café --fields brand,category,url
```

Every word must match, accents are optional (`cafe` finds "Café", `creme` finds "Crème"),
and brands are searched too. Search in the language the stores were downloaded in. Sort orders: `relevance` (default), `price`, `unit-price`,
`discount`, `name`, `store`.

### Brands

Every product has a `brand` field, written the same way in every store, so one brand can
be compared across shops:

```console
$ swiss-grocery brands                          # the biggest brands, with products per store
$ swiss-grocery brands --store denner           # the brands of one store
$ swiss-grocery brands cola                     # brands whose name contains "cola"
$ swiss-grocery search --brand feldschlösschen  # every product of a brand, in every store
$ swiss-grocery export lindt.csv --brand lindt
```

`--brand` ignores case, accents and how umlauts are typed (`feldschlösschen`,
`Feldschloesschen` and `feldschlosschen` are the same), and also matches the brands that
start with it (`--brand coca-cola` includes "Coca-Cola Zero"). Several brands: commas.

Where the brand comes from, read from each store's own API:

| Store | Brand |
|---|---|
| Migros | the brand of each product card (`brand`, e.g. "M-Classic", "Kiri") |
| Coop | the brand Coop gives each product (`originText`), except for wines, where that field holds the origin ("Frankreich, 2022"), not a brand |
| Aldi Suisse | the brand Aldi gives each product (`brandName`) |
| Lidl Suisse | the brand Lidl gives each product (`brand.name`); gift cards and plants have none |
| Denner | none in the API: recognised in the product name (see below) |

Denner product names, and Coop's wine names, start with the brand ("Feldschlösschen Bier
Original", "Naturaplan Bio Chianti…"). For those products the brand is **recognised in the
name**, using only brands the stores themselves publish: a brand counts when the names of
its products usually start with it, or when several stores sell it. Bottle sizes in wine
names ("Magnum Chianti…") and generic words ("Bio", "Original") never count, and Denner's
own products ("Denner Lachsfilets") get the brand Denner. A product whose name starts with
no known brand keeps an empty brand rather than a guess. The field `brand_source` says
which way each brand was found: `store` or `name` (`--fields brand,brand_source`).

Brands are brought up to date after every `fetch` and `update`, so a brand another store
publishes later is recognised in Denner's names too.

### Look at one product

```console
$ swiss-grocery show coop:4446520
```

Shows the price, offer, brand, size, labels, barcode, link, details (if fetched) and the
full **price history**.

### Export

```console
$ swiss-grocery export products.csv                    # all products
$ swiss-grocery export coop.json --store coop
$ swiss-grocery export deals.csv --promo               # only promotions
$ swiss-grocery export lindt.csv --brand lindt         # only one brand
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
| **-31% ab 2** | Conditional offers (here: from 2 items), in the store's own words and language. The shelf price is unchanged. |
| **from 08.10.** | Offer not valid yet: it starts on that date (weekly offers, special buys). |
| **until 12.10.** | Last day of the offer. |
| **ID** | Use it with `swiss-grocery show <ID>`. |

Sizes are normalized in every language, so that `6 x 1,5 l`, `75 cl`, `2,5 dl`,
`les 100 g`, `4 Stück à 125 g` and `4 pièces de 125 g` all compare correctly.

---

## All commands

**`swiss`** (each has `--help` with examples, and `--json` for scripts):

| Command | What it does |
|---|---|
| `premiums <place>` | Health insurance premiums (`--age`/`--born`, `--deductible`, `--no-accident`, `--model`, `--insurer`, `--current`, `--deductibles`, `--history`) |
| `train <from> <to>` | Connections (`--at`, `--date`, `--arrive`, `--via`, `--type`, `--limit`) |
| `departures <stop>` | Departure board (`--at`, `--date`, `--type`, `--limit`) |
| `weather <place>` | MeteoSwiss forecast and the latest measurement (`--days`) |
| `charge [near] <place>` | Charging stations (`--radius`, `--available`, `--fast`, `--min-power`, `--plug`, `--private`) |
| `sharing [near] <place>` | Shared bikes, e-scooters and cars (`--type`, `--radius`) |
| `rivers [name]`, `aare` | Rivers and lakes (`--near`, `--all`) |
| `quakes` | Earthquakes (`--days`, `--min`, `--near`, `--radius`, `--blasts`) |
| `snow <place>`, `avalanche [place]` | Snow depth and the avalanche bulletin |
| `grocery <command>` | The shop commands below (alias `shops`) |
| `status`, `doctor`, `sync` | As below; `swiss doctor` also tests every data source |

**`swiss-grocery`** (or `swiss grocery …`):

| Command | What it does |
|---|---|
| `fetch <stores…>` | Download products and prices (`--category`, `--details`, `--limit`, `--fresh`, `--rate`) |
| `update [stores…]` | Refresh prices and promotions, find new and removed products (`--details`) |
| `search [words…]` | Find and compare products (`--store`, `--brand`, `--sort`, `--promo`, `--category`, `--limit`, `--fields`, `--json`) |
| `show <id>` | Everything about one product, including its price history |
| `brands [words…]` | The brands in your database, with their products per store (`--store`, `--limit`, `--all`, `--json`) |
| `export <file>` | Save to CSV / JSON / JSON Lines (`--store`, `--brand`, `--promo`, `--fields`, `--history`, `--delimiter`) |
| `stores` | Supported stores and what each one publishes |
| `categories <store>` | A store's categories, for `--category` |
| `fields` | Fields available to `--fields` |
| `status` | What is in your database, freshness and completeness |
| `doctor [stores…]` | Check your setup and test each store |
| `sync` | Copy your data to Supabase and/or Firebase (`--to`, `--full`, `--dry-run`, `--print-schema`) |

Options for every command: `--lang de|fr|it` (product language, for every store), `--db <file>`,
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
 normalization/    store-specific → common schema: sizes, unit prices, brands, validation
        │
 storage/          SQLite: products, prices, price_history (+ crawl progress)
        │
 commands/  ui/    the CLI          sync/   optional copy to Supabase or Firebase
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
e.g. `coop:4446520`. Name, `brand` (one spelling in every store), `brand_source` (`store`:
published by the store, `name`: recognised in the name, see [Brands](#brands)),
`brand_key` (the brand in lowercase without accents or umlauts, e.g. `nestle`, for
filtering), category path, size as printed (`size_text`) and normalized
(`quantity_amount` in g/ml/pieces, `quantity_unit`, `pack_count`), labels, URL, image,
barcode (`gtin`), `details` (JSON), and `first_seen_at`, `last_seen_at`, `removed_at`.

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
$ swiss-grocery sync --print-schema            # shows it
$ swiss-grocery sync --print-schema | pbcopy   # Mac: copies it (Windows: | clip)
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
| `aldi_products`, `coop_products`, `denner_products`, `ikea_products`, `landi_products`, `lidl_products`, `migros_products`, `volg_products` | one per shop: its current products with their current price |
| `current_prices` | the same for every shop together, with a `store` column |
| `products`, `prices`, `price_history` | the underlying tables (see [The data](#the-data)) |

The per-shop entries are *views*: they read the shared tables, so nothing is stored
twice and they always show the latest sync. Comparing shops stays a simple query, e.g.
`select store, name, price, unit_price from current_prices where name ilike '%lait%' order by unit_price;`
Every product of a brand, in every shop:
`select store, name, brand_source from products where brand_key = 'feldschlosschen';`

**Updating from an older version** (before brands had `brand_source` and `brand_key`):
run the schema once more (step 1); it adds the new columns and keeps your data. The next
`sync` then sends every product again, with its brand.

**Syncing Volg, LANDI or IKEA** with tables made before they were added: run the schema
once more (step 1). It lets the tables take the new stores and adds `volg_products`,
`landi_products` and `ikea_products`; your data is kept.

---

## Firebase (optional)

You can also (or instead) copy your data to [Cloud Firestore](https://firebase.google.com/docs/firestore),
Firebase's database. Your computer stays the source of truth.

**1. Create the database (once).** In the [Firebase console](https://console.firebase.google.com)
open your project, then *Build → Firestore Database → Create database*.

**2. Download a key.** *Project settings → Service accounts → Generate new private key*.
Save the `.json` file in the folder where you run `swiss-grocery` and point to it from
your `.env` file:

```dotenv
FIREBASE_SERVICE_ACCOUNT=./firebase-service-account.json
```

The key gives full access to your project: **keep it private**. File names like
`*firebase-adminsdk*.json` and `firebase-service-account*.json` are already in
`.gitignore`. (Instead of the file you can set `FIREBASE_PROJECT_ID`,
`FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`, see [`.env.example`](.env.example).)

**3. Sync.**

```console
$ swiss-grocery doctor                # shows "Firebase project …: connected, Firestore ready"
$ swiss-grocery sync --to firebase    # or just `sync`: every target you set up
```

**What you get.** One collection per shop, one document per product:

```
stores/migros                     { store: "migros", name: "Migros" }
stores/migros/products/100014192  { name, brand, brand_source, brand_key, category_path, size_text, price,
                                    regular_price, promo_label, unit_price, labels,
                                    details, price_history: [ … ], removed_at, … }
```

A product's current price and its whole price history are inside its document. To query
every shop at once, use a collection group query on `products`.

**Costs and the daily limit.** Firestore counts every document written; the free plan
allows 20,000 writes a day. Each sync only writes products whose details or price changed,
so daily updates stay small (after an upgrade that adds fields, such as `brand_source`,
the next sync writes every product once). The first sync of a large store can exceed the limit: it then
stops with "Firestore has used up its write quota for today", and running `sync` again the
next day continues where it stopped.

The key used by `sync` ignores Firestore's security rules. If a website or app reads the
data directly, give it read-only rules, e.g. `allow read: if true; allow write: if false;`.

---

## Settings

All optional, as environment variables or in a `.env` file:

| Variable | Meaning | Default |
|---|---|---|
| `SWISS_GROCERY_DB` | Database file | your user data folder |
| `SWISS_GROCERY_LANG` | Product language: `de`, `fr`, `it` | `de` |
| `SWISS_GROCERY_<STORE>_LANG` | Language for one store, e.g. `SWISS_GROCERY_MIGROS_LANG=fr` | `SWISS_GROCERY_LANG` |
| `SWISS_GROCERY_USER_AGENT` | User-Agent sent to stores | identifies this tool |
| `SWISS_GROCERY_MIGROS_REGION` | Migros price region (`national`, `gmz`, `gmaa`…) | `national` |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | For `sync` to Supabase | — |
| `FIREBASE_SERVICE_ACCOUNT` | For `sync` to Firebase: path to the service account key file | — |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Instead of the key file | — |
| `FIREBASE_DATABASE_ID` | A Firestore database other than the default one | `(default)` |
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

**Supabase: "your Supabase tables are from an older version of swiss-grocery".** A newer
version added columns (for example `brand_key`) or stores (Volg, LANDI, IKEA). Run the schema again
(`swiss-grocery sync --print-schema`, then SQL Editor → Run), then `swiss-grocery sync`.
It keeps your data.

**Supabase: "Supabase rejected the key".** Copy the **secret** key (`sb_secret_…`) again from
*Project Settings → API Keys*, and check that `SUPABASE_URL` is the same project. The
publishable key (`sb_publishable_…`) cannot write data.

**Firebase: "Firestore has used up its write quota for today".** The free plan allows
20,000 writes a day. What was sent is kept: run `swiss-grocery sync --to firebase` again
tomorrow and it continues where it stopped (or switch the project to the Blaze plan).

**Firebase: "this Firebase project has no Firestore database yet"** or **"the Firestore
API is not switched on"**. Create the database: *Build → Firestore Database → Create
database*, wait a minute, and try again.

**Firebase: "Google rejected the service account key".** Download a new key (*Project
settings → Service accounts → Generate new private key*) and check that your computer's
clock is right.

**A search finds nothing** although the products are there? Search in the language the
store was downloaded in (see [Language](#language)); the message after an empty search
lists it for each store.

**Behind a company proxy?** Set `HTTPS_PROXY=http://proxy:port`.

**Something looks wrong?** Run the command again with `--verbose` to see every request.
`swiss-grocery doctor` tests each store from your connection.

**Start a download over** (instead of resuming): add `--fresh`.

---

## Responsible use

This tool reads public product pages, the public APIs behind them and the open data of
federal offices, slowly, as an identified client, and respects `robots.txt` (sources
whose `robots.txt` turns robots away are not used, see
[Where the data comes from](#where-the-data-comes-from)). Open data must name its
source: the commands do, e.g. "Source: MeteoSwiss". Prices and product information belong to
the stores; check each store's terms of use before using the data beyond personal price
comparison, and do not republish it commercially without permission. Keep the default
speed: the stores' websites serve real shoppers.

---

## For developers

```console
$ npm install            # also builds dist/
$ npm run dev -- search lait    # run from source (tsx)
$ npm run check          # typecheck + lint (Biome) + unit tests
$ npm run test:live      # smoke tests against the real stores (network)
```

- TypeScript, Node.js ≥ 22.13, ES modules. Storage uses Node's built-in `node:sqlite`
  (nothing native to compile). Runtime dependencies: `commander`, `zod`, `undici`,
  `robots-parser`, `picocolors`.
- Tests (`test/unit`) run offline. Store tests use trimmed real API responses recorded
  in `test/fixtures`, so they check the real response shapes. The Supabase and Firebase
  syncs are tested against scripted answers; Firebase talks to Firestore's REST API with
  a signed service-account token, so it needs no extra dependency.
- `swiss` modules live in `src/modules/<topic>/` (a client for the source, its parsers,
  and `command.ts`); `src/modules/places/` turns what users type into a place, and
  `src/storage/cache.ts` keeps answers for as long as each source asks. Register a new
  command in `src/program.ts`, its data source in `src/modules/sources.ts` (for `doctor`).
- **Adding a store:** create `src/providers/<store>.ts` implementing the `Provider`
  interface in `src/providers/types.ts` (`categories`, `sources`, `fetchPage`, and
  optionally `fetchDetails` / `isStillListed`), validate the store's responses with zod,
  map them to `NormalizedProduct`, and register it in `src/providers/index.ts`. The
  crawler, storage, search, export and sync work unchanged.
