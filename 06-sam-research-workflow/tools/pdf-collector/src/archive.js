import path from 'node:path';
import { SUCCESS_STATUSES } from './constants.js';

export function mainArchiveFileNames(items = []) {
  return [...new Set(items
    .filter((item) => SUCCESS_STATUSES.has(item?.status) && item?.fileName)
    .map((item) => path.basename(item.fileName))
    .filter((fileName) => /\.pdf$/i.test(fileName)))];
}

export function filterSupplementArchiveEntries(entries = []) {
  return entries.filter((entry) => {
    if (path.basename(entry) !== entry) return false;
    return ['.pdf', '.docx', '.doc'].includes(path.extname(entry).toLowerCase());
  });
}
