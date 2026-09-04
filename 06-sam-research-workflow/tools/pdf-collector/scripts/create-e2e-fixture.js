import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { TMP_DIR } from '../src/constants.js';

await fs.mkdir(TMP_DIR, { recursive: true });
const document = await PDFDocument.create();
const font = await document.embedFont(StandardFonts.Helvetica);
const page = document.addPage([612, 792]);
page.drawText('Collector end-to-end fixture', { x: 48, y: 744, size: 16, font });
page.drawText('Source DOI: 10.9999/source.fake', { x: 48, y: 716, size: 10, font });
page.drawText('References', { x: 48, y: 670, size: 13, font });
page.drawText('[1] PLOS ONE Staff. Correction: An image-based model of cell migration.', { x: 48, y: 646, size: 9, font });
page.drawText('PLoS ONE. doi:10.1371/journal.pone.0000308', { x: 48, y: 630, size: 9, font });
const output = path.join(TMP_DIR, 'e2e-source.pdf');
await fs.writeFile(output, await document.save());
console.log(output);
