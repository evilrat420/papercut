import type { PaperProvider, PaperSearchResult } from '../types.js';
import { XMLParser } from 'fast-xml-parser';

const BASE_URL = 'http://export.arxiv.org/api/query';
const REQUEST_DELAY_MS = 3000;

export class ArxivProvider implements PaperProvider {
  id = 'arxiv';
  name = 'arXiv';

  private lastRequest = 0;

  private async enforceDelay(): Promise<void> {
    const elapsed = Date.now() - this.lastRequest;
    if (elapsed < REQUEST_DELAY_MS) {
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS - elapsed));
    }
    this.lastRequest = Date.now();
  }

  async search(query: string, limit: number = 10): Promise<PaperSearchResult[]> {
    await this.enforceDelay();

    const url = `${BASE_URL}?search_query=all:${encodeURIComponent(query)}&max_results=${Math.min(limit, 100)}&sortBy=relevance`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`arXiv API error: ${response.status}`);

    const xml = await response.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => name === 'entry' || name === 'author' || name === 'link',
    });
    const parsed = parser.parse(xml);

    const feed = parsed.feed;
    if (!feed?.entry) return [];

    const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];

    return entries.map((entry: any) => this.mapEntry(entry));
  }

  private mapEntry(entry: any): PaperSearchResult {
    const idUrl = typeof entry.id === 'string' ? entry.id : entry.id?.['#text'] || '';
    const arxivId = this.extractArxivId(idUrl);

    const authors = this.extractAuthors(entry.author);

    const published = entry.published || '';
    const year = published ? new Date(published).getFullYear() : undefined;

    const pdfUrl = arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined;
    const downloadUrls: string[] = [];
    if (pdfUrl) downloadUrls.push(pdfUrl);

    // Also check links for PDF
    if (entry.link) {
      const links = Array.isArray(entry.link) ? entry.link : [entry.link];
      for (const link of links) {
        if (link['@_title'] === 'pdf' && link['@_href']) {
          if (!downloadUrls.includes(link['@_href'])) {
            downloadUrls.push(link['@_href']);
          }
        }
      }
    }

    const abstract = typeof entry.summary === 'string'
      ? entry.summary.replace(/\s+/g, ' ').trim()
      : entry.summary?.['#text']?.replace(/\s+/g, ' ').trim();

    const doi = entry['arxiv:doi']?.['#text'] || entry['arxiv:doi'];

    return {
      provider: this.id,
      externalId: arxivId || idUrl,
      title: (typeof entry.title === 'string' ? entry.title : entry.title?.['#text'] || 'Untitled').replace(/\s+/g, ' ').trim(),
      authors,
      year,
      abstract,
      doi: typeof doi === 'string' ? doi : undefined,
      arxivId,
      pdfUrl,
      downloadUrls,
    };
  }

  private extractArxivId(url: string): string | undefined {
    const match = url.match(/arxiv\.org\/abs\/(.+?)(?:v\d+)?$/);
    return match?.[1];
  }

  private extractAuthors(authorField: any): string[] {
    if (!authorField) return [];
    const authors = Array.isArray(authorField) ? authorField : [authorField];
    return authors.map((a: any) => {
      if (typeof a === 'string') return a;
      if (a.name) return typeof a.name === 'string' ? a.name : a.name['#text'] || '';
      return '';
    }).filter(Boolean);
  }
}
