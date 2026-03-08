# Changelog

## v2.0.0 (2026-03-08)

Major upgrade: pluggable provider architecture, smart search, and 3 new providers.

### Added
- **Provider Registry** — Pluggable architecture with capability-based lookup, priority ordering, and config-driven enable/disable
- **OpenAlex Provider** — 240M+ works, full metadata, OA discovery, citations/references (no API key needed)
- **Unpaywall Provider** — Open access URL resolution by DOI (100K requests/day free)
- **CORE Provider** — 125M+ open access papers with full-text search
- **Smart Search** — Cascade search across all providers with quality assessment and deduplication
- **`find_paper` tool** — Accept DOI, arXiv ID, URL, Semantic Scholar ID, or title; resolve and optionally download
- **`list_providers` tool** — Show all providers with status, coverage estimates, and capabilities
- **URL Resolver** — Multi-source URL resolution with priority ordering (arXiv > DOI > NCBI > OA > IPFS)
- **Provider suggestions** — When search results are sparse, suggests enabling disabled providers
- **Config file support** — Optional `papercut.config.json` for provider configuration
- **Database migrations** — New columns for OpenAlex ID, CORE ID, OA status; `provider_urls` table for multi-URL tracking

### Changed
- `search_papers` now searches all enabled providers in parallel with cross-provider deduplication
- `get_citations` cascades through all citation-capable providers (not just Semantic Scholar)
- `download_paper` uses URL Resolver for multi-source URL fallback with OA discovery
- Provider capabilities are now explicitly declared (search, details, citations, references, download, doiLookup, oaDiscovery)
- All existing providers updated with capability declarations and priority fields

### Technical
- 7 providers (up from 4), 11 tools (up from 9)
- ~2,400 lines of TypeScript (up from ~1,700)
- Estimated coverage: 400M+ unique papers across all providers

## v1.0.0 (2026-02)

Initial release with 4 providers and 9 tools.

- Semantic Scholar, arXiv, CrossRef, Anna's Archive providers
- Paper search, download, text extraction, Haiku AI indexing
- SQLite with FTS5 full-text search
- MCP server with stdio transport
