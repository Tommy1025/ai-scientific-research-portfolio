import assert from "node:assert/strict";
import { File } from "node:buffer";
import test from "node:test";
import * as XLSX from "xlsx";

globalThis.XLSX = XLSX;

const { SAM_COLUMNS, buildComparison, normalizeDoi, parseDataset } = await import("../lib/sam.ts");

const row = {
  編號: "1-2PACz(champion)",
  "SAM/HTL材料名稱": "2PACz",
  smile: "C",
  NiO2: 0,
  ethanol: 1,
  toluene: 0,
  IPA: 0,
  THF: 0,
  chlorobenzene: 0,
  "2-Methoxyethanol": 0,
  CH2CL2: 0,
  "concentration(mg/ml)": 1,
  wash: 1,
  E: 0.1,
  Cs: 0,
  FA: 1,
  MA: 0,
  Pb: 1,
  Sn: 0,
  I: 1,
  Br: 0,
  CL: 0,
  C60: 1,
  BCP: 1,
  PC60BM: 0,
  PCBM: 0,
  PC61BM: 0,
  PEAI: 0,
  "ALD-SnO2": 0,
  PCE: 20,
  Reference_DOI: "10.1000/example",
  Ref_author: "Example et al.",
  Ref_journal: "Example Journal",
  Data_status: "完整(全文+SI)",
  Notes: "",
};

const csv = [
  SAM_COLUMNS.join(","),
  SAM_COLUMNS.map((column) => row[column] ?? "").join(","),
].join("\r\n");

test("parses CSV and marks color checks as not applicable", async () => {
  const profile = await parseDataset(
    new File([csv], "2026_Test_ref1_Model-A.csv"),
    0,
  );
  assert.equal(profile.incompatible, false);
  assert.equal(profile.fileType, "csv");
  assert.equal(profile.records.length, 1);
  assert.equal(profile.records[0].ref, 1);
  assert.equal(profile.audit.notApplicable, 3);
});

test("compares more than two model outputs in one source group", async () => {
  const first = await parseDataset(
    new File([csv], "2026_Test_ref1_Model-A.csv"),
    0,
  );
  const copies = ["Model-B", "Model-C"].map((modelName, index) => {
    const id = `copy-${index}`;
    return {
      ...first,
      id,
      modelName,
      records: first.records.map((record) => ({
        ...record,
        id: `${id}-row`,
        datasetId: id,
      })),
    };
  });
  const analysis = buildComparison([first, ...copies]);
  assert.equal(analysis.totals.comparableRefs, 1);
  assert.equal(analysis.totals.agreedRefs, 1);
  assert.equal(analysis.refs[0].clusters[0].records.length, 3);
});

test("normalizes DOI URLs, hidden characters, and trailing punctuation", () => {
  assert.equal(
    normalizeDoi(" https://doi.org/10.1126/science.abd4016\u200B. "),
    "10.1126/science.abd4016",
  );
  assert.equal(
    normalizeDoi("DOI: 10.1002%2Faenm.201801892"),
    "10.1002/aenm.201801892",
  );
});

test("uses progress headers instead of treating status text as a DOI", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([row], { header: SAM_COLUMNS }), "主表");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Ref", "狀態", "已寫入主表", "備註"],
      [1, "done-已擷取", 1, "已完成稽核"],
    ]),
    "進度追蹤",
  );
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const profile = await parseDataset(
    new File([bytes], "2026_Test_ref1_Model-A.xlsx"),
    0,
  );
  assert.equal(profile.progress[0].doi, "");
  assert.equal(profile.progress[0].status, "done-已擷取");
  assert.equal(profile.progress[0].detail, "已完成稽核");
});

test("keeps concrete Skill issue details for expandable audit rows", async () => {
  const invalidRow = { ...row, NiO2: 2 };
  const invalidCsv = [
    SAM_COLUMNS.join(","),
    SAM_COLUMNS.map((column) => invalidRow[column] ?? "").join(","),
  ].join("\r\n");
  const profile = await parseDataset(
    new File([invalidCsv], "2026_Test_ref1_Model-A.csv"),
    0,
  );
  const issue = profile.audit.issues.find((item) => item.message.includes("真正二元欄"));
  assert.ok(issue);
  assert.match(issue.details[0], /第 2 列 NiO2=2/);

  const validProfile = await parseDataset(
    new File([csv], "2026_Test_ref1_Model-B.csv"),
    1,
  );
  const analysis = buildComparison([profile, validProfile]);
  assert.equal(analysis.refs[0].verdict, "invalid_data");
  assert.match(analysis.refs[0].validationErrors[0].errors.join(" "), /NiO2/);
  assert.ok(analysis.adjudication.some((item) => item.type === "DATA_ERROR"));
});

test("accepts mixed-solvent fractions that sum to one", async () => {
  const mixedRow = {
    ...row,
    ethanol: 0.6,
    THF: 0.4,
  };
  const mixedCsv = [
    SAM_COLUMNS.join(","),
    SAM_COLUMNS.map((column) => mixedRow[column] ?? "").join(","),
  ].join("\r\n");
  const profile = await parseDataset(
    new File([mixedCsv], "2026_Test_ref27_Model-A.csv"),
    0,
  );
  assert.equal(profile.records[0].validationErrors.length, 0);
  const binaryIssue = profile.audit.issues.find((item) => item.message.includes("真正二元欄"));
  const solventRangeIssue = profile.audit.issues.find((item) => item.message.includes("超出 0–1"));
  const solventSumIssue = profile.audit.issues.find((item) => item.message.includes("溶劑比例加總"));
  assert.equal(binaryIssue.severity, "pass");
  assert.equal(solventRangeIssue.severity, "pass");
  assert.equal(solventSumIssue.severity, "pass");
});

test("flags a complete solvent vector whose fractions do not sum to one", async () => {
  const hiddenSolventRow = {
    ...row,
    ethanol: 0.6,
    THF: 0.3,
  };
  const hiddenSolventCsv = [
    SAM_COLUMNS.join(","),
    SAM_COLUMNS.map((column) => hiddenSolventRow[column] ?? "").join(","),
  ].join("\r\n");
  const profile = await parseDataset(
    new File([hiddenSolventCsv], "2026_Test_ref27_Model-A.csv"),
    0,
  );
  const solventSumIssue = profile.audit.issues.find((item) => item.message.includes("溶劑比例加總"));
  assert.equal(solventSumIssue.severity, "error");
  assert.match(solventSumIssue.details[0], /溶劑總和=0\.900000/);
  assert.match(profile.records[0].validationErrors.join(" "), /溶劑比例總和不等於 1/);
});

test("does not require all-black features for partially available paid-wall rows", async () => {
  const workbook = XLSX.utils.book_new();
  const partialRow = {
    ...row,
    編號: "24-2PACz(partial)",
    E: "",
    Data_status: "部分(摘要+SI；正文付費牆)；缺:E",
  };
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([partialRow], { header: SAM_COLUMNS }),
    "主表",
  );
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const profile = await parseDataset(
    new File([bytes], "2026_Test_ref24_GPT.xlsx"),
    0,
  );
  const blackIssue = profile.audit.issues.find((item) =>
    item.message.includes("黑列的 26 特徵"),
  );
  assert.ok(blackIssue);
  assert.equal(blackIssue.severity, "pass");
  assert.equal(profile.records[0].validationErrors.length, 0);
});

test("accepts a complete source status when missing E is explicitly declared", async () => {
  const workbook = XLSX.utils.book_new();
  const declaredMissingRow = {
    ...row,
    編號: "105-NiOx/Me-4PACz(control)",
    E: "",
    Data_status: "完整(全文OA+SI)；缺:E",
  };
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([declaredMissingRow], { header: SAM_COLUMNS }),
    "主表",
  );
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const profile = await parseDataset(
    new File([bytes], "2026_Test_ref105_GPT.xlsx"),
    0,
  );
  const trackingIssue = profile.audit.issues.find((item) => item.category === "追蹤性");
  assert.ok(trackingIssue);
  assert.equal(trackingIssue.severity, "pass");
  assert.equal(trackingIssue.count, 0);
});

test("reports an actually missing feature that Data_status does not declare", async () => {
  const workbook = XLSX.utils.book_new();
  const undeclaredMissingRow = {
    ...row,
    E: "",
    Data_status: "完整(全文OA+SI)",
  };
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([undeclaredMissingRow], { header: SAM_COLUMNS }),
    "主表",
  );
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const profile = await parseDataset(
    new File([bytes], "2026_Test_ref105_GPT.xlsx"),
    0,
  );
  const trackingIssue = profile.audit.issues.find((item) => item.category === "追蹤性");
  assert.ok(trackingIssue);
  assert.equal(trackingIssue.severity, "error");
  assert.match(trackingIssue.details[0], /E.*Data_status 未記錄缺值/);
});

test("classifies an invalid solvent total and SMILES as objective data errors", async () => {
  const invalidRow = {
    ...row,
    ethanol: 0.6,
    THF: 0.3,
    smile: "C((",
  };
  const invalidCsv = [
    SAM_COLUMNS.join(","),
    SAM_COLUMNS.map((column) => invalidRow[column] ?? "").join(","),
  ].join("\r\n");
  const invalidProfile = await parseDataset(
    new File([invalidCsv], "2026_Test_ref1_Model-A.csv"),
    0,
  );
  const validProfile = await parseDataset(
    new File([csv], "2026_Test_ref1_Model-B.csv"),
    1,
  );
  const analysis = buildComparison([invalidProfile, validProfile]);
  const errors = analysis.refs[0].validationErrors[0].errors.join(" ");
  assert.equal(analysis.refs[0].verdict, "invalid_data");
  assert.match(errors, /溶劑比例總和/);
  assert.match(errors, /SMILES/);
});

test("does not force A-site or B-site values to sum to one", async () => {
  const originalBasisRow = {
    ...row,
    Cs: 0.8,
    FA: 0.8,
    MA: 0,
    Pb: 0.7,
    Sn: 0.1,
  };
  const originalBasisCsv = [
    SAM_COLUMNS.join(","),
    SAM_COLUMNS.map((column) => originalBasisRow[column] ?? "").join(","),
  ].join("\r\n");
  const profile = await parseDataset(
    new File([originalBasisCsv], "2026_Test_ref1_Model-A.csv"),
    0,
  );
  assert.equal(profile.records[0].validationErrors.length, 0);
});

test("classifies all-excluded, all-unrecorded, and blocked-vs-included separately", async () => {
  const base = await parseDataset(
    new File([csv], "2026_Test_ref1_Model-A.csv"),
    0,
  );
  const copy = (id, modelName, patch = {}) => ({
    ...base,
    id,
    modelName,
    records: base.records.map((record) => ({
      ...record,
      id: `${id}-row`,
      datasetId: id,
    })),
    ...patch,
  });

  const excluded = buildComparison([
    copy("excluded-a", "Model-A", { records: [], excludedRefs: [1] }),
    copy("excluded-b", "Model-B", { records: [], excludedRefs: [1] }),
  ]);
  assert.equal(excluded.refs[0].verdict, "all_excluded");

  const unrecorded = buildComparison([
    copy("missing-a", "Model-A", { records: [], excludedRefs: [], progress: [] }),
    copy("missing-b", "Model-B", { records: [], excludedRefs: [], progress: [] }),
  ]);
  assert.equal(unrecorded.refs[0].verdict, "all_unrecorded");

  const blocked = copy("blocked", "Model-B");
  blocked.records[0].status = "無法讀取(付費牆)";
  const blockedIncluded = buildComparison([copy("included", "Model-A"), blocked]);
  assert.equal(blockedIncluded.refs[0].verdict, "blocked_included_gap");

  const sameReview = buildComparison([
    copy("review-a", "Model-A", { sourceGroup: "Review 名稱 A" }),
    copy("review-b", "Model-B", { sourceGroup: "另一種檔名解析結果" }),
  ]);
  assert.equal(sameReview.sourceGroups.length, 1);
  assert.equal(sameReview.refs[0].clusters[0].records.length, 2);
});

test("accepts rounded composition values as equivalent", async () => {
  const base = await parseDataset(
    new File([csv], "2026_Test_ref1_Model-A.csv"),
    0,
  );
  const makeProfile = (id, modelName, cs, fa) => ({
    ...base,
    id,
    modelName,
    records: base.records.map((record) => ({
      ...record,
      id: `${id}-row`,
      datasetId: id,
      values: { ...record.values, Cs: cs, FA: fa },
    })),
  });
  const analysis = buildComparison([
    makeProfile("rounded-a", "Model-A", 0.3, 0.6),
    makeProfile("rounded-b", "Model-B", 0.33135, 0.6666667),
  ]);
  assert.equal(analysis.refs[0].verdict, "agree");
  assert.equal(analysis.refs[0].fieldDifferenceCount, 0);
  assert.equal(analysis.refs[0].clusters[0].matchType, "exact");
});

test("does not label a paired record Exact when E is missing in one model", async () => {
  const base = await parseDataset(
    new File([csv], "2026_Test_ref113_Model-A.csv"),
    0,
  );
  const makeProfile = (id, modelName, energy) => ({
    ...base,
    id,
    modelName,
    records: base.records.map((record) => ({
      ...record,
      id: `${id}-row`,
      datasetId: id,
      values: { ...record.values, E: energy },
    })),
  });
  const analysis = buildComparison([
    makeProfile("energy-a", "Fable-5", 0.51),
    makeProfile("energy-b", "GPT-5.6-sol", ""),
  ]);
  const cluster = analysis.refs[0].clusters[0];
  assert.equal(cluster.matchType, "probable");
  assert.deepEqual(cluster.differences.map((difference) => difference.field), ["E"]);
});

test("matches same-ref records by molecule base name and PCE as probable", async () => {
  const base = await parseDataset(
    new File([csv], "2026_Test_ref27_Model-A.csv"),
    0,
  );
  const makeRecord = (datasetId, suffix, refLabel, material, pce) => {
    const smiles = material.startsWith("MeO") ? "MEO-SMILES" : "MPA-SMILES";
    return {
      ...base.records[0],
      id: `${datasetId}-${suffix}`,
      datasetId,
      ref: 27,
      refLabel,
      material,
      smiles,
      pce,
      values: {
        ...base.records[0].values,
        編號: refLabel,
        "SAM/HTL材料名稱": material,
        smile: smiles,
        PCE: pce,
      },
    };
  };
  const first = {
    ...base,
    id: "probable-a",
    modelName: "Model-A",
    declaredRange: { start: 27, end: 27 },
    records: [
      makeRecord("probable-a", "meo", "27-MeO-2PACz(CsFAMA,champion)", "MeO-2PACz(CsFAMA,champion)", 21.29),
      makeRecord("probable-a", "mpa", "27-MPA-Ph-CA(CsFAMA,champion)", "MPA-Ph-CA(CsFAMA,champion)", 22.53),
      makeRecord("probable-a", "map", "27-MPA-Ph-CA(MAPbI3)", "MPA-Ph-CA(MAPbI3)", 21),
    ],
  };
  const second = {
    ...base,
    id: "probable-b",
    modelName: "Model-B",
    declaredRange: { start: 27, end: 27 },
    records: [
      makeRecord("probable-b", "meo", "27-MeO-2PACz(control)", "MeO-2PACz(control)", 21.29),
      makeRecord("probable-b", "mpa", "27-MPA-Ph-CA(champion)", "MPA-Ph-CA(champion)", 22.53),
      makeRecord("probable-b", "map", "27-MPA-Ph-CA(MAPbI3,champion)", "MPA-Ph-CA(MAPbI3,champion)", 21.14),
    ],
  };
  const analysis = buildComparison([first, second]);
  assert.equal(analysis.refs[0].clusters.length, 3);
  assert.ok(
    analysis.refs[0].clusters.every((cluster) => cluster.matchType === "probable"),
    JSON.stringify(
      analysis.refs[0].clusters.map((cluster) => ({
        matchType: cluster.matchType,
        labels: cluster.records.map((record) => record.refLabel),
      })),
    ),
  );
  assert.ok(analysis.refs[0].clusters.every((cluster) => cluster.records.length === 2));
  assert.notEqual(analysis.refs[0].verdict, "record_gap");
});
