import type { TextExtraction } from '../types.js';

export async function extractEpubText(filePath: string): Promise<TextExtraction> {
  try {
    // Dynamic import for epub2 (CommonJS module)
    const mod = await import('epub2');
    const EPub = mod.EPub;
    const epub = await (EPub as any).createAsync(filePath);

    const metadata = epub.metadata || {};
    const chapters: string[] = [];

    // epub.flow contains the ordered spine items (chapters)
    for (const chapter of epub.flow) {
      if (!chapter.id) continue;
      try {
        const html = await epub.getChapterAsync(chapter.id);
        if (html) {
          // Strip HTML tags, collapse whitespace
          const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (plain) chapters.push(plain);
        }
      } catch {
        // Skip chapters that fail to extract
      }
    }

    const fullText = chapters.join('\n\n');

    return {
      text: fullText,
      pageCount: chapters.length,
      format: 'epub',
      metadata: {
        title: metadata.title,
        author: metadata.creator,
        subject: metadata.subject,
      },
    };
  } catch (error) {
    console.error(`EPUB extraction failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return { text: '', pageCount: 0, format: 'epub', metadata: {} };
  }
}
