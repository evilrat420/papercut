import path from 'node:path';
import type { TextExtraction, FileFormat } from '../types.js';
import { extractPdfText } from './pdf-extractor.js';
import { extractEpubText } from './epub-extractor.js';
import { extractPlainText } from './plaintext-extractor.js';

const EXTENSION_TO_FORMAT: Record<string, FileFormat> = {
  '.pdf': 'pdf',
  '.epub': 'epub',
  '.txt': 'txt',
  '.text': 'txt',
  '.html': 'html',
  '.htm': 'html',
};

export function detectFormat(filePath: string): FileFormat {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_FORMAT[ext] || 'unknown';
}

export async function extractText(filePath: string): Promise<TextExtraction> {
  const format = detectFormat(filePath);

  switch (format) {
    case 'pdf':
      return extractPdfText(filePath);
    case 'epub':
      return extractEpubText(filePath);
    case 'txt':
    case 'html':
      return extractPlainText(filePath, format);
    default:
      return { text: '', pageCount: 0, format: 'unknown', metadata: {} };
  }
}
