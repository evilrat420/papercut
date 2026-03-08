import fs from 'node:fs';
import * as cheerio from 'cheerio';
import type { TextExtraction, FileFormat } from '../types.js';

export async function extractPlainText(
  filePath: string,
  format: FileFormat
): Promise<TextExtraction> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');

    let text: string;
    if (format === 'html') {
      const $ = cheerio.load(raw);
      $('script, style, nav, header, footer').remove();
      text = $('body').text().replace(/\s+/g, ' ').trim();
    } else {
      text = raw;
    }

    const pageCount = Math.max(1, Math.ceil(text.length / 3000));

    return {
      text,
      pageCount,
      format,
      metadata: {},
    };
  } catch (error) {
    console.error(`Text extraction failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return { text: '', pageCount: 0, format, metadata: {} };
  }
}
