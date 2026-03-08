import type { PaperSearchResult } from '../types.js';
import { ProviderRegistry } from '../providers/registry.js';

export class UrlResolver {
  constructor(private registry: ProviderRegistry) {}

  /**
   * Collect all possible download URLs from multiple sources,
   * prioritized by reliability.
   */
  async resolveUrls(paper: PaperSearchResult): Promise<string[]> {
    const urls = new Set<string>();

    // 1. Direct URLs from search result
    if (paper.pdfUrl) urls.add(paper.pdfUrl);
    for (const u of paper.downloadUrls) urls.add(u);

    // 2. arXiv direct PDF (always reliable)
    if (paper.arxivId) {
      urls.add(`https://arxiv.org/pdf/${paper.arxivId}.pdf`);
    }

    // 3. DOI-based OA discovery (Unpaywall, OpenAlex)
    if (paper.doi) {
      const oaProviders = this.registry.getByCapability('oaDiscovery');
      const oaResults = await Promise.allSettled(
        oaProviders.map(async (p) => {
          if (p.resolveDownloadUrl) {
            return p.resolveDownloadUrl(paper.doi!);
          }
          return null;
        })
      );

      for (const result of oaResults) {
        if (result.status === 'fulfilled' && result.value) {
          urls.add(result.value);
        }
      }
    }

    // Sort by reliability: arXiv > direct PDFs > OA > IPFS > scraped
    return this.prioritizeUrls([...urls]);
  }

  /**
   * HEAD-check URLs to filter dead ones. Returns only live URLs.
   */
  async filterLiveUrls(urls: string[], timeoutMs: number = 5000): Promise<string[]> {
    if (urls.length === 0) return [];

    const checks = await Promise.allSettled(
      urls.map(async (url) => {
        const response = await fetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'follow',
        });
        return { url, alive: response.ok || response.status === 302 || response.status === 301 };
      })
    );

    return checks
      .filter((r): r is PromiseFulfilledResult<{ url: string; alive: boolean }> =>
        r.status === 'fulfilled' && r.value.alive
      )
      .map(r => r.value.url);
  }

  private prioritizeUrls(urls: string[]): string[] {
    const priority = (url: string): number => {
      if (url.includes('arxiv.org/pdf')) return 0;
      if (url.includes('doi.org')) return 1;
      if (url.includes('ncbi.nlm.nih.gov') || url.includes('pmc')) return 2;
      if (url.includes('unpaywall')) return 3;
      if (url.includes('openalex')) return 3;
      if (url.includes('core.ac.uk')) return 4;
      if (url.includes('ipfs') || url.includes('dweb.link')) return 8;
      if (url.includes('libgen') || url.includes('library.lol')) return 9;
      return 5;
    };

    return [...urls].sort((a, b) => priority(a) - priority(b));
  }
}
