# Krova Pricing Portal

A daily desk tool for pricing customers off supplier matrix sheets. Drop in the
day's matrices, filter to a customer, and read the terms across suppliers side
by side.

Everything runs in the browser. Matrix files are parsed locally and stored in
IndexedDB, so supplier pricing is never uploaded anywhere and the portal keeps
working offline once the page has loaded.

## Daily workflow

1. Open the portal and click **Import matrices** (or drag the files onto the
   window from anywhere).
2. Check the supplier name and price date on each file — both are guessed from
   the filename and are editable before loading.
3. Click **Load pricing**. Re-importing the same file and date replaces the
   previous copy rather than duplicating it.
4. Filter to the customer: state → utility → zone → rate code → annual usage.
5. Read the terms across suppliers. The cheapest price in each term column is
   highlighted.

The badge in the header turns amber when the newest loaded file is older than
today, so a stale sheet is obvious before it gets quoted.

## Pricing a customer

The **Quote** tab groups prices into one line per supplier / utility / rate
code / usage band, with a column per term. **All rows** is the flat table
behind it, sortable by any column.

- **Annual usage** matches the usage band each price applies to, so entering
  120,000 kWh drops every band that does not cover it.
- **Adder** is your margin in mills (1 mill = $0.001/kWh). It is added to every
  displayed rate and to the cost figures.
- **$/kWh vs ¢/kWh** switches the display unit everywhere, including the max
  rate filter and CSV export.
- **Terms** shows 12/24/36/48/60 by default. Toggle a chip to add an off-cycle
  term such as 18 or 30.

### Sweet spot

The sweet spot column is the cheapest rate across *every* term available on
that line, not just the five core ones — so an 18- or 30-month price that beats
them all still surfaces even when its column is hidden.

If that term is also cheaper than both the next shorter and the next longer
available term, it is a genuine dip in the term curve and gets a **dip** flag.
That is the term worth leading with rather than one that is merely cheapest
because it sits at the end of the curve.

## When a sheet is not recognised

Supplier matrices follow no common standard, so the parser works by shape
rather than by supplier. It handles three layouts:

| Layout | Shape |
| --- | --- |
| `wide` | one row per utility/rate/band, a column per term |
| `bandwide` | a term column, and one price column per usage band |
| `long` | one row per quote with explicit term and price columns |

It finds the header row, classifies each column, infers whether prices are in
$/kWh, ¢/kWh, mills or $/MWh, and fills merged cells down.

If a sheet comes in wrong, click **Map columns** on it. Set the header row, the
price unit and each column's role; a live preview shows exactly what will be
extracted. Saving stores the mapping against that sheet's column signature, so
the next daily drop of the same report parses correctly on its own.

Sheets that are not price data — disclaimers, notes tabs — are rejected rather
than guessed at, and are simply left unchecked.

## Data and backups

**Data** lists everything loaded, with per-file delete.

Pricing lives in this browser only. Clearing site data wipes it, so use
**Export backup** before doing that or when moving to another machine;
**Restore backup** reads the file back, including saved column mappings.

If the portal is opened as a `file://` page rather than served over http, some
browsers block IndexedDB. The portal still runs, but holds pricing in memory
only and says so in the Data panel — export a backup or serve the folder over
http to keep pricing between sessions.

## Running it

Any static host works, since there is no build step and no backend. Served from
this repo it lives at `/pricing/`.

Locally:

```
python3 -m http.server 8000
# then open http://localhost:8000/pricing/
```

Note that `/pricing/` is reachable by anyone who knows the URL when deployed —
the page is marked `noindex`, but it is not access-controlled. No pricing data
is exposed by the page itself (that lives only in each user's browser), but put
the deployment behind password protection if the tool itself should be private.

## Tests

```
node pricing/test/parser.test.js
```

Covers term and usage-band parsing, unit inference and conversion, filename
metadata, all three layouts, header-row detection, merged-cell fill, rejection
of prose sheets, and a round trip through a real `.xlsx` file.

## Layout

```
pricing/
  index.html   markup and styles
  app.js       storage, import review, mapping UI, pricing views
  parser.js    matrix detection and extraction (no DOM dependencies)
  vendor/      SheetJS (Apache-2.0), full build for .xlsb support
  test/        parser tests
```
