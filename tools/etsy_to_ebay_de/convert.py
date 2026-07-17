#!/usr/bin/env python3
"""
Etsy -> eBay.de bulk-listing converter.

Takes the CSV you download from Etsy
    (Shop Manager -> Settings -> Options -> Download Data ->
     "Currently for sale listings" -> Download CSV)
and produces a CSV that can be uploaded to eBay Germany via
Seller Hub -> Reports -> Upload  (the tool formerly known as File Exchange).

Why this exists
---------------
The two platforms use completely different column layouts. Etsy gives you
TITLE / DESCRIPTION / PRICE / CURRENCY_CODE / QUANTITY / TAGS / MATERIALS /
IMAGE1..IMAGE10 / VARIATIONS. eBay needs an "Action(Add)" flat file with a
category id, condition, a fixed-price format, shipping, returns, location and
the photos in a single PicURL field. This script maps one onto the other and
fills the eBay-only fields from the CONFIG block below.

It does NOT sync stock (you don't need that for made-to-order / print-on-demand)
and it does NOT translate to German. Translate the texts in the output CSV, or
run the listings through the free eBaymag auto-translation afterwards.

Usage
-----
    python convert.py etsy_listings.csv -o ebay_de_upload.csv
    python convert.py etsy_listings.csv -o ebay_de_upload.csv --rate 0.92
    python convert.py etsy_listings.csv -o ebay_de_upload.csv --verify   # dry-run

Then open ebay_de_upload.csv, review it, and upload it in Seller Hub -> Reports.
Tip: keep --verify (Action=VerifyAdd) for the first upload so eBay only
validates the file and reports errors WITHOUT creating live listings.

Version: 1.0.0
"""

import argparse
import csv
import html
import sys
from dataclasses import dataclass


# ============================================================
# CONFIG  --  edit these to match your eBay.de account
# ============================================================

CONFIG = {
    # eBay.de category id. Put the numeric id of the category that fits your
    # products. Find it in Seller Hub while listing manually, or via
    # https://www.ebay.de/sch (the id shows in the URL / listing form).
    # Leave "" to force yourself to fill the "Category" column by hand later.
    "category_id": "",

    # Item condition. 1000 = New, 1500 = New other, 3000 = Used.
    # Made-to-order / handmade items are almost always New.
    "condition_id": "1000",

    # Listing format & duration.
    "format": "FixedPrice",
    "duration": "GTC",          # Good 'Til Cancelled

    # Quantity per listing. For print-on-demand you never run out, so a fixed
    # number like 10 is fine. Set to None to copy the QUANTITY from Etsy.
    "quantity": 10,

    # Where you ship from.
    "country": "DE",
    "currency": "EUR",
    "location": "Deutschland",

    # Price handling. Etsy prices are usually in USD; eBay.de wants EUR.
    # final_price = etsy_price * fx_rate * (1 + markup) + surcharge, rounded.
    # fx_rate can be overridden on the command line with --rate.
    "fx_rate": 0.92,            # USD -> EUR (update to the current rate)
    "price_markup": 0.0,        # e.g. 0.15 to add 15% for eBay fees
    "price_surcharge": 0.0,     # flat amount added after markup
    "price_round_to": 0,        # keep exact price; set 0.99 for .99 pricing

    # Handling time (business days until you dispatch). Made-to-order needs a
    # realistic number so you don't get late-shipping defects.
    "dispatch_time_max": 5,

    # Shipping. Use a valid eBay.de shipping service id. Common examples:
    #   DE_DeutschePostBrief, DE_DHLPaket, DE_HermsPaket, DE_DHLPaeckchen
    "shipping_type": "Flat",
    "shipping_service": "DE_DHLPaket",
    "shipping_cost": "4.99",

    # Returns. eBay.de effectively requires a return policy for most sellers.
    "returns_accepted": "ReturnsAccepted",   # or ReturnsNotAccepted
    "returns_within": "Days_30",             # Days_14 / Days_30 / Days_60
    "refund_option": "MoneyBack",
    "return_shipping_paid_by": "Buyer",      # Buyer or Seller

    # Brand shown in item specifics. "Handmade" or your shop name work well.
    "brand": "Handmade",

    # Convert Etsy line breaks in the description to <br> so it reads well on
    # eBay (eBay descriptions accept HTML).
    "description_as_html": True,

    # ----- Variations (multi-variation listings) -----
    # Enabled with --variations. Etsy's export does NOT contain per-option
    # prices, so you must supply them here: variation value -> EUR price.
    # A listing is only expanded into a variation listing if EVERY one of its
    # Etsy variation values is found in this map; otherwise it is listed as a
    # single item at its base price and a warning is emitted.
    "variation_ebay_name": "Size",   # variation dimension name shown on eBay
    "variation_quantity": 10,        # quantity per variation option
    "variation_prices": {
        "With Ladder EU/UK": "49.90",
        "No Ladder EU/UK": "49.90",
        "With Ladder US/CA/AU": "49.90",
        "No Ladder US/CA/AU": "49.90",
        "Extra Short Strip": "22.90",
        "Extra Long Strip": "23.90",
    },
}

# eBay hard limit on title length.
EBAY_TITLE_MAX = 80


# ============================================================
# Data model
# ============================================================

@dataclass
class EtsyRow:
    title: str = ""
    description: str = ""
    price: str = ""
    currency: str = ""
    quantity: str = ""
    tags: str = ""
    materials: str = ""
    images: list = None
    sku: str = ""
    variation_name: str = ""      # e.g. "Size"
    variation_values: list = None  # e.g. ["With Ladder EU/UK", ...]

    def __post_init__(self):
        if self.images is None:
            self.images = []
        if self.variation_values is None:
            self.variation_values = []


# ============================================================
# Parsing the Etsy export
# ============================================================

def _pick(row, *names):
    """Return the first matching column value, case-insensitive."""
    lower = {k.lower().strip(): v for k, v in row.items() if k}
    for n in names:
        if n.lower() in lower and lower[n.lower()] is not None:
            return lower[n.lower()].strip()
    return ""


def parse_etsy_csv(path, title_filter="", limit=0):
    """Read Etsy's 'Currently for sale listings' CSV into EtsyRow objects.

    title_filter: keep only listings whose TITLE contains this text
                  (case-insensitive). Empty = keep all.
    limit:        keep at most this many (after filtering). 0 = no limit.
    """
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            images = []
            for i in range(1, 11):
                url = _pick(raw, f"IMAGE{i}", f"IMAGE {i}", f"image{i}")
                if url:
                    images.append(url)
            var_name = _pick(raw, "VARIATION 1 NAME", "VARIATION_1_NAME")
            var_values_raw = _pick(raw, "VARIATION 1 VALUES", "VARIATION_1_VALUES")
            var_values = [v.strip() for v in var_values_raw.split(",") if v.strip()]
            row = EtsyRow(
                title=_pick(raw, "TITLE", "Title"),
                description=_pick(raw, "DESCRIPTION", "Description"),
                price=_pick(raw, "PRICE", "Price"),
                currency=_pick(raw, "CURRENCY_CODE", "CURRENCY", "Currency"),
                quantity=_pick(raw, "QUANTITY", "Quantity"),
                tags=_pick(raw, "TAGS", "Tags"),
                materials=_pick(raw, "MATERIALS", "Materials"),
                images=images,
                sku=_pick(raw, "SKU", "Sku"),
                variation_name=var_name,
                variation_values=var_values,
            )
            if not row.title:
                continue
            if title_filter and title_filter.lower() not in row.title.lower():
                continue
            rows.append(row)
            if limit and len(rows) >= limit:
                break
    return rows


# ============================================================
# Transform helpers
# ============================================================

def convert_price(raw_price, cfg, fx_rate, currency=""):
    """Etsy price string -> eBay EUR price string.

    If the Etsy row is already priced in EUR, the FX rate is ignored (no
    conversion) so EUR shops don't get their prices scaled by mistake.
    """
    try:
        value = float(str(raw_price).replace(",", ".").strip() or 0)
    except ValueError:
        return ""
    rate = 1.0 if (currency or "").strip().upper() == "EUR" else fx_rate
    value = value * rate * (1 + cfg["price_markup"]) + cfg["price_surcharge"]
    round_to = cfg.get("price_round_to") or 0
    if round_to:
        # round UP to the next .99 (or whatever the fractional target is)
        base = int(value)
        candidate = base + round_to
        if value > candidate:
            candidate = base + 1 + round_to
        value = candidate
    return f"{value:.2f}"


def clean_title(title):
    """eBay titles max out at 80 chars and dislike some symbols."""
    t = " ".join(title.split())
    if len(t) > EBAY_TITLE_MAX:
        t = t[:EBAY_TITLE_MAX].rstrip()
    return t


def clean_description(desc, as_html):
    if not desc:
        return ""
    if as_html:
        # escape then restore intentional line breaks as <br>
        escaped = html.escape(desc)
        return escaped.replace("\r\n", "<br>").replace("\n", "<br>")
    return desc


# ============================================================
# Build the eBay File Exchange rows
# ============================================================

def ebay_header(cfg):
    """The eBay File Exchange 'Add' column order for a Germany upload."""
    action_col = (
        f"Action(SiteID=Germany|Country={cfg['country']}"
        f"|Currency={cfg['currency']}|Version=1193|CC=UTF-8)"
    )
    return [
        action_col,
        "CustomLabel",
        "Category",
        "Title",
        "Relationship",
        "RelationshipDetails",
        "Description",
        "ConditionID",
        "PicURL",
        "Quantity",
        "Format",
        "StartPrice",
        "Duration",
        "Location",
        "ShippingType",
        "ShippingService-1:Option",
        "ShippingService-1:Cost",
        "DispatchTimeMax",
        "ReturnsAcceptedOption",
        "ReturnsWithinOption",
        "RefundOption",
        "ShippingCostPaidByOption",
        "C:Marke",
    ], action_col


def _shared_fields(r, cfg, title):
    """Listing-level fields shared by a single item or a variation parent."""
    return {
        "CustomLabel": r.sku,
        "Category": cfg["category_id"],
        "Title": title,
        "Description": clean_description(r.description, cfg["description_as_html"]),
        "ConditionID": cfg["condition_id"],
        "PicURL": "|".join(r.images),
        "Format": cfg["format"],
        "Duration": cfg["duration"],
        "Location": cfg["location"],
        "ShippingType": cfg["shipping_type"],
        "ShippingService-1:Option": cfg["shipping_service"],
        "ShippingService-1:Cost": cfg["shipping_cost"],
        "DispatchTimeMax": cfg["dispatch_time_max"],
        "ReturnsAcceptedOption": cfg["returns_accepted"],
        "ReturnsWithinOption": cfg["returns_within"],
        "RefundOption": cfg["refund_option"],
        "ShippingCostPaidByOption": cfg["return_shipping_paid_by"],
        "C:Marke": cfg["brand"],
    }


def build_rows(etsy_rows, cfg, fx_rate, action, variations=False):
    header, action_col = ebay_header(cfg)
    out = []
    warnings = []
    for idx, r in enumerate(etsy_rows, 1):
        title = clean_title(r.title)
        if len(r.title) > EBAY_TITLE_MAX:
            warnings.append(f"Row {idx}: title shortened to 80 chars -> \"{title}\"")
        if not r.images:
            warnings.append(f"Row {idx}: no image URLs found")
        if not cfg["category_id"]:
            warnings.append(f"Row {idx}: Category is empty (set CONFIG['category_id'])")

        price_map = cfg["variation_prices"]
        use_variation = (
            variations
            and r.variation_values
            and all(v in price_map for v in r.variation_values)
        )

        if use_variation:
            # Parent row: no Relationship, no StartPrice/Quantity.
            values = r.variation_values
            details = cfg["variation_ebay_name"] + "=" + ";".join(values)
            parent = {action_col: action, **_shared_fields(r, cfg, title)}
            parent["Relationship"] = ""
            parent["RelationshipDetails"] = details
            parent["StartPrice"] = ""
            parent["Quantity"] = ""
            out.append(parent)
            # Child rows: one per variation value, each with its own price.
            for v in values:
                child = {c: "" for c in header}
                child[action_col] = action
                child["Relationship"] = "Variation"
                child["RelationshipDetails"] = f"{cfg['variation_ebay_name']}={v}"
                child["StartPrice"] = price_map[v]
                child["Quantity"] = cfg["variation_quantity"]

                out.append(child)
        else:
            if variations and r.variation_values:
                unknown = [v for v in r.variation_values if v not in price_map]
                warnings.append(
                    f"Row {idx}: listed as single item (no price for "
                    f"{unknown}); add them to CONFIG['variation_prices']"
                )
            qty = cfg["quantity"] if cfg["quantity"] is not None else (r.quantity or "1")
            price = convert_price(r.price, cfg, fx_rate, r.currency)
            if not price:
                warnings.append(f"Row {idx}: could not parse price '{r.price}'")
            single = {action_col: action, **_shared_fields(r, cfg, title)}
            single["Relationship"] = ""
            single["RelationshipDetails"] = ""
            single["StartPrice"] = price
            single["Quantity"] = qty
            out.append(single)
    return header, out, warnings


def write_csv(path, header, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=header)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


# ============================================================
# CLI
# ============================================================

def main():
    ap = argparse.ArgumentParser(
        description="Convert an Etsy listings CSV into an eBay.de bulk-upload CSV."
    )
    ap.add_argument("input", help="Etsy 'Currently for sale listings' CSV")
    ap.add_argument("-o", "--output", default="ebay_de_upload.csv",
                    help="output CSV path (default: ebay_de_upload.csv)")
    ap.add_argument("--rate", type=float, default=None,
                    help="USD->EUR FX rate (overrides CONFIG['fx_rate'])")
    ap.add_argument("--verify", action="store_true",
                    help="use Action=VerifyAdd (eBay validates only, no live listings)")
    ap.add_argument("--filter", default="", dest="title_filter",
                    help="only listings whose title contains this text (case-insensitive)")
    ap.add_argument("--limit", type=int, default=0,
                    help="only the first N matching listings (0 = all)")
    ap.add_argument("--category", default=None,
                    help="eBay.de category id (overrides CONFIG['category_id'])")
    ap.add_argument("--variations", action="store_true",
                    help="expand Etsy variations into eBay variation listings "
                         "(uses CONFIG['variation_prices'])")
    args = ap.parse_args()

    cfg = dict(CONFIG)
    if args.category is not None:
        cfg["category_id"] = args.category
    fx_rate = args.rate if args.rate is not None else cfg["fx_rate"]
    action = "VerifyAdd" if args.verify else "Add"

    try:
        etsy_rows = parse_etsy_csv(args.input, args.title_filter, args.limit)
    except FileNotFoundError:
        print(f"Input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    if not etsy_rows:
        print("No listings found in the input CSV. Is it the Etsy listings export?",
              file=sys.stderr)
        sys.exit(1)

    header, rows, warnings = build_rows(etsy_rows, cfg, fx_rate, action,
                                        variations=args.variations)
    write_csv(args.output, header, rows)

    print(f"Converted {len(etsy_rows)} listing(s) -> {len(rows)} row(s) "
          f"-> {args.output}")
    print(f"Action: {action} | FX rate: {fx_rate} | Category: "
          f"{cfg['category_id'] or '(empty - fill the Category column!)'}")
    if warnings:
        print(f"\n{len(warnings)} warning(s):")
        for w in warnings[:30]:
            print(f"  - {w}")
        if len(warnings) > 30:
            print(f"  ... and {len(warnings) - 30} more")
    print("\nNext: review the file, then upload it in "
          "eBay Seller Hub -> Reports -> Upload.")
    if action == "Add":
        print("Tip: run once with --verify first so eBay only validates the file.")


if __name__ == "__main__":
    main()
