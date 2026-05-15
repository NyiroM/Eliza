#!/usr/bin/env python3
# scripts/build_hays_salary_json.py — Hays HU 2026: full guide monthly bands + IT Contracting day rates → JSON for salary-oracle.
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from pypdf import PdfReader
except ImportError:
    print("Install: pip install pypdf cryptography", file=sys.stderr)
    raise

SENIORITY_ORDER = ("Junior", "Medior", "Senior", "Lead")

SKIP_ROLE_SUBSTR = (
    "pozíció",
    "min.",
    "max.",
    "módusz",
    "junior sw engineer",
    "medior sw engineer",
    "senior sw engineer",
    "staff/architect",
    "architect /",
    "bruttó havi",
    "állás esetén",
)

PROSE_SUBSTR = (
    "iparági trend",
    "várható top",
    "munkavállaló",
    "munkáltató",
    "előszó",
    "kapcsolat",
    "hays hungary",
    "salary guide",
    "munkaerőpiac",
)


def spaced_huf_tokens_to_amounts(tokens: list[str]) -> list[int]:
    """Hungarian spaced HUF: 1–2 digit prefix + at most two ×1000 triples; 3-digit prefix + at most one triple."""
    amounts: list[int] = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if len(t) > 3:
            amounts.append(int(t))
            i += 1
            continue
        val = int(t)
        i += 1
        max_triples = 2 if len(t) <= 2 else 1
        got = 0
        while i < len(tokens) and len(tokens[i]) == 3 and got < max_triples:
            val = val * 1000 + int(tokens[i])
            i += 1
            got += 1
        amounts.append(val)
    return amounts


# Spaced thousands (HUF) at end of row — avoids picking digits from "(0-3 év)" in role text.
_HUF_CHUNK = r"\d{1,3}(?: \d{3})+"
_RE_3_TAIL = re.compile(rf"({_HUF_CHUNK})\s+({_HUF_CHUNK})\s+({_HUF_CHUNK})\s*$")
_RE_12_TAIL = re.compile(rf"(?:{_HUF_CHUNK}\s+){{11}}{_HUF_CHUNK}\s*$")


def parse_monthly_line_amounts(line: str) -> tuple[str, list[int]] | None:
    """Role + exactly 12 gross monthly HUF values (4 seniority × min/max/modus), anchored at line end."""
    m = _RE_12_TAIL.search(line)
    if not m:
        return None
    tail = m.group(0)
    tokens = re.findall(r"\d+", tail)
    amounts = spaced_huf_tokens_to_amounts(tokens)
    if len(amounts) != 12:
        return None
    role = line[: m.start()].strip()
    if len(role) < 4:
        return None
    return role, amounts


def parse_three_amount_line(line: str) -> tuple[str, int, int, int] | None:
    """Role + three trailing spaced HUF amounts (min, max, modus); ignores digits inside role parentheses."""
    m = _RE_3_TAIL.search(line)
    if not m:
        return None
    parts = [m.group(1), m.group(2), m.group(3)]
    nums: list[int] = []
    for g in parts:
        toks = re.findall(r"\d+", g)
        a = spaced_huf_tokens_to_amounts(toks)
        if len(a) != 1:
            return None
        nums.append(a[0])
    role = line[: m.start()].strip()
    if len(role) < 3:
        return None
    return role, nums[0], nums[1], nums[2]


def extract_pdf_text(pdf_path: Path) -> str:
    r = PdfReader(str(pdf_path))
    if r.is_encrypted:
        r.decrypt("")
    parts: list[str] = []
    for p in r.pages:
        parts.append(p.extract_text() or "")
    return "\n".join(parts)


def strip_ft_nap_contracting_raw_block(text: str) -> str:
    """Remove IT Contracting Ft/nap table text (parsed separately); avoids triple-column false positives."""
    start = text.find("Backend Min. Ft/nap")
    if start == -1:
        start = text.find("Min. Ft/nap*")
    end = text.find("Jog és compliance", start if start != -1 else 0)
    if start != -1 and end != -1 and end > start:
        return text[:start] + "\n" + text[end:]
    return text


def merge_split_salary_lines(lines: list[str]) -> list[str]:
    """Join wrapped PDF lines when a salary row is split mid-number."""
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        if not s or s.startswith("====="):
            i += 1
            continue
        if re.search(r"\d", s):
            j = i
            buf = s
            while j + 1 < n:
                nxt = lines[j + 1].strip()
                if not nxt:
                    j += 1
                    continue
                if not nxt[0].isdigit():
                    break
                cand = buf + " " + nxt
                if parse_monthly_line_amounts(cand):
                    buf = cand
                    j += 1
                    break
                dg = re.search(r"\d", cand)
                if not dg:
                    break
                toks = re.findall(r"\d+", cand[dg.start() :])
                n_am = len(spaced_huf_tokens_to_amounts(toks))
                if n_am > 13:
                    break
                buf = cand
                j += 1
                if parse_monthly_line_amounts(buf) or parse_three_amount_line(buf):
                    break
            out.append(buf)
            i = j + 1
        else:
            out.append(s)
            i += 1
    return out


def role_skip(low: str) -> bool:
    if any(k in low for k in SKIP_ROLE_SUBSTR):
        return True
    if "ft/nap" in low:
        return True
    if "tipikus" in low and "nap" in low:
        return True
    return False


def is_prose_line(low: str) -> bool:
    return any(p in low for p in PROSE_SUBSTR)


BAND_HEADER_HINT = re.compile(
    r"(friss\s+diplom|junior|medior|szenior|menedzseri|\(0-1\s*év|\(0-3\s*év|\(1-3\s*év|\(3-5\s*év|\(5\+|5\+\s*év)",
    re.I,
)


def infer_seniority_threecol(role: str, band_header: str) -> str:
    blob = f"{band_header} {role}".lower().replace("t eam", "team")
    bh = band_header.lower()
    if "menedzseri" in bh:
        return "Lead"
    if "friss diplomás" in blob or "0-1 év" in blob:
        return "Junior"
    if "junior" in blob or "(0-3 év)" in blob or "(1-3 év" in blob:
        return "Junior"
    if "medior" in blob or "(3-5 év)" in blob:
        if "szenior" not in blob:
            return "Medior"
    if "szenior" in blob or "(5+ év)" in blob or "5+ év" in blob:
        return "Senior"
    rl = role.lower()
    if any(k in rl for k in ("menedzser", "igazgat", "vezető", "director", "főkönyvel", "chief", "head of")):
        return "Lead"
    return "unknown"


def build_hays_label(major: str, subsection: str, role: str) -> str:
    parts = [p for p in (major.strip(), subsection.strip(), role.strip()) if p and p != "Unknown"]
    if len(parts) >= 3:
        return f"{parts[0]} › {parts[1]} › {parts[2]}"
    if len(parts) == 2:
        return f"{parts[0]} › {parts[1]}"
    return parts[0] if parts else role


def parse_full_guide_rows(lines: list[str]) -> list[dict]:
    """Walk merged lines; extract 12-column (4×3) and 3-column monthly rows with chapter context."""
    rows: list[dict] = []
    major = "Unknown"
    subsection = ""
    band_header = ""

    n = len(lines)
    idx = 0
    while idx < n:
        line = lines[idx].strip()
        idx += 1
        if not line or line.startswith("====="):
            continue
        low = line.lower()

        if line == "Bérek" and idx >= 2:
            subsection = ""
            band_header = ""
            p = lines[idx - 2].strip()
            if p and len(p) < 120 and not re.search(r"\d", p) and not is_prose_line(p.lower()):
                major = p
            continue

        if "pozíció" in low and "min" in low:
            continue

        if not re.search(r"\d", line):
            if is_prose_line(low):
                continue
            if len(line) > 70:
                continue
            if BAND_HEADER_HINT.search(line):
                band_header = line
                continue
            if 2 < len(line) < 55 and line != "Bérek":
                subsection = line
            continue

        p12 = parse_monthly_line_amounts(line)
        if p12:
            role, nums = p12
            rl = role.lower()
            if len(role) < 4 or len(role) > 120 or role_skip(rl):
                continue
            label = build_hays_label(major, subsection, role)
            for i, sen in enumerate(SENIORITY_ORDER):
                b = i * 3
                rows.append(
                    {
                        "industry": major,
                        "hays_label": label,
                        "seniority": sen,
                        "min": nums[b],
                        "max": nums[b + 1],
                        "modus": nums[b + 2],
                        "day_rate": None,
                    }
                )
            continue

        p3 = parse_three_amount_line(line)
        if p3:
            role, mn, mx, md = p3
            rl = role.lower()
            if len(role) < 3 or len(role) > 130 or role_skip(rl):
                continue
            if mx < 250_000:
                continue
            sen = infer_seniority_threecol(role, band_header)
            label = build_hays_label(major, subsection, role)
            rows.append(
                {
                    "industry": major,
                    "hays_label": label,
                    "seniority": sen,
                    "min": mn,
                    "max": mx,
                    "modus": md,
                    "day_rate": None,
                }
            )

    return rows


def dedupe_rows(rows: list[dict]) -> list[dict]:
    seen: set[tuple] = set()
    out: list[dict] = []
    for r in rows:
        key = (r["industry"], r["hays_label"], r["seniority"], r["min"], r["max"], r["modus"])
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    pdf = root / "storage" / "HU-Hays Hungary Salary Guide 2026.pdf"
    out_path = root / "data" / "salary" / "hays-hu-2026.json"
    if not pdf.is_file():
        print(f"Missing PDF: {pdf}", file=sys.stderr)
        sys.exit(1)

    text = strip_ft_nap_contracting_raw_block(extract_pdf_text(pdf))
    raw_lines = text.splitlines()
    merged = merge_split_salary_lines(raw_lines)
    monthly = dedupe_rows(parse_full_guide_rows(merged))
    daily = it_contracting_rows_from_pdf()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    rows = monthly + daily
    out_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"Wrote {len(rows)} rows to {out_path} "
        f"(monthly_all_guide={len(monthly)}, contracting_day={len(daily)}, "
        f"generated_at={datetime.now(timezone.utc).isoformat()})"
    )


def it_contracting_rows_from_pdf() -> list[dict]:
    """Structured Ft/nap bands from Hays 2026 IT Contracting (PDF pp. 46–49)."""
    out: list[dict] = []
    flat: list[tuple[str, str, str, tuple[int, int, int]]] = [
        ("Java", "Java Developer", "Junior", (55_000, 80_000, 72_000)),
        ("Java", "Java Developer", "Medior", (80_000, 112_000, 95_000)),
        ("Java", "Java Developer", "Senior", (100_000, 160_000, 115_000)),
        (".NET/C#", ".NET Developer", "Junior", (55_000, 80_000, 70_000)),
        (".NET/C#", ".NET Developer", "Medior", (80_000, 115_000, 100_000)),
        (".NET/C#", ".NET Developer", "Senior", (100_000, 160_000, 120_000)),
        ("Python", "Python Developer", "Junior", (60_000, 75_000, 72_000)),
        ("Python", "Python Developer", "Medior", (80_000, 115_000, 104_000)),
        ("Python", "Python Developer", "Senior", (104_000, 155_000, 115_000)),
        ("C/C++", "C/C++ Developer", "Junior", (55_000, 75_000, 68_000)),
        ("C/C++", "C/C++ Developer", "Medior", (80_000, 110_000, 95_000)),
        ("C/C++", "C/C++ Developer", "Senior", (95_000, 145_000, 110_000)),
        ("Software Architect", "Software Architect", "Senior", (112_000, 195_000, 140_000)),
        ("DevOps Engineer", "DevOps Engineer", "Junior", (64_000, 85_000, 75_000)),
        ("DevOps Engineer", "DevOps Engineer", "Medior", (80_000, 120_000, 95_000)),
        ("DevOps Engineer", "DevOps Engineer", "Senior", (112_000, 160_000, 120_000)),
        ("System/Network Administrator", "System Network Administrator", "Junior", (40_000, 64_000, 56_000)),
        ("System/Network Administrator", "System Network Administrator", "Medior", (60_000, 85_000, 70_000)),
        ("System/Network Administrator", "System Network Administrator", "Senior", (65_000, 90_000, 80_000)),
        ("System/Network/App Engineer", "System Network App Engineer", "Junior", (48_000, 68_000, 64_000)),
        ("System/Network/App Engineer", "System Network App Engineer", "Medior", (72_000, 88_000, 82_000)),
        ("System/Network/App Engineer", "System Network App Engineer", "Senior", (80_000, 115_000, 100_000)),
        ("MLOps Engineer", "MLOps Engineer", "Senior", (100_000, 150_000, 112_000)),
        ("Test Automation Engineer", "Test Automation Engineer", "Junior", (48_000, 70_000, 56_000)),
        ("Test Automation Engineer", "Test Automation Engineer", "Medior", (80_000, 100_000, 90_000)),
        ("Test Automation Engineer", "Test Automation Engineer", "Senior", (88_000, 160_000, 112_000)),
        ("Manual Tester", "Manual Tester", "Junior", (40_000, 55_000, 48_000)),
        ("Manual Tester", "Manual Tester", "Medior", (50_000, 70_000, 56_000)),
        ("Manual Tester", "Manual Tester", "Senior", (64_000, 110_000, 80_000)),
        ("Test Manager", "Test Manager", "Senior", (100_000, 135_000, 115_000)),
        ("Android/iOS", "Mobile Developer", "Junior", (50_000, 78_000, 68_000)),
        ("Android/iOS", "Mobile Developer", "Medior", (76_000, 110_000, 100_000)),
        ("Android/iOS", "Mobile Developer", "Senior", (90_000, 160_000, 115_000)),
        ("Frontend", "Frontend Developer", "Junior", (50_000, 72_000, 70_000)),
        ("Frontend", "Frontend Developer", "Medior", (72_000, 115_000, 90_000)),
        ("Frontend", "Frontend Developer", "Senior", (90_000, 155_000, 118_000)),
        ("Fullstack", "Fullstack Developer", "Junior", (60_000, 85_000, 80_000)),
        ("Fullstack", "Fullstack Developer", "Medior", (85_000, 115_000, 100_000)),
        ("Fullstack", "Fullstack Developer", "Senior", (104_000, 160_000, 115_000)),
        ("Cloud Engineer", "Cloud Engineer", "Junior", (68_000, 95_000, 85_000)),
        ("Cloud Engineer", "Cloud Engineer", "Medior", (88_000, 116_000, 100_000)),
        ("Cloud Engineer", "Cloud Engineer", "Senior", (100_000, 152_000, 120_000)),
        ("Cloud Architect", "Cloud Architect", "Senior", (110_000, 185_000, 140_000)),
        ("Help Desk", "Help Desk", "Junior", (32_000, 45_000, 40_000)),
        ("Help Desk", "Help Desk", "Medior", (40_000, 60_000, 50_000)),
        ("Help Desk", "Help Desk", "Senior", (48_000, 75_000, 60_000)),
        ("Data Engineer", "Data Engineer", "Junior", (64_000, 88_000, 72_000)),
        ("Data Engineer", "Data Engineer", "Medior", (90_000, 108_000, 96_000)),
        ("Data Engineer", "Data Engineer", "Senior", (100_000, 140_000, 112_000)),
        ("Data Scientist", "Data Scientist", "Junior", (72_000, 94_000, 85_000)),
        ("Data Scientist", "Data Scientist", "Medior", (85_000, 115_000, 100_000)),
        ("Data Scientist", "Data Scientist", "Senior", (95_000, 155_000, 125_000)),
        ("Data Architect", "Data Architect", "Senior", (120_000, 170_000, 128_000)),
        ("Database Administrator", "Database Administrator contracting", "Senior", (68_000, 100_000, 80_000)),
        ("Data Analyst", "Data Analyst contracting", "Senior", (72_000, 116_000, 96_000)),
        ("BI Developer", "BI Developer contracting", "Senior", (80_000, 160_000, 115_000)),
        ("BI Consultant", "BI Consultant contracting", "Senior", (88_000, 160_000, 108_000)),
        ("Security Engineer", "Security Engineer contracting", "Junior", (68_000, 90_000, 80_000)),
        ("Security Engineer", "Security Engineer contracting", "Medior", (85_000, 115_000, 100_000)),
        ("Security Engineer", "Security Engineer contracting", "Senior", (110_000, 165_000, 125_000)),
        ("Cyber Security Consultant", "Cyber Security Consultant", "Senior", (105_000, 180_000, 135_000)),
        ("Security Manager", "Security Manager contracting", "Senior", (120_000, 170_000, 140_000)),
        ("Security Architect", "Security Architect contracting", "Senior", (115_000, 170_000, 140_000)),
        ("DWH Developer", "DWH Developer", "Junior", (60_000, 90_000, 75_000)),
        ("DWH Developer", "DWH Developer", "Medior", (80_000, 110_000, 95_000)),
        ("DWH Developer", "DWH Developer", "Senior", (100_000, 155_000, 115_000)),
        ("DWH System Analyst", "DWH System Analyst", "Junior", (50_000, 70_000, 64_000)),
        ("DWH System Analyst", "DWH System Analyst", "Medior", (80_000, 115_000, 100_000)),
        ("DWH System Analyst", "DWH System Analyst", "Senior", (100_000, 160_000, 120_000)),
        ("Project Manager", "Project Manager contracting", "Junior", (60_000, 88_000, 80_000)),
        ("Project Manager", "Project Manager contracting", "Medior", (75_000, 110_000, 100_000)),
        ("Project Manager", "Project Manager contracting", "Senior", (90_000, 180_000, 120_000)),
        ("Programme Manager", "Programme Manager contracting", "Senior", (120_000, 190_000, 145_000)),
        ("Product Owner", "Product Owner contracting", "Junior", (65_000, 85_000, 70_000)),
        ("Product Owner", "Product Owner contracting", "Medior", (80_000, 115_000, 95_000)),
        ("Product Owner", "Product Owner contracting", "Senior", (100_000, 150_000, 118_000)),
        ("Solution Architect", "Solution Architect contracting", "Senior", (120_000, 165_000, 135_000)),
        ("Enterprise Architect", "Enterprise Architect contracting", "Senior", (128_000, 175_000, 150_000)),
        ("SAP Consultant", "SAP Consultant contracting", "Junior", (80_000, 112_000, 96_000)),
        ("SAP Consultant", "SAP Consultant contracting", "Medior", (96_000, 145_000, 116_000)),
        ("SAP Consultant", "SAP Consultant contracting", "Senior", (130_000, 200_000, 155_000)),
        ("SAP Developer", "SAP Developer contracting", "Junior", (80_000, 110_000, 95_000)),
        ("SAP Developer", "SAP Developer contracting", "Medior", (90_000, 130_000, 115_000)),
        ("SAP Developer", "SAP Developer contracting", "Senior", (120_000, 190_000, 155_000)),
        ("Business Analyst", "Business Analyst contracting", "Junior", (60_000, 88_000, 70_000)),
        ("Business Analyst", "Business Analyst contracting", "Medior", (72_000, 105_000, 88_000)),
        ("Business Analyst", "Business Analyst contracting", "Senior", (100_000, 135_000, 112_000)),
        ("System Analyst", "System Analyst contracting", "Junior", (64_000, 88_000, 70_000)),
        ("System Analyst", "System Analyst contracting", "Medior", (80_000, 115_000, 100_000)),
        ("System Analyst", "System Analyst contracting", "Senior", (100_000, 165_000, 120_000)),
        ("Scrum Master", "Scrum Master contracting", "Junior", (65_000, 80_000, 72_000)),
        ("Scrum Master", "Scrum Master contracting", "Medior", (75_000, 115_000, 90_000)),
        ("Scrum Master", "Scrum Master contracting", "Senior", (85_000, 145_000, 115_000)),
        ("Agile Coach", "Agile Coach contracting", "Senior", (90_000, 160_000, 120_000)),
    ]
    for stack, label, sen, (mn, mx, tip) in flat:
        out.append(
            {
                "industry": "IT Contracting",
                "hays_label": f"{label} ({stack})",
                "seniority": sen,
                "min": mn,
                "max": mx,
                "modus": tip,
                "day_rate": tip,
            }
        )
    return out


if __name__ == "__main__":
    main()
