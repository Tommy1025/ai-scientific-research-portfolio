"""Merge every second-preprocessed CSV into one audited ML dataset.

Equivalent SMILES spellings are matched with RDKit canonical isomeric SMILES.
Rows are deduplicated only when the molecular identity and every other output
field, including PCE, are equal after conservative numeric normalization.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from itertools import combinations
from pathlib import Path
from typing import Iterable, Sequence
from zoneinfo import ZoneInfo

import pandas as pd  # type: ignore[import-not-found]
import rdkit  # type: ignore[import-not-found]
from rdkit import Chem  # type: ignore[import-not-found]


VERSION = "1.1.1"
EXPECTED_RDKIT_VERSION = "2026.03.5"
EXPECTED_COLUMN_COUNT = 224
EXPECTED_DESCRIPTOR_COUNT = 196

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
DEFAULT_INPUT_DIR = PROJECT_ROOT / "second_preprocessed_csv" / "csv"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR

SMILES_COLUMN = "smile"
MOLECULE_NAME_COLUMN = "SAM/HTL材料名稱"
PCE_COLUMN = "PCE"
CONCENTRATION_COLUMN = "concentration(mg/ml)"
E_COLUMN = "E"
WASH_COLUMN = "wash"
PROCESS_START_COLUMN = "NiO2"

MISSINGNESS_LABELS = {
    "rdkit_descriptors": "RDKit 分子描述符",
    "concentration": "concentration",
    "E": "E",
    "wash": "wash",
}


@dataclass(frozen=True)
class Record:
    values: dict[str, str]
    molecule_name: str
    source_file: str
    source_order: int
    data_row: int
    file_line: int
    canonical_smiles: str | None
    molecule_key: str
    smiles_error: str | None

    def location(self) -> dict[str, object]:
        return {
            "source_csv": self.source_file,
            "data_row": self.data_row,
            "file_line": self.file_line,
            "smile": self.values[SMILES_COLUMN],
            "molecule_name": self.molecule_name,
        }


def clean_cell(value: object) -> str:
    if value is None or pd.isna(value):
        return ""
    return str(value).strip()


def normalized_cell(value: str) -> str:
    """Normalize numeric spellings without changing nonnumeric field content."""
    text = value.strip()
    if not text:
        return ""
    try:
        number = Decimal(text)
    except (InvalidOperation, ValueError):
        return text
    if not number.is_finite():
        return text
    if number == 0:
        return "0"
    normalized = number.normalize()
    rendered = format(normalized, "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def canonicalize_smiles(raw_smiles: str) -> tuple[str | None, str | None]:
    text = raw_smiles.strip()
    if not text:
        return None, "missing SMILES"
    molecule = Chem.MolFromSmiles(text)
    if molecule is None:
        return None, "RDKit could not parse SMILES"
    try:
        canonical = Chem.MolToSmiles(
            molecule,
            canonical=True,
            isomericSmiles=True,
        )
    except Exception as exc:  # pragma: no cover - defensive RDKit boundary
        return None, f"canonicalization failed: {exc}"
    return canonical, None


def source_metadata_for(second_csv: Path) -> tuple[Path, pd.DataFrame]:
    base_name = second_csv.stem.removesuffix("_2nd_preprocessed")
    first_csv = PROJECT_ROOT / "first_preprocessed_csv" / "csv" / f"{base_name}.csv"
    if not first_csv.is_file():
        raise FileNotFoundError(
            f"Cannot locate Stage-1 source for {second_csv.name}: expected {first_csv}"
        )
    frame = pd.read_csv(
        first_csv,
        encoding="utf-8-sig",
        dtype=str,
        keep_default_na=False,
        na_filter=False,
    )
    return first_csv, frame


def read_inputs(input_dir: Path) -> tuple[list[str], list[Record], list[dict[str, object]]]:
    files = sorted(input_dir.glob("*.csv"), key=lambda path: path.name.casefold())
    if not files:
        raise FileNotFoundError(f"No CSV files found in {input_dir}")

    expected_header: list[str] | None = None
    records: list[Record] = []
    input_summaries: list[dict[str, object]] = []

    for source_order, path in enumerate(files):
        frame = pd.read_csv(
            path,
            encoding="utf-8-sig",
            dtype=str,
            keep_default_na=False,
            na_filter=False,
        )
        header = frame.columns.tolist()
        if frame.columns.duplicated().any():
            duplicates = frame.columns[frame.columns.duplicated()].tolist()
            raise ValueError(f"Duplicate columns in {path.name}: {duplicates}")
        if len(header) != EXPECTED_COLUMN_COUNT:
            raise ValueError(
                f"{path.name}: expected {EXPECTED_COLUMN_COUNT} columns, got {len(header)}"
            )
        if expected_header is None:
            expected_header = header
        elif header != expected_header:
            raise ValueError(f"Column names/order differ in {path.name}")

        metadata_path, metadata = source_metadata_for(path)
        required_metadata = {MOLECULE_NAME_COLUMN, SMILES_COLUMN}
        missing_metadata = sorted(required_metadata.difference(metadata.columns))
        if missing_metadata:
            raise ValueError(
                f"{metadata_path.name} is missing metadata columns: {missing_metadata}"
            )
        if len(metadata) != len(frame):
            raise ValueError(
                f"Row count differs between {path.name} ({len(frame)}) and "
                f"{metadata_path.name} ({len(metadata)})"
            )
        second_smiles = [clean_cell(value) for value in frame[SMILES_COLUMN]]
        metadata_smiles = [clean_cell(value) for value in metadata[SMILES_COLUMN]]
        if second_smiles != metadata_smiles:
            mismatch = next(
                index
                for index, (left, right) in enumerate(
                    zip(second_smiles, metadata_smiles, strict=True),
                    start=1,
                )
                if left != right
            )
            raise ValueError(
                f"SMILES row alignment failed: {path.name} data row {mismatch} "
                f"does not match {metadata_path.name}"
            )
        molecule_names = [
            clean_cell(value) for value in metadata[MOLECULE_NAME_COLUMN]
        ]

        for data_row, (row, molecule_name) in enumerate(
            zip(frame.to_dict(orient="records"), molecule_names, strict=True),
            start=1,
        ):
            values = {column: clean_cell(row[column]) for column in header}
            canonical, error = canonicalize_smiles(values[SMILES_COLUMN])
            molecule_key = (
                f"VALID::{canonical}"
                if canonical is not None
                else f"UNRESOLVED::{path.name}::{data_row}"
            )
            records.append(
                Record(
                    values=values,
                    molecule_name=molecule_name,
                    source_file=path.name,
                    source_order=source_order,
                    data_row=data_row,
                    file_line=data_row + 1,
                    canonical_smiles=canonical,
                    molecule_key=molecule_key,
                    smiles_error=error,
                )
            )
        input_summaries.append(
            {
                "source_csv": path.name,
                "rows": len(frame),
                "molecule_name_source": str(metadata_path.relative_to(PROJECT_ROOT)),
                "rows_without_molecule_name": sum(not name for name in molecule_names),
            }
        )

    assert expected_header is not None
    required = {SMILES_COLUMN, PCE_COLUMN, CONCENTRATION_COLUMN, E_COLUMN, WASH_COLUMN}
    missing = sorted(required.difference(expected_header))
    if missing:
        raise ValueError(f"Required merged columns are missing: {missing}")
    return expected_header, records, input_summaries


def descriptor_columns(header: Sequence[str]) -> list[str]:
    try:
        start = header.index(SMILES_COLUMN) + 1
        end = header.index(PROCESS_START_COLUMN)
    except ValueError as exc:
        raise ValueError("Cannot locate descriptor block between smile and NiO2") from exc
    columns = list(header[start:end])
    if len(columns) != EXPECTED_DESCRIPTOR_COUNT:
        raise ValueError(
            f"Expected {EXPECTED_DESCRIPTOR_COUNT} descriptor columns, got {len(columns)}"
        )
    return columns


def row_key(record: Record, columns: Iterable[str]) -> tuple[str, ...]:
    return (
        record.molecule_key,
        *(normalized_cell(record.values[column]) for column in columns),
    )


def deduplicate(
    records: Sequence[Record],
    header: Sequence[str],
) -> tuple[list[Record], list[Record], list[dict[str, object]]]:
    comparison_columns = [column for column in header if column != SMILES_COLUMN]
    groups: dict[tuple[str, ...], list[Record]] = defaultdict(list)
    for record in records:
        groups[row_key(record, comparison_columns)].append(record)

    kept: list[Record] = []
    removed: list[Record] = []
    duplicate_groups: list[dict[str, object]] = []

    for members in groups.values():
        keeper = members[0]
        kept.append(keeper)
        if len(members) == 1:
            continue
        duplicates = members[1:]
        removed.extend(duplicates)
        duplicate_groups.append(
            {
                "canonical_smiles": keeper.canonical_smiles,
                "raw_smiles_variants": sorted(
                    {member.values[SMILES_COLUMN] for member in members}
                ),
                "identical_rows_in_group": len(members),
                "removed_rows": len(duplicates),
                "kept": keeper.location(),
                "removed_by_source": dict(
                    sorted(Counter(item.source_file for item in duplicates).items())
                ),
                "removed": [item.location() for item in duplicates],
            }
        )

    duplicate_groups.sort(
        key=lambda item: (
            str(item["canonical_smiles"]),
            str(item["kept"]),
        )
    )
    return kept, removed, duplicate_groups


def sorted_by_molecule(records: Sequence[Record]) -> list[Record]:
    return sorted(
        records,
        key=lambda record: (
            record.canonical_smiles is None,
            record.canonical_smiles or "",
            record.values[SMILES_COLUMN],
            record.source_file.casefold(),
            record.data_row,
        ),
    )


def molecule_summary(
    all_records: Sequence[Record],
    dataset_records: Sequence[Record],
) -> list[dict[str, object]]:
    all_groups: dict[str, list[Record]] = defaultdict(list)
    dataset_groups: dict[str, list[Record]] = defaultdict(list)
    for record in all_records:
        all_groups[record.molecule_key].append(record)
    for record in dataset_records:
        dataset_groups[record.molecule_key].append(record)

    summaries: list[dict[str, object]] = []
    for molecule_key, source_records in all_groups.items():
        retained = dataset_groups.get(molecule_key, [])
        dataset_name_counts = Counter(record.molecule_name for record in retained)
        source_name_counts = Counter(record.molecule_name for record in source_records)
        observed_names = []
        for name in sorted(source_name_counts, key=lambda value: (not value, value.casefold())):
            observed_names.append(
                {
                    "name": name or None,
                    "dataset_row_count": dataset_name_counts.get(name, 0),
                    "source_row_count_before_dedup": source_name_counts[name],
                }
            )
        canonical = source_records[0].canonical_smiles
        summaries.append(
            {
                "identity_status": "canonical" if canonical is not None else "unresolved",
                "canonical_smiles": canonical,
                "raw_smiles_variants": sorted(
                    {record.values[SMILES_COLUMN] for record in source_records}
                ),
                "observed_names": observed_names,
                "dataset_row_count": len(retained),
                "source_row_count_before_dedup": len(source_records),
                "source_csvs": sorted({record.source_file for record in source_records}),
            }
        )
    summaries.sort(
        key=lambda item: (
            item["canonical_smiles"] is None,
            str(item["canonical_smiles"] or item["raw_smiles_variants"]),
        )
    )
    return summaries


def find_pce_conflicts(
    records: Sequence[Record],
    header: Sequence[str],
) -> list[dict[str, object]]:
    feature_columns = [
        column for column in header if column not in {SMILES_COLUMN, PCE_COLUMN}
    ]
    groups: dict[tuple[str, ...], list[Record]] = defaultdict(list)
    for record in records:
        groups[row_key(record, feature_columns)].append(record)

    conflicts: list[dict[str, object]] = []
    for members in groups.values():
        distinct_pce = {normalized_cell(item.values[PCE_COLUMN]) for item in members}
        if len(distinct_pce) <= 1:
            continue
        first = members[0]
        conflicts.append(
            {
                "canonical_smiles": first.canonical_smiles,
                "raw_smiles_variants": sorted(
                    {member.values[SMILES_COLUMN] for member in members}
                ),
                "distinct_pce": sorted(distinct_pce),
                "rows": [
                    {**member.location(), "PCE": member.values[PCE_COLUMN]}
                    for member in members
                ],
            }
        )
    conflicts.sort(key=lambda item: str(item["canonical_smiles"]))
    return conflicts


def missingness_summary(
    records: Sequence[Record],
    descriptors: Sequence[str],
) -> dict[str, object]:
    exact_patterns: Counter[tuple[str, ...]] = Counter()
    overall = Counter({key: 0 for key in MISSINGNESS_LABELS})

    for record in records:
        flags: list[str] = []
        if any(not record.values[column] for column in descriptors):
            flags.append("rdkit_descriptors")
        if not record.values[CONCENTRATION_COLUMN]:
            flags.append("concentration")
        if not record.values[E_COLUMN]:
            flags.append("E")
        if not record.values[WASH_COLUMN]:
            flags.append("wash")
        for flag in flags:
            overall[flag] += 1
        exact_patterns[tuple(flags)] += 1

    intersections: list[dict[str, object]] = []
    flag_names = list(MISSINGNESS_LABELS)
    for size in range(2, len(flag_names) + 1):
        for subset in combinations(flag_names, size):
            count = sum(
                value
                for pattern, value in exact_patterns.items()
                if set(subset).issubset(pattern)
            )
            if count:
                intersections.append({"fields": list(subset), "rows": count})

    patterns = [
        {"fields": list(pattern), "rows": count}
        for pattern, count in sorted(
            exact_patterns.items(),
            key=lambda item: (-item[1], item[0]),
        )
    ]
    return {
        "total_rows": len(records),
        "overall": dict(overall),
        "exact_patterns": patterns,
        "inclusive_intersections": intersections,
    }


def pattern_label(fields: Sequence[str]) -> str:
    if not fields:
        return "無上述缺值"
    return " + ".join(MISSINGNESS_LABELS[field] for field in fields)


def build_missingness_svg(summary: dict[str, object]) -> str:
    patterns = summary["exact_patterns"]
    overall = summary["overall"]
    assert isinstance(patterns, list)
    assert isinstance(overall, dict)
    exact_rows = [item for item in patterns if isinstance(item, dict)]
    overall_rows = [
        {"field": field, "rows": int(overall[field])}
        for field in MISSINGNESS_LABELS
    ]
    width = 1200
    row_height = 40
    overall_start = 164
    exact_start = overall_start + len(overall_rows) * row_height + 116
    bottom = 48
    height = exact_start + max(1, len(exact_rows)) * row_height + bottom
    overall_max = max((int(item["rows"]) for item in overall_rows), default=1)
    exact_max = max((int(item["rows"]) for item in exact_rows), default=1)
    bar_start = 470
    bar_max = 630

    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect x="0" y="0" width="1200" height="100%" fill="#FFFFFF"/>',
        '<style>text{font-family:"Noto Sans TC","Microsoft JhengHei",Arial,sans-serif;fill:#111827}.title{font-size:28px;font-weight:700}.section{font-size:20px;font-weight:700}.sub{font-size:15px;fill:#374151}.label{font-size:15px}.count{font-size:15px;font-weight:700}.overall-bar{fill:#111827}.exact-bar{fill:#374151}.complete-bar{fill:#4B5563}.divider{stroke:#9CA3AF;stroke-width:1}</style>',
        '<text x="36" y="42" class="title">第三次前處理：缺值統計</text>',
        '<text x="36" y="72" class="sub">白色背景、深色文字與長條；統計對象為合併去重後的 dataset.csv。</text>',
        '<text x="36" y="116" class="section">A. 各欄位缺值總數（可重疊）</text>',
        '<text x="36" y="143" class="sub">例如 E = 132，包含「只缺 E」以及「E 與其他欄位同時缺值」的全部資料。</text>',
    ]
    for index, item in enumerate(overall_rows):
        field = str(item["field"])
        count = int(item["rows"])
        label = html.escape(MISSINGNESS_LABELS[field])
        y = overall_start + index * row_height
        bar_width = 0 if overall_max == 0 else max(2, round(bar_max * count / overall_max))
        svg.append(f'<text x="36" y="{y + 19}" class="label">{label}</text>')
        svg.append(
            f'<rect x="{bar_start}" y="{y}" width="{bar_width}" height="25" rx="4" class="overall-bar"/>'
        )
        svg.append(
            f'<text x="{bar_start + bar_width + 10}" y="{y + 19}" class="count">{count}</text>'
        )

    divider_y = overall_start + len(overall_rows) * row_height + 18
    svg.extend(
        [
            f'<line x1="36" y1="{divider_y}" x2="1164" y2="{divider_y}" class="divider"/>',
            f'<text x="36" y="{divider_y + 43}" class="section">B. 互斥缺值組合（每筆只計一次）</text>',
            f'<text x="36" y="{divider_y + 70}" class="sub">「僅缺」是指只缺列出的類別；其他三項追蹤類別不缺。例如「僅缺：E」目前為 118 筆。</text>',
        ]
    )
    for index, item in enumerate(exact_rows):
        fields = item["fields"]
        count = int(item["rows"])
        assert isinstance(fields, list)
        label = (
            "四項皆不缺值"
            if not fields
            else "僅缺：" + pattern_label([str(field) for field in fields])
        )
        y = exact_start + index * row_height
        bar_width = 0 if exact_max == 0 else max(2, round(bar_max * count / exact_max))
        css_class = "complete-bar" if not fields else "exact-bar"
        svg.append(f'<text x="36" y="{y + 19}" class="label">{html.escape(label)}</text>')
        svg.append(
            f'<rect x="{bar_start}" y="{y}" width="{bar_width}" height="25" rx="4" class="{css_class}"/>'
        )
        svg.append(
            f'<text x="{bar_start + bar_width + 10}" y="{y + 19}" class="count">{count}</text>'
        )
    svg.append("</svg>")
    return "\n".join(svg) + "\n"


def markdown_table(headers: Sequence[str], rows: Sequence[Sequence[object]]) -> list[str]:
    lines = [
        "| " + " | ".join(headers) + " |",
        "|" + "|".join("---" for _ in headers) + "|",
    ]
    for row in rows:
        escaped = [str(value).replace("|", "\\|").replace("\n", " ") for value in row]
        lines.append("| " + " | ".join(escaped) + " |")
    return lines


def build_report(audit: dict[str, object]) -> str:
    summary = audit["summary"]
    assert isinstance(summary, dict)
    lines = [
        "# 第三次前處理合併報告",
        "",
        f"產生時間：{audit['generated_at']}",
        "",
        "本次讀取 `second_preprocessed_csv/csv/` 內所有 CSV，以 RDKit canonical isomeric SMILES 辨識同一分子的不同 SMILES 寫法；只在分子身分與其餘 223 欄（包含 PCE）全部相同時去重。無法由 RDKit 解析的 SMILES 不會彼此合併或去重。",
        "",
        "## 合併摘要",
        "",
        *markdown_table(
            ["項目", "數量"],
            [
                ["來源 CSV", summary["input_files"]],
                ["合併前資料", summary["input_rows"]],
                ["移除完全重複資料", summary["removed_duplicate_rows"]],
                ["合併後 dataset.csv", summary["output_rows"]],
                ["相異分子（RDKit canonical SMILES）", summary["distinct_molecules"]],
                ["相異原始 SMILES 字串寫法", summary["distinct_raw_smiles"]],
                ["同特徵但 PCE 不同群組", summary["pce_conflict_groups"]],
                ["RDKit 無法解析 SMILES", summary["unresolved_smiles_rows"]],
            ],
        ),
        "",
        "### 各來源列數",
        "",
        *markdown_table(
            ["來源 CSV", "列數"],
            [[item["source_csv"], item["rows"]] for item in audit["inputs"]],
        ),
        "",
        "### 全部被移除重複資料的來源統計",
        "",
        *markdown_table(
            ["來源 CSV", "被移除筆數"],
            [
                [source, count]
                for source, count in audit["removed_duplicates_by_source"].items()
            ],
        ),
        "",
        "## 5.1 完全重複資料",
        "",
    ]

    duplicate_groups = audit["duplicate_groups"]
    assert isinstance(duplicate_groups, list)
    if not duplicate_groups:
        lines.extend(["未移除任何完全重複資料。", ""])
    for index, group in enumerate(duplicate_groups, start=1):
        assert isinstance(group, dict)
        kept = group["kept"]
        assert isinstance(kept, dict)
        lines.extend(
            [
                f"### 重複群組 {index}",
                "",
                f"- Canonical SMILES：`{group['canonical_smiles']}`",
                f"- 原始 SMILES 寫法：{', '.join(f'`{item}`' for item in group['raw_smiles_variants'])}",
                f"- 完全相同資料共 {group['identical_rows_in_group']} 筆；移除 {group['removed_rows']} 筆，只保留 1 筆。",
                f"- 保留：`{kept['source_csv']}` 資料第 {kept['data_row']} 筆（檔案第 {kept['file_line']} 行）。",
                "- 移除來源統計："
                + "、".join(
                    f"`{source}` {count} 筆"
                    for source, count in group["removed_by_source"].items()
                ),
                "",
                *markdown_table(
                    ["被移除來源", "資料第幾筆", "檔案行號", "SMILES"],
                    [
                        [item["source_csv"], item["data_row"], item["file_line"], item["smile"]]
                        for item in group["removed"]
                    ],
                ),
                "",
            ]
        )

    conflicts = audit["pce_conflicts"]
    assert isinstance(conflicts, list)
    lines.extend(["## 5.2 所有特徵相同但 PCE 不同", ""])
    if not conflicts:
        lines.extend(["沒有發現此類 ML 衝突資料點。", ""])
    for index, conflict in enumerate(conflicts, start=1):
        assert isinstance(conflict, dict)
        lines.extend(
            [
                f"### PCE 衝突群組 {index}",
                "",
                f"Canonical SMILES：`{conflict['canonical_smiles']}`",
                f"不同 PCE：{', '.join(f'`{value}`' for value in conflict['distinct_pce'])}",
                "",
                *markdown_table(
                    ["來源 CSV", "資料第幾筆", "檔案行號", "SMILES", "PCE"],
                    [
                        [item["source_csv"], item["data_row"], item["file_line"], item["smile"], item["PCE"]]
                        for item in conflict["rows"]
                    ],
                ),
                "",
            ]
        )

    missingness = audit["missingness"]
    assert isinstance(missingness, dict)
    overall = missingness["overall"]
    assert isinstance(overall, dict)
    lines.extend(
        [
            "## 5.3 合併後缺值統計",
            "",
            "![缺值組合圖](missingness_summary.svg)",
            "",
            "圖的 A 區為各欄位缺值總數，允許同一筆資料同時計入多個欄位；因此 `E=132` 是所有 E 缺值資料。圖的 B 區為互斥組合，每筆只計一次；其中「僅缺 E」為 118 筆，代表 concentration、wash 與 RDKit descriptors 均不缺。",
            "",
            *markdown_table(
                ["項目", "有缺值的資料筆數"],
                [
                    ["任一 RDKit 分子描述符", overall["rdkit_descriptors"]],
                    ["concentration", overall["concentration"]],
                    ["E", overall["E"]],
                    ["wash", overall["wash"]],
                ],
            ),
            "",
            "### 完全相同的缺值組合（互斥）",
            "",
            *markdown_table(
                ["缺值組合", "資料筆數"],
                [
                    [pattern_label(item["fields"]), item["rows"]]
                    for item in missingness["exact_patterns"]
                ],
            ),
            "",
            "### 同時缺值交集（可重疊）",
            "",
        ]
    )
    intersections = missingness["inclusive_intersections"]
    assert isinstance(intersections, list)
    if intersections:
        lines.extend(
            markdown_table(
                ["同時缺值欄位", "資料筆數"],
                [
                    [pattern_label(item["fields"]), item["rows"]]
                    for item in intersections
                ],
            )
        )
    else:
        lines.append("沒有兩種以上欄位同時缺值的資料。")

    unresolved = audit["unresolved_smiles"]
    assert isinstance(unresolved, list)
    lines.extend(["", "## SMILES 解析警告", ""])
    if unresolved:
        lines.extend(
            markdown_table(
                ["來源 CSV", "資料第幾筆", "檔案行號", "SMILES", "原因"],
                [
                    [item["source_csv"], item["data_row"], item["file_line"], item["smile"], item["reason"]]
                    for item in unresolved
                ],
            )
        )
    else:
        lines.append("全部 SMILES 均可由 RDKit 解析。")

    lines.extend(
        [
            "",
            "## 產物",
            "",
            "- `dataset.csv`：合併、去重並按 canonical SMILES 排序的 224 欄資料集。",
            "- `preprocessing_audit.json`：完整機器可讀稽核紀錄。",
            "- `molecule_summary.jsonl`：每行一個相異分子，列出 canonical／原始 SMILES、來源分子名稱，以及去重後與去重前數量。名稱完全沿用來源欄位，不自行拆分或猜測。",
            "- `preprocessing_report.md`：本報告。",
            "- `missingness_summary.svg`：白色背景、深色文字與圖形的缺值統計圖；分開呈現可重疊總數與互斥組合。",
            "",
        ]
    )
    return "\n".join(lines)


def atomic_text(path: Path, content: str, encoding: str = "utf-8") -> None:
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding=encoding,
            newline="\n",
            dir=path.parent,
            prefix=f".{path.stem}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(content)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def atomic_csv(path: Path, frame: pd.DataFrame) -> None:
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8-sig",
            newline="",
            dir=path.parent,
            prefix=f".{path.stem}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            frame.to_csv(handle, index=False, lineterminator="\n", na_rep="")
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge, molecule-sort, deduplicate, and audit all second-preprocessed CSV files."
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=DEFAULT_INPUT_DIR,
        help="Directory whose every *.csv file will be merged.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for dataset.csv and audit outputs.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if rdkit.__version__ != EXPECTED_RDKIT_VERSION:
        raise RuntimeError(
            f"Expected RDKit {EXPECTED_RDKIT_VERSION}, imported {rdkit.__version__}"
        )

    input_dir = args.input_dir.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    header, records, inputs = read_inputs(input_dir)
    descriptors = descriptor_columns(header)
    kept, removed, duplicate_groups = deduplicate(records, header)
    ordered = sorted_by_molecule(kept)
    conflicts = find_pce_conflicts(ordered, header)
    missingness = missingness_summary(ordered, descriptors)
    molecules = molecule_summary(records, ordered)
    distinct_molecules = sum(
        item["canonical_smiles"] is not None for item in molecules
    )
    unresolved = [
        {**record.location(), "reason": record.smiles_error}
        for record in ordered
        if record.smiles_error
    ]

    output_frame = pd.DataFrame(
        [record.values for record in ordered],
        columns=header,
    )
    dataset_path = output_dir / "dataset.csv"
    atomic_csv(dataset_path, output_frame)

    verified = pd.read_csv(
        dataset_path,
        encoding="utf-8-sig",
        dtype=str,
        keep_default_na=False,
        na_filter=False,
    )
    if verified.columns.tolist() != header or len(verified) != len(ordered):
        raise RuntimeError("dataset.csv verification failed")

    audit: dict[str, object] = {
        "script": "third_preprocessed_csv/third_preprocess.py",
        "script_version": VERSION,
        "generated_at": datetime.now(ZoneInfo("Asia/Taipei")).isoformat(timespec="seconds"),
        "rdkit_version": rdkit.__version__,
        "molecule_identity": "RDKit canonical isomeric SMILES",
        "deduplication_rule": (
            "canonical molecular identity plus all remaining output columns, including PCE; "
            "numeric spellings are normalized; unresolved SMILES are never deduplicated"
        ),
        "inputs": inputs,
        "summary": {
            "input_files": len(inputs),
            "input_rows": len(records),
            "removed_duplicate_rows": len(removed),
            "duplicate_groups": len(duplicate_groups),
            "output_rows": len(ordered),
            "output_columns": len(header),
            "distinct_molecules": distinct_molecules,
            "distinct_raw_smiles": len(
                {record.values[SMILES_COLUMN] for record in ordered}
            ),
            "molecule_summary_records": len(molecules),
            "source_rows_without_molecule_name": sum(
                not record.molecule_name for record in records
            ),
            "dataset_rows_without_molecule_name": sum(
                not record.molecule_name for record in ordered
            ),
            "pce_conflict_groups": len(conflicts),
            "unresolved_smiles_rows": len(unresolved),
        },
        "removed_duplicates_by_source": dict(
            sorted(Counter(record.source_file for record in removed).items())
        ),
        "duplicate_groups": duplicate_groups,
        "pce_conflicts": conflicts,
        "missingness": missingness,
        "unresolved_smiles": unresolved,
        "molecule_summary_file": "third_preprocessed_csv/molecule_summary.jsonl",
    }

    audit_path = output_dir / "preprocessing_audit.json"
    report_path = output_dir / "preprocessing_report.md"
    svg_path = output_dir / "missingness_summary.svg"
    molecule_summary_path = output_dir / "molecule_summary.jsonl"
    atomic_text(audit_path, json.dumps(audit, ensure_ascii=False, indent=2) + "\n")
    atomic_text(report_path, build_report(audit))
    atomic_text(svg_path, build_missingness_svg(missingness))
    atomic_text(
        molecule_summary_path,
        "".join(
            json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"
            for item in molecules
        ),
    )

    print(
        f"Done: files={len(inputs)}, input_rows={len(records)}, "
        f"removed_duplicates={len(removed)}, output_rows={len(ordered)}, "
        f"distinct_molecules={distinct_molecules}, "
        f"PCE_conflict_groups={len(conflicts)}, unresolved_SMILES={len(unresolved)}"
    )
    print(f"dataset={dataset_path}")
    print(f"report={report_path}")
    print(f"audit={audit_path}")
    print(f"missingness_chart={svg_path}")
    print(f"molecule_summary={molecule_summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
