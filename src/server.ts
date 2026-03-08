import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'node:fs';

import { loadConfig, type PapercutConfig } from './config.js';
import { PaperDatabase } from './storage/database.js';
import { Downloader } from './download/downloader.js';
import { ProgressReporter } from './download/progress.js';
import { extractText } from './indexing/text-extractor.js';
import { HaikuIndexer } from './indexing/haiku-indexer.js';
import { ProviderRegistry } from './providers/registry.js';
import { SemanticScholarProvider } from './providers/semantic-scholar.js';
import { ArxivProvider } from './providers/arxiv.js';
import { CrossRefProvider } from './providers/crossref.js';
import { AnnasArchiveProvider } from './providers/annas-archive.js';
import type { PaperSearchResult, IndexedPaper } from './types.js';

// --- Zod Schemas ---

const SearchPapersSchema = z.object({
  query: z.string().describe('Search query for papers'),
  providers: z.array(z.string()).optional().describe('Provider IDs to search (default: all)'),
  limit: z.number().optional().default(10).describe('Max results per provider'),
  year: z.number().optional().describe('Filter to specific year'),
  yearRange: z.object({
    from: z.number().optional(),
    to: z.number().optional(),
  }).optional().describe('Filter to year range'),
});

const DownloadPaperSchema = z.object({
  provider: z.string().describe('Provider ID the paper came from'),
  externalId: z.string().describe('External ID from the provider'),
  pdfUrl: z.string().optional().describe('Direct PDF URL if known'),
  title: z.string().describe('Paper title (used for filename)'),
  skipIndexing: z.boolean().optional().default(false).describe('Skip Haiku AI indexing (default: false)'),
});

const SearchLibrarySchema = z.object({
  query: z.string().describe('Full-text search query'),
  limit: z.number().optional().default(10).describe('Max results'),
});

const GetPaperSchema = z.object({
  id: z.number().optional().describe('Paper ID'),
  doi: z.string().optional().describe('Paper DOI'),
  title: z.string().optional().describe('Paper title (fuzzy match)'),
  includeFullText: z.boolean().optional().default(false).describe('Include full extracted text'),
});

const GetPaperTextSchema = z.object({
  id: z.number().describe('Paper ID'),
  startPage: z.number().optional().describe('Start page (estimated, ~3000 chars/page)'),
  endPage: z.number().optional().describe('End page'),
});

const ReindexPaperSchema = z.object({
  id: z.number().describe('Paper ID to reindex'),
});

const GetCitationsSchema = z.object({
  paperId: z.string().describe('Semantic Scholar paper ID or DOI'),
  limit: z.number().optional().default(20).describe('Max citations to return'),
});

const UpdatePaperIndexSchema = z.object({
  id: z.number().describe('Paper ID in local database'),
  summary: z.string().describe('2-3 paragraph summary of the paper'),
  topics: z.array(z.string()).optional().describe('Key topics/keywords (5-10)'),
  key_findings: z.array(z.string()).optional().describe('Key findings (3-7 bullet points)'),
  methodology: z.string().optional().describe('Brief description of methodology'),
});

// --- Server ---

export class PapercutServer {
  private server: Server;
  private config: PapercutConfig;
  private db!: PaperDatabase;
  private downloader!: Downloader;
  private progress!: ProgressReporter;
  private indexer!: HaikuIndexer;
  private registry!: ProviderRegistry;

  constructor() {
    this.server = new Server(
      { name: 'papercut', version: '2.0.0' },
      { capabilities: { tools: {} } }
    );

    this.config = loadConfig();
    this.init();
    this.setupHandlers();
  }

  private init() {
    // Ensure directories
    for (const dir of [this.config.papersDir, this.config.dataDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new PaperDatabase(this.config.dbPath);
    this.downloader = new Downloader(this.config.papersDir);
    this.progress = new ProgressReporter(this.server);
    this.indexer = new HaikuIndexer();

    // Provider registry
    this.registry = new ProviderRegistry();
    this.registry.register(new SemanticScholarProvider(this.config.semanticScholarApiKey));
    this.registry.register(new ArxivProvider());
    this.registry.register(new CrossRefProvider(this.config.crossrefEmail));
    this.registry.register(new AnnasArchiveProvider());

    // Apply config overrides (enabled/disabled, priority)
    if (Object.keys(this.config.providers).length > 0) {
      this.registry.applyConfig(this.config.providers);
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_papers',
          description: 'Search for research papers across multiple sources (Semantic Scholar, arXiv, CrossRef, Anna\'s Archive). Returns titles, authors, abstracts, and download availability.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query for papers' },
              providers: { type: 'array', items: { type: 'string' }, description: 'Provider IDs to search: semantic-scholar, arxiv, crossref, annas-archive (default: all)' },
              limit: { type: 'number', description: 'Max results per provider (default: 10)' },
              year: { type: 'number', description: 'Filter to specific publication year' },
              yearRange: {
                type: 'object',
                properties: { from: { type: 'number' }, to: { type: 'number' } },
                description: 'Filter to year range',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'download_paper',
          description: 'Download a paper PDF and optionally index it with Haiku for smart search. Shows download progress.',
          inputSchema: {
            type: 'object',
            properties: {
              provider: { type: 'string', description: 'Provider ID the paper came from' },
              externalId: { type: 'string', description: 'External ID from the provider' },
              pdfUrl: { type: 'string', description: 'Direct PDF URL if known' },
              title: { type: 'string', description: 'Paper title (used for filename)' },
              skipIndexing: { type: 'boolean', description: 'Skip Haiku AI indexing (default: false)' },
            },
            required: ['provider', 'externalId', 'title'],
          },
        },
        {
          name: 'update_paper_index',
          description: 'Store structured analysis for a paper. Use after reading paper text with get_paper_text to save your summary, topics, and key findings.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'number', description: 'Paper ID in local database' },
              summary: { type: 'string', description: '2-3 paragraph summary of the paper' },
              topics: { type: 'array', items: { type: 'string' }, description: 'Key topics/keywords (5-10)' },
              key_findings: { type: 'array', items: { type: 'string' }, description: 'Key findings (3-7 bullet points)' },
              methodology: { type: 'string', description: 'Brief description of methodology' },
            },
            required: ['id', 'summary'],
          },
        },
        {
          name: 'search_library',
          description: 'Full-text search across your locally indexed papers using BM25 ranking. Searches titles, abstracts, full text, summaries, and topics.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query (supports AND, OR, NOT operators)' },
              limit: { type: 'number', description: 'Max results (default: 10)' },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_paper',
          description: 'Get full details of an indexed paper by ID, DOI, or title.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'number', description: 'Paper ID in local database' },
              doi: { type: 'string', description: 'Paper DOI' },
              title: { type: 'string', description: 'Paper title (fuzzy matched)' },
              includeFullText: { type: 'boolean', description: 'Include full extracted text (default: false)' },
            },
          },
        },
        {
          name: 'get_paper_text',
          description: 'Get the full extracted text of a paper, optionally paginated (~3000 chars per page).',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'number', description: 'Paper ID' },
              startPage: { type: 'number', description: 'Start page (1-indexed, ~3000 chars/page)' },
              endPage: { type: 'number', description: 'End page' },
            },
            required: ['id'],
          },
        },
        {
          name: 'library_stats',
          description: 'Get statistics about your paper library: total papers, indexed count, pending, failed, total size.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'reindex_paper',
          description: 'Re-run PDF text extraction and Haiku AI indexing on a paper.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'number', description: 'Paper ID to reindex' },
            },
            required: ['id'],
          },
        },
        {
          name: 'get_citations',
          description: 'Get papers that cite a given paper (via Semantic Scholar).',
          inputSchema: {
            type: 'object',
            properties: {
              paperId: { type: 'string', description: 'Semantic Scholar paper ID or DOI' },
              limit: { type: 'number', description: 'Max citations (default: 20)' },
            },
            required: ['paperId'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const progressToken = (request.params as any)._meta?.progressToken;

      try {
        switch (name) {
          case 'search_papers': return await this.handleSearchPapers(args, progressToken);
          case 'download_paper': return await this.handleDownloadPaper(args, progressToken);
          case 'search_library': return await this.handleSearchLibrary(args);
          case 'get_paper': return await this.handleGetPaper(args);
          case 'get_paper_text': return await this.handleGetPaperText(args);
          case 'library_stats': return await this.handleLibraryStats();
          case 'update_paper_index': return await this.handleUpdatePaperIndex(args);
          case 'reindex_paper': return await this.handleReindexPaper(args, progressToken);
          case 'get_citations': return await this.handleGetCitations(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error in ${name}: ${msg}` }] };
      }
    });
  }

  // --- Tool Handlers ---

  private async handleSearchPapers(args: any, progressToken?: string | number) {
    const { query, providers, limit, year, yearRange } = SearchPapersSchema.parse(args);

    // Use specified providers or all enabled search-capable providers
    const searchProviders = providers && providers.length > 0
      ? providers.map(id => this.registry.get(id)).filter((p): p is NonNullable<typeof p> => !!p)
      : this.registry.getByCapability('search');

    const results = await Promise.allSettled(
      searchProviders.map(async (provider) => {
        return { id: provider.id, name: provider.name, results: await provider.search(query, limit, { year, yearRange }) };
      })
    );

    let output = `# Search Results for "${query}"\n\n`;
    let totalResults = 0;
    let failedProviders = 0;

    for (const result of results) {
      if (result.status === 'rejected') {
        failedProviders++;
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        output += `## [Error] ${reason}\n\n`;
        continue;
      }

      const { name, results: papers } = result.value;
      totalResults += papers.length;
      output += `## ${name} (${papers.length} results)\n\n`;

      for (const paper of papers) {
        output += this.formatSearchResult(paper);
      }
    }

    if (totalResults === 0 && failedProviders === searchProviders.length) {
      output += `All ${failedProviders} provider(s) failed. This is likely a network issue.\n`;
    } else if (totalResults === 0) {
      output += `No results found. Try different keywords or broader terms.\n`;
    }

    // Suggest disabled providers
    const disabled = this.registry.getDisabled().filter(p => p.capabilities.search);
    if (disabled.length > 0 && totalResults < limit) {
      output += `\n---\n**Disabled providers:** ${disabled.map(p => p.name).join(', ')} — enable in config for broader coverage.\n`;
    }

    return { content: [{ type: 'text', text: output }] };
  }

  private async handleDownloadPaper(args: any, progressToken?: string | number) {
    const { provider, externalId, pdfUrl, title } = DownloadPaperSchema.parse(args);

    const reportProgress = (p: any) => this.progress.report(progressToken, p);

    // Get paper details from provider if needed
    let paperDetails: PaperSearchResult | null = null;
    const prov = this.registry.get(provider);
    if (prov?.getDetails) {
      try {
        paperDetails = await prov.getDetails(externalId);
      } catch {}
    }

    // Prefer detail page title, but fall back to caller-provided title if detail page returned nothing useful
    const detailTitle = paperDetails?.title?.trim();
    const resolvedTitle = detailTitle && detailTitle.length > 3 ? detailTitle : title;
    const doi = paperDetails?.doi;
    const md5 = paperDetails?.md5;

    // Check for duplicates
    const existing = this.db.findDuplicate(doi, md5, resolvedTitle);
    if (existing) {
      return {
        content: [{
          type: 'text',
          text: `Paper already in library (ID: ${existing.id}): "${existing.title}"\nStatus: ${existing.indexing_status}`,
        }],
      };
    }

    // Resolve download URLs
    const urls: string[] = [];
    if (pdfUrl) urls.push(pdfUrl);
    if (paperDetails?.pdfUrl && !urls.includes(paperDetails.pdfUrl)) urls.push(paperDetails.pdfUrl);
    if (paperDetails?.downloadUrls) {
      for (const u of paperDetails.downloadUrls) {
        if (!urls.includes(u)) urls.push(u);
      }
    }

    // Try OA discovery providers as fallback for DOI-identified papers
    if (urls.length === 0 && doi) {
      const oaProviders = this.registry.getByCapability('oaDiscovery');
      for (const oaProv of oaProviders) {
        if (oaProv.resolveDownloadUrl) {
          try {
            const oaUrl = await oaProv.resolveDownloadUrl(doi);
            if (oaUrl) { urls.push(oaUrl); break; }
          } catch {}
        }
      }
    }

    if (urls.length === 0) {
      // Store metadata without file
      const paperId = this.db.insert({
        title: resolvedTitle,
        authors: paperDetails?.authors || [],
        year: paperDetails?.year,
        abstract: paperDetails?.abstract,
        venue: paperDetails?.venue,
        doi,
        arxiv_id: paperDetails?.arxivId,
        md5,
        provider,
        external_id: externalId,
        indexing_status: 'skipped',
        indexing_error: 'No download URL available',
      });

      let msg = `Paper saved to library (ID: ${paperId}) but no PDF URL available.\n`;
      msg += `Title: "${resolvedTitle}"\n`;
      if (doi) msg += `Tried Unpaywall OA lookup for DOI ${doi} - no open access PDF found.\n`;
      msg += `You can try providing a direct pdfUrl parameter if you find the PDF elsewhere.`;

      return { content: [{ type: 'text', text: msg }] };
    }

    // Download
    await reportProgress({ phase: 'downloading', bytesDownloaded: 0, message: 'Starting download...' });
    const { filePath, fileSize, format } = await this.downloader.download(urls, resolvedTitle, (p) => reportProgress(p));

    // Extract text
    await reportProgress({ phase: 'extracting', bytesDownloaded: fileSize, message: 'Extracting text...' });
    const extraction = await extractText(filePath);

    // Insert into DB with extracted text, status = pending
    const paperId = this.db.insert({
      title: resolvedTitle,
      authors: paperDetails?.authors || [],
      year: paperDetails?.year,
      abstract: paperDetails?.abstract,
      venue: paperDetails?.venue,
      doi,
      arxiv_id: paperDetails?.arxivId,
      md5,
      file_path: filePath,
      file_size: fileSize,
      page_count: extraction.pageCount,
      full_text: extraction.text,
      file_format: format,
      provider,
      external_id: externalId,
      indexing_status: 'pending',
    });

    // Haiku indexing via Claude CLI (runs in background, doesn't block response)
    let indexResult: string = 'pending';
    let haikuSummary = '';
    if (extraction.text.length > 100) {
      try {
        await reportProgress({ phase: 'indexing', bytesDownloaded: fileSize, message: 'Indexing with Haiku...' });

        const indexed = await this.indexer.indexPaper(extraction.text, {
          title: resolvedTitle,
          authors: paperDetails?.authors,
          abstract: paperDetails?.abstract,
        });

        this.db.updateIndexing(paperId, {
          summary: indexed.summary,
          topics: indexed.keyTopics,
          key_findings: indexed.keyFindings,
          methodology: indexed.methodology,
          indexing_status: 'indexed',
        });

        indexResult = 'indexed';
        haikuSummary = `\n## Haiku Summary\n${indexed.summary}\n\n` +
          `## Topics\n${indexed.keyTopics.join(', ')}\n\n` +
          `## Key Findings\n${indexed.keyFindings.map(f => `- ${f}`).join('\n')}`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.db.markFailed(paperId, msg);
        indexResult = `failed: ${msg}`;
      }
    }

    await reportProgress({ phase: 'complete', bytesDownloaded: fileSize, totalBytes: fileSize, message: 'Done' });

    const totalPages = Math.ceil(extraction.text.length / 3000);

    return {
      content: [{
        type: 'text',
        text: `Paper downloaded (ID: ${paperId})\n` +
          `Title: "${resolvedTitle}"\n` +
          `File: ${filePath}\n` +
          `Pages: ${extraction.pageCount} | Size: ${(fileSize / 1024 / 1024).toFixed(1)} MB\n` +
          `Extracted text: ${extraction.text.length} chars (~${totalPages} pages via get_paper_text)\n` +
          `Indexing: ${indexResult}` +
          haikuSummary,
      }],
    };
  }

  private async handleSearchLibrary(args: any) {
    const { query, limit } = SearchLibrarySchema.parse(args);
    const results = this.db.search(query, limit);

    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No results found for "${query}" in your library.` }] };
    }

    let output = `# Library Search: "${query}" (${results.length} results)\n\n`;
    for (const paper of results) {
      output += this.formatIndexedPaper(paper, false);
    }

    return { content: [{ type: 'text', text: output }] };
  }

  private async handleGetPaper(args: any) {
    const { id, doi, title, includeFullText } = GetPaperSchema.parse(args);

    let paper: IndexedPaper | null = null;

    if (id) paper = this.db.getById(id);
    else if (doi) paper = this.db.getByDoi(doi);
    else if (title) paper = this.db.findDuplicate(undefined, undefined, title);

    if (!paper) {
      return { content: [{ type: 'text', text: 'Paper not found.' }] };
    }

    return { content: [{ type: 'text', text: this.formatIndexedPaper(paper, includeFullText ?? false) }] };
  }

  private async handleGetPaperText(args: any) {
    const { id, startPage, endPage } = GetPaperTextSchema.parse(args);

    const paper = this.db.getById(id);
    if (!paper) return { content: [{ type: 'text', text: 'Paper not found.' }] };
    if (!paper.full_text) return { content: [{ type: 'text', text: 'No extracted text available for this paper.' }] };

    const charsPerPage = 3000;
    const totalPages = Math.ceil(paper.full_text.length / charsPerPage);

    const start = Math.max(1, startPage || 1);
    const end = Math.min(totalPages, endPage || totalPages);

    const startChar = (start - 1) * charsPerPage;
    const endChar = end * charsPerPage;
    const text = paper.full_text.slice(startChar, endChar);

    return {
      content: [{
        type: 'text',
        text: `# ${paper.title}\nPages ${start}-${end} of ${totalPages} (~${charsPerPage} chars/page)\n\n${text}`,
      }],
    };
  }

  private async handleLibraryStats() {
    const stats = this.db.getStats();

    return {
      content: [{
        type: 'text',
        text: `# Library Statistics\n\n` +
          `- Total papers: ${stats.totalPapers}\n` +
          `- Indexed (AI): ${stats.indexedCount}\n` +
          `- Pending: ${stats.pendingCount}\n` +
          `- Failed: ${stats.failedCount}\n` +
          `- Total size: ${(stats.totalSizeBytes / 1024 / 1024).toFixed(1)} MB`,
      }],
    };
  }

  private async handleReindexPaper(args: any, progressToken?: string | number) {
    const { id } = ReindexPaperSchema.parse(args);
    const reportProgress = (p: any) => this.progress.report(progressToken, p);

    const paper = this.db.getById(id);
    if (!paper) return { content: [{ type: 'text', text: 'Paper not found.' }] };
    if (!paper.file_path) return { content: [{ type: 'text', text: 'Paper has no downloaded file.' }] };

    await reportProgress({ phase: 'extracting', bytesDownloaded: 0, message: 'Re-extracting text...' });
    const extraction = await extractText(paper.file_path);

    if (extraction.text.length < 100) {
      this.db.markFailed(id, 'Insufficient text extracted from PDF');
      return { content: [{ type: 'text', text: 'Failed: insufficient text in PDF (encrypted or image-only?)' }] };
    }

    // Update extracted text
    this.db.updateIndexing(id, {
      full_text: extraction.text,
      page_count: extraction.pageCount,
      indexing_status: 'pending',
    });

    // Re-index with Haiku
    let indexResult = 'pending';
    let haikuSummary = '';
    try {
      await reportProgress({ phase: 'indexing', bytesDownloaded: 0, message: 'Indexing with Haiku...' });

      const indexed = await this.indexer.indexPaper(extraction.text, {
        title: paper.title,
        authors: paper.authors,
        abstract: paper.abstract || undefined,
      });

      this.db.updateIndexing(id, {
        summary: indexed.summary,
        topics: indexed.keyTopics,
        key_findings: indexed.keyFindings,
        methodology: indexed.methodology,
        indexing_status: 'indexed',
      });

      indexResult = 'indexed';
      haikuSummary = `\n## Summary\n${indexed.summary}\n\n` +
        `## Topics\n${indexed.keyTopics.join(', ')}\n\n` +
        `## Key Findings\n${indexed.keyFindings.map(f => `- ${f}`).join('\n')}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.db.markFailed(id, msg);
      indexResult = `failed: ${msg}`;
    }

    const totalPages = Math.ceil(extraction.text.length / 3000);

    return {
      content: [{
        type: 'text',
        text: `Paper reindexed (ID: ${id})\n` +
          `Pages: ${extraction.pageCount} | Text: ${extraction.text.length} chars (~${totalPages} pages)\n` +
          `Indexing: ${indexResult}` +
          haikuSummary,
      }],
    };
  }

  private async handleUpdatePaperIndex(args: any) {
    const { id, summary, topics, key_findings, methodology } = UpdatePaperIndexSchema.parse(args);

    const paper = this.db.getById(id);
    if (!paper) return { content: [{ type: 'text', text: 'Paper not found.' }] };

    this.db.updateIndexing(id, {
      summary,
      topics: topics || [],
      key_findings: key_findings || [],
      methodology: methodology || undefined,
      indexing_status: 'indexed',
    });

    return {
      content: [{
        type: 'text',
        text: `Paper indexed successfully (ID: ${id})\n` +
          `Title: "${paper.title}"\n` +
          `Topics: ${(topics || []).join(', ')}\n` +
          `Key findings: ${(key_findings || []).length} items\n` +
          `Status: indexed`,
      }],
    };
  }

  private async handleGetCitations(args: any) {
    const { paperId, limit } = GetCitationsSchema.parse(args);

    // Cascade through all providers with citation capability
    const citationProviders = this.registry.getByCapability('citations');
    if (citationProviders.length === 0) {
      return { content: [{ type: 'text', text: 'No citation-capable providers available.' }] };
    }

    for (const provider of citationProviders) {
      try {
        const citations = await provider.getCitations!(paperId, limit);
        if (citations.length > 0) {
          let output = `# Citations for ${paperId} via ${provider.name} (${citations.length} results)\n\n`;
          for (const paper of citations) {
            output += this.formatSearchResult(paper);
          }
          return { content: [{ type: 'text', text: output }] };
        }
      } catch { continue; }
    }

    return { content: [{ type: 'text', text: 'No citations found across any provider.' }] };
  }

  // --- Formatting ---

  private formatSearchResult(paper: PaperSearchResult): string {
    let out = `### ${paper.title}\n`;
    if (paper.authors.length > 0) out += `**Authors:** ${paper.authors.join(', ')}\n`;
    if (paper.year) out += `**Year:** ${paper.year}`;
    if (paper.venue) out += ` | **Venue:** ${paper.venue}`;
    if (paper.citationCount !== undefined) out += ` | **Citations:** ${paper.citationCount}`;
    out += '\n';
    if (paper.doi) out += `**DOI:** ${paper.doi}\n`;
    if (paper.arxivId) out += `**arXiv:** ${paper.arxivId}\n`;
    out += `**Provider:** ${paper.provider} | **ID:** ${paper.externalId}\n`;
    if (paper.pdfUrl) out += `**PDF:** Available\n`;
    else if (paper.downloadUrls.length > 0) out += `**PDF:** Available (${paper.downloadUrls.length} source(s))\n`;
    else out += `**PDF:** Not available\n`;
    if (paper.tldr) out += `**TL;DR:** ${paper.tldr}\n`;
    if (paper.abstract) out += `**Abstract:** ${paper.abstract.substring(0, 300)}${paper.abstract.length > 300 ? '...' : ''}\n`;
    if (paper.fileInfo) out += `**File Info:** ${paper.fileInfo}\n`;
    out += '\n';
    return out;
  }

  private formatIndexedPaper(paper: IndexedPaper, includeFullText: boolean): string {
    let out = `### ${paper.title} (ID: ${paper.id})\n`;
    if (paper.authors.length > 0) out += `**Authors:** ${paper.authors.join(', ')}\n`;
    if (paper.year) out += `**Year:** ${paper.year}`;
    if (paper.venue) out += ` | **Venue:** ${paper.venue}`;
    out += '\n';
    if (paper.doi) out += `**DOI:** ${paper.doi}\n`;
    out += `**Status:** ${paper.indexing_status} | **Added:** ${paper.added_at}\n`;
    if (paper.file_path) out += `**File:** ${paper.file_path} (${paper.page_count || '?'} pages)\n`;
    if (paper.abstract) out += `\n**Abstract:** ${paper.abstract}\n`;
    if (paper.summary) out += `\n**Summary:**\n${paper.summary}\n`;
    if (paper.topics && paper.topics.length > 0) out += `\n**Topics:** ${paper.topics.join(', ')}\n`;
    if (paper.key_findings && paper.key_findings.length > 0) {
      out += `\n**Key Findings:**\n${paper.key_findings.map(f => `- ${f}`).join('\n')}\n`;
    }
    if (paper.methodology) out += `\n**Methodology:** ${paper.methodology}\n`;
    if (includeFullText && paper.full_text) {
      out += `\n---\n**Full Text:**\n${paper.full_text}\n`;
    }
    out += '\n';
    return out;
  }

  // --- Run ---

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Papercut MCP Server running on stdio');
  }
}
