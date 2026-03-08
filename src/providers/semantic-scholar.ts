import type { PaperProvider, PaperSearchResult, ProviderCapabilities, SearchFilterOptions } from '../types.js';
import { RateLimiter, fetchWithRetry } from '../utils/http.js';

const BASE_URL = 'https://api.semanticscholar.org/graph/v1';
const FIELDS = 'paperId,title,abstract,year,venue,authors,citationCount,openAccessPdf,tldr,s2FieldsOfStudy,externalIds';

export class SemanticScholarProvider implements PaperProvider {
  id = 'semantic-scholar';
  name = 'Semantic Scholar';
  capabilities: ProviderCapabilities = {
    search: true,
    details: true,
    citations: true,
    references: true,
    download: false,
    doiLookup: true,
    oaDiscovery: false,
  };
  priority = 0;

  private rateLimiter = new RateLimiter(100, 5 * 60 * 1000);
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Accept': 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  async resolveByDoi(doi: string): Promise<PaperSearchResult | null> {
    return this.getDetails(doi);
  }

  async search(query: string, limit: number = 10, options?: SearchFilterOptions): Promise<PaperSearchResult[]> {
    let url = `${BASE_URL}/paper/search?query=${encodeURIComponent(query)}&fields=${FIELDS}&limit=${Math.min(limit, 100)}`;

    if (options?.year) {
      url += `&year=${options.year}`;
    } else if (options?.yearRange) {
      const from = options.yearRange.from || '';
      const to = options.yearRange.to || '';
      url += `&year=${from}-${to}`;
    }

    const response = await fetchWithRetry(url, {
      headers: this.headers(),
      rateLimiter: this.rateLimiter,
    });

    const json = await response.json() as any;
    if (!json.data) return [];

    return json.data.map((p: any) => this.mapResult(p));
  }

  async getDetails(externalId: string): Promise<PaperSearchResult | null> {
    const url = `${BASE_URL}/paper/${externalId}?fields=${FIELDS}`;

    try {
      const response = await fetchWithRetry(url, {
        headers: this.headers(),
        rateLimiter: this.rateLimiter,
      });
      const json = await response.json() as any;
      return this.mapResult(json);
    } catch {
      return null;
    }
  }

  async getCitations(externalId: string, limit: number = 20): Promise<PaperSearchResult[]> {
    const url = `${BASE_URL}/paper/${externalId}/citations?fields=${FIELDS}&limit=${Math.min(limit, 100)}`;

    const response = await fetchWithRetry(url, {
      headers: this.headers(),
      rateLimiter: this.rateLimiter,
    });

    const json = await response.json() as any;
    if (!json.data) return [];

    return json.data
      .filter((c: any) => c.citingPaper?.paperId)
      .map((c: any) => this.mapResult(c.citingPaper));
  }

  async getReferences(externalId: string, limit: number = 20): Promise<PaperSearchResult[]> {
    const url = `${BASE_URL}/paper/${externalId}/references?fields=${FIELDS}&limit=${Math.min(limit, 100)}`;

    const response = await fetchWithRetry(url, {
      headers: this.headers(),
      rateLimiter: this.rateLimiter,
    });

    const json = await response.json() as any;
    if (!json.data) return [];

    return json.data
      .filter((r: any) => r.citedPaper?.paperId)
      .map((r: any) => this.mapResult(r.citedPaper));
  }

  private mapResult(p: any): PaperSearchResult {
    const downloadUrls: string[] = [];
    const pdfUrl = p.openAccessPdf?.url;
    if (pdfUrl) downloadUrls.push(pdfUrl);

    return {
      provider: this.id,
      externalId: p.paperId || '',
      title: p.title || 'Untitled',
      authors: (p.authors || []).map((a: any) => a.name),
      year: p.year,
      abstract: p.abstract,
      venue: p.venue,
      doi: p.externalIds?.DOI,
      arxivId: p.externalIds?.ArXiv,
      citationCount: p.citationCount,
      pdfUrl,
      downloadUrls,
      tldr: p.tldr?.text,
      fieldsOfStudy: (p.s2FieldsOfStudy || []).map((f: any) => f.category),
    };
  }
}
