"use client";

import { Fragment, type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import {
  type AdjudicationItem,
  type AuditIssue,
  type DatasetProfile,
  type RefComparison,
  buildComparison,
  bytesLabel,
  coverageLabel,
  parseDataset,
  verdictDescription,
  verdictLabel,
} from "@/lib/sam";

type Tab = "overview" | "audit" | "refs" | "queue";
type Decision = { status: string; note: string };
type RefViewState = {
  source: string;
  verdict: string;
  search: string;
  selected: string;
};

const DECISION_OPTIONS = [
  "待查核",
  "確認應收錄",
  "確認應排除",
  "多組皆正確",
  "資料不足",
  "不可比較",
];

function csvCell(value: unknown) {
  const rendered = value === null || value === undefined ? "" : String(value);
  return `"${rendered.replaceAll('"', '""')}"`;
}

function downloadCsv(fileName: string, rows: Array<Array<unknown>>) {
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function verdictClass(verdict: RefComparison["verdict"]) {
  if (verdict === "agree" || verdict === "all_excluded") return "success";
  if (verdict === "all_unrecorded" || verdict === "not_comparable") return "muted";
  if (
    verdict === "field_conflict" ||
    verdict === "record_gap" ||
    verdict === "blocked_included_gap"
  ) return "review";
  return "critical";
}

const VERDICT_ORDER: RefComparison["verdict"][] = [
  "agree",
  "all_excluded",
  "all_unrecorded",
  "blocked_included_gap",
  "field_conflict",
  "record_gap",
  "inclusion_conflict",
  "doi_conflict",
  "not_comparable",
  'invalid_data',
];

function issueLabel(issue: AuditIssue) {
  return {
    error: "不符合",
    warning: "提醒",
    pass: "通過",
    na: "不適用",
  }[issue.severity];
}

function UploadPanel({
  onFiles,
  loading,
  compact = false,
}: {
  onFiles: (files: File[]) => void;
  loading: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`upload-panel ${compact ? "compact" : ""} ${dragging ? "dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        onFiles([...event.dataTransfer.files]);
      }}
    >
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        multiple
        accept=".xlsx,.xlsm,.csv,.tsv"
        onChange={(event) => onFiles([...(event.target.files || [])])}
      />
      <div className="upload-mark" aria-hidden="true">
        <span />
        <span />
      </div>
      <div>
        <p className="eyebrow">{compact ? "ADD DATASETS" : "LOCAL INPUT"}</p>
        <h2>{loading ? "正在讀取試算表…" : compact ? "加入更多模型檔案" : "拖放所有要比較的檔案"}</h2>
        {!compact && (
          <p>
            可一次選擇任意數量的 XLSX 或 CSV。檔案只在這台電腦的瀏覽器中解析，不會上傳。
          </p>
        )}
      </div>
      <button
        className="button primary"
        type="button"
        disabled={loading}
        onClick={() => inputRef.current?.click()}
      >
        {loading ? "處理中" : compact ? "選擇檔案" : "選擇多個檔案"}
      </button>
    </div>
  );
}

function DatasetCard({
  dataset,
  onUpdate,
  onRemove,
}: {
  dataset: DatasetProfile;
  onUpdate: (patch: Partial<DatasetProfile>) => void;
  onRemove: () => void;
}) {
  const uniqueRefs = new Set(dataset.records.map((record) => record.ref).filter(Boolean)).size;
  return (
    <article className={`dataset-card ${dataset.incompatible ? "incompatible" : ""}`}>
      <div className="dataset-card-top">
        <span className={`status-dot ${dataset.audit.errors ? "error" : "ok"}`} />
        <span className="file-name" title={dataset.fileName}>
          {dataset.fileName}
        </span>
        <button className="icon-button" type="button" onClick={onRemove} aria-label={`移除 ${dataset.fileName}`}>
          ×
        </button>
      </div>
      <div className="dataset-fields">
        <label>
          <span>模型名稱</span>
          <input value={dataset.modelName} onChange={(event) => onUpdate({ modelName: event.target.value })} />
        </label>
        <label>
          <span>來源群組</span>
          <input value={dataset.sourceGroup} onChange={(event) => onUpdate({ sourceGroup: event.target.value })} />
        </label>
      </div>
      <div className="dataset-metrics">
        <span>
          <strong>{dataset.records.length}</strong> 資料點
        </span>
        <span>
          <strong>{uniqueRefs}</strong> refs
        </span>
        <span>
          <strong className={dataset.audit.errors ? "text-error" : ""}>{dataset.audit.errors}</strong> 不符合
        </span>
        <span>{bytesLabel(dataset.byteSize)}</span>
      </div>
      {dataset.incompatible && <p className="inline-alert">無法辨識標準 35 欄主表，已排除於內容比較。</p>}
    </article>
  );
}

function Metric({
  label,
  value,
  note,
  tone = "default",
}: {
  label: string;
  value: string | number;
  note: string;
  tone?: "default" | "accent" | "danger";
}) {
  return (
    <article className={`metric ${tone}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{note}</span>
    </article>
  );
}

function EmptyState({ onFiles, loading }: { onFiles: (files: File[]) => void; loading: boolean }) {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">SAM DATASET · MODEL COMPARATOR</p>
          <h1>
            先驗規則，
            <br />
            再談差異。
          </h1>
          <p className="hero-lede">
            以 Skill 規格稽核格式與顏色，再按來源與 ref 對齊任意數量的模型輸出。獨有資料點只進入裁決，不自動判對錯。
          </p>
          <div className="privacy-note">
            <span className="privacy-pulse" />
            完全本機運算 · 檔案不離開瀏覽器
          </div>
        </div>
        <div className="hero-index" aria-hidden="true">
          <span>01</span>
          <span>35 COLS</span>
          <span>N MODELS</span>
        </div>
      </section>
      <UploadPanel onFiles={onFiles} loading={loading} />
      <section className="workflow">
        <article>
          <span>01</span>
          <h3>Skill 稽核</h3>
          <p>35 欄、工作表、標頭分類色、紅黑可信度標色與欄位規則。</p>
        </article>
        <article>
          <span>02</span>
          <h3>Ref 對齊</h3>
          <p>先確認 DOI，再以分子、SMILES、組成及 device 條件配對資料點。</p>
        </article>
        <article>
          <span>03</span>
          <h3>人工裁決</h3>
          <p>收錄衝突、單模型獨有與關鍵欄位差異集中列出，不用多數決。</p>
        </article>
      </section>
    </>
  );
}

function Overview({
  datasets,
  analysis,
}: {
  datasets: DatasetProfile[];
  analysis: ReturnType<typeof buildComparison>;
}) {
  const totalErrors = datasets.reduce((sum, dataset) => sum + dataset.audit.errors, 0);
  const totalWarnings = datasets.reduce((sum, dataset) => sum + dataset.audit.warnings, 0);
  return (
    <div className="section-stack">
      <section className="metric-grid">
        <Metric label="已載入模型檔" value={datasets.length} note="視為同一份 Review 的不同模型輸出" />
        <Metric
          label="可比較 refs"
          value={analysis.totals.comparableRefs}
          note={`共追蹤 ${analysis.totals.refs} refs`}
          tone="accent"
        />
        <Metric label="完全一致 refs" value={analysis.totals.agreedRefs} note="只代表模型間一致，不代表正確率" />
        <Metric
          label="待處理衝突"
          value={analysis.adjudication.length}
          note={`${analysis.totals.fieldDifferences} 個欄位差異`}
          tone={analysis.adjudication.length ? "danger" : "default"}
        />
      </section>
      <section className="two-column">
        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">SKILL HEALTH</p>
              <h2>合規概況</h2>
            </div>
            <div className="score-ring" style={{ "--value": `${Math.max(0, 100 - totalErrors * 6)}%` } as React.CSSProperties}>
              <span>{totalErrors}</span>
              <small>不符合</small>
            </div>
          </div>
          <div className="model-health-list">
            {datasets.map((dataset) => (
              <div key={dataset.id}>
                <span className={`status-dot ${dataset.audit.errors ? "error" : "ok"}`} />
                <strong>{dataset.modelName}</strong>
                <span>{dataset.audit.errors} error</span>
                <span>{dataset.audit.warnings} warning</span>
              </div>
            ))}
          </div>
          <p className="panel-footnote">目前共有 {totalWarnings} 個提醒；CSV 的顏色與工作表檢查會標記為不適用。</p>
        </article>
        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">COMPARISON MAP</p>
              <h2>差異分布</h2>
            </div>
          </div>
          <div className="distribution">
            {VERDICT_ORDER.map((verdict) => {
                const count = analysis.refs.filter((ref) => ref.verdict === verdict).length;
                const width = analysis.totals.refs ? (count / analysis.totals.refs) * 100 : 0;
                return (
                  <div
                    className="distribution-row"
                    key={verdict}
                    tabIndex={0}
                    aria-label={`${verdictLabel(verdict)}：${verdictDescription(verdict)}`}
                  >
                    <span>
                      {verdictLabel(verdict)}
                      <i className="info-dot" aria-hidden="true">?</i>
                    </span>
                    <div className="distribution-track">
                      <i className={verdictClass(verdict)} style={{ width: `${Math.max(width, count ? 2 : 0)}%` }} />
                    </div>
                    <strong>{count}</strong>
                    <p className="distribution-tooltip" role="tooltip">
                      <b>{verdictLabel(verdict)}</b>
                      {verdictDescription(verdict)}
                    </p>
                  </div>
                );
              })}
          </div>
        </article>
      </section>
      <section className="panel principle-panel">
        <div>
          <p className="eyebrow">INTERPRETATION RULE</p>
          <h2>一致率 ≠ 正確率</h2>
        </div>
        <p>
          此工具目前衡量 Skill 合規性、覆蓋差異及模型間一致性。真正的正確率仍需以逐篇核對主文／SI 的 Gold Standard 裁決；任何單一模型獨有資料都不會直接加分。
        </p>
      </section>
    </div>
  );
}

function AuditIssueRow({ issue }: { issue: AuditIssue }) {
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(8);
  const details = issue.details || [];
  const expandable = details.length > 0 && issue.severity !== "pass";

  return (
    <div className={`audit-row ${issue.severity} ${expanded ? "expanded" : ""}`}>
      <button
        className="audit-row-summary"
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? expanded : undefined}
        onClick={() => {
          if (!expandable) return;
          setExpanded((current) => !current);
          setVisibleCount(8);
        }}
      >
        <span className="issue-icon">
          {issue.severity === "pass" ? "✓" : issue.severity === "error" ? "!" : "·"}
        </span>
        <span className="audit-row-copy">
          <strong>{issue.message}</strong>
          {issue.location && <small>{issue.location}</small>}
        </span>
        <em>{issueLabel(issue)}</em>
        {expandable && <span className="expand-indicator" aria-hidden="true">⌄</span>}
      </button>
      {expanded && (
        <div className="audit-details">
          <ol>
            {details.slice(0, visibleCount).map((detail, index) => (
              <li key={`${issue.id}-detail-${index}`}>{detail}</li>
            ))}
          </ol>
          {visibleCount < details.length && (
            <button
              className="show-more"
              type="button"
              onClick={() => setVisibleCount((current) => Math.min(current + 8, details.length))}
            >
              顯示更多（尚有 {details.length - visibleCount} 筆）
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AuditView({ datasets }: { datasets: DatasetProfile[] }) {
  const [active, setActive] = useState(datasets[0]?.id || "");
  const activeId = datasets.some((dataset) => dataset.id === active)
    ? active
    : datasets[0]?.id || "";
  const dataset = datasets.find((item) => item.id === activeId) || datasets[0];
  if (!dataset) return null;
  const grouped = dataset.audit.issues.reduce<Record<string, AuditIssue[]>>((accumulator, issue) => {
    accumulator[issue.category] = [...(accumulator[issue.category] || []), issue];
    return accumulator;
  }, {});
  const exportSkillAudit = () => {
    const rows = dataset.audit.issues.flatMap((issue) => {
      const details = issue.details?.length ? issue.details : [""];
      return details.map((detail, index) => [
        dataset.modelName,
        dataset.fileName,
        issueLabel(issue),
        issue.severity,
        issue.category,
        issue.message,
        issue.location || "",
        issue.count ?? "",
        details.length > 1 ? index + 1 : "",
        detail,
      ]);
    });
    const safeModelName = dataset.modelName.replace(/[^a-z0-9._-]+/gi, "-") || "dataset";
    downloadCsv(`${safeModelName}-skill-audit.csv`, [
      ["模型", "檔名", "結果", "嚴重度代碼", "分類", "稽核訊息", "位置", "問題數", "明細序號", "明細"],
      ...rows,
    ]);
  };
  return (
    <div className="audit-layout">
      <aside className="audit-sidebar">
        <p className="eyebrow">DATASETS</p>
        {datasets.map((item) => (
          <button key={item.id} className={item.id === activeId ? "active" : ""} onClick={() => setActive(item.id)}>
            <span className={`status-dot ${item.audit.errors ? "error" : "ok"}`} />
            <span>{item.modelName}</span>
            <strong>{item.audit.errors}</strong>
          </button>
        ))}
      </aside>
      <section className="panel audit-report">
        <div className="panel-heading audit-title">
          <div>
            <p className="eyebrow">SKILL AUDIT</p>
            <h2>{dataset.modelName}</h2>
            <span className="subtle">{dataset.fileName}</span>
          </div>
          <div className="audit-title-actions">
            <button className="button secondary compact-button" type="button" onClick={exportSkillAudit}>
              匯出 Skill 稽核結果
            </button>
            <div className="audit-counters">
              <span className="counter error">{dataset.audit.errors} 不符合</span>
              <span className="counter warning">{dataset.audit.warnings} 提醒</span>
              <span className="counter pass">{dataset.audit.passes} 通過</span>
            </div>
          </div>
        </div>
        <div className="trust-strip">
          <span>
            <i className="cell-swatch red" /> 紅格 {dataset.audit.redCells}
          </span>
          <span>
            <i className="cell-swatch black" /> 黑格 {dataset.audit.blackCells}
          </span>
          <span>主表：{dataset.mainSheetName || "未辨識"}</span>
          <span>{dataset.sheetNames.length} 個工作表</span>
        </div>
        {Object.entries(grouped).map(([category, issues]) => (
          <div className="audit-group" key={category}>
            <h3>{category}</h3>
            {issues.map((issue) => (
              <AuditIssueRow issue={issue} key={issue.id} />
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}

function RefDetail({
  comparison,
  onOpenQueue,
}: {
  comparison: RefComparison;
  onOpenQueue: (ref: number) => void;
}) {
  return (
    <div className="ref-detail">
      <div className="ref-detail-heading">
        <div>
          <p className="eyebrow">{comparison.sourceGroup}</p>
          <h3>Ref {comparison.ref}</h3>
        </div>
        <div className="ref-detail-actions">
          <span className={`verdict ${verdictClass(comparison.verdict)}`}>{verdictLabel(comparison.verdict)}</span>
          <button className="button secondary compact-button" type="button" onClick={() => onOpenQueue(comparison.ref)}>
            前往裁決 Ref {comparison.ref}
          </button>
        </div>
      </div>
      {comparison.validationErrors.length > 0 && (
        <div className="record-error-panel">
          <h4>資料錯誤</h4>
          <p>以下內容違反可客觀檢查的 Skill 規則；這是資料本身的錯誤，不只是模型間的差異。</p>
          <div className="record-error-list">
            {comparison.validationErrors.map((item) => (
              <article key={`${item.datasetId}-${item.recordId}`}>
                <strong>{item.modelName} · 第 {item.rowNumber} 列 · {item.refLabel || `Ref ${comparison.ref}`}</strong>
                <ul>
                  {item.errors.map((error) => <li key={error}>{error}</li>)}
                </ul>
              </article>
            ))}
          </div>
        </div>
      )}
      <div className="model-state-grid">
        {comparison.modelStates.map((state) => (
          <article key={state.datasetId}>
            <span>{state.modelName}</span>
            <strong>{coverageLabel(state.state)}</strong>
            <small>{state.records.length} 資料點</small>
            <p>{state.doi.join("、") || state.detail || "無補充資訊"}</p>
          </article>
        ))}
      </div>
      <div className="cluster-list">
        {comparison.clusters.length ? (
          comparison.clusters.map((cluster) => (
            <article className="cluster" key={cluster.id}>
              <div className="cluster-title">
                <div>
                  <span className={`match-type ${cluster.matchType}`}>{cluster.matchType}</span>
                  <strong>{cluster.label}</strong>
                </div>
                <span>{cluster.differences.length} 欄差異</span>
              </div>
              <div className="cluster-records">
                {cluster.records.map((record) => (
                  <div key={record.id}>
                    <strong>{comparison.modelStates.find((state) => state.datasetId === record.datasetId)?.modelName}</strong>
                    <span>{record.refLabel}</span>
                    <span>PCE {String(record.pce || "—")}</span>
                  </div>
                ))}
              </div>
              {cluster.differences.length > 0 && (
                <div className="difference-list">
                  {cluster.differences.map((difference) => (
                    <div key={difference.field}>
                      <strong className={difference.kind === "critical" ? "text-error" : ""}>{difference.field}</strong>
                      <span>
                        {difference.values.map((value) => `${value.model}: ${value.value || "∅"}`).join(" ｜ ")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))
        ) : (
          <p className="empty-note">這個 ref 沒有主表資料點；請查看各模型的進度追蹤狀態。</p>
        )}
      </div>
    </div>
  );
}

function RefView({
  analysis,
  onOpenQueue,
  viewState,
  setViewState,
}: {
  analysis: ReturnType<typeof buildComparison>;
  onOpenQueue: (ref: number) => void;
  viewState: RefViewState;
  setViewState: Dispatch<SetStateAction<RefViewState>>;
}) {
  const { source, verdict, search, selected } = viewState;
  const filtered = analysis.refs.filter((ref) => {
    if (source !== "all" && ref.sourceGroup !== source) return false;
    if (verdict !== "all" && ref.verdict !== verdict) return false;
    if (search && ref.ref !== Number(search)) return false;
    return true;
  });
  return (
    <div className="section-stack">
      <section className="filter-bar">
        <label>
          <span>來源</span>
          <select
            value={source}
            onChange={(event) => {
              setViewState((current) => ({ ...current, source: event.target.value, selected: "" }));
            }}
          >
            <option value="all">全部來源</option>
            {analysis.sourceGroups.map((group) => (
              <option key={group}>{group}</option>
            ))}
          </select>
        </label>
        <label>
          <span>判定</span>
          <select
            value={verdict}
            onChange={(event) => {
              setViewState((current) => ({ ...current, verdict: event.target.value, selected: "" }));
            }}
          >
            <option value="all">全部判定</option>
            <option value="invalid_data">錯誤</option>
            <option value="agree">一致</option>
            <option value="all_excluded">皆已排除</option>
            <option value="all_unrecorded">皆未收錄</option>
            <option value="blocked_included_gap">受阻／已收錄</option>
            <option value="field_conflict">欄位差異</option>
            <option value="record_gap">資料點缺漏</option>
            <option value="inclusion_conflict">收錄衝突</option>
            <option value="doi_conflict">DOI 衝突</option>
            <option value="not_comparable">不可比較</option>
          </select>
        </label>
        <label className="search-field">
          <span>Ref 編號</span>
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={search}
            onChange={(event) => {
              setViewState((current) => ({
                ...current,
                search: event.target.value.replace(/\D/g, ""),
                selected: "",
              }));
            }}
            placeholder="精準輸入，例如 63"
          />
        </label>
        <span className="result-count">{filtered.length} refs</span>
      </section>
      <section className="match-legend" aria-label="資料點配對等級說明">
        <strong>資料點配對等級</strong>
        <div>
          <span className="match-type exact">Exact</span>
          <p>至少兩個模型已配對，且所有比較欄位經格式正規化與數值容差後皆一致（0 欄差異）。</p>
        </div>
        <div>
          <span className="match-type probable">Probable</span>
          <p>依 Ref、分子、PCE 等資訊判斷高機率為同一資料點，但仍有缺值、名稱或欄位數值差異，需人工確認。</p>
        </div>
        <div>
          <span className="match-type single">Single</span>
          <p>此配對群組只有一個模型收錄，尚無其他模型的對應資料點可比較。</p>
        </div>
        <small>等級只描述模型輸出的配對與一致程度，不代表資料已經原始論文／SI 驗證為正確。</small>
      </section>
      <section className="panel table-panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>來源／Ref</th>
                <th>模型狀態</th>
                <th>DOI</th>
                <th>資料點</th>
                <th>欄位差異</th>
                <th>判定</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((comparison) => (
                <Fragment key={comparison.id}>
                  <tr
                    id={`ref-row-${comparison.ref}`}
                    className={selected === comparison.id ? "selected" : ""}
                    onClick={() => setViewState((current) => ({
                      ...current,
                      selected: current.selected === comparison.id ? "" : comparison.id,
                    }))}
                    aria-expanded={selected === comparison.id}
                  >
                    <td>
                      <span className="source-label">{comparison.sourceGroup}</span>
                      <strong>Ref {comparison.ref}</strong>
                    </td>
                    <td>
                      <div className="state-pills">
                        {comparison.modelStates.map((state) => (
                          <span key={state.datasetId} className={state.state}>
                            {state.modelName}: {coverageLabel(state.state)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="doi-cell">{comparison.doiValues.join("、") || "—"}</td>
                    <td>{comparison.clusters.length}</td>
                    <td>{comparison.fieldDifferenceCount}</td>
                    <td>
                      <span className={`verdict ${verdictClass(comparison.verdict)}`}>{verdictLabel(comparison.verdict)}</span>
                    </td>
                  </tr>
                  {selected === comparison.id && (
                    <tr className="ref-detail-row">
                      <td colSpan={6}>
                        <RefDetail comparison={comparison} onOpenQueue={onOpenQueue} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && <p className="empty-note">沒有符合目前篩選條件的 ref。</p>}
      </section>
    </div>
  );
}

function QueueView({
  items,
  decisions,
  setDecision,
  refSearch,
  setRefSearch,
  onBackToRefs,
}: {
  items: AdjudicationItem[];
  decisions: Record<string, Decision>;
  setDecision: (id: string, patch: Partial<Decision>) => void;
  refSearch: string;
  setRefSearch: (value: string) => void;
  onBackToRefs: () => void;
}) {
  const [showResolved, setShowResolved] = useState(true);
  const visible = items.filter((item) => {
    if (refSearch && item.ref !== Number(refSearch)) return false;
    return showResolved || !decisions[item.id] || decisions[item.id].status === "待查核";
  });
  return (
    <div className="section-stack">
      <section className="queue-intro" id="adjudication-queue">
        <div>
          <p className="eyebrow">ADJUDICATION</p>
          <h2>不以多數決取代證據</h2>
          <p>模型獨有、收錄衝突、DOI 錯配與關鍵欄位不一致都留在這裡，等主文／SI 核驗後再決定。</p>
        </div>
        <div className="queue-controls">
          <button className="button secondary compact-button" type="button" onClick={onBackToRefs}>
            返回 Ref 比較
          </button>
          <label className="queue-ref-search">
            <span>依 Ref 精準查找</span>
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              value={refSearch}
              onChange={(event) => setRefSearch(event.target.value.replace(/\D/g, ""))}
              placeholder="例如 27"
            />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} />
            <span />
            顯示已裁決
          </label>
          <small>{visible.length} 個裁決項目</small>
        </div>
      </section>
      <section className="queue-list">
        {visible.map((item, index) => {
          const decision = decisions[item.id] || { status: "待查核", note: "" };
          return (
            <article className={`queue-item ${item.severity}`} key={item.id}>
              <div className="queue-number">{String(index + 1).padStart(2, "0")}</div>
              <div className="queue-content">
                <div className="queue-title">
                  <div>
                    <span>{item.sourceGroup} · Ref {item.ref}</span>
                    <h3>{item.title}</h3>
                  </div>
                  <span className={`priority ${item.severity}`}>{item.severity === "critical" ? "關鍵" : "需查核"}</span>
                </div>
                <p>{item.detail}</p>
                <div className="model-tags">{[...new Set(item.models)].map((model) => <span key={model}>{model}</span>)}</div>
                <div className="decision-row">
                  <label>
                    <span>裁決</span>
                    <select value={decision.status} onChange={(event) => setDecision(item.id, { status: event.target.value })}>
                      {DECISION_OPTIONS.map((option) => <option key={option}>{option}</option>)}
                    </select>
                  </label>
                  <label className="decision-note">
                    <span>依據／備註</span>
                    <input
                      value={decision.note}
                      onChange={(event) => setDecision(item.id, { note: event.target.value })}
                      placeholder="例如：核對 SI Table S4，確認 control 應收錄"
                    />
                  </label>
                </div>
              </div>
            </article>
          );
        })}
        {!visible.length && (
          <p className="empty-note panel">
            {refSearch ? `Ref ${refSearch} 目前沒有符合條件的裁決項目。` : "目前沒有待顯示的裁決項目。"}
          </p>
        )}
      </section>
    </div>
  );
}

export default function Home() {
  const [datasets, setDatasets] = useState<DatasetProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [queueRefSearch, setQueueRefSearch] = useState("");
  const [refViewState, setRefViewState] = useState<RefViewState>({
    source: "all",
    verdict: "all",
    search: "",
    selected: "",
  });
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const stored = localStorage.getItem("sam-comparator-decisions");
      return stored ? (JSON.parse(stored) as Record<string, Decision>) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("sam-comparator-decisions", JSON.stringify(decisions));
    } catch {
      // Private browsing may block storage; the in-memory decision still works.
    }
  }, [decisions]);

  const analysis = useMemo(() => buildComparison(datasets), [datasets]);

  const handleFiles = async (incoming: File[]) => {
    const accepted = incoming.filter((file) => /\.(xlsx|xlsm|csv|tsv)$/i.test(file.name));
    if (!accepted.length) {
      setLoadError("請選擇 .xlsx、.xlsm、.csv 或 .tsv 檔案。");
      return;
    }
    setLoading(true);
    setLoadError("");
    try {
      const parsed = await Promise.all(accepted.map((file, index) => parseDataset(file, datasets.length + index)));
      setDatasets((current) => [...current, ...parsed]);
    } catch (error) {
      setLoadError(error instanceof Error ? `讀取失敗：${error.message}` : "讀取檔案時發生未知錯誤。");
    } finally {
      setLoading(false);
    }
  };

  const updateDataset = (id: string, patch: Partial<DatasetProfile>) => {
    setDatasets((current) =>
      current.map((dataset) => {
        if (patch.sourceGroup !== undefined) {
          return { ...dataset, sourceGroup: patch.sourceGroup };
        }
        return dataset.id === id ? { ...dataset, ...patch } : dataset;
      }),
    );
  };

  const setDecision = (id: string, patch: Partial<Decision>) => {
    setDecisions((current) => {
      const previous = current[id] || { status: "待查核", note: "" };
      return {
        ...current,
        [id]: { ...previous, ...patch },
      };
    });
  };

  const openQueueForRef = (ref: number) => {
    setQueueRefSearch(String(ref));
    setTab("queue");
    window.setTimeout(() => {
      document.getElementById("adjudication-queue")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 0);
  };

  const returnToRefComparison = () => {
    const selectedRef = analysis.refs.find((item) => item.id === refViewState.selected)?.ref;
    setTab("refs");
    window.setTimeout(() => {
      const targetRef = selectedRef ?? (refViewState.search ? Number(refViewState.search) : null);
      if (targetRef !== null) {
        document.getElementById(`ref-row-${targetRef}`)?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
    }, 0);
  };

  const exportRefSummary = () => {
    downloadCsv("ref-comparison-summary.csv", [
      ["來源群組", "Ref", "判定", "DOI", "資料點群數", "欄位差異數", ...datasets.map((dataset) => dataset.modelName)],
      ...analysis.refs.map((ref) => [
        ref.sourceGroup,
        ref.ref,
        verdictLabel(ref.verdict),
        ref.doiValues.join(" | "),
        ref.clusters.length,
        ref.fieldDifferenceCount,
        ...datasets.map((dataset) => {
          const state = ref.modelStates.find((item) => item.datasetId === dataset.id);
          return state ? `${coverageLabel(state.state)} (${state.records.length})` : "不在此來源群組";
        }),
      ]),
    ]);
  };

  const exportQueue = () => {
    downloadCsv("adjudication-queue.csv", [
      ["來源群組", "Ref", "衝突類型", "嚴重度", "標題", "細節", "模型", "裁決", "依據／備註"],
      ...analysis.adjudication.map((item) => [
        item.sourceGroup,
        item.ref,
        item.type,
        item.severity,
        item.title,
        item.detail,
        [...new Set(item.models)].join(" | "),
        decisions[item.id]?.status || "待查核",
        decisions[item.id]?.note || "",
      ]),
    ]);
  };

  const exportRecordGaps = () => {
    const rows = analysis.adjudication
      .filter((item) => item.type === "RECORD_GAP")
      .map((item) => {
        const comparison = analysis.refs.find(
          (ref) => ref.sourceGroup === item.sourceGroup && ref.ref === item.ref,
        );
        const cluster = comparison?.clusters.find((candidate) => `${candidate.id}-gap` === item.id);
        const presentIds = new Set(cluster?.modelIds ?? []);
        const missingModels = comparison?.modelStates
          .filter((state) => state.state !== "not_evaluated" && !presentIds.has(state.datasetId))
          .map((state) => state.modelName) ?? [];
        const presentRecords = cluster?.records.map((record) => {
          const model = datasets.find((dataset) => dataset.id === record.datasetId)?.modelName || record.datasetId;
          return `${model}: ${record.refLabel} (PCE ${String(record.pce || "∅")})`;
        }) ?? [];
        return [
          item.sourceGroup,
          item.ref,
          cluster?.label || item.title,
          cluster?.matchType || "single",
          presentRecords.join(" | "),
          missingModels.join(" | "),
          item.detail,
        ];
      });
    downloadCsv("record-gaps.csv", [
      ["來源群組", "Ref", "資料點", "配對等級", "已收錄資料列與 PCE", "未收錄模型", "缺漏摘要"],
      ...rows,
    ]);
  };

  const exportFieldDifferences = () => {
    const rows = analysis.refs.flatMap((ref) =>
      ref.clusters.flatMap((cluster) =>
        cluster.differences.map((difference) => [
          ref.sourceGroup,
          ref.ref,
          cluster.label,
          cluster.matchType,
          difference.field,
          { critical: "關鍵欄位", missing: "一方缺值", value: "欄位值不同" }[difference.kind],
          cluster.records.map((record) => record.refLabel).join(" | "),
          ...datasets.map((dataset) =>
            difference.values.find((value) => value.model === dataset.modelName)?.value || "∅",
          ),
        ]),
      ),
    );
    downloadCsv("field-differences.csv", [
      ["來源群組", "Ref", "資料點", "配對等級", "差異欄位", "差異類型", "資料列", ...datasets.map((dataset) => dataset.modelName)],
      ...rows,
    ]);
  };

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="SAM Compare 首頁">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>
            SAM <strong>COMPARE</strong>
          </span>
        </a>
        <div className="header-meta">
          <span>LOCAL / PRIVATE</span>
          <span>SKILL CONTRACT · 2026-08-10</span>
        </div>
      </header>

      <div id="top" className="page-shell">
        {!datasets.length ? (
          <EmptyState onFiles={handleFiles} loading={loading} />
        ) : (
          <>
            <section className="workspace-heading">
              <div>
                <p className="eyebrow">COMPARISON WORKSPACE</p>
                <h1>多模型擷取差異分析</h1>
                <p>已載入 {datasets.length} 份檔案；修改模型名稱或來源群組後會立即重新配對。</p>
              </div>
              <div className="workspace-actions">
                <button className="button secondary" type="button" onClick={exportRefSummary}>匯出 Ref 摘要</button>
                <button className="button secondary" type="button" onClick={exportRecordGaps} disabled={!analysis.adjudication.some((item) => item.type === "RECORD_GAP")}>匯出資料點缺漏</button>
                <button className="button secondary" type="button" onClick={exportFieldDifferences} disabled={!analysis.totals.fieldDifferences}>匯出欄位差異</button>
                <button className="button primary" type="button" onClick={exportQueue}>匯出裁決佇列</button>
              </div>
            </section>

            <section className="dataset-strip">
              {datasets.map((dataset) => (
                <DatasetCard
                  key={dataset.id}
                  dataset={dataset}
                  onUpdate={(patch) => updateDataset(dataset.id, patch)}
                  onRemove={() => setDatasets((current) => current.filter((item) => item.id !== dataset.id))}
                />
              ))}
              <UploadPanel onFiles={handleFiles} loading={loading} compact />
            </section>

            <nav className="tabs" aria-label="分析頁籤">
              {[
                ["overview", "總覽", analysis.totals.conflicts],
                ["audit", "Skill 稽核", datasets.reduce((sum, dataset) => sum + dataset.audit.errors, 0)],
                ["refs", "Ref 比較", analysis.totals.refs],
                ["queue", "裁決佇列", analysis.adjudication.length],
              ].map(([value, label, count]) => (
                <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value as Tab)}>
                  {label}<span>{count}</span>
                </button>
              ))}
            </nav>

            {tab === "overview" && <Overview datasets={datasets} analysis={analysis} />}
            {tab === "audit" && <AuditView datasets={datasets} />}
            {tab === "refs" && (
              <RefView
                analysis={analysis}
                onOpenQueue={openQueueForRef}
                viewState={refViewState}
                setViewState={setRefViewState}
              />
            )}
            {tab === "queue" && (
              <QueueView
                items={analysis.adjudication}
                decisions={decisions}
                setDecision={setDecision}
                refSearch={queueRefSearch}
                setRefSearch={setQueueRefSearch}
                onBackToRefs={returnToRefComparison}
              />
            )}
          </>
        )}
        {loadError && <div className="toast" role="alert">{loadError}<button onClick={() => setLoadError("")}>×</button></div>}
      </div>
      <footer>
        <span>SAM DATASET QUALITY CONTROL</span>
        <p>本工具的「一致」只代表模型輸出相符；正確率需由主文／SI 的 Gold Standard 驗證。</p>
      </footer>
    </main>
  );
}
