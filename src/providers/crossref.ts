import type { PaperProvider, PaperSearchResult } from '../types.js';
import { fetchWithRetry } from '../utils/http.js';

const BASE_URL = 'https://api.crossref.org/works';

export class CrossRefProvider implements PaperProvider {
  id = 'crossref';
  name = 'CrossRef';

  private email?: string;

  constructor(email?: string) {
    this.email = email;
  }

  async search(query: string, limit: number = 10, options?: { year?: number; yearRange?: { from?: number; to?: number } }): Promise<PaperSearchResult[]> {
    let url = `${BASE_URL}?query=${encodeURIComponent(query)}&rows=${Math.min(limit, 100)}`;

    if (options?.year) {
      url += `&filter=from-pub-date:${options.year},until-pub-date:${options.year}`;
    } else if (options?.yearRange) {
      if (options.yearRange.from) url += `&filter=from-pub-date:${options.yearRange.from}`;
      if (options.yearRange.to) url += `${options.yearRange.from ? ',' : '&filter='}until-pub-date:${options.yearRange.to}`;
    }

    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (this.email) {
      headers['User-Agent'] = `papercut/1.0 (mailto:${this.email})`;
    }

    const response = await fetchWithRetry(url, { headers });
    const json = await response.json() as any;

    if (!json.message?.items) return [];

    return json.message.items.map((item: any) => this.mapItem(item));
  }

  private mapItem(item: any): PaperSearchResult {
    const authors = (item.author || []).map((a: any) => {
      const parts = [a.given, a.family].filter(Boolean);
      return parts.join(' ');
    });

    const year = item['published-print']?.['date-parts']?.[0]?.[0]
      || item['published-online']?.['date-parts']?.[0]?.[0]
      || item.created?.['date-parts']?.[0]?.[0];

    const downloadUrls: string[] = [];
    let pdfUrl: string | undefined;

    if (item.link) {
      for (const link of item.link) {
        if (link['content-type'] === 'application/pdf' && link.URL) {
          if (!pdfUrl) pdfUrl = link.URL;
          downloadUrls.push(link.URL);
        }
      }
    }

    const title = Array.isArray(item.title) ? item.title[0] : item.title;

    return {
      provider: this.id,
      externalId: item.DOI || '',
      title: title || 'Untitled',
      authors,
      year,
      abstract: item.abstract?.replace(/<[^>]+>/g, ''),
      venue: item['container-title']?.[0],
      doi: item.DOI,
      pdfUrl,
      downloadUrls,
    };
  }
}
