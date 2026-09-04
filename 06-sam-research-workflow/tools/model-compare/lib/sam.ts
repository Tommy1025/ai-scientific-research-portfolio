import * as XLSX from "xlsx";

interface WorkSheet {
  [address: string]: unknown;
}

interface WorkBook {
  SheetNames: string[];
  Sheets: Record<string, WorkSheet>;
}

interface XlsxApi {
  read(data: ArrayBuffer | string, options: Record<string, unknown>): WorkBook;
  utils: {
    sheet_to_json(sheet: WorkSheet, options: Record<string, unknown>): unknown[];
    encode_cell(cell: { r: number; c: number }): string;
    encode_col(column: number): string;
  };
}

function xlsxApi(): XlsxApi {
  return XLSX as unknown as XlsxApi;
}

export const SAM_COLUMNS = [
  "編號",
  "SAM/HTL材料名稱",
  "smile",
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
  "PCE",
  "Reference_DOI",
  "Ref_author",
  "Ref_journal",
  "Data_status",
  "Notes",
] as const;

export type SamColumn = (typeof SAM_COLUMNS)[number];
export type CellValue = string | number | boolean;
export type Severity = "error" | "warning" | "pass" | "na";

export const FEATURE_COLUMNS = SAM_COLUMNS.slice(3, 29);
export const SOLVENT_COLUMNS = [
  "ethanol",
  "toluene",
  "IPA",
  "THF",
  "chlorobenzene",
  "2-Methoxyethanol",
  "CH2CL2",
] as const;
export const BINARY_COLUMNS = [
  "NiO2",
  "wash",
  "C60",
  "BCP",
  "PC60BM",
  "PCBM",
  "PC61BM",
  "PEAI",
  "ALD-SnO2",
] as const;

export const REQUIRED_SHEETS = [
  "主表",
  "說明_Legend",
  "E補值紀錄",
  "Notes備份",
  "已剔除_同特徵異PCE",
  "已刪除_不收錄",
  "進度追蹤",
] as const;

const MISSING_FIELD_ALIASES: Record<string, readonly string[]> = {
  solvent: SOLVENT_COLUMNS,
  溶劑: SOLVENT_COLUMNS,
  濃度: ["concentration(mg/ml)"],
  concentration: ["concentration(mg/ml)"],
  組成: ["Cs", "FA", "MA", "Pb", "Sn", "I", "Br", "CL"],
  etl: ["C60", "BCP", "PC60BM", "PCBM", "PC61BM", "PEAI", "ALD-SnO2"],
};

function normalizeMissingField(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "");
}

function declaredMissingFields(status: string): Set<string> {
  const declared = new Set<string>();
  const match = status.match(/缺\s*[:：]\s*([^；;]+)/i);
  if (!match) return declared;

  for (const rawToken of match[1].split(/[、,，/／]+/)) {
    const token = rawToken.trim();
    if (!token) continue;
    const aliases = MISSING_FIELD_ALIASES[token] ?? MISSING_FIELD_ALIASES[token.toLowerCase()];
    for (const field of aliases ?? [token]) declared.add(normalizeMissingField(field));
  }
  return declared;
}

const HEADER_COLORS: Partial<Record<SamColumn, string>> = {
  NiO2: "D0CECE",
  C60: "D0CECE",
  BCP: "D0CECE",
  PC60BM: "D0CECE",
  PCBM: "D0CECE",
  PC61BM: "D0CECE",
  PEAI: "D0CECE",
  "ALD-SnO2": "D0CECE",
  ethanol: "FBE5D6",
  toluene: "FBE5D6",
  IPA: "FBE5D6",
  THF: "FBE5D6",
  chlorobenzene: "FBE5D6",
  "2-Methoxyethanol": "FBE5D6",
  CH2CL2: "FBE5D6",
  "concentration(mg/ml)": "E2F0D9",
  E: "E2F0D9",
  I: "E2F0D9",
  Br: "E2F0D9",
  CL: "E2F0D9",
  wash: "DAE3F3",
  Cs: "D6DCE5",
  FA: "D6DCE5",
  MA: "D6DCE5",
  Pb: "FFF2CC",
  Sn: "FFF2CC",
  PCE: "FFCCFF",
};

export interface AuditIssue {
  id: string;
  severity: Severity;
  category: "結構" | "標頭顏色" | "可信度顏色" | "欄位規則" | "追蹤性";
  message: string;
  location?: string;
  count?: number;
  details?: string[];
}

export interface AuditSummary {
  errors: number;
  warnings: number;
  passes: number;
  notApplicable: number;
  redCells: number;
  blackCells: number;
  issues: AuditIssue[];
}

export interface SamRecord {
  id: string;
  datasetId: string;
  rowNumber: number;
  ref: number | null;
  refLabel: string;
  material: string;
  smiles: string;
  doi: string;
  pce: CellValue | "";
  status: string;
  notes: string;
  values: Record<string, CellValue | "">;
  colors: Record<string, string>;
  validationErrors: string[];
}

export interface ProgressEntry {
  ref: number;
  status: string;
  detail: string;
  doi: string;
}

export interface DatasetProfile {
  id: string;
  fileName: string;
  fileType: "xlsx" | "csv";
  byteSize: number;
  modelName: string;
  sourceGroup: string;
  declaredRange: { start: number; end: number } | null;
  sheetNames: string[];
  mainSheetName: string | null;
  headers: string[];
  records: SamRecord[];
  progress: ProgressEntry[];
  excludedRefs: number[];
  audit: AuditSummary;
  incompatible: boolean;
}

export type CoverageState =
  | "included"
  | "excluded"
  | "blocked"
  | "untracked"
  | "not_evaluated";

export interface ModelRefState {
  datasetId: string;
  modelName: string;
  state: CoverageState;
  records: SamRecord[];
  doi: string[];
  detail: string;
}

export interface FieldDifference {
  field: SamColumn;
  kind: "value" | "missing" | "critical";
  values: Array<{ model: string; value: string }>;
}

export interface RecordCluster {
  id: string;
  sourceGroup: string;
  ref: number;
  records: SamRecord[];
  modelIds: string[];
  matchType: "exact" | "probable" | "single";
  label: string;
  differences: FieldDifference[];
  similarity: number;
}

export type RefVerdict =
  | 'invalid_data'
  | "agree"
  | "all_excluded"
  | "all_unrecorded"
  | "blocked_included_gap"
  | "field_conflict"
  | "record_gap"
  | "inclusion_conflict"
  | "doi_conflict"
  | "not_comparable";

export interface RefComparison {
  id: string;
  sourceGroup: string;
  ref: number;
  modelStates: ModelRefState[];
  clusters: RecordCluster[];
  verdict: RefVerdict;
  doiValues: string[];
  fieldDifferenceCount: number;
  validationErrors: Array<{
    datasetId: string;
    modelName: string;
    recordId: string;
    rowNumber: number;
    refLabel: string;
    errors: string[];
  }>;
}

export interface AdjudicationItem {
  id: string;
  sourceGroup: string;
  ref: number;
  type:
    | 'DATA_ERROR'
    | "DOI_CONFLICT"
    | "BLOCKED_INCLUDED_GAP"
    | "INCLUSION_CONFLICT"
    | "RECORD_GAP"
    | "CRITICAL_FIELD_CONFLICT";
  severity: "critical" | "review";
  title: string;
  detail: string;
  models: string[];
}

export interface ComparisonAnalysis {
  refs: RefComparison[];
  adjudication: AdjudicationItem[];
  sourceGroups: string[];
  totals: {
    refs: number;
    comparableRefs: number;
    agreedRefs: number;
    conflicts: number;
    recordClusters: number;
    fieldDifferences: number;
  };
}

type Sheet = WorkSheet;

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value).trim();
}

export function normalizeDoi(value: unknown): string {
  let normalized = text(value)
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[／⁄]/g, "/")
    .trim();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original text when a malformed percent escape is present.
  }
  normalized = normalized
    .toLowerCase()
    .replace(/^doi\s*:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/\s+/g, "")
    .replace(/[?#].*$/, "")
    .replace(/^["'“”‘’<\[]+/, "")
    .replace(/["'“”‘’>\].,;:]+$/, "");
  const doiMatch = normalized.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
  return doiMatch ? doiMatch[0].replace(/[.,;:]+$/, "") : normalized;
}

function isValidDoi(value: unknown): boolean {
  return /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i.test(normalizeDoi(value));
}

function normalizeIdentity(value: unknown): string {
  return text(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(champion|control|reference|ref)\b/g, "")
    .replace(/[\s_–—\-+:/\\()[\]{}，,；;]+/g, "")
    .trim();
}

function normalizeSmiles(value: unknown): string {
  return text(value).replace(/\s+/g, "");
}

function parseRef(value: unknown): number | null {
  const match = text(value).match(/^(\d{1,4})(?=\D|$)/);
  return match ? Number(match[1]) : null;
}

function inferMetadata(fileName: string) {
  const base = fileName.replace(/\.(xlsx|xlsm|csv|tsv)$/i, "");
  const rangeMatch = base.match(/_ref(?:erence)?(\d+)(?:-(\d+))?/i);
  const declaredRange = rangeMatch
    ? {
        start: Number(rangeMatch[1]),
        end: Number(rangeMatch[2] || rangeMatch[1]),
      }
    : null;
  const afterRange = rangeMatch
    ? base.slice((rangeMatch.index || 0) + rangeMatch[0].length).replace(/^[_-]+/, "")
    : "";
  const modelName =
    afterRange
      .replace(/_(?:data|dataset)$/i, "")
      .replace(/\s+/g, " ")
      .trim() ||
    base.match(/(?:GPT|Opus|Fable|Gemini|Claude)[-_ ]?[A-Za-z0-9.\-]+/i)?.[0] ||
    `模型 ${base.slice(0, 24)}`;
  const sourceGroup = rangeMatch
    ? base.slice(0, rangeMatch.index).replace(/^\d{4}_?/, "").replace(/_/g, " ").trim()
    : base.replace(/[_-](?:GPT|Opus|Fable|Gemini|Claude).*$/i, "").replace(/_/g, " ").trim();
  return {
    modelName,
    sourceGroup: sourceGroup || "未命名來源",
    declaredRange,
  };
}

function sheetRows(sheet: Sheet): unknown[][] {
  return xlsxApi().utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  }) as unknown[][];
}

function findMainSheet(workbook: WorkBook) {
  const candidates = workbook.SheetNames.map((name) => {
    const rows = sheetRows(workbook.Sheets[name]);
    const headers = (rows[0] || []).map(text);
    const matches = SAM_COLUMNS.filter((column) => headers.includes(column)).length;
    return { name, rows, headers, matches };
  }).sort((a, b) => b.matches - a.matches);
  const named =
    candidates.find((candidate) => candidate.name === "主表" && candidate.matches >= 30) ||
    candidates.find((candidate) => /ML用/i.test(candidate.name) && candidate.matches >= 30);
  const best = named || candidates[0];
  return best && best.matches >= 30 && best.headers.includes("編號") ? best : null;
}

function normalizeRgb(value: unknown): string {
  const raw = text(value).replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{8}$/.test(raw)) return raw.slice(-6);
  if (/^[0-9A-F]{6}$/.test(raw)) return raw;
  return "";
}

function cellColor(sheet: Sheet, rowIndex: number, columnIndex: number): string {
  const address = xlsxApi().utils.encode_cell({ r: rowIndex, c: columnIndex });
  const cell = sheet[address] as
    | {
        s?: {
          fill?: {
            fgColor?: { rgb?: string; indexed?: number };
            patternType?: string;
          };
          fgColor?: { rgb?: string; indexed?: number };
          patternType?: string;
        };
      }
    | undefined;
  const style = cell?.s;
  if (!style) return "";
  const foreground = style.fill?.fgColor || style.fgColor;
  const rgb = normalizeRgb(foreground?.rgb || "");
  if (rgb) return rgb;
  if (foreground?.indexed === 0 || foreground?.indexed === 8) return "000000";
  if (foreground?.indexed === 1 || foreground?.indexed === 9) return "FFFFFF";
  const patternType = style.fill?.patternType || style.patternType;
  return patternType === "solid" ? "000000" : "";
}

function expandRefSpec(value: unknown): number[] {
  const result = new Set<number>();
  for (const part of text(value).split(/[,，、]/)) {
    const trimmed = part.trim();
    const range = trimmed.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end >= start && end - start <= 500) {
        for (let ref = start; ref <= end; ref += 1) result.add(ref);
      }
      continue;
    }
    const single = trimmed.match(/^(\d+)$/);
    if (single) result.add(Number(single[1]));
  }
  return [...result].sort((a, b) => a - b);
}

function extractProgress(workbook: WorkBook): ProgressEntry[] {
  const sheet = workbook.Sheets["進度追蹤"];
  if (!sheet) return [];
  const rows = sheetRows(sheet);
  if (!rows.length) return [];
  const headers = rows[0].map((value) =>
    text(value)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s_\-／/()（）]+/g, ""),
  );
  const findColumn = (patterns: RegExp[]) =>
    headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
  const refColumn = findColumn([/^ref(?:編號|number|no)?$/, /^參考文獻(?:編號)?$/, /^編號$/]);
  const doiColumn = findColumn([/^doi$/, /reference.*doi/, /文獻.*doi/]);
  const statusColumn = findColumn([/^狀態$/, /status/, /處理狀態/, /擷取狀態/]);
  const detailColumns = headers
    .map((header, index) => ({ header, index }))
    .filter(
      ({ header, index }) =>
        index !== refColumn &&
        index !== doiColumn &&
        index !== statusColumn &&
        /備註|說明|原因|結果|紀錄|notes?|detail|message/.test(header),
    )
    .map(({ index }) => index);
  const result: ProgressEntry[] = [];
  for (const row of rows.slice(1)) {
    const refs = expandRefSpec(row[refColumn >= 0 ? refColumn : 0]);
    for (const ref of refs) {
      const doi = doiColumn >= 0 ? normalizeDoi(row[doiColumn]) : "";
      result.push({
        ref,
        doi: isValidDoi(doi) ? doi : "",
        status: statusColumn >= 0 ? text(row[statusColumn]) : "",
        detail: detailColumns.map((index) => text(row[index])).filter(Boolean).join("；"),
      });
    }
  }
  return result;
}

function extractExcludedRefs(workbook: WorkBook): number[] {
  const result = new Set<number>();
  for (const sheetName of ["已剔除_同特徵異PCE", "已刪除_不收錄"]) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = sheetRows(sheet);
    for (const row of rows.slice(1)) {
      const ref = parseRef(row[0]);
      if (ref !== null) result.add(ref);
    }
  }
  return [...result].sort((a, b) => a - b);
}

function sumIsValid(values: Array<CellValue | "">, tolerance = 0.011) {
  if (values.some((value) => text(value) === "")) return true;
  const numbers = values.map(Number);
  return numbers.every(Number.isFinite) && Math.abs(numbers.reduce((a, b) => a + b, 0) - 1) <= tolerance;
}

function valuesAreComplete(values: Array<CellValue | "">) {
  return values.every((value) => text(value) !== "");
}

function solventValidationErrors(record: SamRecord): string[] {
  if (isBlockedRecord(record)) return [];
  const errors: string[] = [];
  const values = SOLVENT_COLUMNS.map((column) => record.values[column]);
  for (const [index, value] of values.entries()) {
    const rendered = text(value);
    if (!rendered) continue;
    const numeric = Number(rendered);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
      errors.push(`${SOLVENT_COLUMNS[index]} 應為 0–1 分率，實際為 ${rendered}`);
    }
  }
  if (valuesAreComplete(values) && errors.length === 0 && !sumIsValid(values)) {
    errors.push(
      `溶劑比例總和不等於 1（${SOLVENT_COLUMNS.map((column, index) => `${column}=${text(values[index])}`).join("、")}）`,
    );
  }
  return errors;
}

function xSiteDeviationIsExplained(notes: string) {
  return /過量|缺量|無欄位|未設欄位|添加劑|excess|deficien|unrecorded/i.test(notes);
}

function isBlockedRecord(record: SamRecord) {
  const explicitlyBlocked = /^(?:無法讀取|受阻|blocked\b)/i.test(record.status.trim());
  return (
    explicitlyBlocked ||
    FEATURE_COLUMNS.every((column) => record.colors[column] === "000000")
  );
}

function smilesValidationError(value: string): string | null {
  const smiles = normalizeSmiles(value);
  if (!smiles) return null;
  if (/^(?:n\/?a|na|none|null|unknown|missing|無|未知|不明|\?|-+)$/i.test(smiles)) {
    return 'SMILES 是占位文字，不是化學結構字串';
  }
  if (!/^[A-Za-z0-9@+\-\[\]()=#$%.:/\\*]+$/.test(smiles)) {
    return 'SMILES 含不允許的字元';
  }
  const balanced = (open: string, close: string) => {
    let depth = 0;
    for (const character of smiles) {
      if (character === open) depth += 1;
      if (character === close) depth -= 1;
      if (depth < 0) return false;
    }
    return depth === 0;
  };
  if (!balanced('(', ')') || !balanced('[', ']')) return 'SMILES 的括號不成對';
  const outsideBrackets = smiles.replace(/\[[^\]]*\]/g, '');
  const unknownLetters = outsideBrackets.replace(/Cl|Br|Si|Se|As|B|C|N|O|P|S|F|I|b|c|n|o|p|s/g, '');
  if (/[A-Za-z]/.test(unknownLetters)) return 'SMILES 含無法辨識的原子符號或文字';
  if (!/(?:\[[^\]]+\]|Cl|Br|Si|Se|As|B|C|N|O|P|S|F|I|b|c|n|o|p|s)/.test(smiles)) {
    return 'SMILES 未包含可辨識的原子';
  }
  return null;
}

function validateRecord(record: SamRecord): string[] {
  const errors: string[] = [];
  for (const column of BINARY_COLUMNS) {
    const value = text(record.values[column]);
    if (value && value !== '0' && value !== '1') errors.push(`${column} 應為 0 或 1，實際為 ${value}`);
  }
  errors.push(...solventValidationErrors(record));
  const xSite = ['I', 'Br', 'CL'] as SamColumn[];
  const xSiteValues = xSite.map((column) => record.values[column]);
  if (!sumIsValid(xSiteValues) && !xSiteDeviationIsExplained(record.notes)) {
    errors.push(
      `${xSite.join('+')} 的比例總和偏離 1 且 Notes 未說明（${xSiteValues.map((value) => text(value) || '∅').join('+')}）`,
    );
  }
  const concentration = text(record.values['concentration(mg/ml)']);
  if (concentration && (!Number.isFinite(Number(concentration)) || Number(concentration) < 0)) {
    errors.push(`concentration(mg/ml) 應為非負數，實際為 ${concentration}`);
  }
  const pce = text(record.values.PCE);
  if (!pce && !isBlockedRecord(record)) errors.push('PCE 缺失');
  else if (pce && (!Number.isFinite(Number(pce)) || Number(pce) <= 0 || Number(pce) > 35)) {
    errors.push(`PCE 應介於 0–35%，實際為 ${pce}`);
  }
  const energy = text(record.values.E);
  if (energy && (!Number.isFinite(Number(energy)) || Number(energy) < -0.7 || Number(energy) > 1)) {
    errors.push(`E 應介於 −0.7–1.0 eV，實際為 ${energy}`);
  }
  if (record.doi && !isValidDoi(record.doi)) errors.push(`DOI 格式不合理：${text(record.values.Reference_DOI)}`);
  const smilesError = smilesValidationError(record.smiles);
  if (smilesError) errors.push(`${smilesError}：${record.smiles}`);
  return errors;
}

function auditDataset(
  profile: Omit<DatasetProfile, "audit">,
  workbook: WorkBook,
  mainSheet: Sheet | null,
): AuditSummary {
  const issues: AuditIssue[] = [];
  const add = (
    severity: Severity,
    category: AuditIssue["category"],
    message: string,
    location?: string,
    count?: number,
    details?: string[],
  ) =>
    issues.push({
      id: `${profile.id}-${issues.length}`,
      severity,
      category,
      message,
      location,
      count,
      details,
    });

  if (!mainSheet) {
    add("error", "結構", "找不到含標準 35 欄的主表，無法進行內容比較。");
  } else {
    const exactHeaders =
      profile.headers.length >= SAM_COLUMNS.length &&
      SAM_COLUMNS.every((column, index) => profile.headers[index] === column);
    add(
      exactHeaders ? "pass" : "error",
      "結構",
      exactHeaders ? "35 欄名稱與順序符合 Skill。" : "35 欄名稱或順序不符合 Skill。",
      `${profile.mainSheetName}!1:1`,
      undefined,
      exactHeaders
        ? undefined
        : SAM_COLUMNS.flatMap((expected, index) => {
            const actual = profile.headers[index] || "∅";
            return actual === expected ? [] : [`第 ${index + 1} 欄：應為「${expected}」，實際為「${actual}」`];
          }),
    );
    if (profile.mainSheetName !== "主表") {
      add("warning", "結構", `主表名稱為「${profile.mainSheetName}」，可辨識但不符合目前標準名稱。`);
    }
  }

  if (profile.fileType === "csv") {
    add("na", "結構", "CSV 不支援多工作表，工作表完整性不列入評分。");
    add("na", "標頭顏色", "CSV 不保存儲存格顏色。");
    add("na", "可信度顏色", "CSV 不保存紅／黑可信度標色。");
  } else {
    const missingSheets = REQUIRED_SHEETS.filter(
      (name) => name !== "主表" && !profile.sheetNames.includes(name),
    );
    add(
      missingSheets.length ? "error" : "pass",
      "結構",
      missingSheets.length
        ? `缺少必要工作表：${missingSheets.join("、")}`
        : "必要工作表完整。",
      undefined,
      missingSheets.length,
      missingSheets.map((sheetName) => `缺少工作表「${sheetName}」`),
    );
  }

  let redCells = 0;
  let blackCells = 0;
  if (mainSheet && profile.fileType === "xlsx") {
    const headerColors = SAM_COLUMNS.map((column, index) => ({
      column,
      expected: HEADER_COLORS[column] || "",
      actual: cellColor(mainSheet, 0, index),
    }));
    const styleReadable = headerColors.some((item) => item.actual);
    if (!styleReadable) {
      add("warning", "標頭顏色", "檔案含樣式，但目前解析器未讀到標頭填色；顏色結果標記為待確認。");
    } else {
      const mismatches = headerColors.filter((item) =>
        item.expected ? item.actual !== item.expected : Boolean(item.actual && item.actual !== "FFFFFF"),
      );
      add(
        mismatches.length ? "error" : "pass",
        "標頭顏色",
        mismatches.length
          ? `${mismatches.length} 個標頭底色不符合 Skill：${mismatches
              .slice(0, 7)
              .map((item) => `${item.column}(${item.actual || "無填色"})`)
              .join("、")}${mismatches.length > 7 ? "…" : ""}`
          : "標頭分類色符合 Skill。",
        `${profile.mainSheetName}!1:1`,
        mismatches.length,
        mismatches.map(
          (item) =>
            `${item.column}：應為 ${item.expected || "無填色"}，實際為 ${item.actual || "無填色"}`,
        ),
      );
    }
  }

  const duplicateKeys = new Map<string, SamRecord>();
  const invalidBinary: string[] = [];
  const invalidSolventRange: string[] = [];
  const invalidSolventSum: string[] = [];
  const invalidXSite: string[] = [];
  const invalidPce: string[] = [];
  const invalidE: string[] = [];
  const invalidDoi: string[] = [];
  const invalidSmiles: string[] = [];
  const redWithoutNotes: string[] = [];
  const blackRowErrors: string[] = [];
  const statusErrors: string[] = [];
  const duplicateErrors: string[] = [];

  for (const record of profile.records) {
    const redFields = SAM_COLUMNS.filter((column) => record.colors[column] === "FFC7CE");
    const blackFields = SAM_COLUMNS.filter((column) => record.colors[column] === "000000");
    redCells += redFields.length;
    blackCells += blackFields.length;
    if (redFields.length && !record.notes) {
      redWithoutNotes.push(`第 ${record.rowNumber} 列（${record.refLabel || "無編號"}）：紅格 ${redFields.join("、")}，但 Notes 空白`);
    }

    const blackRow = isBlockedRecord(record);
    const blackMismatches = FEATURE_COLUMNS.filter((column) => record.colors[column] !== "000000");
    if (blackRow && blackMismatches.length) {
      blackRowErrors.push(
        `第 ${record.rowNumber} 列（${record.refLabel || "無編號"}）：未標黑 ${blackMismatches.join("、")}`,
      );
    }
    const missingFeatures = FEATURE_COLUMNS.filter((column) => text(record.values[column]) === "");
    const declaredMissing = declaredMissingFields(record.status);
    const undeclaredMissing = missingFeatures.filter(
      (column) => !declaredMissing.has(normalizeMissingField(column)),
    );
    if (undeclaredMissing.length && !blackRow) {
      statusErrors.push(
        `第 ${record.rowNumber} 列（${record.refLabel || "無編號"}）：缺少 ${undeclaredMissing.join("、")}，Data_status 未記錄缺值`,
      );
    }

    for (const column of BINARY_COLUMNS) {
      const value = text(record.values[column]);
      if (value !== "" && value !== "0" && value !== "1") {
        invalidBinary.push(`第 ${record.rowNumber} 列 ${column}=${value}`);
      }
    }
    const solventValues = SOLVENT_COLUMNS.map((column) => record.values[column]);
    const solventRangeErrors = solventValidationErrors(record).filter((error) => error.includes("應為 0–1 分率"));
    invalidSolventRange.push(...solventRangeErrors.map((error) => `第 ${record.rowNumber} 列 ${error}`));
    if (
      !blackRow &&
      valuesAreComplete(solventValues) &&
      solventRangeErrors.length === 0 &&
      !sumIsValid(solventValues)
    ) {
      invalidSolventSum.push(
        `第 ${record.rowNumber} 列（${record.refLabel || "無編號"}）：溶劑總和=${solventValues.map(Number).reduce((sum, value) => sum + value, 0).toFixed(6)}；${SOLVENT_COLUMNS.map((column, index) => `${column}=${text(solventValues[index])}`).join("、")}`,
      );
    }
    const xSiteColumns = ["I", "Br", "CL"] as SamColumn[];
    const xSiteValues = xSiteColumns.map((column) => record.values[column]);
    if (!sumIsValid(xSiteValues) && !xSiteDeviationIsExplained(record.notes)) {
      invalidXSite.push(
        `第 ${record.rowNumber} 列 I+Br+CL：${xSiteValues.map((value) => text(value) || "∅").join("+")}；Notes 未說明過量、缺量或未設欄位成分`,
      );
    }
    const pceText = text(record.values.PCE);
    if (pceText) {
      const pce = Number(pceText);
      if (!Number.isFinite(pce) || pce <= 0 || pce > 35) {
        invalidPce.push(`第 ${record.rowNumber} 列 PCE=${pceText}`);
      }
    } else if (!blackRow) {
      invalidPce.push(`第 ${record.rowNumber} 列 PCE=∅`);
    }
    const eText = text(record.values.E);
    if (eText) {
      const energy = Number(eText);
      if (!Number.isFinite(energy) || energy < -0.7 || energy > 1) {
        invalidE.push(`第 ${record.rowNumber} 列 E=${eText}`);
      }
    }
    if (record.doi && !isValidDoi(record.doi)) {
      invalidDoi.push(`第 ${record.rowNumber} 列 DOI=${text(record.values.Reference_DOI)}`);
    }
    const smilesError = smilesValidationError(record.smiles);
    if (smilesError) {
      invalidSmiles.push(`第 ${record.rowNumber} 列 ${smilesError}：${record.smiles}`);
    }

    if (!blackRow) {
      const key = [normalizeSmiles(record.smiles), ...FEATURE_COLUMNS.map((column) => text(record.values[column]))].join("¦");
      const previous = duplicateKeys.get(key);
      if (previous && text(previous.pce) !== text(record.pce)) {
        duplicateErrors.push(
          `第 ${previous.rowNumber}、${record.rowNumber} 列：相同特徵但 PCE 為 ${text(previous.pce)}／${text(record.pce)}`,
        );
      }
      else duplicateKeys.set(key, record);
    }
  }

  const ruleChecks: Array<[string[], string, string]> = [
    [invalidSmiles, 'SMILES 字串格式不合理', 'C'],
    [invalidBinary, "真正二元欄含非 0/1 值", "D、M、W:AC"],
    [invalidSolventRange, "溶劑欄含超出 0–1 的分率", "E:K"],
    [invalidSolventSum, "溶劑比例加總不等於 1", "E:K"],
    [invalidXSite, "X-site 比例偏離 1 且 Notes 未說明", "T:V"],
    [invalidPce, "PCE 缺失或超出 0–35%", "AD"],
    [invalidE, "E 非數值或超出 −0.7–1.0 eV", "N"],
    [invalidDoi, "DOI 格式異常", "AE"],
    [duplicateErrors, "相同 SMILES＋26 特徵出現不同 PCE", "主表"],
  ];
  for (const [details, label, location] of ruleChecks) {
    const count = details.length;
    add(
      count ? "error" : "pass",
      "欄位規則",
      count ? `${label}：${count} 筆。` : `${label}：未發現。`,
      location,
      count,
      count ? details : undefined,
    );
  }
  add(
    redWithoutNotes.length ? "error" : "pass",
    "可信度顏色",
    redWithoutNotes.length ? `有紅格但 Notes 空白：${redWithoutNotes.length} 列。` : "所有紅格列都有 Notes。",
    "AI",
    redWithoutNotes.length,
    redWithoutNotes.length ? redWithoutNotes : undefined,
  );
  add(
    blackRowErrors.length ? "error" : "pass",
    "可信度顏色",
    blackRowErrors.length ? `無法讀取列未將 26 特徵全黑：${blackRowErrors.length} 列。` : "黑列的 26 特徵標色符合規則。",
    "D:AC",
    blackRowErrors.length,
    blackRowErrors.length ? blackRowErrors : undefined,
  );
  add(
    statusErrors.length ? "error" : "pass",
    "追蹤性",
    statusErrors.length ? `Data_status 與實際缺值不一致：${statusErrors.length} 個問題。` : "Data_status 與缺值狀態基本一致。",
    "AH",
    statusErrors.length,
    statusErrors.length ? statusErrors : undefined,
  );

  return {
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    passes: issues.filter((issue) => issue.severity === "pass").length,
    notApplicable: issues.filter((issue) => issue.severity === "na").length,
    redCells,
    blackCells,
    issues,
  };
}

export async function parseDataset(file: File, sequence: number): Promise<DatasetProfile> {
  const id = `dataset-${Date.now()}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
  const fileType = /\.(csv|tsv)$/i.test(file.name) ? "csv" : "xlsx";
  const metadata = inferMetadata(file.name);
  const input = fileType === "csv" ? await file.text() : await file.arrayBuffer();
  const workbook = xlsxApi().read(input, {
    type: fileType === "csv" ? "string" : "array",
    cellStyles: true,
    cellDates: false,
    dense: false,
  });
  const main = findMainSheet(workbook);
  const records: SamRecord[] = [];
  let headers: string[] = [];
  if (main) {
    headers = main.headers;
    const indexByName = new Map(headers.map((header, index) => [header, index]));
    for (let rowIndex = 1; rowIndex < main.rows.length; rowIndex += 1) {
      const row = main.rows[rowIndex];
      const refLabel = text(row[indexByName.get("編號") ?? 0]);
      if (!refLabel && row.every((value) => text(value) === "")) continue;
      const values: Record<string, CellValue | ""> = {};
      const colors: Record<string, string> = {};
      for (const column of SAM_COLUMNS) {
        const columnIndex = indexByName.get(column);
        const raw = columnIndex === undefined ? "" : row[columnIndex];
        values[column] =
          typeof raw === "number" || typeof raw === "boolean" ? raw : text(raw);
        colors[column] =
          columnIndex === undefined ? "" : cellColor(workbook.Sheets[main.name], rowIndex, columnIndex);
      }
      const ref = parseRef(values["編號"]);
      const parsedRecord: SamRecord = {
        id: `${id}-row-${rowIndex + 1}`,
        datasetId: id,
        rowNumber: rowIndex + 1,
        ref,
        refLabel,
        material: text(values["SAM/HTL材料名稱"]),
        smiles: text(values.smile),
        doi: normalizeDoi(values.Reference_DOI),
        pce: values.PCE,
        status: text(values.Data_status),
        notes: text(values.Notes),
        values,
        colors,
        validationErrors: [],
      };
      parsedRecord.validationErrors = validateRecord(parsedRecord);
      records.push(parsedRecord);
    }
  }
  const baseProfile: Omit<DatasetProfile, "audit"> = {
    id,
    fileName: file.name,
    fileType,
    byteSize: file.size,
    modelName: metadata.modelName,
    sourceGroup: metadata.sourceGroup,
    declaredRange: metadata.declaredRange,
    sheetNames: workbook.SheetNames,
    mainSheetName: main?.name || null,
    headers,
    records,
    progress: extractProgress(workbook),
    excludedRefs: extractExcludedRefs(workbook),
    incompatible: !main,
  };
  return {
    ...baseProfile,
    audit: auditDataset(baseProfile, workbook, main ? workbook.Sheets[main.name] : null),
  };
}

function numericEquivalent(field: SamColumn, a: string, b: string) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (BINARY_COLUMNS.includes(field as (typeof BINARY_COLUMNS)[number])) return x === y;
  if (field === "PCE") return Math.abs(x - y) <= 0.05;
  if (field === "E") return Math.abs(x - y) <= 0.01;
  if (["Cs", "FA", "MA", "Pb", "Sn", "I", "Br", "CL"].includes(field)) {
    const difference = Math.abs(x - y);
    const scale = Math.max(Math.abs(x), Math.abs(y), 1e-9);
    return difference <= 0.005 || (difference <= 0.075 && difference / scale <= 0.12);
  }
  if (field === "concentration(mg/ml)") {
    return Math.abs(x - y) <= Math.max(0.01, Math.abs(x) * 0.01);
  }
  return Math.abs(x - y) <= 1e-6;
}

function fieldEquivalent(field: SamColumn, left: CellValue | "", right: CellValue | "") {
  const a = text(left);
  const b = text(right);
  if (!a || !b) return a === b;
  if (
    BINARY_COLUMNS.includes(field as (typeof BINARY_COLUMNS)[number]) ||
    SOLVENT_COLUMNS.includes(field as (typeof SOLVENT_COLUMNS)[number]) ||
    ["PCE", "E", "Cs", "FA", "MA", "Pb", "Sn", "I", "Br", "CL", "concentration(mg/ml)"].includes(field)
  ) {
    return numericEquivalent(field, a, b);
  }
  if (field === "Reference_DOI") return normalizeDoi(a) === normalizeDoi(b);
  if (field === "smile") return normalizeSmiles(a) === normalizeSmiles(b);
  if (field === "SAM/HTL材料名稱") return normalizeIdentity(a) === normalizeIdentity(b);
  return normalizeIdentity(a) === normalizeIdentity(b);
}

function tokenSet(value: string) {
  return new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff.]+/)
      .filter((token) => token.length > 1),
  );
}

function jaccard(left: string, right: string) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / (a.size + b.size - intersection);
}

function baseMoleculeIdentity(value: unknown) {
  return normalizeIdentity(
    text(value)
      .replace(/^\s*\d{1,4}\s*[-_:]\s*/, "")
      .split(/[（(\[［]/, 1)[0]
      .replace(/\b(champion|control|reference|ref)\b/gi, ""),
  );
}

function recordBaseIdentities(record: SamRecord) {
  return [
    baseMoleculeIdentity(record.material),
    baseMoleculeIdentity(record.refLabel),
  ].filter(Boolean);
}

function pceEquivalentForPairing(left: string, right: string) {
  const x = Number(left);
  const y = Number(right);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= Math.max(0.2, Math.max(Math.abs(x), Math.abs(y)) * 0.01);
}

function recordSimilarity(left: SamRecord, right: SamRecord) {
  if (left.datasetId === right.datasetId) return -1;
  if (left.doi && right.doi && left.doi !== right.doi) return -1;
  const leftBases = recordBaseIdentities(left);
  const rightBases = recordBaseIdentities(right);
  const baseMatch = leftBases.some((identity) => rightBases.includes(identity));
  const smilesMatch =
    Boolean(left.smiles && right.smiles) &&
    normalizeSmiles(left.smiles) === normalizeSmiles(right.smiles);
  if (leftBases.length && rightBases.length && !baseMatch && !smilesMatch) return -1;

  let score = 0;
  let weight = 0;
  if (left.doi || right.doi) {
    weight += 0.1;
    if (left.doi && right.doi && left.doi === right.doi) score += 0.1;
  }
  if (leftBases.length || rightBases.length) {
    weight += 0.35;
    if (baseMatch) score += 0.35;
  }
  const leftPce = text(left.pce);
  const rightPce = text(right.pce);
  if (leftPce || rightPce) {
    weight += 0.3;
    if (leftPce && rightPce && pceEquivalentForPairing(leftPce, rightPce)) score += 0.3;
  }
  if (left.smiles || right.smiles) {
    weight += 0.15;
    if (smilesMatch) score += 0.15;
  }
  if (left.material || right.material) {
    weight += 0.1;
    if (normalizeIdentity(left.material) === normalizeIdentity(right.material)) score += 0.1;
    else score += 0.06 * jaccard(left.material, right.material);
  }
  const conditionFields = [
    "NiO2",
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
  ] as SamColumn[];
  const comparable = conditionFields.filter(
    (field) => text(left.values[field]) && text(right.values[field]),
  );
  if (comparable.length) {
    weight += 0.2;
    score +=
      0.2 *
      (comparable.filter((field) => fieldEquivalent(field, left.values[field], right.values[field])).length /
        comparable.length);
  }
  return weight ? score / weight : 0;
}

function clusterDifferences(records: SamRecord[], datasets: Map<string, DatasetProfile>) {
  const differences: FieldDifference[] = [];
  for (const field of SAM_COLUMNS) {
    if (field === "編號" || field === "Notes" || field === "Data_status") continue;
    const entries = records.map((record) => ({
      model: datasets.get(record.datasetId)?.modelName || record.datasetId,
      value: text(record.values[field]),
    }));
    const first = entries[0];
    const equivalent = entries.every((entry) =>
      fieldEquivalent(field, first.value, entry.value),
    );
    if (!equivalent) {
      const hasMissing = entries.some((entry) => !entry.value) && entries.some((entry) => entry.value);
      const critical = ["SAM/HTL材料名稱", "smile", "PCE", "Reference_DOI"].includes(field);
      differences.push({
        field,
        kind: critical ? "critical" : hasMissing ? "missing" : "value",
        values: entries,
      });
    }
  }
  return differences;
}

function stateForRef(dataset: DatasetProfile, ref: number): ModelRefState {
  const records = dataset.records.filter((record) => record.ref === ref);
  const progress = dataset.progress.find((entry) => entry.ref === ref);
  const inDeclaredRange =
    !dataset.declaredRange ||
    (ref >= dataset.declaredRange.start && ref <= dataset.declaredRange.end);
  const inScope = inDeclaredRange || Boolean(progress) || records.length > 0;
  const detail = [progress?.status, progress?.detail].filter(Boolean).join("；");
  let state: CoverageState = "not_evaluated";
  if (records.length) {
    state = records.every(isBlockedRecord)
      ? "blocked"
      : "included";
  } else if (!inScope) {
    state = "not_evaluated";
  } else if (
    dataset.excludedRefs.includes(ref) ||
    /不收|省略|刪除|剔除|排除/i.test(detail)
  ) {
    state = "excluded";
  } else if (/受阻|黑格|blocked|付費牆|無法讀取|權限|不可取得|無全文/i.test(detail)) {
    state = "blocked";
  } else {
    state = "untracked";
  }
  return {
    datasetId: dataset.id,
    modelName: dataset.modelName,
    state,
    records,
    doi: [
      ...new Set(
        [...records.map((record) => record.doi), progress?.doi || ""].filter(isValidDoi),
      ),
    ],
    detail,
  };
}

function buildClusters(
  sourceGroup: string,
  ref: number,
  states: ModelRefState[],
  datasetMap: Map<string, DatasetProfile>,
) {
  const allRecords = states.flatMap((state) => state.records);
  const rawClusters: Array<{ records: SamRecord[]; similarity: number }> = [];
  for (const record of allRecords) {
    let bestIndex = -1;
    let bestScore = -1;
    rawClusters.forEach((cluster, index) => {
      if (cluster.records.some((member) => member.datasetId === record.datasetId)) return;
      const score = Math.max(...cluster.records.map((member) => recordSimilarity(record, member)));
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && bestScore >= 0.68) {
      rawClusters[bestIndex].records.push(record);
      rawClusters[bestIndex].similarity = Math.min(rawClusters[bestIndex].similarity, bestScore);
    } else {
      rawClusters.push({ records: [record], similarity: 1 });
    }
  }
  return rawClusters.map<RecordCluster>((cluster, index) => {
    const differences = clusterDifferences(cluster.records, datasetMap);
    const models = [...new Set(cluster.records.map((record) => record.datasetId))];
    const matchType =
      models.length === 1 ? "single" : differences.length === 0 ? "exact" : "probable";
    return {
      id: `${normalizeIdentity(sourceGroup)}-${ref}-cluster-${index + 1}`,
      sourceGroup,
      ref,
      records: cluster.records,
      modelIds: models,
      matchType,
      label:
        cluster.records.find((record) => record.material)?.material ||
        cluster.records.find((record) => record.smiles)?.smiles ||
        `資料點 ${index + 1}`,
      differences,
      similarity: cluster.similarity,
    };
  });
}

export function buildComparison(datasets: DatasetProfile[]): ComparisonAnalysis {
  const usable = datasets.filter((dataset) => !dataset.incompatible);
  const datasetMap = new Map(usable.map((dataset) => [dataset.id, dataset]));
  const sourceGroup =
    usable.map((dataset) => dataset.sourceGroup.trim()).find(Boolean) || "同一 Review";
  const grouped = new Map<string, DatasetProfile[]>(
    usable.length ? [[sourceGroup, usable]] : [],
  );
  const refs: RefComparison[] = [];
  const adjudication: AdjudicationItem[] = [];

  for (const [sourceGroup, groupDatasets] of grouped) {
    const refSet = new Set<number>();
    for (const dataset of groupDatasets) {
      dataset.records.forEach((record) => record.ref !== null && refSet.add(record.ref));
      dataset.progress.forEach((entry) => refSet.add(entry.ref));
      if (dataset.declaredRange && dataset.declaredRange.end - dataset.declaredRange.start <= 500) {
        for (let ref = dataset.declaredRange.start; ref <= dataset.declaredRange.end; ref += 1) {
          refSet.add(ref);
        }
      }
    }
    for (const ref of [...refSet].sort((a, b) => a - b)) {
      const states = groupDatasets.map((dataset) => stateForRef(dataset, ref));
      const evaluated = states.filter((state) => state.state !== "not_evaluated");
      const explicitlyEvaluated = states.filter(
        (state) => !["not_evaluated", "untracked"].includes(state.state),
      );
      const included = states.filter((state) => state.state === "included");
      const blocked = states.filter((state) => state.state === "blocked");
      const excluded = states.filter((state) => state.state === "excluded");
      const doiValues = [
        ...new Set(
          states.flatMap((state) => state.doi).filter(isValidDoi),
        ),
      ];
      const statesWithDoi = states.filter((state) => state.doi.length > 0);
      const doiConflict = statesWithDoi.some((left, leftIndex) =>
        statesWithDoi.slice(leftIndex + 1).some(
          (right) => !left.doi.some((doi) => right.doi.includes(doi)),
        ),
      );
      const allBlocked =
        states.length > 1 && states.every((state) => state.state === "blocked");
      const clusters = buildClusters(sourceGroup, ref, states, datasetMap).map((cluster) =>
        allBlocked ? { ...cluster, differences: [] } : cluster,
      );
      const fieldDifferenceCount = allBlocked ? 0 : clusters.reduce(
        (sum, cluster) => sum + cluster.differences.length,
        0,
      );
      const evaluatedIds = new Set(evaluated.map((state) => state.datasetId));
      const recordGap = clusters.some(
        (cluster) =>
          cluster.modelIds.length < evaluatedIds.size &&
          cluster.modelIds.length < groupDatasets.length,
      );
      const noRecords = states.every((state) => state.records.length === 0);
      const allExcluded =
        states.length > 1 && states.every((state) => state.state === "excluded");
      const allUnrecorded =
        noRecords &&
        !blocked.length &&
        !allExcluded;
      const validationErrors = states.flatMap((state) =>
        state.records
          .filter((record) => record.validationErrors.length > 0)
          .map((record) => ({
            datasetId: state.datasetId,
            modelName: state.modelName,
            recordId: record.id,
            rowNumber: record.rowNumber,
            refLabel: record.refLabel,
            errors: record.validationErrors,
          })),
      );
      let verdict: RefVerdict = "agree";
      if (validationErrors.length) {
        verdict = 'invalid_data';
      }
      else if (groupDatasets.length < 2) {
        verdict = "not_comparable";
      }
      else if (allExcluded) verdict = "all_excluded";
      else if (allUnrecorded) verdict = "all_unrecorded";
      else if (doiConflict) verdict = "doi_conflict";
      else if (allBlocked) verdict = "agree";
      else if (included.length && blocked.length) verdict = "blocked_included_gap";
      else if ((included.length || blocked.length) && excluded.length) verdict = "inclusion_conflict";
      else if (recordGap) verdict = "record_gap";
      else if (fieldDifferenceCount) verdict = "field_conflict";
      else if (
        evaluated.length < 2 ||
        (!clusters.length && explicitlyEvaluated.length < 2)
      ) {
        verdict = "not_comparable";
      }

      const comparison: RefComparison = {
        id: `${normalizeIdentity(sourceGroup)}-${ref}`,
        sourceGroup,
        ref,
        modelStates: states,
        clusters,
        verdict,
        doiValues,
        fieldDifferenceCount,
        validationErrors,
      };
      refs.push(comparison);

      if (validationErrors.length) {
        adjudication.push({
          id: `${comparison.id}-data-error`,
          sourceGroup,
          ref,
          type: 'DATA_ERROR',
          severity: 'critical',
          title: `Ref ${ref} 含不符合 Skill 的錯誤值`,
          detail: validationErrors
            .map((item) => `${item.modelName} 第 ${item.rowNumber} 列：${item.errors.join('；')}`)
            .join(' ｜ '),
          models: [...new Set(validationErrors.map((item) => item.modelName))],
        });
      }
      if (doiConflict) {
        adjudication.push({
          id: `${comparison.id}-doi`,
          sourceGroup,
          ref,
          type: "DOI_CONFLICT",
          severity: "critical",
          title: `Ref ${ref} 對應到不同 DOI`,
          detail: doiValues.join(" ↔ "),
          models: evaluated.map((state) => state.modelName),
        });
      }
      if (included.length && blocked.length) {
        adjudication.push({
          id: `${comparison.id}-blocked-included`,
          sourceGroup,
          ref,
          type: "BLOCKED_INCLUDED_GAP",
          severity: "review",
          title: `Ref ${ref} 有模型受阻、另有模型已收錄`,
          detail: `${included.map((state) => `${state.modelName}：已收錄`).join("；")}；${blocked
            .map((state) => `${state.modelName}：受阻／黑格`)
            .join("；")}`,
          models: [...included, ...blocked].map((state) => state.modelName),
        });
      }
      if ((included.length || blocked.length) && excluded.length) {
        const retained = [...included, ...blocked];
        adjudication.push({
          id: `${comparison.id}-inclusion`,
          sourceGroup,
          ref,
          type: "INCLUSION_CONFLICT",
          severity: "critical",
          title: `Ref ${ref} 的收錄決策衝突`,
          detail: `${retained.map((state) => `${state.modelName}：${coverageLabel(state.state)}`).join("；")}；${excluded
            .map((state) => `${state.modelName}：排除`)
            .join("；")}`,
          models: [...retained, ...excluded].map((state) => state.modelName),
        });
      }
      for (const cluster of clusters) {
        if (
          !allBlocked &&
          evaluatedIds.size > 1 &&
          cluster.modelIds.length < evaluatedIds.size
        ) {
          const present = cluster.records.map(
            (record) => datasetMap.get(record.datasetId)?.modelName || record.datasetId,
          );
          const missing = evaluated
            .filter((state) => !cluster.modelIds.includes(state.datasetId))
            .map((state) => state.modelName);
          adjudication.push({
            id: `${cluster.id}-gap`,
            sourceGroup,
            ref,
            type: "RECORD_GAP",
            severity: "review",
            title: `Ref ${ref}「${cluster.label}」只被部分模型收錄`,
            detail: `有：${present.join("、")}；無：${missing.join("、")}`,
            models: [...present, ...missing],
          });
        }
        const criticalDiffs = cluster.differences.filter(
          (difference) => difference.kind === "critical",
        );
        if (!allBlocked && criticalDiffs.length && cluster.modelIds.length > 1) {
          adjudication.push({
            id: `${cluster.id}-critical`,
            sourceGroup,
            ref,
            type: "CRITICAL_FIELD_CONFLICT",
            severity: "critical",
            title: `Ref ${ref}「${cluster.label}」有關鍵欄位衝突`,
            detail: criticalDiffs.map((difference) => difference.field).join("、"),
            models: cluster.records.map(
              (record) => datasetMap.get(record.datasetId)?.modelName || record.datasetId,
            ),
          });
        }
      }
    }
  }

  return {
    refs,
    adjudication,
    sourceGroups: [...grouped.keys()].sort(),
    totals: {
      refs: refs.length,
      comparableRefs: refs.filter(
        (ref) => !["not_comparable", "all_excluded", "all_unrecorded"].includes(ref.verdict),
      ).length,
      agreedRefs: refs.filter((ref) => ref.verdict === "agree").length,
      conflicts: refs.filter(
        (ref) =>
          !["agree", "all_excluded", "all_unrecorded", "not_comparable"].includes(ref.verdict),
      ).length,
      recordClusters: refs.reduce((sum, ref) => sum + ref.clusters.length, 0),
      fieldDifferences: refs.reduce((sum, ref) => sum + ref.fieldDifferenceCount, 0),
    },
  };
}

export function bytesLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function verdictLabel(verdict: RefVerdict) {
  return {
    invalid_data: '錯誤',
    agree: "一致",
    all_excluded: "皆已排除",
    all_unrecorded: "皆未收錄",
    blocked_included_gap: "受阻／已收錄",
    field_conflict: "欄位差異",
    record_gap: "資料點缺漏",
    inclusion_conflict: "收錄衝突",
    doi_conflict: "DOI 衝突",
    not_comparable: "不可比較",
  }[verdict];
}

export function verdictDescription(verdict: RefVerdict) {
  return {
    invalid_data: '至少一筆資料含客觀不合法值，例如比例總和不為 1、0/1 欄出現其他值、SMILES 格式不合理，或 PCE、E、DOI 超出規則。',
    agree: "至少兩個模型有可比較證據，DOI、配對資料點與比較欄位皆一致；也可能是所有模型皆為相同的受阻狀態。",
    all_excluded: "所有模型都明確在排除表或進度追蹤中將此 Ref 標為排除。",
    all_unrecorded: "所有檔案的主表都沒有此 Ref 資料點；可能是未追蹤、未評估，或實際排除但未留下排除紀錄。",
    blocked_included_gap: "至少一個模型因付費牆、無法讀取或黑格而受阻，另至少一個模型已成功收錄主表資料。",
    field_conflict: "相同 Ref 且已配對到同一資料點，但一個或多個製程、材料、PCE 或其他欄位值不同。",
    record_gap: "相同 Ref 下，有資料點只出現在部分模型；其他可比較模型沒有對應資料點。",
    inclusion_conflict: "相同 Ref 被部分模型收錄或保留，但另有模型明確標示排除。",
    doi_conflict: "至少兩個模型都提供有效 DOI，但模型間沒有共同 DOI，表示同一 Ref 被對應到不同論文。",
    not_comparable: "目前少於兩個模型具有足夠的可比較證據；例如只載入一個模型，或其他模型尚未評估該 Ref。",
  }[verdict];
}

export function coverageLabel(state: CoverageState) {
  return {
    included: "已收錄",
    excluded: "已排除",
    blocked: "受阻／黑格",
    untracked: "未收錄／未追蹤",
    not_evaluated: "未評估",
  }[state];
}
