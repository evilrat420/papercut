import type { PaperProvider, PaperSearchResult, ProviderCapabilities, SearchFilterOptions } from '../types.js';

const BASE_URL = 'https://api.unpaywall.org/v2';

export class UnpaywallProvider implements PaperProvider {
  id = 'unpaywall';
  name = 'Unpaywall';
  capabilities: ProviderCapabilities = {
    search: false,
    details: false,
    citations: false,
    references: false,
    download: true,
    doiLookup: true,
    oaDiscovery: true,
  };
  priority = 10;

  private email: string;

  constructor(email: string = 'papercut@example.com') {
    this.email = email;
  }

  async search(_query: string, _limit: number, _options?: SearchFilterOptions): Promise<PaperSearchResult[]> {
    return []; // Unpaywall doesn't support free-text search
  }

  async resolveByDoi(doi: string): Promise<PaperSearchResult | null> {
    try {
      const url = `${BASE_URL}/${encodeURIComponent(doi)}?email=${encodeURIComponent(this.email)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const data = await response.json() as any;

      const pdfUrl = data.best_oa_location?.url_for_pdf
        || data.best_oa_location?.url
        || null;

      const downloadUrls: string[] = [];
      if (pdfUrl) downloadUrls.push(pdfUrl);

      // Collect all OA locations
      if (data.oa_locations) {
        for (const loc of data.oa_locations) {
          const u = loc.url_for_pdf || loc.url;
          if (u && !downloadUrls.includes(u)) downloadUrls.push(u);
        }
      }

      return {
        provider: this.id,
        externalId: doi,
        title: data.title || 'Untitled',
        authors: (data.z_authors || []).map((a: any) =>
          [a.given, a.family].filter(Boolean).join(' ')
        ),
        year: data.year,
        doi,
        pdfUrl: pdfUrl || undefined,
        downloadUrls,
      };
    } catch {
      return null;
    }
  }

  async resolveDownloadUrl(doi: string): Promise<string | null> {
    try {
      const url = `${BASE_URL}/${encodeURIComponent(doi)}?email=${encodeURIComponent(this.email)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const data = await response.json() as any;
      return data?.best_oa_location?.url_for_pdf
        || data?.best_oa_location?.url
        || null;
    } catch {
      return null;
    }
  }
}
