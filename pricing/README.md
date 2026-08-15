# Pinnacle Pricing Portal

A daily desk tool for pricing customers off supplier matrix sheets. Drop in the
day's matrices, filter to a customer, and read the terms across suppliers side
by side.

Matrix files are parsed locally in the browser. Only the extracted prices sync
to your account, so you reach the same pricing from any machine.

Accounts are backed by Supabase. Every table is protected by row level
security, so no account can read another's pricing — and the licence check is
enforced by the database, not the browser: an expired account's writes are
rejected by policy even if the front end is bypassed entirely.

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

A card above the table calls out the single cheapest line for the current
filters — rate, supplier, term, annual cost and cost over the term — with
**Copy quote** to put a formatted summary on the clipboard, since pasting into
an email is usually the next thing that happens.

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

## Accounts and licensing

Signing up starts a 14-day trial automatically — a database trigger creates the
profile, licence and settings rows. **Account** shows the signed-in email,
licence state and how much is stored.

When a trial or licence lapses the portal stays usable read-only: existing
pricing is still filterable and exportable, but imports are disabled and the
header shows why. That split is enforced in the database — `SELECT` stays open
while `INSERT`/`UPDATE` require a live licence via `has_active_license()`.

Licences are deliberately read-only to the user. There is no update policy on
the `licenses` table at all, so an account cannot extend its own trial from the
browser. Changing a licence means updating that row from the Supabase dashboard
or a server with the service role key.

## Data and backups

**Data** lists everything loaded, with per-file delete.

Pricing lives in your account, so signing in elsewhere brings it with you.
Quote blobs are cached in this browser and only re-downloaded when the server
copy changes, so returning is fast. **Export backup** still writes a local JSON
copy if you want one outside the system.

## Running it

Any static host works, since there is no build step and no backend. Served from
this repo it lives at `/pricing/`.

Locally:

```
python3 -m http.server 8000
# then open http://localhost:8000/pricing/
```

The page is now access-controlled: a signed-out visitor sees only the sign-in
screen, and the anon key in `config.js` is public by design — it identifies the
project and grants nothing on its own, since every table is behind RLS.

## Supabase setup that lives outside this repo

Three settings are dashboard-only. The first is required — signup confirmation
is broken without it.

**1. URL configuration** (Authentication → URL Configuration)

Supabase defaults the Site URL to `http://localhost:3000`, and that is where
confirmation links point when nothing else is specified. Set:

| Field | Value |
| --- | --- |
| Site URL | `https://energymatrixtool.com` |
| Redirect URLs | `https://energymatrixtool.com/**` |

The signup call passes `emailRedirectTo` as the **bare origin** on purpose.
Auth only honours a redirect matching its allow list, and setting the Site URL
is what populates that list — so a target carrying a path or query string needs
the extra wildcard entry and errors out to a blank page without it. The bare
origin works as soon as the Site URL is set. The wildcard row above is
belt-and-braces for later additions.

**2. Email template** (Authentication → Emails → Confirm signup)

Paste `pricing/email-templates/confirm-signup.html`. Subject:
*Confirm your email to start your Pinnacle trial*.

**3. SMTP** (Project Settings → Authentication → SMTP)

The built-in mailer is rate limited to a handful of messages per hour and is
explicitly not for production. Configure Resend, Postmark or SendGrid before
real signups arrive, or confirmation emails will silently stop being delivered.

Also worth knowing:

- **Trial length** is set in the `handle_new_user` trigger (14 days).
- **Granting a paid licence** is one update:
  `update licenses set status='active', expires_at='2027-01-01' where user_id=...`

## What a new user sees

1. Signs up → the form is replaced by a **Check your inbox** panel naming the
   address, with a resend button and a note about spam.
2. Opens the email → a branded confirmation with the trial terms, not a bare
   link.
3. Clicks confirm → Supabase signs them in as part of confirming and returns
   them to the portal already authenticated, so they land **inside the tool**
   with *Email confirmed — welcome to Pinnacle* rather than being asked for the
   password they just set. If no session comes back, the sign-in form is shown
   with a confirmation notice instead. Either way the auth parameters are
   stripped from the URL so a refresh cannot replay them.
4. An expired or reused link is caught too, and says so rather than failing
   silently.

## Tests

```
node pricing/test/parser.test.js   # 92 assertions, offline
node pricing/test/auth.test.js     # 23 assertions, needs the Supabase project
```

The parser tests cover term and usage-band parsing, unit inference and
conversion, filename metadata, all three layouts, header-row detection,
merged-cell fill, rejection of prose sheets, and a round trip through a real
`.xlsx` file.

The auth tests run against live Supabase through PostgREST with real signed-in
user JWTs — the same path the browser takes — so what passes is what a real
account can and cannot do. They cover signup provisioning, cross-account
isolation in both directions, licence enforcement on writes, the read-only
licence rule, and cascade deletes. They need two seeded users; see the file
header.

## Layout

```
pricing/
  index.html   markup and styles
  config.js    Supabase project URL and publishable key
  account.js   auth screen, licence state, Supabase-backed storage
  app.js       import review, mapping UI, pricing views
  parser.js    matrix detection and extraction (no DOM dependencies)
  vendor/      SheetJS (Apache-2.0) and supabase-js (MIT)
  test/        parser and auth tests
```

`account.js` exposes the same `all/put/del/clear` interface the portal used
when this was a single-user IndexedDB app, which is why becoming multi-tenant
needed almost no change in `app.js`.
