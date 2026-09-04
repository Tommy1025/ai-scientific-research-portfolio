import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { hasPdfMagic, parsePdfBuffer } from '../src/pdf.js';

async function fixturePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Sample article DOI 10.1234/ABC.9', { x:50, y:740, size:12, font });
  page.drawText('References', { x:50, y:700, size:12, font });
  page.drawText('[1] Chen, A. A long reference title. Journal 2020. doi:10.1000/ref1', { x:50, y:680, size:9, font });
  return Buffer.from(await doc.save());
}

test('合成 PDF 通過 magic bytes、頁數與 DOI 擷取', async () => {
  const buffer = await fixturePdf();
  assert.equal(hasPdfMagic(buffer), true);
  const parsed = await parsePdfBuffer(buffer);
  assert.equal(parsed.pageCount, 1);
  assert.equal(parsed.likelyDoi, '10.1234/abc.9');
  assert.match(parsed.text, /References/);
});

test('HTML 偽裝 PDF 會被拒絕', async () => {
  const fake = Buffer.from('<html><title>login</title></html>');
  assert.equal(hasPdfMagic(fake), false);
  await assert.rejects(parsePdfBuffer(fake), /PDF/);
});
