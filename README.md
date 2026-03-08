# Papercut

MCP server for research paper discovery, download, and AI-powered indexing. Connects Claude to 400M+ academic papers across 7 providers.

## Features

- **7 providers** — Semantic Scholar, OpenAlex, arXiv, CrossRef, CORE, Unpaywall, Anna's Archive
- **Smart search** — Cascade search with cross-provider deduplication and quality assessment
- **Universal input** — Accept DOIs, arXiv IDs, URLs, or plain titles via `find_paper`
- **Multi-source downloads** — URL resolution across OA discovery services with automatic fallback
- **AI indexing** — Haiku-powered paper summarization with key findings extraction
- **Local library** — SQLite with FTS5 full-text search across all indexed papers
- **Pluggable architecture** — Enable/disable providers, set priorities, configure via JSON

## Quick Start

```bash
# Clone and build
git clone https://github.com/yourusername/papercut.git
cd papercut
npm install
npm run build

# Add to Claude Code MCP config (~/.claude.json)
```

Add to your Claude config's `mcpServers`:

```json
{
  "papercut": {
    "command": "node",
    "args": ["C:/path/to/papercut/dist/index.js"]
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_papers` | Search across all enabled providers with deduplication |
| `find_paper` | Resolve a DOI, arXiv ID, URL, or title to a paper; optionally download |
| `download_paper` | Download a paper PDF and optionally index with Haiku AI |
| `list_providers` | Show all providers with status, coverage, and capabilities |
| `search_library` | Full-text search across locally indexed papers (BM25) |
| `get_paper` | Get full details of an indexed paper by ID, DOI, or title |
| `get_paper_text` | Get extracted text of a paper, paginated (~3000 chars/page) |
| `update_paper_index` | Store structured analysis for a paper |
| `get_citations` | Get papers that cite a given paper (cascades across providers) |
| `library_stats` | Get library statistics: total papers, indexed, pending, size |
| `reindex_paper` | Re-run text extraction and Haiku AI indexing on a paper |

## Providers

| Provider | Coverage | Free? | Key Capabilities |
|----------|----------|-------|-----------------|
| Semantic Scholar | 200M+ papers | Yes (API key optional) | Citations, references, TLDR |
| OpenAlex | 240M+ works | Yes (no key needed) | Full metadata, OA discovery, citations |
| arXiv | 2.4M preprints | Yes | Direct PDF URLs, CS/physics/math |
| CrossRef | Publisher metadata | Yes | DOI resolution, publisher data |
| CORE | 125M+ OA papers | Yes (key for full access) | Open access full text |
| Unpaywall | OA URL resolver | Yes | Find free versions of paywalled papers |
| Anna's Archive | Books + papers | Yes | Broadest catalog, last resort |

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar API key (optional, higher rate limits) |
| `CORE_API_KEY` | CORE API key (free, needed for full access) |
| `PAPERCUT_EMAIL` | Email for polite API pools (OpenAlex, CrossRef, Unpaywall) |
| `PAPERCUT_PAPERS_DIR` | Directory for downloaded papers (default: `./papers`) |
| `PAPERCUT_DATA_DIR` | Directory for database (default: `./data`) |

### Config File

Create `papercut.config.json` in the project root (see `papercut.config.example.json`):

```json
{
  "email": "your-email@example.com",
  "providers": {
    "annas-archive": { "enabled": false },
    "core": { "enabled": true, "priority": 5 }
  }
}
```

## Architecture

```
src/
  server.ts              # MCP server, tool handlers
  config.ts              # Config loading (env + JSON file)
  types.ts               # Shared interfaces
  providers/
    registry.ts          # Provider registry with capability lookup
    semantic-scholar.ts  # Semantic Scholar API
    openalex.ts          # OpenAlex API (240M+ works)
    arxiv.ts             # arXiv API
    crossref.ts          # CrossRef API
    core.ts              # CORE API (125M+ OA papers)
    unpaywall.ts         # Unpaywall OA discovery
    annas-archive.ts     # Anna's Archive scraper
  search/
    smart-search.ts      # Cascade search, identifier resolution, dedup
  download/
    downloader.ts        # HTTP download with progress
    url-resolver.ts      # Multi-source URL resolution
    progress.ts          # MCP progress notifications
  indexing/
    text-extractor.ts    # PDF/EPUB text extraction
    haiku-indexer.ts     # Claude Haiku AI indexing via CLI
  storage/
    database.ts          # SQLite + FTS5 storage layer
  utils/
    http.ts              # Rate limiter, fetch with retry
```

## License

MIT
