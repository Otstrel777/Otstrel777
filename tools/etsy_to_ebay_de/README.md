# Etsy → eBay.de bulk listing converter

A free, one-time way to move your Etsy listings onto **eBay Germany (eBay.de)**
without a paid crosslisting subscription. Built for made-to-order /
print-on-demand shops that **don't need stock synchronisation** — you just want
your existing listings recreated on eBay.de.

It uses the platforms' own free tools:

1. **Etsy** exports your listings to CSV.
2. This script converts that CSV into eBay's bulk-upload format.
3. **eBay Seller Hub → Reports** uploads the file and creates the listings.

No third-party service touches your account; both uploads are official.

---

## Full workflow

### 1. Export from Etsy
Shop Manager → **Settings** → **Options** → **Download Data** tab →
under *Currently for sale listings* click **Download CSV**.

The file contains: `TITLE, DESCRIPTION, PRICE, CURRENCY_CODE, QUANTITY, TAGS,
MATERIALS, IMAGE1…IMAGE10, VARIATIONS`. The **image URLs are included**, which
is what makes photo transfer possible without re-uploading anything.

### 2. Configure the script
Open `convert.py` and edit the `CONFIG` block, especially:

| Setting | What to put |
|---|---|
| `category_id` | The numeric eBay.de category id for your products |
| `condition_id` | `1000` = New (handmade is usually New) |
| `shipping_service` / `shipping_cost` | A valid eBay.de service, e.g. `DE_DHLPaket`, and its price |
| `fx_rate` | Current USD→EUR rate (or pass `--rate`) |
| `dispatch_time_max` | Realistic handling days for made-to-order |
| `returns_*` | Your return policy (eBay.de expects one) |

### 3. Convert
```bash
# validate-only first (recommended)
python convert.py etsy_listings.csv -o ebay_de_upload.csv --verify

# real run
python convert.py etsy_listings.csv -o ebay_de_upload.csv --rate 0.92
```

Roll out in small batches instead of all at once:
```bash
# only "KURA bed" listings, first 5, with a category id, validate-only
python convert.py etsy_listings.csv --filter "kura bed" --limit 5 \
    --category 108426 --verify -o kura_test_5.csv
```
- `--filter TEXT`   only listings whose title contains TEXT (case-insensitive)
- `--limit N`       only the first N matching listings
- `--category ID`   eBay.de category id for this batch (overrides CONFIG)
- `--variations`    expand Etsy variations into eBay variation listings

### Variations
Etsy's export lists variation **names** (e.g. `Size`: *With Ladder EU/UK*, …)
but **not** the price of each option. Put those prices in
`CONFIG['variation_prices']` (value → EUR). With `--variations`, each listing
whose variation values are all found in that map becomes a proper eBay
variation listing (a parent row plus one child row per option, each with its
own price and quantity). A listing that ends up with fewer than 2 known options
is listed as a single item instead, and a warning tells you why.

Options you don't want on eBay.de (e.g. the US/CA/AU sizes when you only ship
within Europe) go in `CONFIG['variation_exclude']` and are left out. Any Etsy
option that isn't in `variation_prices` at all (accidental/custom values) is
dropped automatically, and each drop is reported as a warning.

```bash
python convert.py etsy_listings.csv --filter "kura bed" --limit 5 \
    --category 108426 --variations --verify -o kura_var_5.csv
```
Read the warnings it prints — empty category, unparseable price, missing
images and shortened titles are all reported per row.

### 4. Upload to eBay.de
Seller Hub → **Reports** → **Upload** → choose the file → Upload.
eBay processes it (usually < 15 min) and returns a result report.

**Do the first upload with `--verify`.** That sets `Action=VerifyAdd`, so eBay
only *validates* the file and lists the errors **without creating live
listings**. Fix anything it flags, then re-run without `--verify`.

---

## Important notes / limitations

- **Titles**: eBay caps titles at **80 characters** (Etsy allows 140). The
  script truncates and warns you — review those rows, a hard cut can look ugly.
- **Category & item specifics**: eBay.de requires a category id and often
  mandatory *Merkmale* (item specifics like *Marke*). The script sets `C:Marke`
  and one category for all rows. If your products span several categories,
  split the file or edit the `Category` column per row.
- **German translation is NOT done here.** Either translate the texts in the
  output CSV, or after listing run everything through the free **eBaymag**
  auto-translation.
- **Prices**: `final = etsy_price × fx_rate × (1 + markup) + surcharge`, rounded
  up to `.99` by default. Set `price_markup` to cover eBay fees if you want.
- **Images**: taken from Etsy's public CDN URLs; eBay pulls them by URL.
- **No stock sync**: this is a one-shot transfer, by design.

---

## Files
- `convert.py` — the converter (run `python convert.py -h` for options)
