import type { PaperProvider, PaperSearchResult, ProviderCapabilities, SearchFilterOptions } from '../types.js';
import { fetchWithRetry } from '../utils/http.js';

const BASE_URL = 'https://api.openalex.org';

export class OpenAlexProvider implements PaperProvider {
  id = 'openalex';
  name = 'OpenAlex';
  capabilities: ProviderCapabilities = {
    search: true,
    details: true,
    citations: true,
    references: true,
    download: false,
    doiLookup: true,
    oaDiscovery: true,
  };
  priority = 1;

  private email?: string;

  constructor(email?: string) {
    this.email = email;
  }

  private params(): string {
    return this.email ? `&mailto=${encodeURIComponent(this.email)}` : '';
  }

  async search(query: string, limit: number = 10, options?: SearchFilterOptions): Promise<PaperSearchResult[]> {
    let url = `${BASE_URL}/works?search=${encodeURIComponent(query)}&per_page=${Math.min(limit, 200)}${this.params()}`;

    if (options?.year) {
      url += `&filter=publication_year:${options.year}`;
    } else if (options?.yearRange) {
      const filters: string[] = [];
      if (options.yearRange.from) filters.push(`from_publication_date:${options.yearRange.from}-01-01`);
      if (options.yearRange.to) filters.push(`to_publication_date:${options.yearRange.to}-12-31`);
      if (filters.length > 0) url += `&filter=${filters.join(',')}`;
    }

    const response = await fetchWithRetry(url, {
      headers: { 'Accept': 'application/json' },
      timeoutMs: 15_000,
    });
    const json = await response.json() as any;

    if (!json.results) return [];
    return json.results.map((w: any) => this.mapWork(w));
  }

  async getDetails(externalId: string): Promise<PaperSearchResult | null> {
    try {
      const url = `${BASE_URL}/works/${externalId}${this.params() ? '?' + this.params().slice(1) : ''}`;
      const response = await fetchWithRetry(url, {
        headers: { 'Accept': 'application/json' },
        timeoutMs: 10_000,
      });
      const json = await response.json() as any;
      return this.mapWork(json);
    } catch {
      return null;
    }
  }

  async resolveByDoi(doi: string): Promise<PaperSearchResult | null> {
    try {
      const url = `${BASE_URL}/works/https://doi.org/${encodeURIComponent(doi)}${this.params() ? '?' + this.params().slice(1) : ''}`;
      const response = await fetchWithRetry(url, {
        headers: { 'Accept': 'application/json' },
        timeoutMs: 10_000,
      });
      const json = await response.json() as any;
      return this.mapWork(json);
    } catch {
      return null;
    }
  }

  async resolveDownloadUrl(doi: string): Promise<string | null> {
    const result = await this.resolveByDoi(doi);
    return result?.pdfUrl || result?.downloadUrls?.[0] || null;
  }

  async getCitations(externalId: string, limit: number = 20): Promise<PaperSearchResult[]> {
    try {
      const url = `${BASE_URL}/works?filter=cites:${externalId}&per_page=${Math.min(limit, 200)}${this.params()}`;
      const response = await fetchWithRetry(url, {
        headers: { 'Accept': 'application/json' },
        timeoutMs: 15_000,
      });
      const json = await response.json() as any;
      if (!json.results) return [];
      return json.results.map((w: any) => this.mapWork(w));
    } catch {
      return [];
    }
  }

  async getReferences(externalId: string, limit: number = 20): Promise<PaperSearchResult[]> {
    try {
      // Get the work's referenced_works list, then fetch each
      const work = await this.getDetails(externalId);
      if (!work) return [];

      // referenced_works are stored as OpenAlex IDs in the work object
      // We need to fetch them — use a filter query
      const url = `${BASE_URL}/works?filter=openalex:${externalId}&select=referenced_works${this.params() ? '&' + this.params().slice(1) : ''}`;
      const response = await fetchWithRetry(url, {
        headers: { 'Accept': 'application/json' },
        timeoutMs: 10_000,
      });
      const json = await response.json() as any;
      const refIds: string[] = json.results?.[0]?.referenced_works || [];
      if (refIds.length === 0) return [];

      // Fetch referenced works using pipe-separated filter
      const batch = refIds.slice(0, Math.min(limit, 50));
      const refUrl = `${BASE_URL}/works?filter=openalex:${batch.join('|')}&per_page=${batch.length}${this.params()}`;
      const refResponse = await fetchWithRetry(refUrl, {
        headers: { 'Accept': 'application/json' },
        timeoutMs: 15_000,
      });
      const refJson = await refResponse.json() as any;
      if (!refJson.results) return [];
      return refJson.results.map((w: any) => this.mapWork(w));
    } catch {
      return [];
    }
  }

  private mapWork(work: any): PaperSearchResult {
    const authors = (work.authorships || []).map((a: any) =>
      a.author?.display_name || ''
    ).filter(Boolean);

    // Reconstruct abstract from inverted index
    let abstract: string | undefined;
    if (work.abstract_inverted_index) {
      abstract = this.reconstructAbstract(work.abstract_inverted_index);
    }

    // Extract OA URLs
    const downloadUrls: string[] = [];
    let pdfUrl: string | undefined;

    const bestOa = work.best_oa_location?.pdf_url || work.best_oa_location?.landing_page_url;
    const oaUrl = work.open_access?.oa_url;

    if (work.best_oa_location?.pdf_url) {
      pdfUrl = work.best_oa_location.pdf_url as string;
      downloadUrls.push(pdfUrl);
    }
    if (oaUrl && !downloadUrls.includes(oaUrl)) {
      downloadUrls.push(oaUrl);
    }
    if (bestOa && !downloadUrls.includes(bestOa)) {
      downloadUrls.push(bestOa);
    }

    // Extract DOI without the URL prefix
    let doi: string | undefined;
    if (work.doi) {
      doi = work.doi.replace('https://doi.org/', '');
    }

    // Extract OpenAlex ID
    const openalexId = work.id?.replace('https://openalex.org/', '') || work.id;

    return {
      provider: this.id,
      externalId: openalexId || '',
      title: work.display_name || work.title || 'Untitled',
      authors,
      year: work.publication_year,
      abstract,
      venue: work.primary_location?.source?.display_name,
      doi,
      citationCount: work.cited_by_count,
      pdfUrl,
      downloadUrls,
      fieldsOfStudy: (work.topics || []).slice(0, 5).map((t: any) => t.display_name),
    };
  }

  private reconstructAbstract(invertedIndex: Record<string, number[]>): string {
    const words: [string, number][] = [];
    for (const [word, positions] of Object.entries(invertedIndex)) {
      for (const pos of positions) {
        words.push([word, pos]);
      }
    }
    words.sort((a, b) => a[1] - b[1]);
    return words.map(w => w[0]).join(' ');
  }
}
