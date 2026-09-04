import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("renders the SAM comparison workspace", async () => {
  const html = await readFile(
    new URL("../.next/server/app/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /<title>SAM Compare/);
  assert.match(html, /SAM.*COMPARE/);
  assert.match(html, /先驗規則/);
  assert.match(html, /檔案不離開瀏覽器/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("keeps multi-file and local-only comparison in the product source", async () => {
  const [page, parser, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/sam.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /multiple/);
  assert.match(page, /parseDataset/);
  assert.match(page, /裁決佇列/);
  assert.match(page, /顯示更多/);
  assert.match(page, /verdictDescription/);
  assert.match(page, /ref-detail-row/);
  assert.match(page, /ref\.ref !== Number\(search\)/);
  assert.match(page, /依 Ref 精準查找/);
  assert.match(page, /資料點配對等級/);
  assert.match(page, /所有比較欄位.*0 欄差異/);
  assert.match(page, /Probable/);
  assert.match(page, /Single/);
  assert.match(page, /openQueueForRef/);
  assert.match(page, /exportRecordGaps/);
  assert.match(page, /record-gaps\.csv/);
  assert.match(page, /exportFieldDifferences/);
  assert.match(page, /field-differences\.csv/);
  assert.match(page, /refViewState/);
  assert.match(page, /returnToRefComparison/);
  assert.match(page, /返回 Ref 比較/);
  assert.match(page, /exportSkillAudit/);
  assert.match(page, /skill-audit\.csv/);
  assert.match(page, /匯出 Skill 稽核結果/);
  assert.match(page, /SKILL CONTRACT · 2026-08-10/);
  assert.match(page, /localStorage/);
  assert.match(parser, /RECORD_GAP/);
  assert.match(parser, /DOI_CONFLICT/);
  assert.match(parser, /BLOCKED_INCLUDED_GAP/);
  assert.match(parser, /all_unrecorded/);
  assert.match(parser, /cellStyles:\s*true/);
  assert.match(layout, /lang="zh-Hant"/);
});
