import * as cheerio from 'cheerio';
import type { PaperProvider, PaperSearchResult } from '../types.js';
import { fetchWithRetry, RateLimiter } from '../utils/http.js';

const DOMAINS = [
  'https://annas-archive.li',
  'https://annas-archive.org',
  'https://annas-archive.se',
  'https://annas-archive.gs',
];

export class AnnasArchiveProvider implements PaperProvider {
  id = 'annas-archive';
  name = "Anna's Archive";

  private rateLimiter = new RateLimiter(10, 60 * 1000);

  private headers(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  async search(query: string, limit: number = 10): Promise<PaperSearchResult[]> {
    const searchPath = `/search?q=${encodeURIComponent(query)}&content=scitech`;
    let lastError: Error | null = null;

    for (const domain of DOMAINS) {
      try {
        const response = await fetchWithRetry(`${domain}${searchPath}`, {
          headers: this.headers(),
          rateLimiter: this.rateLimiter,
          maxRetries: 1,
          baseDelay: 3000,
          timeoutMs: 15_000,
        });

        const html = await response.text();
        const results = this.parseSearchResults(html, limit);
        return results;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
    }

    throw lastError || new Error('All Anna\'s Archive domains failed');
  }

  private parseSearchResults(html: string, limit: number): PaperSearchResult[] {
    // Strip ALL HTML comments - Anna's Archive wraps lazy-loaded results in <!-- -->
    const stripped = html.replace(/(<!--|-->)/g, '');
    const $ = cheerio.load(stripped);

    const results: PaperSearchResult[] = [];
    const seen = new Set<string>();

    // Each result is a div.flex inside div.js-aarecord-list-outer
    $('div.js-aarecord-list-outer > div.flex').each((_, el) => {
      if (results.length >= limit) return;

      try {
        const entry = $(el);

        // Title is the text of a.js-vim-focus
        const titleLink = entry.find('a.js-vim-focus').first();
        if (!titleLink.length) return;

        const href = titleLink.attr('href') || '';
        const md5Match = href.match(/\/md5\/([a-fA-F0-9]+)/);
        if (!md5Match) return;

        const md5 = md5Match[1]!;
        if (seen.has(md5)) return;
        seen.add(md5);

        const title = titleLink.text().trim() || 'Untitled';

        // Content div has the metadata links
        const contentDiv = entry.find('div.max-w-full').first();

        // Meta links: a[href^="/search?q="] - these contain author and publisher info
        // Pattern: first link = author(s), second link = publisher/date
        // Author links may have semicolons, "(author)" tags, or just comma-separated names
        const metaLinks: { text: string; href: string }[] = [];
        contentDiv.find('a[href^="/search?q="]').each((_, a) => {
          const text = $(a).text().trim();
          if (text && !text.startsWith('TODO')) {
            metaLinks.push({ text, href: $(a).attr('href') || '' });
          }
        });

        let authors: string[] = [];
        let publisher = '';

        if (metaLinks.length >= 2) {
          // First link = authors, second = publisher/date
          authors = this.parseAuthors(metaLinks[0]!.text);
          publisher = metaLinks[1]!.text;
        } else if (metaLinks.length === 1) {
          // Could be either - if it looks like names, treat as authors
          const text = metaLinks[0]!.text;
          if (this.looksLikeAuthors(text)) {
            authors = this.parseAuthors(text);
          } else {
            publisher = text;
          }
        }

        // File info line: div.text-gray-800 contains "PDF · 2.2MB · 2017 · type · sources"
        // Truncate at TODO:TRANSLATE or script content
        const fileInfoDiv = contentDiv.find('div.text-gray-800').first();
        let fileInfo = '';
        if (fileInfoDiv.length) {
          // Get only direct text nodes + span content, not script/button text
          fileInfo = fileInfoDiv.clone().find('script,button,a').remove().end()
            .text().trim().replace(/\s+/g, ' ');
          // Truncate at "TODO:" junk
          const todoIdx = fileInfo.indexOf('TODO:');
          if (todoIdx > 0) fileInfo = fileInfo.substring(0, todoIdx).trim();
          // Clean trailing separator
          fileInfo = fileInfo.replace(/\s*·\s*$/, '').trim();
        }

        // Extract year from file info or publisher line
        const yearMatch = (fileInfo + ' ' + publisher).match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? parseInt(yearMatch[0], 10) : undefined;

        results.push({
          provider: this.id,
          externalId: md5,
          title,
          authors,
          year,
          md5,
          venue: publisher || undefined,
          pdfUrl: undefined,
          downloadUrls: [],
          fileInfo: fileInfo || undefined,
        });
      } catch {
        // Skip malformed entries
      }
    });

    return results;
  }

  private parseAuthors(text: string): string[] {
    // Handle "Name (author);Name2 (author)" format
    if (text.includes(';')) {
      return text.split(';')
        .map(a => a.replace(/\(author\)/g, '').trim())
        .filter(Boolean);
    }
    // Handle "Last, First, Last2, First2" format - split on comma pairs
    const parts = text.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      // If parts look like "Last, First, Last2, First2", group in pairs
      const authors: string[] = [];
      for (let i = 0; i < parts.length; i += 2) {
        if (i + 1 < parts.length) {
          authors.push(`${parts[i]}, ${parts[i + 1]}`);
        } else {
          authors.push(parts[i]!);
        }
      }
      return authors;
    }
    return parts;
  }

  private looksLikeAuthors(text: string): boolean {
    // Contains "(author)", semicolons, or has comma-separated name-like patterns
    if (text.includes('(author)') || text.includes(';')) return true;
    // Multiple commas with mostly alphabetic content suggests author names
    const commaCount = (text.match(/,/g) || []).length;
    const hasDigits = /\d{4}/.test(text);
    return commaCount >= 1 && !hasDigits;
  }

  // --- Detail page + download link resolution ---

  async getDetails(md5: string): Promise<PaperSearchResult | null> {
    const detailPath = `/md5/${md5}`;
    let lastError: Error | null = null;

    for (const domain of DOMAINS) {
      try {
        const response = await fetchWithRetry(`${domain}${detailPath}`, {
          headers: this.headers(),
          rateLimiter: this.rateLimiter,
          maxRetries: 1,
          baseDelay: 3000,
          timeoutMs: 15_000,
        });

        const html = await response.text();
        const result = await this.parseDetailPage(html, md5);

        // Try to resolve a direct download link from library.lol
        const directUrl = await this.resolveLibraryLolUrl(md5);
        if (directUrl) {
          result.downloadUrls.unshift(directUrl);
          if (!result.pdfUrl) result.pdfUrl = directUrl;
        }

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
    }

    // If all Anna's Archive domains fail, still try library.lol directly
    try {
      const directUrl = await this.resolveLibraryLolUrl(md5);
      if (directUrl) {
        return {
          provider: this.id,
          externalId: md5,
          title: '',
          authors: [],
          md5,
          pdfUrl: directUrl,
          downloadUrls: [directUrl],
        };
      }
    } catch {}

    return null;
  }

  private async parseDetailPage(html: string, md5: string): Promise<PaperSearchResult> {
    const stripped = html.replace(/(<!--|-->)/g, '');
    const $ = cheerio.load(stripped);

    // Title from main heading - skip generic site headers
    const SKIP_TITLES = ['anna\'s archive', 'annas archive', ''];
    let title = '';
    $('div.text-3xl, div.text-2xl, h1').each((_, el) => {
      if (title) return;
      const t = $(el).text().trim();
      if (t && !SKIP_TITLES.includes(t.toLowerCase())) {
        title = t;
      }
    });

    // Extract metadata
    let authors: string[] = [];
    let year: number | undefined;
    let doi: string | undefined;

    // Look for metadata in the page
    $('div.text-sm, div.text-gray-500, div.text-gray-600').each((_, el) => {
      const text = $(el).text().trim();
      const yearMatch = text.match(/\b(19|20)\d{2}\b/);
      if (yearMatch && !year) year = parseInt(yearMatch[0], 10);
      const doiMatch = text.match(/10\.\d{4,}\/[^\s,]+/);
      if (doiMatch && !doi) doi = doiMatch[0];
    });

    // Look for author info in meta links
    $('a[href*="/search?q="]').each((_, el) => {
      const text = $(el).text().trim();
      if (text && this.looksLikeAuthors(text) && authors.length === 0) {
        authors = this.parseAuthors(text);
      }
    });

    // Extract download URLs and pages that need further resolution
    const downloadUrls: string[] = [];
    const libgenFilePages: string[] = [];

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';

      // Direct IPFS gateway links (HTTP, not ipfs:// protocol)
      if (href.startsWith('http') && (
        href.includes('cloudflare-ipfs') ||
        href.includes('gateway.ipfs.io') ||
        href.includes('gateway.pinata.cloud') ||
        href.includes('dweb.link')
      )) {
        if (!downloadUrls.includes(href)) downloadUrls.push(href);
      }

      // LibGen file pages (need one more hop to get IPFS gateway URLs)
      if (href.includes('libgen.li/file.php') || href.includes('libgen.rs/file.php')) {
        if (!libgenFilePages.includes(href)) libgenFilePages.push(href);
      }

      // Direct library.lol or libgen download links
      if (href.startsWith('http') && (
        href.includes('download.library.lol') ||
        href.includes('library.lol/main/')
      )) {
        if (!downloadUrls.includes(href)) downloadUrls.push(href);
      }
    });

    // Convert ipfs:// CIDs to IPFS gateway URLs
    $('a[href^="ipfs://"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const cidMatch = href.match(/ipfs:\/\/([a-zA-Z0-9]+)/);
      if (cidMatch) {
        const gatewayUrl = `https://cloudflare-ipfs.com/ipfs/${cidMatch[1]}`;
        if (!downloadUrls.includes(gatewayUrl)) downloadUrls.push(gatewayUrl);
      }
    });

    // Resolve libgen.li/file.php pages for IPFS gateway URLs
    for (const filePageUrl of libgenFilePages.slice(0, 2)) {
      const resolved = await this.resolveLibgenFileUrl(filePageUrl);
      for (const u of resolved) {
        if (!downloadUrls.includes(u)) downloadUrls.push(u);
      }
    }

    // library.lol as final fallback
    const libraryLolUrl = `https://library.lol/main/${md5}`;
    if (!downloadUrls.includes(libraryLolUrl)) {
      downloadUrls.push(libraryLolUrl);
    }

    const pdfUrl = downloadUrls[0] || undefined;

    return {
      provider: this.id,
      externalId: md5,
      title,
      authors,
      year,
      doi,
      md5,
      pdfUrl,
      downloadUrls,
    };
  }

  private async resolveLibraryLolUrl(md5: string): Promise<string | null> {
    const url = `https://library.lol/main/${md5}`;
    try {
      const response = await fetchWithRetry(url, {
        headers: this.headers(),
        maxRetries: 1,
        baseDelay: 2000,
        timeoutMs: 10_000,
      });

      const html = await response.text();
      const $ = cheerio.load(html);

      const downloadLink =
        $('a[href*="download.library.lol"]').attr('href') ||
        $('a:contains("GET")').attr('href') ||
        $('a[href*="cloudflare-ipfs"]').attr('href') ||
        $('a[href*="ipfs.io"]').attr('href') ||
        $('a[href*="dweb.link"]').attr('href') ||
        $('#download a[href]').attr('href');

      return downloadLink || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve direct download URLs from a libgen.li/file.php page.
   * Chain: file.php → ads.php (has get.php link with time-limited key) → actual file.
   * Also picks up IPFS gateway links as fallback.
   */
  private async resolveLibgenFileUrl(filePageUrl: string): Promise<string[]> {
    const urls: string[] = [];
    try {
      const response = await fetchWithRetry(filePageUrl, {
        headers: this.headers(),
        maxRetries: 1,
        baseDelay: 2000,
        timeoutMs: 10_000,
      });

      const html = await response.text();
      const $ = cheerio.load(html);

      // Extract the base URL for relative links
      const baseUrl = new URL(filePageUrl);
      const origin = baseUrl.origin;

      // Look for ads.php link (leads to get.php with download key)
      let adsUrl: string | null = null;
      $('a[href*="ads.php"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.includes('ads.php') && !adsUrl) {
          adsUrl = href.startsWith('http') ? href : `${origin}/${href.replace(/^\//, '')}`;
        }
      });

      // Follow ads.php to get the get.php link with time-limited key
      if (adsUrl) {
        try {
          const adsResponse = await fetchWithRetry(adsUrl, {
            headers: this.headers(),
            maxRetries: 1,
            baseDelay: 2000,
            timeoutMs: 10_000,
          });
          const adsHtml = await adsResponse.text();
          const $ads = cheerio.load(adsHtml);

          $ads('a[href*="get.php"]').each((_, el) => {
            const href = $ads(el).attr('href') || '';
            if (href.includes('get.php')) {
              const fullUrl = href.startsWith('http') ? href : `${origin}/${href.replace(/^\//, '')}`;
              if (!urls.includes(fullUrl)) urls.push(fullUrl);
            }
          });
        } catch {}
      }

      // Also pick up IPFS gateway links as fallback
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.startsWith('http') && (
          href.includes('cloudflare-ipfs.com') ||
          href.includes('gateway.ipfs.io') ||
          href.includes('gateway.pinata.cloud') ||
          href.includes('dweb.link') ||
          href.includes('download.library.lol')
        )) {
          if (!urls.includes(href)) urls.push(href);
        }
      });
    } catch {}
    return urls;
  }
}
