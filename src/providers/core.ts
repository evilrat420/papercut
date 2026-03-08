import type { PaperProvider, PaperSearchResult, ProviderCapabilities, SearchFilterOptions } from '../types.js';
import { fetchWithRetry, RateLimiter } from '../utils/http.js';

const API_BASE = 'https://api.core.ac.uk/v3';

export class CoreProvider implements PaperProvider {
  id = 'core';
  name = 'CORE';
  capabilities: ProviderCapabilities = {
    search: true,
    details: true,
    citations: false,
    references: false,
    download: true,
    doiLookup: true,
    oaDiscovery: true,
  };
  priority = 5;

  private apiKey?: string;
  private rateLimiter = new RateLimiter(10, 60 * 1000);

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async search(query: string, limit: number = 10, options?: SearchFilterOptions): Promise<PaperSearchResult[]> {
    let q = query;
    if (options?.year) {
      q += ` AND yearPublished:${options.year}`;
    } else if (options?.yearRange) {
      const from = options.yearRange.from || 1900;
      const to = options.yearRange.to || new Date().getFullYear();
      q += ` AND yearPublished>=${from} AND yearPublished<=${to}`;
    }

    try {
      const url = `${API_BASE}/search/works?q=${encodeURIComponent(q)}&limit=${limit}`;
      const res = await fetchWithRetry(url, {
        headers: this.headers(),
        rateLimiter: this.rateLimiter,
        maxRetries: 2,
        baseDelay: 2000,
        timeoutMs: 15_000,
      });

      const data = await res.json() as any;
      const results = data.results || [];
      return results.map((work: any) => this.mapWork(work)).filter(Boolean) as PaperSearchResult[];
    } catch {
      return [];
    }
  }

  async getDetails(externalId: string): Promise<PaperSearchResult | null> {
    try {
      const url = `${API_BASE}/works/${encodeURIComponent(externalId)}`;
      const response = await fetchWithRetry(url, {
        headers: this.headers(),
        rateLimiter: this.rateLimiter,
        maxRetries: 2,
        timeoutMs: 10_000,
      });
      const work = await response.json() as any;
      return this.mapWork(work);
    } catch {
      return null;
    }
  }

  async resolveByDoi(doi: string): Promise<PaperSearchResult | null> {
    try {
      // CORE v3 supports DOI search
      const url = `${API_BASE}/search/works?q=doi:"${encodeURIComponent(doi)}"&limit=1`;
      const response = await fetchWithRetry(url, {
        headers: this.headers(),
        rateLimiter: this.rateLimiter,
        maxRetries: 2,
        timeoutMs: 10_000,
      });
      const data = await response.json() as any;
      const results = data.results || [];
      if (results.length === 0) return null;
      return this.mapWork(results[0]);
    } catch {
      return null;
    }
  }

  async resolveDownloadUrl(doi: string): Promise<string | null> {
    const paper = await this.resolveByDoi(doi);
    return paper?.pdfUrl || null;
  }

  private mapWork(work: any): PaperSearchResult | null {
    if (!work) return null;

    const title = work.title || '';
    if (!title) return null;

    const authors: string[] = [];
    if (Array.isArray(work.authors)) {
      for (const a of work.authors) {
        if (typeof a === 'string') {
          authors.push(a);
        } else if (a?.name) {
          authors.push(a.name);
        }
      }
    }

    const downloadUrls: string[] = [];
    if (work.downloadUrl) downloadUrls.push(work.downloadUrl);
    if (work.sourceFulltextUrls) {
      for (const u of work.sourceFulltextUrls) {
        if (u && !downloadUrls.includes(u)) downloadUrls.push(u);
      }
    }

    // CORE provides full text URLs
    const pdfUrl = work.downloadUrl || undefined;

    // Extract DOI
    let doi: string | undefined;
    if (work.doi) {
      doi = work.doi;
    } else if (work.identifiers) {
      for (const id of work.identifiers) {
        if (typeof id === 'string' && id.startsWith('10.')) {
          doi = id;
          break;
        }
      }
    }

    return {
      provider: this.id,
      externalId: String(work.id || work.coreId || ''),
      title,
      authors,
      year: work.yearPublished || undefined,
      abstract: work.abstract || undefined,
      doi,
      pdfUrl,
      downloadUrls,
      venue: work.publisher || work.journals?.[0]?.title || undefined,
    };
  }
}
