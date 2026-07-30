#!/usr/bin/env python3
"""
Etsy OSS/One-Stop-Shop Report Generator

Builds a quarterly OSS VAT report (Excel) from Etsy "Sold Order Items" CSV
exports, ready for transcription into the BZSt online portal (Mein BOP).

Sales are split into three buckets:
  - OSS        intra-EU distance sales to consumers in other member states
  - Inland     sales into the seller's home country (regular UStVA)
  - Drittland  sales outside the EU (export, no VAT)

Usage:
    python3 oss_report.py 2026 Q2 export_04.csv export_05.csv export_06.csv
    python3 oss_report.py 2026 Q2 exports/*.csv -o report.xlsx

Version: 1.0.0
"""

import argparse
import glob
import sys
from decimal import Decimal, ROUND_HALF_UP

import pandas as pd
from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter


# ============================================================
# VAT rates — standard rate per EU member state (2026)
# Adjust here if a reduced rate applies to your goods.
# ============================================================

EU_RATES = {
    "Austria": ("Österreich", "AT", 0.20),
    "Belgium": ("Belgien", "BE", 0.21),
    "Bulgaria": ("Bulgarien", "BG", 0.20),
    "Croatia": ("Kroatien", "HR", 0.25),
    "Cyprus": ("Zypern", "CY", 0.19),
    "Czech Republic": ("Tschechien", "CZ", 0.21),
    "Denmark": ("Dänemark", "DK", 0.25),
    "Estonia": ("Estland", "EE", 0.24),
    "Finland": ("Finnland", "FI", 0.255),
    "France": ("Frankreich", "FR", 0.20),
    "Germany": ("Deutschland", "DE", 0.19),
    "Greece": ("Griechenland", "GR", 0.24),
    "Hungary": ("Ungarn", "HU", 0.27),
    "Ireland": ("Irland", "IE", 0.23),
    "Italy": ("Italien", "IT", 0.22),
    "Latvia": ("Lettland", "LV", 0.21),
    "Lithuania": ("Litauen", "LT", 0.21),
    "Luxembourg": ("Luxemburg", "LU", 0.17),
    "Malta": ("Malta", "MT", 0.18),
    "Poland": ("Polen", "PL", 0.23),
    "Portugal": ("Portugal", "PT", 0.23),
    "Romania": ("Rumänien", "RO", 0.21),
    "Slovakia": ("Slowakei", "SK", 0.23),
    "Slovenia": ("Slowenien", "SI", 0.22),
    "Spain": ("Spanien", "ES", 0.21),
    "Sweden": ("Schweden", "SE", 0.25),
    "The Netherlands": ("Niederlande", "NL", 0.21),
    "Netherlands": ("Niederlande", "NL", 0.21),
}

# Non-EU destinations seen in Etsy exports; anything unknown lands here too.
THIRD_NAMES = {
    "United States": ("USA", "US"),
    "Canada": ("Kanada", "CA"),
    "Switzerland": ("Schweiz", "CH"),
    "United Kingdom": ("Vereinigtes Königreich", "GB"),
    "Norway": ("Norwegen", "NO"),
    "Australia": ("Australien", "AU"),
    "Japan": ("Japan", "JP"),
    "New Zealand": ("Neuseeland", "NZ"),
}

QUARTER_MONTHS = {"Q1": (1, 2, 3), "Q2": (4, 5, 6), "Q3": (7, 8, 9), "Q4": (10, 11, 12)}
MONTH_NAMES = {
    1: "Januar", 2: "Februar", 3: "März", 4: "April", 5: "Mai", 6: "Juni",
    7: "Juli", 8: "August", 9: "September", 10: "Oktober", 11: "November", 12: "Dezember",
}

FONT = "Arial"
EUR_FMT = '#,##0.00\\ "€"'
PCT_FMT = "0.0%"
HDR_FILL = PatternFill("solid", fgColor="1F3864")
TOTAL_FILL = PatternFill("solid", fgColor="FFF2CC")
_THIN = Side(style="thin", color="BFBFBF")
BOX = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)


# ============================================================
# Data loading
# ============================================================

def load_orders(paths):
    """Read Etsy 'Sold Order Items' CSVs and aggregate them to one row per order.

    Etsy repeats nothing at order level: shipping, discount and shipping discount
    are written only on the first line item of an order. Summing them per line
    would still be safe, but aggregating per order makes that explicit and lets
    us carry the line count through.
    """
    frames = []
    for p in paths:
        df = pd.read_csv(p)
        missing = {"Order ID", "Item Total", "Ship Country"} - set(df.columns)
        if missing:
            raise SystemExit(f"{p}: not an Etsy Sold Order Items export (missing {missing})")
        frames.append(df)
    d = pd.concat(frames, ignore_index=True)

    currencies = set(d["Currency"].dropna().unique())
    if currencies - {"EUR"}:
        raise SystemExit(
            f"Non-EUR currencies present ({sorted(currencies)}); convert to EUR first."
        )

    d["sale"] = pd.to_datetime(d["Sale Date"], format="%m/%d/%y")
    orders = (
        d.groupby("Order ID")
        .agg(
            sale=("sale", "min"),
            positions=("Item Total", "size"),
            items=("Item Total", "sum"),
            shipping=("Order Shipping", "max"),
            discount=("Discount Amount", "max"),
            ship_discount=("Shipping Discount", "max"),
            land=("Ship Country", "first"),
        )
        .reset_index()
    )
    # Gross received per order: items + shipping, less any discount granted.
    orders["brutto"] = (
        orders["items"] + orders["shipping"] - orders["discount"] - orders["ship_discount"]
    ).round(2)
    orders["month"] = orders["sale"].dt.month
    return d, orders


def classify(land, home):
    if land == home:
        return "Inland"
    return "OSS" if land in EU_RATES else "Drittland"


def display_name(land, home):
    if land in EU_RATES:
        return EU_RATES[land][0]
    if land in THIRD_NAMES:
        return THIRD_NAMES[land][0]
    return land


def country_code(land):
    if land in EU_RATES:
        return EU_RATES[land][1]
    if land in THIRD_NAMES:
        return THIRD_NAMES[land][1]
    return ""


def money(x):
    return float(Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


# ============================================================
# Sheet helpers
# ============================================================

def header_row(ws, row, ncols):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = Font(name=FONT, bold=True, color="FFFFFF", size=10)
        cell.fill = HDR_FILL
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = BOX


def sheet_title(ws, text, subtitle=None):
    ws["A1"] = text
    ws["A1"].font = Font(name=FONT, bold=True, size=14, color="1F3864")
    if subtitle:
        ws["A2"] = subtitle
        ws["A2"].font = Font(name=FONT, italic=True, size=10, color="595959")


def widths(ws, spec):
    for col, w in spec.items():
        ws.column_dimensions[col].width = w


def style_block(ws, first, last, ncols, total_row=None, eur_cols=(), pct_cols=(),
                center_cols=(), size=10):
    for r in range(first, last + 1):
        bold = r == total_row
        for c in range(1, ncols + 1):
            cell = ws.cell(r, c)
            cell.border = BOX
            cell.font = Font(name=FONT, size=size, bold=bold)
            if bold:
                cell.fill = TOTAL_FILL
            if c in eur_cols:
                cell.number_format = EUR_FMT
            if c in pct_cols:
                cell.number_format = PCT_FMT
            if c in center_cols:
                cell.alignment = Alignment(horizontal="center")


def note(ws, row, text):
    ws.cell(row, 1, text).font = Font(name=FONT, italic=True, size=9, color="595959")


# ============================================================
# Workbook
# ============================================================

def build_workbook(orders, year, quarter, home, out_path, restricted=False):
    months = QUARTER_MONTHS[quarter]
    agg = orders.groupby("land").agg(brutto=("brutto", "sum"), n=("Order ID", "size")).round(2)

    oss = sorted(
        [
            (EU_RATES[l][0], EU_RATES[l][1], EU_RATES[l][2], int(agg.loc[l, "n"]),
             money(agg.loc[l, "brutto"]))
            for l in agg.index
            if l != home and l in EU_RATES
        ],
        key=lambda r: -r[4],
    )
    third = sorted(
        [
            (display_name(l, home), country_code(l), int(agg.loc[l, "n"]),
             money(agg.loc[l, "brutto"]))
            for l in agg.index
            if l != home and l not in EU_RATES
        ],
        key=lambda r: -r[3],
    )

    wb = Workbook()

    # ---- Sheet 1: OSS ----
    ws = wb.active
    ws.title = f"OSS {quarter} {year}"
    period = f"{MONTH_NAMES[months[0]]}–{MONTH_NAMES[months[2]]}"
    span = f"{orders['sale'].min():%d.%m.%Y} – {orders['sale'].max():%d.%m.%Y}"
    subtitle = ("Innergemeinschaftliche Fernverkäufe an Privatkunden (B2C) — EU-Regelung, "
                "§ 18j UStG. Alle Beträge in EUR.")
    if restricted:
        subtitle += (f"  ACHTUNG: eingeschränkter Zeitraum — nur Verkäufe vom {span}; "
                     "frühere Umsätze des Quartals sind hier NICHT enthalten.")
    sheet_title(ws, f"OSS-Meldung — {quarter[1]}. Quartal {year} ({period})", subtitle)
    for i, h in enumerate(
        ["Verbrauchsland (Mitgliedstaat)", "Code", "Bestellungen", "Bruttoumsatz (inkl. USt)",
         "Steuersatz", "Bemessungsgrundlage (netto)", "Umsatzsteuer"], 1):
        ws.cell(4, i, h)
    header_row(ws, 4, 7)

    r = 5
    for name, code, rate, n, brutto in oss:
        ws.cell(r, 1, name)
        ws.cell(r, 2, code)
        ws.cell(r, 3, n)
        ws.cell(r, 4, brutto)
        ws.cell(r, 5, rate)
        ws.cell(r, 6, f"=ROUND(D{r}/(1+E{r}),2)")
        ws.cell(r, 7, f"=ROUND(D{r}-F{r},2)")
        r += 1
    last = r - 1
    ws.cell(r, 1, "SUMME OSS")
    for col in ("C", "D", "F", "G"):
        ws[f"{col}{r}"] = f"=SUM({col}5:{col}{last})"
    total_row = r
    style_block(ws, 5, r, 7, total_row=total_row, eur_cols=(4, 6, 7), pct_cols=(5,),
                center_cols=(2, 3, 5))

    ws.cell(total_row + 2, 1, f"Zu zahlende OSS-Umsatzsteuer für {quarter} {year}:").font = Font(
        name=FONT, bold=True, size=11)
    pay = ws.cell(total_row + 2, 7, f"=G{total_row}")
    pay.font = Font(name=FONT, bold=True, size=11, color="C00000")
    pay.number_format = EUR_FMT
    note(ws, total_row + 4,
         "Nicht in der OSS-Meldung enthalten: Inlandsumsätze (reguläre UStVA) und Drittländer "
         '(steuerfreie Ausfuhr) — siehe Blatt "Inland & Drittland".')
    note(ws, total_row + 5,
         "Der Bruttoumsatz umfasst Artikelpreise + Versandkosten abzüglich gewährter Rabatte.")
    ws["D4"].comment = Comment(
        "Summe je Land: Item Total + Order Shipping − Discount Amount − Shipping Discount, "
        "aggregiert je Bestellung.\nQuelle: Etsy 'Sold Order Items' CSV-Export.", "oss_report.py")
    ws["E4"].comment = Comment(
        "Regelsteuersatz des Bestimmungslandes. Bei ermäßigt besteuerten Waren anpassen — "
        "Netto und Steuer rechnen sich automatisch neu.", "oss_report.py")
    widths(ws, dict(zip("ABCDEFG", [28, 8, 13, 20, 11, 24, 16])))
    ws.freeze_panes = "A5"

    # ---- Sheet 2: transcription list ----
    ws2 = wb.create_sheet("Elster-Eingabe")
    sheet_title(ws2, "Eingabemaske — Werte zum Abtippen",
                "Je Mitgliedstaat eine Zeile erfassen. Der Steuerbetrag wird vom Portal "
                "berechnet — Spalte E dient nur der Kontrolle.")
    for i, h in enumerate(["Nr.", "Mitgliedstaat des Verbrauchs", "Steuersatz (%)",
                           "Bemessungsgrundlage", "Steuerbetrag (Kontrolle)"], 1):
        ws2.cell(4, i, h)
    header_row(ws2, 4, 5)
    r = 5
    for i, (name, code, rate, _n, _b) in enumerate(oss, 1):
        src = i + 4
        ws2.cell(r, 1, i)
        ws2.cell(r, 2, f"{name} ({code})")
        ws2.cell(r, 3, round(rate * 100, 1))
        ws2.cell(r, 4, f"='{ws.title}'!F{src}")
        ws2.cell(r, 5, f"='{ws.title}'!G{src}")
        r += 1
    last2 = r - 1
    ws2.cell(r, 2, "SUMME")
    ws2.cell(r, 4, f"=SUM(D5:D{last2})")
    ws2.cell(r, 5, f"=SUM(E5:E{last2})")
    style_block(ws2, 5, r, 5, total_row=r, eur_cols=(4, 5), center_cols=(1, 3))
    for rr in range(5, r):
        ws2.cell(rr, 3).number_format = "0.0"
    widths(ws2, dict(zip("ABCDE", [6, 34, 15, 22, 22])))
    ws2.freeze_panes = "A5"

    # ---- Sheet 3: domestic + third countries ----
    ws3 = wb.create_sheet("Inland & Drittland")
    sheet_title(ws3, f"Nicht über OSS zu melden — {quarter} {year}",
                "Diese Umsätze gehören nicht in die OSS-Erklärung.")
    home_name = display_name(home, home)
    home_rate = EU_RATES.get(home, (home, "", 0.19))[2]
    ws3["A4"] = f"{home_name} — reguläre Umsatzsteuer-Voranmeldung"
    ws3["A4"].font = Font(name=FONT, bold=True, size=11, color="1F3864")
    for i, h in enumerate(["Land", "Bestellungen", "Brutto", "Satz", "Netto", "USt"], 1):
        ws3.cell(5, i, h)
    header_row(ws3, 5, 6)
    if home in agg.index:
        ws3.cell(6, 1, f"{home_name} ({country_code(home)})")
        ws3.cell(6, 2, int(agg.loc[home, "n"]))
        ws3.cell(6, 3, money(agg.loc[home, "brutto"]))
    else:
        ws3.cell(6, 1, home_name)
        ws3.cell(6, 2, 0)
        ws3.cell(6, 3, 0)
    ws3.cell(6, 4, home_rate)
    ws3.cell(6, 5, "=ROUND(C6/(1+D6),2)")
    ws3.cell(6, 6, "=ROUND(C6-E6,2)")
    style_block(ws3, 6, 6, 6, eur_cols=(3, 5, 6), pct_cols=(4,), center_cols=(2, 4))
    note(ws3, 7, f'→ In der UStVA unter "Steuerpflichtige Umsätze zum Steuersatz von '
                 f'{home_rate:.0%}" (Kz. 81) mit dem Nettobetrag erfassen.')

    ws3["A9"] = "Drittländer — Ausfuhrlieferungen (nicht steuerbar / steuerfrei)"
    ws3["A9"].font = Font(name=FONT, bold=True, size=11, color="1F3864")
    for i, h in enumerate(["Land", "Bestellungen", "Umsatz", "Satz", "Netto", "USt"], 1):
        ws3.cell(10, i, h)
    header_row(ws3, 10, 6)
    r = 11
    for name, code, n, brutto in third:
        ws3.cell(r, 1, f"{name} ({code})" if code else name)
        ws3.cell(r, 2, n)
        ws3.cell(r, 3, brutto)
        ws3.cell(r, 4, 0.0)
        ws3.cell(r, 5, f"=C{r}")
        ws3.cell(r, 6, 0)
        r += 1
    last3 = r - 1
    ws3.cell(r, 1, "SUMME Drittland")
    for col in ("B", "C", "E", "F"):
        ws3[f"{col}{r}"] = f"=SUM({col}11:{col}{last3})"
    style_block(ws3, 11, r, 6, total_row=r, eur_cols=(3, 5, 6), pct_cols=(4,), center_cols=(2, 4))
    note(ws3, r + 1, "→ Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1a i.V.m. § 6 UStG); "
                     "UStVA Kz. 43. Ausfuhrnachweise erforderlich.")
    note(ws3, r + 2, "→ Achtung UK: bei Sendungen bis 135 GBP an Privatkunden ist ggf. der "
                     "Marktplatz bzw. eine UK-VAT-Registrierung zu prüfen.")
    widths(ws3, dict(zip("ABCDEF", [34, 13, 16, 10, 16, 14])))

    # ---- Sheet 4: monthly ----
    ws4 = wb.create_sheet("Monatsübersicht")
    sheet_title(ws4, f"Monatsübersicht {quarter} {year} (Bruttoumsatz je Land)",
                "Zur Abstimmung mit den Etsy-Monatsberichten.")
    heads = ["Land", "Kategorie"] + [MONTH_NAMES[m] for m in months] + [f"Summe {quarter}"]
    for i, h in enumerate(heads, 1):
        ws4.cell(4, i, h)
    header_row(ws4, 4, len(heads))
    pivot = orders.groupby(["land", "month"])["brutto"].sum().unstack(fill_value=0).round(2)
    rank = {"OSS": 0, "Inland": 1, "Drittland": 2}
    ordered = sorted(pivot.index,
                     key=lambda l: (rank[classify(l, home)], -pivot.loc[l].sum()))
    r = 5
    for land in ordered:
        ws4.cell(r, 1, display_name(land, home))
        ws4.cell(r, 2, classify(land, home))
        for j, m in enumerate(months):
            ws4.cell(r, 3 + j, float(pivot.loc[land, m]) if m in pivot.columns else 0.0)
        ws4.cell(r, 6, f"=SUM(C{r}:E{r})")
        r += 1
    last4 = r - 1
    ws4.cell(r, 1, "GESAMT")
    for c in range(3, 7):
        col = get_column_letter(c)
        ws4[f"{col}{r}"] = f"=SUM({col}5:{col}{last4})"
    style_block(ws4, 5, r, 6, total_row=r, eur_cols=(3, 4, 5, 6), center_cols=(2,))
    widths(ws4, dict(zip("ABCDEF", [26, 12, 14, 14, 14, 15])))
    ws4.freeze_panes = "A5"

    # ---- Sheet 5: order detail ----
    ws5 = wb.create_sheet("Bestellungen")
    sheet_title(ws5, f"Einzelbestellungen {quarter} {year}",
                "Grundlage der Auswertung — je Zeile eine Bestellung (Order ID).")
    cols = ["Order ID", "Verkaufsdatum", "Land", "Kategorie", "Positionen", "Artikel",
            "Versand", "Rabatt", "Versandrabatt", "Brutto"]
    for i, h in enumerate(cols, 1):
        ws5.cell(4, i, h)
    header_row(ws5, 4, len(cols))
    r = 5
    for _, row in orders.sort_values(["land", "sale"]).iterrows():
        ws5.cell(r, 1, str(row["Order ID"]))
        ws5.cell(r, 2, row["sale"].date())
        ws5.cell(r, 3, display_name(row["land"], home))
        ws5.cell(r, 4, classify(row["land"], home))
        ws5.cell(r, 5, int(row["positions"]))
        ws5.cell(r, 6, float(row["items"]))
        ws5.cell(r, 7, float(row["shipping"]))
        ws5.cell(r, 8, float(row["discount"]))
        ws5.cell(r, 9, float(row["ship_discount"]))
        ws5.cell(r, 10, f"=ROUND(F{r}+G{r}-H{r}-I{r},2)")
        r += 1
    last5 = r - 1
    ws5.cell(r, 1, "SUMME")
    for c in range(5, 11):
        col = get_column_letter(c)
        ws5[f"{col}{r}"] = f"=SUM({col}5:{col}{last5})"
    style_block(ws5, 5, r, 10, total_row=r, eur_cols=(6, 7, 8, 9, 10),
                center_cols=(2, 4, 5), size=9)
    for rr in range(5, r):
        ws5.cell(rr, 2).number_format = "DD.MM.YYYY"
    widths(ws5, dict(zip("ABCDEFGHIJ", [14, 14, 22, 11, 11, 12, 11, 11, 13, 13])))
    ws5.freeze_panes = "A5"
    ws5.auto_filter.ref = f"A4:J{last5}"

    # ---- Sheet 6: methodology ----
    ws6 = wb.create_sheet("Hinweise & Methodik")
    sheet_title(ws6, "Hinweise, Annahmen und Prüfpunkte")
    total_gross = money(orders["brutto"].sum())
    oss_gross = money(sum(x[4] for x in oss))
    third_gross = money(sum(x[3] for x in third))
    home_gross = money(agg.loc[home, "brutto"]) if home in agg.index else 0.0
    notes = [
        ("Datengrundlage",
         f"Etsy-Exporte 'Sold Order Items' für {quarter} {year}: {len(orders)} Bestellungen, "
         f"Gesamtbrutto {total_gross:,.2f} €. Alle Beträge in EUR."
         + (f" Eingeschränkter Zeitraum: nur Verkäufe vom "
            f"{orders['sale'].min():%d.%m.%Y} bis {orders['sale'].max():%d.%m.%Y} — frühere "
            "Umsätze des Quartals wurden bewusst ausgeklammert, weil sie bereits in einer "
            "früheren Erklärung enthalten waren." if restricted else "")),
        ("Berechnung des Bruttoumsatzes",
         "Je Bestellung: Item Total (Artikelpreis × Menge) + Order Shipping − Discount Amount "
         "− Shipping Discount. Versandkosten und Rabatte stehen im Etsy-Export nur in der "
         "ersten Zeile einer Bestellung und werden deshalb je Bestellung und nicht je "
         "Artikelzeile aggregiert — sonst käme es zu Doppelerfassungen."),
        ("Versandkosten",
         "Versandkosten sind als unselbständige Nebenleistung Teil der Bemessungsgrundlage "
         "und teilen das Steuerschicksal der Hauptleistung. Sie sind daher einbezogen."),
        ("Brutto- oder Nettopreise?",
         "Sofern Etsy keine Umsatzsteuer einbehalten hat ('VAT Paid by Buyer' = 0), sind die "
         "vereinnahmten Beträge Bruttobeträge inklusive der Umsatzsteuer des Bestimmungslandes: "
         "Netto = Brutto ÷ (1 + Steuersatz)."),
        ("Steuersätze",
         "Angesetzt ist jeweils der Regelsteuersatz des Bestimmungslandes. Sollte ein "
         "ermäßigter Satz einschlägig sein, ist die Spalte 'Steuersatz' auf dem ersten Blatt "
         "anzupassen — alle Folgewerte rechnen sich automatisch neu."),
        ("Abgrenzung Inland",
         f"Lieferungen nach {home_name} ({home_gross:,.2f} € brutto) sind Inlandsumsätze und "
         "gehören NICHT in die OSS-Erklärung, sondern in die reguläre "
         "Umsatzsteuer-Voranmeldung."),
        ("Abgrenzung Drittland",
         f"Lieferungen außerhalb der EU ({third_gross:,.2f} € brutto) sind Ausfuhrlieferungen "
         "und gehören ebenfalls nicht in die OSS-Erklärung."),
        ("Summenprobe",
         f"OSS {oss_gross:,.2f} € + Inland {home_gross:,.2f} € + Drittland {third_gross:,.2f} € "
         f"= {total_gross:,.2f} €."),
        ("Retouren und Stornos",
         "Der Etsy-Export enthält keine Stornopositionen. Erfolgte Erstattungen sind aus dem "
         "Etsy-Zahlungskonto zu ergänzen und mindern die Bemessungsgrundlage des betroffenen "
         "Landes."),
        ("Übermittlungsweg",
         "Die OSS-Erklärung (EU-Regelung) wird über das BZSt-Online-Portal (Mein BOP) "
         "übermittelt — die Anmeldung erfolgt mit dem ELSTER-Zertifikat. Frist: einen Monat "
         "nach Quartalsende."),
        ("Vorbehalt",
         "Diese Auswertung ist eine rechnerische Aufbereitung der Etsy-Rohdaten und ersetzt "
         "keine steuerliche Beratung."),
    ]
    r = 4
    for head, text in notes:
        ws6.cell(r, 1, head).font = Font(name=FONT, bold=True, size=10, color="1F3864")
        cell = ws6.cell(r, 2, text)
        cell.font = Font(name=FONT, size=10)
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        ws6.row_dimensions[r].height = max(30, 13 * (len(text) // 95 + 1))
        r += 1
    widths(ws6, {"A": 26, "B": 105})

    for sheet in wb.worksheets:
        sheet.sheet_view.showGridLines = False
    wb.save(out_path)
    return oss, third, home_gross, total_gross


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("year", type=int)
    ap.add_argument("quarter", choices=sorted(QUARTER_MONTHS))
    ap.add_argument("csv", nargs="+", help="Etsy 'Sold Order Items' CSV exports (globs allowed)")
    ap.add_argument("-o", "--output", help="output .xlsx (default: OSS_<quarter>_<year>.xlsx)")
    ap.add_argument("--home", default="Germany",
                    help="seller's home country as spelled by Etsy (default: Germany)")
    ap.add_argument("--since", metavar="YYYY-MM-DD",
                    help="only orders sold on or after this date — use when earlier orders "
                         "of the quarter were already declared in a previous return")
    ap.add_argument("--until", metavar="YYYY-MM-DD",
                    help="only orders sold on or before this date")
    args = ap.parse_args(argv)

    paths = sorted({p for pat in args.csv for p in (glob.glob(pat) or [pat])})
    out = args.output or f"OSS_{args.quarter}_{args.year}.xlsx"

    _lines, orders = load_orders(paths)
    months = QUARTER_MONTHS[args.quarter]
    outside = orders[(orders["sale"].dt.year != args.year) | (~orders["month"].isin(months))]
    if not outside.empty:
        print(f"Warning: {len(outside)} order(s) fall outside {args.quarter} {args.year} "
              f"and are excluded.", file=sys.stderr)
        orders = orders.drop(outside.index)
    if args.since:
        cut = pd.Timestamp(args.since)
        dropped = (orders["sale"] < cut).sum()
        orders = orders[orders["sale"] >= cut]
        print(f"--since {args.since}: {dropped} earlier order(s) excluded.", file=sys.stderr)
    if args.until:
        cut = pd.Timestamp(args.until)
        dropped = (orders["sale"] > cut).sum()
        orders = orders[orders["sale"] <= cut]
        print(f"--until {args.until}: {dropped} later order(s) excluded.", file=sys.stderr)
    if orders.empty:
        raise SystemExit(f"No orders in {args.quarter} {args.year}.")

    oss, third, home_gross, total = build_workbook(orders, args.year, args.quarter,
                                                   args.home, out,
                                                   restricted=bool(args.since or args.until))

    print(f"{out}  —  {len(orders)} orders, {total:,.2f} EUR gross")
    print(f"{'Country':<26}{'Gross':>12}{'Rate':>8}{'Net':>12}{'VAT':>12}")
    net_sum = vat_sum = 0.0
    for name, code, rate, _n, brutto in oss:
        net = money(Decimal(str(brutto)) / (Decimal(1) + Decimal(str(rate))))
        vat = money(brutto - net)
        net_sum += net
        vat_sum += vat
        print(f"{name + ' (' + code + ')':<26}{brutto:>12,.2f}{rate:>7.1%}{net:>12,.2f}{vat:>12,.2f}")
    print(f"{'OSS TOTAL':<26}{sum(x[4] for x in oss):>12,.2f}{'':>8}"
          f"{net_sum:>12,.2f}{vat_sum:>12,.2f}")
    print(f"{'Domestic (' + args.home + ')':<26}{home_gross:>12,.2f}")
    print(f"{'Third countries':<26}{sum(x[3] for x in third):>12,.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
