import fs from 'node:fs';
import type { TextExtraction } from '../types.js';

export async function extractPdfText(filePath: string): Promise<TextExtraction> {
  try {
    const buffer = fs.readFileSync(filePath);

    // Dynamic import for pdf-parse (CommonJS module)
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);

    return {
      text: data.text || '',
      pageCount: data.numpages || 0,
      format: 'pdf',
      metadata: {
        title: data.info?.Title,
        author: data.info?.Author,
        subject: data.info?.Subject,
      },
    };
  } catch (error) {
    console.error(`PDF extraction failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return { text: '', pageCount: 0, format: 'pdf', metadata: {} };
  }
}
