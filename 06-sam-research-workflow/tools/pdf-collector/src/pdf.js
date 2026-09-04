import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractDois } from './utils.js';

export function hasPdfMagic(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}

function reconstructPage(items) {
  const ordered = [];
  let flowing = '';
  for (const item of items) {
    if (!('str' in item)) continue;
    flowing += item.str;
    flowing += item.hasEOL ? '\n' : ' ';
    ordered.push({
      text: item.str,
      x: Number(item.transform?.[4] || 0),
      y: Number(item.transform?.[5] || 0),
      width: Number(item.width || 0),
    });
  }

  const lines = [];
  for (const item of ordered.sort((a, b) => b.y - a.y || a.x - b.x)) {
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 2.2);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }
  const layout = lines
    .sort((a, b) => b.y - a.y)
    .map((line) => line.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { flowing: flowing.replace(/[ \t]+\n/g, '\n').trim(), layout };
}

export async function parsePdfBuffer(buffer) {
  if (!hasPdfMagic(buffer)) throw new Error('檔案沒有 PDF 標頭');
  const task = getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const document = await task.promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({ pageNumber, ...reconstructPage(content.items) });
  }
  const metadata = await document.getMetadata().catch(() => ({ info: {}, metadata: null }));
  const firstPages = pages.slice(0, 3).map((page) => page.flowing).join('\n');
  return {
    pageCount: document.numPages,
    pages,
    text: pages.map((page) => page.flowing).join('\n\n'),
    layoutText: pages.map((page) => page.layout).join('\n\n'),
    metadata: metadata.info || {},
    likelyDoi: extractDois(firstPages)[0] || null,
  };
}
