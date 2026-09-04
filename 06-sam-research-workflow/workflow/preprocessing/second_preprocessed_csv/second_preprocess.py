"""Second preprocessing for reviewed SAM datasets.

The script keeps every first-preprocessed row, calculates the 196 RDKit
descriptors defined by the local ``reference.csv`` with RDKit 2026.03.5, and writes
one CSV file per input containing only:

    smile + 196 RDKit descriptors + 26 process features + PCE

Identification, molecule-name, DOI, reference, note, and data-status columns
are intentionally omitted from the second-preprocessed outputs.
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
LATEST_RDKIT_VERSION = "2026.03.5"
LATEST_RDKIT_RELEASE_DATE = "2026-08-01"

import numpy as np  # type: ignore[import-not-found]  # noqa: E402
import pandas as pd  # type: ignore[import-not-found]  # noqa: E402
import rdkit  # type: ignore[import-not-found]  # noqa: E402
from rdkit import Chem  # type: ignore[import-not-found]  # noqa: E402
from rdkit.Chem import Descriptors  # type: ignore[import-not-found]  # noqa: E402


if rdkit.__version__ != LATEST_RDKIT_VERSION:
    raise RuntimeError(
        f"Expected RDKit {LATEST_RDKIT_VERSION}, imported {rdkit.__version__}"
    )


DEFAULT_REFERENCE_CSV = PROJECT_ROOT / "reference.csv"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / "csv"
DEFAULT_OUTPUT_SUFFIX = "_2nd_preprocessed"
DEFAULT_ROUND_DIGITS = 3

PROCESS_COLUMNS = [
    "NiO2",
    "ethanol",
    "toluene",
    "IPA",
    "THF",
    "chlorobenzene",
    "2-Methoxyethanol",
    "CH2CL2",
    "concentration(mg/ml)",
    "wash",
    "E",
    "Cs",
    "FA",
    "MA",
    "Pb",
    "Sn",
    "I",
    "Br",
    "CL",
    "C60",
    "BCP",
    "PC60BM",
    "PCBM",
    "PC61BM",
    "PEAI",
    "ALD-SnO2",
]


def read_table(path: Path) -> pd.DataFrame:
    """Read one CSV/XLSX while preserving source rows and blank cells."""
    if not path.is_file():
        raise FileNotFoundError(f"Input not found: {path}")

    suffix = path.suffix.lower()
    if suffix == ".csv":
        frame = pd.read_csv(path, encoding="utf-8-sig", keep_default_na=False)
    elif suffix in {".xlsx", ".xlsm"}:
        frame = pd.read_excel(
            path,
            sheet_name=0,
            engine="openpyxl",
            keep_default_na=False,
        )
    else:
        raise ValueError(f"Unsupported input type: {path.suffix}")

    if frame.columns.duplicated().any():
        duplicates = frame.columns[frame.columns.duplicated()].tolist()
        raise ValueError(f"Duplicate column(s) in {path.name}: {duplicates}")
    return frame


def load_descriptor_contract(reference_csv: Path) -> list[str]:
    """Read the exact 196-descriptor names and order from reference.csv."""
    reference = read_table(reference_csv)
    available = {name for name, _ in Descriptors._descList}
    descriptor_columns = [
        column for column in reference.columns if column in available
    ]
    if len(descriptor_columns) != 196:
        raise ValueError(
            f"Expected 196 RDKit descriptor columns in {reference_csv}, "
            f"got {len(descriptor_columns)}"
        )
    return descriptor_columns


def rounded_descriptor_value(value: object, digits: int | None) -> float | None:
    """Return a finite numeric descriptor, otherwise a CSV blank."""
    if not isinstance(value, (int, float, np.number)):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return number if digits is None else round(number, digits)


def source_values_equal(left: object, right: object) -> bool:
    """Compare an Excel/CSV source value after a CSV round trip."""
    left_blank = pd.isna(left) or (isinstance(left, str) and not left.strip())
    right_blank = pd.isna(right) or (isinstance(right, str) and not right.strip())
    if left_blank or right_blank:
        return bool(left_blank and right_blank)

    try:
        left_number = float(left)
        right_number = float(right)
    except (TypeError, ValueError):
        return str(left) == str(right)
    return left_number == right_number


def calculate_descriptors(
    smile: object,
    descriptor_columns: Sequence[str],
    round_digits: int | None,
) -> tuple[dict[str, float | None], str | None]:
    """Calculate one molecule without dropping the row when parsing fails."""
    blank = {column: None for column in descriptor_columns}
    if not isinstance(smile, str) or not smile.strip():
        return blank, "missing SMILES"

    molecule = Chem.MolFromSmiles(smile.strip())
    if molecule is None:
        return blank, "RDKit could not parse SMILES"

    try:
        calculated = Descriptors.CalcMolDescriptors(
            molecule,
            missingVal=float("nan"),
            silent=True,
        )
    except Exception as exc:
        return blank, f"descriptor calculation failed: {exc}"

    values = {
        column: rounded_descriptor_value(calculated.get(column), round_digits)
        for column in descriptor_columns
    }
    return values, None


def output_path_for(input_path: Path, output_dir: Path, suffix: str) -> Path:
    return output_dir / f"{input_path.stem}{suffix}.csv"


def preprocess_file(
    input_path: Path,
    output_dir: Path,
    output_suffix: str,
    descriptor_columns: Sequence[str],
    round_digits: int | None,
) -> dict[str, object]:
    """Create one 224-column output and return its audit summary."""
    source = read_table(input_path)
    required_source_columns = ["smile", *PROCESS_COLUMNS, "PCE"]
    missing_source_columns = [
        column for column in required_source_columns if column not in source.columns
    ]
    if missing_source_columns:
        raise ValueError(
            f"{input_path.name} is missing required column(s): "
            f"{missing_source_columns}"
        )

    output_columns = ["smile", *descriptor_columns, *PROCESS_COLUMNS, "PCE"]
    if len(output_columns) != 224:
        raise ValueError(
            f"Expected 224 output columns, constructed {len(output_columns)}"
        )

    records: list[dict[str, object]] = []
    failed_rows: list[tuple[int, str]] = []
    rows_with_descriptor_blanks = 0
    descriptor_blank_cells = 0

    for csv_row_number, (_, source_row) in enumerate(source.iterrows(), start=2):
        descriptors, error = calculate_descriptors(
            source_row["smile"], descriptor_columns, round_digits
        )
        blank_count = sum(value is None for value in descriptors.values())
        descriptor_blank_cells += blank_count
        if blank_count:
            rows_with_descriptor_blanks += 1
        if error:
            failed_rows.append((csv_row_number, error))

        record: dict[str, object] = {"smile": source_row["smile"]}
        record.update(descriptors)
        record.update({column: source_row[column] for column in PROCESS_COLUMNS})
        record["PCE"] = source_row["PCE"]
        records.append(record)

    output = pd.DataFrame(records, columns=output_columns)
    if len(output) != len(source):
        raise RuntimeError(
            f"Row preservation failed for {input_path.name}: "
            f"input={len(source)}, output={len(output)}"
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_path_for(input_path, output_dir, output_suffix)
    output.to_csv(
        output_path,
        index=False,
        encoding="utf-8-sig",
        lineterminator="\n",
        na_rep="",
    )

    # Re-open the actual deliverable and verify its contract.
    verified = pd.read_csv(
        output_path,
        encoding="utf-8-sig",
        keep_default_na=False,
    )
    if verified.columns.tolist() != output_columns:
        raise RuntimeError(f"Output column verification failed: {output_path}")
    if len(verified) != len(source):
        raise RuntimeError(f"Output row verification failed: {output_path}")
    retained_source_columns = ["smile", *PROCESS_COLUMNS, "PCE"]
    for column in retained_source_columns:
        for row_index, (source_value, verified_value) in enumerate(
            zip(source[column], verified[column], strict=True),
            start=2,
        ):
            if not source_values_equal(source_value, verified_value):
                raise RuntimeError(
                    "Retained source-value verification failed: "
                    f"{output_path}, row={row_index}, column={column}, "
                    f"source={source_value!r}, output={verified_value!r}"
                )

    for row_number, error in failed_rows:
        print(f"  WARNING {input_path.name} row {row_number}: {error}")

    summary = {
        "input": input_path,
        "output": output_path,
        "input_rows": len(source),
        "output_rows": len(verified),
        "output_columns": len(verified.columns),
        "descriptor_columns": len(descriptor_columns),
        "failed_smiles_rows": len(failed_rows),
        "rows_with_descriptor_blanks": rows_with_descriptor_blanks,
        "descriptor_blank_cells": descriptor_blank_cells,
    }
    print(
        f"{input_path.name} -> {output_path.name}: "
        f"rows={len(verified)}, columns={len(verified.columns)}, "
        f"RDKit_failed_rows={len(failed_rows)}, "
        f"rows_with_descriptor_blanks={rows_with_descriptor_blanks}, "
        f"descriptor_blank_cells={descriptor_blank_cells}, "
        f"retained_source_fields_verified={len(retained_source_columns)}"
    )
    return summary


def discover_interactive_inputs() -> list[Path]:
    first_csv_dir = PROJECT_ROOT / "first_preprocessed_csv" / "csv"
    return sorted(
        (
            path
            for path in first_csv_dir.glob("*.csv")
            if path.is_file() and not path.name.startswith("~$")
        ),
        key=lambda path: path.name.casefold(),
    )


def parse_number_selection(raw: str, item_count: int) -> list[int]:
    text = raw.strip()
    if not text:
        raise ValueError("請至少輸入一個編號。")
    selected: set[int] = set()
    for token in text.replace("，", ",").split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            parts = [part.strip() for part in token.split("-")]
            if len(parts) != 2 or not all(part.isdigit() for part in parts):
                raise ValueError(f"無法辨識的選擇：{token!r}")
            start, end = (int(part) for part in parts)
        elif token.isdigit():
            start = end = int(token)
        else:
            raise ValueError(f"無法辨識的選擇：{token!r}")
        if start > end:
            raise ValueError(f"編號範圍顛倒：{token}")
        if start < 1 or end > item_count:
            raise ValueError(f"編號必須介於 1 到 {item_count}：{token}")
        selected.update(range(start, end + 1))
    if not selected:
        raise ValueError("請至少輸入一個編號。")
    return sorted(selected)


def prompt_yes_no(message: str) -> bool:
    while True:
        answer = input(f"{message} [y/N]：").strip().casefold()
        if answer in {"y", "yes", "是"}:
            return True
        if answer in {"", "n", "no", "否"}:
            return False
        print("請輸入 y 或 n。")


def run_preprocessing(args: argparse.Namespace, inputs: Sequence[Path]) -> int:
    round_digits = None if args.round_digits < 0 else args.round_digits
    descriptor_columns = load_descriptor_contract(args.reference.resolve())

    print(
        f"RDKit={rdkit.__version__} "
        f"(release {LATEST_RDKIT_RELEASE_DATE}); "
        f"descriptors={len(descriptor_columns)}; "
        f"process_features={len(PROCESS_COLUMNS)}; PCE=1; "
        f"output_columns={1 + len(descriptor_columns) + len(PROCESS_COLUMNS) + 1}"
    )

    summaries = [
        preprocess_file(
            input_path=input_path.resolve(),
            output_dir=args.output_dir.resolve(),
            output_suffix=args.suffix,
            descriptor_columns=descriptor_columns,
            round_digits=round_digits,
        )
        for input_path in inputs
    ]

    print(
        f"Done: files={len(summaries)}, "
        f"input_rows={sum(int(item['input_rows']) for item in summaries)}, "
        f"output_rows={sum(int(item['output_rows']) for item in summaries)}, "
        f"failed_smiles_rows={sum(int(item['failed_smiles_rows']) for item in summaries)}, "
        "rows_with_descriptor_blanks="
        f"{sum(int(item['rows_with_descriptor_blanks']) for item in summaries)}, "
        "descriptor_blank_cells="
        f"{sum(int(item['descriptor_blank_cells']) for item in summaries)}, "
        f"output_dir={args.output_dir.resolve()}"
    )
    return 0


def interactive_main(args: argparse.Namespace) -> int:
    available = discover_interactive_inputs()
    if not available:
        print("錯誤：找不到可供第二次前處理的 CSV 或 XLSX。")
        return 2

    print("第二次前處理互動模式")
    print("輸入 q 可取消；來源 CSV／XLSX 不會被修改。\n")
    for index, path in enumerate(available, start=1):
        print(f"  {index}. {path.relative_to(PROJECT_ROOT)}")
    raw = input("請選擇檔案（可輸入 1、1,3 或 2-5）：").strip()
    if raw.casefold() in {"q", "quit", "exit"}:
        print("已取消，未寫入任何檔案。")
        return 0
    try:
        indexes = parse_number_selection(raw, len(available))
    except ValueError as exc:
        print(f"錯誤：{exc}")
        return 2
    selected = [available[index - 1] for index in indexes]
    output_dir = args.output_dir.resolve()
    outputs = [output_path_for(path, output_dir, args.suffix) for path in selected]
    if len(set(outputs)) != len(outputs):
        print("錯誤：所選來源會產生重複的輸出檔名，請分開執行。")
        return 2

    print("\n將處理：")
    for source, output in zip(selected, outputs, strict=True):
        state = "覆寫既有檔案" if output.exists() else "建立新檔案"
        print(f"  - {source.relative_to(PROJECT_ROOT)}")
        print(f"    → {output}（{state}）")
    if not prompt_yes_no("是否開始第二次前處理？"):
        print("已取消，未寫入任何檔案。")
        return 0
    return run_preprocessing(args, selected)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Calculate 196 descriptors with RDKit 2026.03.5 for reviewed SAM datasets."
        )
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        type=Path,
        help="CSV/XLSX inputs. If omitted, use --interactive to select available Stage-1 CSV files.",
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Select one or more available inputs from a numbered menu.",
    )
    parser.add_argument(
        "--reference",
        type=Path,
        default=DEFAULT_REFERENCE_CSV,
        help="reference.csv used only to define the 196 descriptor names/order.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for second-preprocessed CSV files; defaults to second_preprocessed_csv/csv.",
    )
    parser.add_argument(
        "--suffix",
        default=DEFAULT_OUTPUT_SUFFIX,
        help="Filename suffix added before .csv.",
    )
    parser.add_argument(
        "--round-digits",
        type=int,
        default=DEFAULT_ROUND_DIGITS,
        help="RDKit decimal places; use -1 for full precision.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.interactive:
        if args.inputs:
            print("錯誤：--interactive 不可與位置參數 inputs 併用。")
            return 2
        return interactive_main(args)
    inputs = tuple(args.inputs)
    if not inputs:
        print("錯誤：請使用 --interactive 選擇輸入，或直接指定 CSV/XLSX 路徑。")
        return 2
    return run_preprocessing(args, inputs)


if __name__ == "__main__":
    raise SystemExit(main())
