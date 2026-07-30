#!/usr/bin/env python3
"""Erstellt die OSS-Meldung (One-Stop-Shop) aus einem Etsy-Bestellexport.

Aufruf:
    python3 tools/oss_report.py Bestellungen.csv --quartal 1 --jahr 2026
    python3 tools/oss_report.py Bestellungen.csv -q 1 -j 2026 --xlsx OSS_Q1_2026.xlsx

Der Export ist semikolongetrennt, CP1252-kodiert und ohne Kopfzeile. Die Belege
werden auf vier Kategorien verteilt, die unterschiedlich zu melden sind:

  * innergemeinschaftliche Fernverkaeufe B2C  -> OSS-Meldung des Quartals
  * Gutschriften auf Umsaetze aus Vorquartalen -> Abschnitt "Berichtigungen"
  * Gutschriften auf Umsaetze mit deutscher USt -> USt-Voranmeldung, Kz 81
  * Lieferungen ausserhalb des EU-USt-Gebiets  -> USt-Voranmeldung, Kz 43
"""

import argparse
import csv
import datetime
import html
import sys
from collections import defaultdict
from decimal import Decimal

# Spaltenpositionen im Etsy-Bestellexport (keine Kopfzeile vorhanden).
COL_BESTELLNR = 0
COL_BESTELLUNG = 1
COL_DATUM = 2
COL_BRUTTO = 4
COL_KUNDE = 5
COL_PLZ = 8
COL_ORT = 9
COL_LAND = 10
COL_RECHNUNG = 12
COL_SATZ = 15
COL_STEUER = 16
# Billbee legt die Rechnung erst beim Versand an, deshalb steht in Spalte 25
# beides zugleich: Versanddatum und Rechnungsdatum. Nachweisbar daran, dass die
# Rechnungsnummern streng mit dieser Spalte aufsteigen, mit dem Bestelldatum
# aus Spalte 2 dagegen nicht. Spalte 3 ist das Zahlungsdatum.
COL_VERSAND = 25
COL_NETTO = 29

DEUTSCHER_SATZ = Decimal("19")

# Regelsteuersaetze 2026 der EU-Mitgliedstaaten.
REGELSATZ = {
    "AT": 20, "BE": 21, "BG": 20, "HR": 25, "CY": 19, "CZ": 21, "DK": 25,
    "EE": 24, "FI": Decimal("25.5"), "FR": 20, "GR": 24, "HU": 27, "IE": 23,
    "IT": 22, "LV": 21, "LT": 21, "LU": 17, "MT": 18, "NL": 21, "PL": 23,
    "PT": 23, "RO": 21, "SK": 23, "SI": 22, "SE": 25, "ES": 21,
}

LAND_NAME = {
    "AT": "Österreich", "BE": "Belgien", "BG": "Bulgarien", "HR": "Kroatien",
    "CY": "Zypern", "CZ": "Tschechien", "DK": "Dänemark", "EE": "Estland",
    "FI": "Finnland", "FR": "Frankreich", "GR": "Griechenland", "HU": "Ungarn",
    "IE": "Irland", "IT": "Italien", "LV": "Lettland", "LT": "Litauen",
    "LU": "Luxemburg", "MT": "Malta", "NL": "Niederlande", "PL": "Polen",
    "PT": "Portugal", "RO": "Rumänien", "SK": "Slowakei", "SI": "Slowenien",
    "SE": "Schweden", "ES": "Spanien",
}


def gebiet_ausserhalb_eu(land, plz):
    """Liefert den Grund, falls die Lieferadresse nicht im EU-USt-Gebiet liegt."""
    p = plz.replace(" ", "").replace("-", "").upper()
    if land == "ES" and p[:2] in ("35", "38"):
        return "Kanarische Inseln"
    if land == "ES" and p[:2] in ("51", "52"):
        return "Ceuta / Melilla"
    if land == "FR" and p[:3] in ("971", "972", "973", "974", "976"):
        return "Französische Überseedepartements"
    if land == "FI" and p[:2] == "22":
        return "Åland"
    if land == "IT" and p in ("23030", "22060"):
        return "Livigno / Campione d'Italia"
    if land == "GR" and p[:3] == "630":
        return "Berg Athos"
    if land == "DE" and p in ("78266", "27498"):
        return "Büsingen / Helgoland"
    return None


def betrag(text):
    text = text.strip()
    if not text:
        return Decimal("0")
    return Decimal(text.replace(".", "").replace(",", "."))


def datum(text):
    text = text.strip()
    if not text:
        return None
    return datetime.datetime.strptime(text, "%d.%m.%Y").date()


def eur(wert):
    return f"{wert:,.2f}".replace(",", "#").replace(".", ",").replace("#", ".")


def prozent(satz):
    text = f"{satz:f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text.replace(".", ",") + " %"


def quartalsgrenzen(quartal, jahr):
    start_monat = 3 * (quartal - 1) + 1
    start = datetime.date(jahr, start_monat, 1)
    if quartal == 4:
        ende = datetime.date(jahr, 12, 31)
    else:
        ende = datetime.date(jahr, start_monat + 3, 1) - datetime.timedelta(days=1)
    return start, ende


def belege_lesen(pfad):
    with open(pfad, "rb") as fh:
        text = fh.read().decode("cp1252")
    for nr, zeile in enumerate(csv.reader(text.splitlines(), delimiter=";", quotechar='"'), 1):
        if len(zeile) <= COL_NETTO:
            continue
        yield nr, zeile


def beleg_aufbereiten(nr, zeile):
    return {
        "zeile": nr,
        "rechnung": zeile[COL_RECHNUNG] or "—",
        "bestellung": zeile[COL_BESTELLUNG].strip(),
        "datum": datum(zeile[COL_DATUM]),
        "rechnungsdatum": datum(zeile[COL_VERSAND]),
        "land": zeile[COL_LAND].strip().upper(),
        "plz": zeile[COL_PLZ].strip(),
        "ort": html.unescape(zeile[COL_ORT]),
        "kunde": html.unescape(zeile[COL_KUNDE]),
        "satz": betrag(zeile[COL_SATZ]),
        "netto": betrag(zeile[COL_NETTO]),
        "steuer": betrag(zeile[COL_STEUER]),
        "brutto": betrag(zeile[COL_BRUTTO]),
    }


def stichtag(beleg, basis):
    """Das Datum, das den Meldezeitraum des Belegs bestimmt.

    "rechnung" grenzt nach dem Rechnungsdatum ab. Billbee legt die Rechnung
    beim Versand an, das ist zugleich der Beginn der Versendung und damit der
    Zeitpunkt der Lieferung nach § 3 Abs. 6 UStG.

    "bestellung" grenzt nach dem Eingang der Bestellung ab. Eine Ende Maerz
    bestellte, Anfang April versandte Lieferung faellt dann noch ins erste
    Quartal, obwohl ihre Rechnung ein Aprildatum traegt.

    Gutschriften werden nicht versendet und tragen kein Rechnungsdatum in
    Spalte 25; fuer sie gilt unter beiden Varianten das Buchungsdatum.
    """
    gutschrift = beleg["bestellung"].endswith("-GS") or beleg["brutto"] < 0
    if basis == "rechnung" and not gutschrift:
        return beleg["rechnungsdatum"]
    return beleg["datum"]


def klassifizieren(belege, start, ende, basis="bestellung"):
    """Verteilt die Belege auf die Meldekategorien."""
    ergebnis = {
        "fernverkauf": [], "berichtigung": [], "deutsche_ust": [],
        "ausfuhr": [], "ausserhalb": [], "nicht_versendet": [],
    }
    for b in belege:
        tag = stichtag(b, basis)
        if tag is None:
            # Ohne Rechnung wurde auch nicht versendet: es liegt keine
            # Lieferung vor, die zu melden waere.
            ergebnis["nicht_versendet"].append(b)
            continue
        if not start <= tag <= ende:
            ergebnis["ausserhalb"].append(b)
            continue
        grund = gebiet_ausserhalb_eu(b["land"], b["plz"])
        if grund:
            b["grund"] = grund
            ergebnis["ausfuhr"].append(b)
            continue
        if b["bestellung"].endswith("-GS") or b["brutto"] < 0:
            # Der Steuersatz verraet, ob der Ursprungsumsatz im Bestimmungsland
            # oder noch mit deutscher USt versteuert wurde.
            if b["satz"] == REGELSATZ.get(b["land"]):
                ergebnis["berichtigung"].append(b)
            elif b["satz"] == DEUTSCHER_SATZ:
                ergebnis["deutsche_ust"].append(b)
            else:
                ergebnis["berichtigung"].append(b)
            continue
        ergebnis["fernverkauf"].append(b)
    return ergebnis


def pruefen(belege):
    """Rechnerische Plausibilitaetspruefung je Beleg."""
    hinweise = []
    for b in belege:
        if b["netto"] + b["steuer"] != b["brutto"]:
            hinweise.append(
                f"Rg. {b['rechnung']}: Netto {eur(b['netto'])} + USt {eur(b['steuer'])} "
                f"ergibt nicht das ausgewiesene Brutto {eur(b['brutto'])}")
        erwartet = (b["netto"] * b["satz"] / 100).quantize(Decimal("0.01"))
        if abs(erwartet - b["steuer"]) > Decimal("0.02"):
            hinweise.append(
                f"Rg. {b['rechnung']}: USt {eur(b['steuer'])} weicht ab von "
                f"{prozent(b['satz'])} auf {eur(b['netto'])} = {eur(erwartet)}")
        regel = REGELSATZ.get(b["land"])
        if regel is not None and b["satz"] != regel and b["steuer"] != 0:
            hinweise.append(
                f"Rg. {b['rechnung']}: {b['land']} mit {prozent(b['satz'])} "
                f"statt Regelsatz {prozent(Decimal(regel))}")
        if b["rechnung"] == "—" and b["rechnungsdatum"] is None:
            hinweise.append(
                f"Bestellung {b['bestellung']} ({b['land']}, {eur(b['brutto'])}, "
                f"{b['datum'].strftime('%d.%m.%Y')}): weder Rechnungsnummer noch "
                "Versanddatum – vor der Meldung klären, ob storniert oder offen")
    return hinweise


def summieren(belege):
    """Aggregiert nach Verbrauchsmitgliedstaat und Steuersatz."""
    summen = defaultdict(lambda: {"netto": Decimal(0), "steuer": Decimal(0),
                                  "brutto": Decimal(0), "anzahl": 0})
    for b in belege:
        eintrag = summen[(b["land"], b["satz"])]
        eintrag["netto"] += b["netto"]
        eintrag["steuer"] += b["steuer"]
        eintrag["brutto"] += b["brutto"]
        eintrag["anzahl"] += 1
    return dict(sorted(summen.items()))


def bericht_ausgeben(summen, kategorien, quartal, jahr, start, ende, hinweise,
                     basis="bestellung"):
    breite = 86
    print("=" * breite)
    print(f"OSS-MELDUNG · {quartal}. QUARTAL {jahr}")
    print(f"Zeitraum {start.strftime('%d.%m.%Y')} – {ende.strftime('%d.%m.%Y')} · Währung EUR")
    print("Abgrenzung nach "
          + ("Rechnungsdatum (= Versanddatum, § 3 Abs. 6 UStG)"
             if basis == "rechnung" else "Eingang der Bestellung"))
    print("=" * breite)

    print(f"\n1) MELDEDATEN FÜR ELSTER – innergemeinschaftliche Fernverkäufe (B2C)\n")
    print(f"{'Land':<5}{'Mitgliedstaat':<16}{'Steuersatz':>11}"
          f"{'Bemessungsgrundlage':>21}{'Steuerbetrag':>15}{'Belege':>8}")
    print("-" * breite)
    netto = steuer = brutto = Decimal(0)
    anzahl = 0
    for (land, satz), w in summen.items():
        print(f"{land:<5}{LAND_NAME.get(land, land):<16}{prozent(satz):>11}"
              f"{eur(w['netto']):>21}{eur(w['steuer']):>15}{w['anzahl']:>8}")
        netto += w["netto"]
        steuer += w["steuer"]
        brutto += w["brutto"]
        anzahl += w["anzahl"]
    print("-" * breite)
    print(f"{'SUMME':<32}{eur(netto):>21}{eur(steuer):>15}{anzahl:>8}")
    print(f"\nAn das BZSt zu zahlende Steuer: {eur(steuer)} EUR "
          f"(Bruttoumsatz {eur(brutto)} EUR)")

    if kategorien["berichtigung"]:
        print(f"\n\n2) BERICHTIGUNGEN ZU FRÜHEREN BESTEUERUNGSZEITRÄUMEN")
        print("   Eigener Abschnitt im OSS-Formular, nicht mit dem Quartal saldieren.\n")
        print(f"{'Rechnung':<10}{'Land':<5}{'Satz':>8}{'Bemess.grdl.':>15}"
              f"{'Steuer':>11}   Bestellung")
        print("-" * breite)
        bn = bs = Decimal(0)
        for b in kategorien["berichtigung"]:
            print(f"{b['rechnung']:<10}{b['land']:<5}{prozent(b['satz']):>8}"
                  f"{eur(b['netto']):>15}{eur(b['steuer']):>11}   {b['bestellung']}")
            bn += b["netto"]
            bs += b["steuer"]
        print("-" * breite)
        print(f"{'SUMME':<23}{eur(bn):>15}{eur(bs):>11}")
        print(f"\nZahllast nach Berichtigungen: {eur(steuer + bs)} EUR")

    if kategorien["deutsche_ust"] or kategorien["ausfuhr"]:
        print(f"\n\n3) NICHT IN DIE OSS-MELDUNG – deutsche USt-Voranmeldung\n")
        for b in kategorien["deutsche_ust"]:
            print(f"   Kz 81  Rg. {b['rechnung']} ({b['land']}, {prozent(b['satz'])}): "
                  f"Netto {eur(b['netto'])}, USt {eur(b['steuer'])} – "
                  f"Gutschrift auf Umsatz mit deutscher USt")
        for b in kategorien["ausfuhr"]:
            print(f"   Kz 43  Rg. {b['rechnung']} ({b['land']} {b['plz']} {b['ort']}): "
                  f"Netto {eur(b['netto'])} – {b['grund']}, kein EU-USt-Gebiet")

    print(f"\n\n4) ABSTIMMUNG")
    zeilen = [
        ("Fernverkäufe B2C (OSS)", kategorien["fernverkauf"]),
        ("Berichtigungen Vorquartale (OSS)", kategorien["berichtigung"]),
        ("Korrektur deutsche USt (Kz 81)", kategorien["deutsche_ust"]),
        ("Steuerfreie Ausfuhr (Kz 43)", kategorien["ausfuhr"]),
        ("Außerhalb des Meldezeitraums", kategorien["ausserhalb"]),
        ("Ohne Rechnung, keine Lieferung", kategorien["nicht_versendet"]),
    ]
    gesamt_netto = gesamt_steuer = Decimal(0)
    gesamt_anzahl = 0
    for bezeichnung, gruppe in zeilen:
        n = sum(b["netto"] for b in gruppe)
        s = sum(b["steuer"] for b in gruppe)
        print(f"   {bezeichnung:<36}{len(gruppe):>5} Belege"
              f"{eur(n):>13}{eur(s):>12}")
        gesamt_netto += n
        gesamt_steuer += s
        gesamt_anzahl += len(gruppe)
    print("   " + "-" * (breite - 3))
    print(f"   {'Summe Quelldatei':<36}{gesamt_anzahl:>5} Belege"
          f"{eur(gesamt_netto):>13}{eur(gesamt_steuer):>12}")

    if hinweise:
        print(f"\n\n5) PRÜFHINWEISE\n")
        for h in dict.fromkeys(hinweise):
            print(f"   ! {h}")


def xlsx_schreiben(pfad, summen, kategorien, quartal, jahr, start, ende):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    EUR_FMT = "#,##0.00"
    kopf_fill = PatternFill("solid", fgColor="1F3864")
    kopf_font = Font(color="FFFFFF", bold=True, size=10)
    summen_fill = PatternFill("solid", fgColor="D9E2F3")
    duenn = Side(style="thin", color="B4C6E7")
    rahmen = Border(left=duenn, right=duenn, top=duenn, bottom=duenn)
    oben = Side(style="medium", color="1F3864")

    wb = Workbook()

    def kopfzeile(ws, zeile, spalten, breiten):
        for i, (name, breite) in enumerate(zip(spalten, breiten), 1):
            zelle = ws.cell(zeile, i, name)
            zelle.fill = kopf_fill
            zelle.font = kopf_font
            zelle.border = rahmen
            zelle.alignment = Alignment(horizontal="center", vertical="center",
                                        wrap_text=True)
            ws.column_dimensions[get_column_letter(i)].width = breite
        ws.row_dimensions[zeile].height = 28

    ws = wb.active
    ws.title = f"OSS-Meldung Q{quartal} {jahr}"
    ws["A1"] = f"OSS-Meldung · {quartal}. Quartal {jahr}"
    ws["A1"].font = Font(bold=True, size=14, color="1F3864")
    ws["A2"] = (f"Innergemeinschaftliche Fernverkäufe B2C · "
                f"{start.strftime('%d.%m.%Y')}–{ende.strftime('%d.%m.%Y')} · EUR")
    ws["A2"].font = Font(italic=True, size=9, color="555555")

    zeile = 4
    kopfzeile(ws, zeile, ["Land", "Verbrauchsmitgliedstaat", "Steuersatz",
                          "Bemessungsgrundlage", "Steuerbetrag", "Bruttoumsatz",
                          "Belege"], [8, 24, 11, 20, 14, 14, 9])
    zeile += 1
    erste = zeile
    for (land, satz), w in summen.items():
        ws.cell(zeile, 1, land).alignment = Alignment(horizontal="center")
        ws.cell(zeile, 2, LAND_NAME.get(land, land))
        ws.cell(zeile, 3, float(satz) / 100).number_format = "0.0%"
        for spalte, wert in ((4, w["netto"]), (5, w["steuer"]), (6, w["brutto"])):
            ws.cell(zeile, spalte, float(wert)).number_format = EUR_FMT
        ws.cell(zeile, 7, w["anzahl"]).alignment = Alignment(horizontal="center")
        for spalte in range(1, 8):
            ws.cell(zeile, spalte).border = rahmen
        zeile += 1
    ws.cell(zeile, 2, "SUMME")
    for spalte, buchstabe in ((4, "D"), (5, "E"), (6, "F"), (7, "G")):
        ws.cell(zeile, spalte, f"=SUM({buchstabe}{erste}:{buchstabe}{zeile - 1})")
    for spalte in range(1, 8):
        zelle = ws.cell(zeile, spalte)
        zelle.fill = summen_fill
        zelle.font = Font(bold=True)
        zelle.border = Border(left=duenn, right=duenn, top=oben, bottom=duenn)
        if spalte in (4, 5, 6):
            zelle.number_format = EUR_FMT
    ws.freeze_panes = "A5"

    detail = wb.create_sheet("Einzelbelege")
    detail["A1"] = "Einzelbelege der OSS-Fernverkäufe"
    detail["A1"].font = Font(bold=True, size=14, color="1F3864")
    kopfzeile(detail, 3, ["Rechnung", "Datum", "Bestellung", "Kunde", "Ort",
                          "PLZ", "Land", "Steuersatz", "Bemessungsgrundlage",
                          "Steuerbetrag", "Brutto"],
              [10, 12, 16, 28, 22, 11, 7, 11, 20, 14, 12])
    zeile = 4
    for b in sorted(kategorien["fernverkauf"], key=lambda x: (x["land"], x["datum"])):
        detail.cell(zeile, 1, b["rechnung"])
        detail.cell(zeile, 2, b["datum"]).number_format = "DD.MM.YYYY"
        detail.cell(zeile, 3, b["bestellung"])
        detail.cell(zeile, 4, b["kunde"])
        detail.cell(zeile, 5, b["ort"])
        detail.cell(zeile, 6, b["plz"])
        detail.cell(zeile, 7, b["land"]).alignment = Alignment(horizontal="center")
        detail.cell(zeile, 8, float(b["satz"]) / 100).number_format = "0.0%"
        for spalte, wert in ((9, b["netto"]), (10, b["steuer"]), (11, b["brutto"])):
            detail.cell(zeile, spalte, float(wert)).number_format = EUR_FMT
        for spalte in range(1, 12):
            detail.cell(zeile, spalte).border = rahmen
        zeile += 1
    detail.cell(zeile, 4, "SUMME").font = Font(bold=True)
    for spalte, buchstabe in ((9, "I"), (10, "J"), (11, "K")):
        zelle = detail.cell(zeile, spalte, f"=SUM({buchstabe}4:{buchstabe}{zeile - 1})")
        zelle.number_format = EUR_FMT
        zelle.font = Font(bold=True)
    for spalte in range(1, 12):
        detail.cell(zeile, spalte).fill = summen_fill
        detail.cell(zeile, spalte).border = Border(left=duenn, right=duenn,
                                                   top=oben, bottom=duenn)
    detail.freeze_panes = "A4"
    detail.auto_filter.ref = f"A3:K{zeile - 1}"

    for blatt in wb:
        blatt.sheet_view.showGridLines = False
    wb.save(pfad)


def main():
    p = argparse.ArgumentParser(description="OSS-Meldung aus Etsy-Bestellexport erstellen")
    p.add_argument("csv", help="Etsy-Bestellexport (CSV, semikolongetrennt, CP1252)")
    p.add_argument("-q", "--quartal", type=int, required=True, choices=(1, 2, 3, 4))
    p.add_argument("-j", "--jahr", type=int, required=True)
    p.add_argument("--basis", choices=("bestellung", "rechnung"), default="bestellung",
                   help="Datum, das den Meldezeitraum bestimmt: Bestelleingang "
                        "(Vorgabe) oder Rechnungsdatum, das hier zugleich das "
                        "Versanddatum ist (§ 3 Abs. 6 UStG)")
    p.add_argument("--xlsx", help="Zusätzlich eine Excel-Mappe schreiben")
    args = p.parse_args()

    start, ende = quartalsgrenzen(args.quartal, args.jahr)
    belege = [beleg_aufbereiten(nr, z) for nr, z in belege_lesen(args.csv)]
    if not belege:
        sys.exit("Keine auswertbaren Belege in der Datei gefunden.")

    kategorien = klassifizieren(belege, start, ende, args.basis)
    summen = summieren(kategorien["fernverkauf"])
    im_zeitraum = [b for b in belege
                   if (t := stichtag(b, args.basis)) and start <= t <= ende]
    hinweise = pruefen(im_zeitraum)
    if args.basis == "rechnung":
        hinweise.append(
            "Abgrenzung nach Rechnungsdatum: Bestellungen aus dem Vorquartal, die erst "
            f"im {args.quartal}. Quartal berechnet wurden, gehören hier hinein. Prüfen, "
            "ob der Export sie enthält – er beginnt am "
            f"{min(b['datum'] for b in belege).strftime('%d.%m.%Y')}.")
    else:
        spaet = [b for b in kategorien["fernverkauf"]
                 if b["rechnungsdatum"] and b["rechnungsdatum"] > ende]
        if spaet:
            hinweise.append(
                f"Abgrenzung nach Bestelleingang: {len(spaet)} Lieferungen dieses Quartals "
                "tragen ein Rechnungsdatum aus dem Folgequartal "
                f"(Bemessungsgrundlage {eur(sum(b['netto'] for b in spaet))}). Sie sind hier "
                "enthalten und dürfen im Folgequartal nicht noch einmal erscheinen.")
    bericht_ausgeben(summen, kategorien, args.quartal, args.jahr, start, ende, hinweise,
                     args.basis)

    if args.xlsx:
        xlsx_schreiben(args.xlsx, summen, kategorien, args.quartal, args.jahr, start, ende)
        print(f"\nExcel-Mappe geschrieben: {args.xlsx}")


if __name__ == "__main__":
    main()
