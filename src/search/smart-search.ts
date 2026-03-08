import type { PaperSearchResult, SearchFilterOptions } from '../types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { PaperDatabase } from '../storage/database.js';
import { titleSimilarity } from '../utils/dedup.js';

export interface SmartSearchOptions {
  query: string;
  limit: number;
  year?: number;
  yearRange?: { from?: number; to?: number };
  providers?: string[];
}

export interface SmartSearchResult {
  results: PaperSearchResult[];
  providerResults: Map<string, { count: number; error?: string }>;
  suggestions: string[];
}

export class SmartSearch {
  constructor(
    private registry: ProviderRegistry,
    private db: PaperDatabase,
  ) {}

  /**
   * Resolve a DOI, arXiv ID, URL, or Semantic Scholar ID to a paper.
   */
  async resolve(input: string): Promise<PaperSearchResult | null> {
    const trimmed = input.trim();

    // 1. DOI pattern: 10.xxxx/xxxxx
    const doiMatch = trimmed.match(/^(?:https?:\/\/(?:dx\.)?doi\.org\/)?((10\.\d{4,})\/.+)$/i);
    if (doiMatch) {
      return this.resolveByDoi(doiMatch[1]);
    }

    // 2. arXiv ID: 2301.12345 or arxiv.org/abs/2301.12345
    const arxivMatch = trimmed.match(/(?:arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    if (arxivMatch) {
      return this.resolveArxiv(arxivMatch[1]);
    }

    // 3. Semantic Scholar ID (40-char hex)
    if (/^[a-f0-9]{40}$/i.test(trimmed)) {
      const s2 = this.registry.get('semantic-scholar');
      if (s2?.getDetails) {
        try { return await s2.getDetails(trimmed); } catch {}
      }
    }

    // 4. URL — try to extract DOI or arXiv ID from it
    if (trimmed.startsWith('http')) {
      const urlDoiMatch = trimmed.match(/doi\.org\/((10\.\d{4,})\/.+?)(?:\?|$)/i);
      if (urlDoiMatch) return this.resolveByDoi(urlDoiMatch[1]);

      const urlArxivMatch = trimmed.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
      if (urlArxivMatch) return this.resolveArxiv(urlArxivMatch[1]);

      // Semantic Scholar URL
      const s2UrlMatch = trimmed.match(/semanticscholar\.org\/paper\/[^/]*\/([a-f0-9]{40})/i);
      if (s2UrlMatch) {
        const s2 = this.registry.get('semantic-scholar');
        if (s2?.getDetails) {
          try { return await s2.getDetails(s2UrlMatch[1]); } catch {}
        }
      }
    }

    // Not a recognizable identifier
    return null;
  }

  /**
   * Cascade search with quality assessment and provider suggestions.
   */
  async search(options: SmartSearchOptions): Promise<SmartSearchResult> {
    const { query, limit, year, yearRange, providers: providerFilter } = options;
    const filterOpts: SearchFilterOptions = { year, yearRange };

    // Get search-capable providers
    let searchProviders = this.registry.getByCapability('search');
    if (providerFilter && providerFilter.length > 0) {
      searchProviders = providerFilter
        .map(id => this.registry.get(id))
        .filter((p): p is NonNullable<typeof p> => !!p && p.capabilities.search);
    }

    const providerResults = new Map<string, { count: number; error?: string }>();
    let allResults: PaperSearchResult[] = [];

    // Search all enabled providers in parallel
    const settled = await Promise.allSettled(
      searchProviders.map(async (provider) => {
        const results = await provider.search(query, limit, filterOpts);
        return { id: provider.id, results };
      })
    );

    for (const result of settled) {
      if (result.status === 'rejected') {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        // We can't easily get the provider id from a rejected promise, so skip
        continue;
      }
      const { id, results } = result.value;
      providerResults.set(id, { count: results.length });
      allResults.push(...results);
    }

    // Deduplicate by DOI, then by title similarity
    allResults = this.deduplicateResults(allResults);

    // Generate suggestions for disabled providers
    const suggestions = this.generateSuggestions(allResults, limit);

    return { results: allResults, providerResults, suggestions };
  }

  private async resolveByDoi(doi: string): Promise<PaperSearchResult | null> {
    const doiProviders = this.registry.getByCapability('doiLookup');

    for (const provider of doiProviders) {
      if (provider.resolveByDoi) {
        try {
          const result = await provider.resolveByDoi(doi);
          if (result) return result;
        } catch { continue; }
      }
    }

    return null;
  }

  private async resolveArxiv(arxivId: string): Promise<PaperSearchResult | null> {
    // Try Semantic Scholar first (has richer metadata)
    const s2 = this.registry.get('semantic-scholar');
    if (s2?.getDetails) {
      try {
        const result = await s2.getDetails(`ArXiv:${arxivId}`);
        if (result) return result;
      } catch {}
    }

    // Fall back to arXiv search
    const arxiv = this.registry.get('arxiv');
    if (arxiv) {
      try {
        const results = await arxiv.search(arxivId, 1);
        if (results.length > 0) return results[0];
      } catch {}
    }

    return null;
  }

  private deduplicateResults(results: PaperSearchResult[]): PaperSearchResult[] {
    const seen = new Map<string, PaperSearchResult>(); // DOI -> best result
    const unique: PaperSearchResult[] = [];

    for (const result of results) {
      // Check DOI dedup
      if (result.doi) {
        const existing = seen.get(result.doi);
        if (existing) {
          // Keep the one with more metadata
          if (this.resultRichness(result) > this.resultRichness(existing)) {
            seen.set(result.doi, result);
            const idx = unique.indexOf(existing);
            if (idx >= 0) unique[idx] = result;
          }
          continue;
        }
        seen.set(result.doi, result);
      }

      // Check title similarity against existing
      let isDup = false;
      for (const existing of unique) {
        if (titleSimilarity(result.title, existing.title) >= 0.85) {
          // Keep richer one
          if (this.resultRichness(result) > this.resultRichness(existing)) {
            const idx = unique.indexOf(existing);
            if (idx >= 0) unique[idx] = result;
          }
          isDup = true;
          break;
        }
      }

      if (!isDup) unique.push(result);
    }

    return unique;
  }

  private resultRichness(r: PaperSearchResult): number {
    let score = 0;
    if (r.abstract) score += 3;
    if (r.pdfUrl) score += 2;
    if (r.downloadUrls.length > 0) score += 1;
    if (r.citationCount !== undefined) score += 1;
    if (r.doi) score += 1;
    if (r.tldr) score += 1;
    if (r.venue) score += 1;
    return score;
  }

  private generateSuggestions(results: PaperSearchResult[], limit: number): string[] {
    const suggestions: string[] = [];
    const disabled = this.registry.getDisabled().filter(p => p.capabilities.search);

    if (disabled.length > 0 && results.length < limit) {
      for (const p of disabled) {
        suggestions.push(`${p.name} is disabled but could provide additional results. Enable it in papercut.config.json.`);
      }
    }

    // Check if we have OA coverage
    const hasOa = results.some(r => r.pdfUrl || r.downloadUrls.length > 0);
    if (!hasOa && results.length > 0) {
      const oaProviders = this.registry.getByCapability('oaDiscovery');
      if (oaProviders.length === 0) {
        suggestions.push('Enable Unpaywall or OpenAlex for open access PDF discovery.');
      }
    }

    return suggestions;
  }
}
