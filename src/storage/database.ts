import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import type { IndexedPaper, LibraryStats } from '../types.js';
import { titleSimilarity } from '../utils/dedup.js';

export class PaperDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS papers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        authors TEXT DEFAULT '[]',
        year INTEGER,
        abstract TEXT,
        venue TEXT,
        doi TEXT,
        arxiv_id TEXT,
        md5 TEXT,
        file_path TEXT,
        file_size INTEGER,
        page_count INTEGER,
        full_text TEXT,
        summary TEXT,
        topics TEXT DEFAULT '[]',
        key_findings TEXT DEFAULT '[]',
        methodology TEXT,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        indexing_status TEXT NOT NULL DEFAULT 'pending',
        indexing_error TEXT,
        file_format TEXT DEFAULT 'pdf'
      );

      CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi);
      CREATE INDEX IF NOT EXISTS idx_papers_md5 ON papers(md5);
      CREATE INDEX IF NOT EXISTS idx_papers_provider ON papers(provider, external_id);
      CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(indexing_status);
      CREATE INDEX IF NOT EXISTS idx_papers_title ON papers(title);
    `);

    // Migrations: add columns if missing (for existing DBs)
    const addColumnIfMissing = (col: string, def: string) => {
      const has = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM pragma_table_info('papers') WHERE name=?`
      ).get(col) as any;
      if (!has?.cnt) {
        this.db.exec(`ALTER TABLE papers ADD COLUMN ${col} ${def}`);
      }
    };

    addColumnIfMissing('file_format', "TEXT DEFAULT 'pdf'");
    addColumnIfMissing('openalex_id', 'TEXT');
    addColumnIfMissing('core_id', 'TEXT');
    addColumnIfMissing('open_access', 'INTEGER DEFAULT 0');
    addColumnIfMissing('oa_url', 'TEXT');

    // Provider URLs table for multi-source URL tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        provider TEXT NOT NULL,
        url_type TEXT NOT NULL DEFAULT 'pdf',
        last_checked TEXT,
        is_alive INTEGER DEFAULT 1,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(paper_id, url)
      );
      CREATE INDEX IF NOT EXISTS idx_provider_urls_paper ON provider_urls(paper_id);
    `);

    // FTS5 virtual table
    const ftsExists = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='papers_fts'`
    ).get();

    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE papers_fts USING fts5(
          title,
          authors,
          abstract,
          full_text,
          summary,
          topics,
          key_findings,
          content='papers',
          content_rowid='id',
          tokenize='porter unicode61'
        );

        CREATE TRIGGER papers_fts_insert AFTER INSERT ON papers BEGIN
          INSERT INTO papers_fts(rowid, title, authors, abstract, full_text, summary, topics, key_findings)
          VALUES (new.id, new.title, new.authors, new.abstract, new.full_text, new.summary, new.topics, new.key_findings);
        END;

        CREATE TRIGGER papers_fts_delete AFTER DELETE ON papers BEGIN
          INSERT INTO papers_fts(papers_fts, rowid, title, authors, abstract, full_text, summary, topics, key_findings)
          VALUES ('delete', old.id, old.title, old.authors, old.abstract, old.full_text, old.summary, old.topics, old.key_findings);
        END;

        CREATE TRIGGER papers_fts_update AFTER UPDATE ON papers BEGIN
          INSERT INTO papers_fts(papers_fts, rowid, title, authors, abstract, full_text, summary, topics, key_findings)
          VALUES ('delete', old.id, old.title, old.authors, old.abstract, old.full_text, old.summary, old.topics, old.key_findings);
          INSERT INTO papers_fts(rowid, title, authors, abstract, full_text, summary, topics, key_findings)
          VALUES (new.id, new.title, new.authors, new.abstract, new.full_text, new.summary, new.topics, new.key_findings);
        END;
      `);
    }
  }

  insert(paper: Omit<IndexedPaper, 'id' | 'added_at'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO papers (title, authors, year, abstract, venue, doi, arxiv_id, md5,
        file_path, file_size, page_count, full_text, summary, topics, key_findings,
        methodology, provider, external_id, indexing_status, indexing_error, file_format,
        openalex_id, core_id, open_access, oa_url)
      VALUES (@title, @authors, @year, @abstract, @venue, @doi, @arxiv_id, @md5,
        @file_path, @file_size, @page_count, @full_text, @summary, @topics, @key_findings,
        @methodology, @provider, @external_id, @indexing_status, @indexing_error, @file_format,
        @openalex_id, @core_id, @open_access, @oa_url)
    `);

    const result = stmt.run({
      title: paper.title,
      authors: JSON.stringify(paper.authors),
      year: paper.year ?? null,
      abstract: paper.abstract ?? null,
      venue: paper.venue ?? null,
      doi: paper.doi ?? null,
      arxiv_id: paper.arxiv_id ?? null,
      md5: paper.md5 ?? null,
      file_path: paper.file_path ?? null,
      file_size: paper.file_size ?? null,
      page_count: paper.page_count ?? null,
      full_text: paper.full_text ?? null,
      summary: paper.summary ?? null,
      topics: JSON.stringify(paper.topics ?? []),
      key_findings: JSON.stringify(paper.key_findings ?? []),
      methodology: paper.methodology ?? null,
      provider: paper.provider,
      external_id: paper.external_id,
      indexing_status: paper.indexing_status,
      indexing_error: paper.indexing_error ?? null,
      file_format: paper.file_format ?? 'pdf',
      openalex_id: paper.openalex_id ?? null,
      core_id: paper.core_id ?? null,
      open_access: paper.open_access ? 1 : 0,
      oa_url: paper.oa_url ?? null,
    });

    return result.lastInsertRowid as number;
  }

  addProviderUrl(paperId: number, url: string, provider: string, urlType: string = 'pdf'): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO provider_urls (paper_id, url, provider, url_type)
      VALUES (?, ?, ?, ?)
    `).run(paperId, url, provider, urlType);
  }

  getProviderUrls(paperId: number): Array<{ url: string; provider: string; url_type: string; is_alive: boolean }> {
    return (this.db.prepare(
      'SELECT url, provider, url_type, is_alive FROM provider_urls WHERE paper_id = ? ORDER BY is_alive DESC'
    ).all(paperId) as any[]).map(r => ({ ...r, is_alive: !!r.is_alive }));
  }

  search(query: string, limit: number = 10): IndexedPaper[] {
    if (!query || !query.trim()) return [];

    // Sanitize FTS5 query: escape special chars, wrap bare words as terms
    const sanitized = this.sanitizeFtsQuery(query);

    try {
      const rows = this.db.prepare(`
        SELECT p.*, bm25(papers_fts, 5.0, 3.0, 4.0, 1.0, 3.0, 2.0, 2.0) as rank
        FROM papers_fts fts
        JOIN papers p ON p.id = fts.rowid
        WHERE papers_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(sanitized, limit) as any[];

      return rows.map(r => this.rowToPaper(r));
    } catch {
      // If FTS query still fails (complex syntax), fall back to LIKE search
      const rows = this.db.prepare(`
        SELECT * FROM papers
        WHERE title LIKE ? OR abstract LIKE ? OR summary LIKE ?
        ORDER BY added_at DESC
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as any[];

      return rows.map(r => this.rowToPaper(r));
    }
  }

  private sanitizeFtsQuery(query: string): string {
    // Strip characters that break FTS5 syntax
    let cleaned = query.replace(/[":(){}[\]^~\\]/g, ' ').trim();
    // Collapse whitespace
    cleaned = cleaned.replace(/\s+/g, ' ');
    if (!cleaned) return '""';
    return cleaned;
  }

  getById(id: number): IndexedPaper | null {
    const row = this.db.prepare('SELECT * FROM papers WHERE id = ?').get(id) as any;
    return row ? this.rowToPaper(row) : null;
  }

  getByDoi(doi: string): IndexedPaper | null {
    const row = this.db.prepare('SELECT * FROM papers WHERE doi = ?').get(doi) as any;
    return row ? this.rowToPaper(row) : null;
  }

  findDuplicate(doi?: string | null, md5?: string | null, title?: string): IndexedPaper | null {
    if (doi) {
      const byDoi = this.getByDoi(doi);
      if (byDoi) return byDoi;
    }

    if (md5) {
      const row = this.db.prepare('SELECT * FROM papers WHERE md5 = ?').get(md5) as any;
      if (row) return this.rowToPaper(row);
    }

    if (title) {
      // Use indexed title column with LIKE for initial filter, then Jaccard for precision
      const firstWord = title.split(/\s+/)[0] || title;
      const candidates = this.db.prepare(
        'SELECT * FROM papers WHERE title LIKE ? LIMIT 100'
      ).all(`%${firstWord}%`) as any[];

      for (const row of candidates) {
        if (titleSimilarity(row.title, title) >= 0.85) {
          return this.rowToPaper(row);
        }
      }
    }

    return null;
  }

  getPendingIndexing(): IndexedPaper[] {
    const rows = this.db.prepare(
      `SELECT * FROM papers WHERE indexing_status = 'pending' AND file_path IS NOT NULL`
    ).all() as any[];
    return rows.map(r => this.rowToPaper(r));
  }

  getStats(): LibraryStats {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as totalPapers,
        SUM(CASE WHEN indexing_status = 'indexed' THEN 1 ELSE 0 END) as indexedCount,
        SUM(CASE WHEN indexing_status = 'pending' THEN 1 ELSE 0 END) as pendingCount,
        SUM(CASE WHEN indexing_status = 'failed' THEN 1 ELSE 0 END) as failedCount,
        COALESCE(SUM(file_size), 0) as totalSizeBytes
      FROM papers
    `).get() as any;

    return {
      totalPapers: stats.totalPapers ?? 0,
      indexedCount: stats.indexedCount ?? 0,
      pendingCount: stats.pendingCount ?? 0,
      failedCount: stats.failedCount ?? 0,
      totalSizeBytes: stats.totalSizeBytes ?? 0,
    };
  }

  updateIndexing(
    id: number,
    data: {
      full_text?: string;
      summary?: string;
      topics?: string[];
      key_findings?: string[];
      methodology?: string;
      page_count?: number;
      indexing_status: string;
      indexing_error?: string;
    }
  ) {
    this.db.prepare(`
      UPDATE papers SET
        full_text = COALESCE(@full_text, full_text),
        summary = COALESCE(@summary, summary),
        topics = COALESCE(@topics, topics),
        key_findings = COALESCE(@key_findings, key_findings),
        methodology = COALESCE(@methodology, methodology),
        page_count = COALESCE(@page_count, page_count),
        indexing_status = @indexing_status,
        indexing_error = @indexing_error
      WHERE id = @id
    `).run({
      id,
      full_text: data.full_text ?? null,
      summary: data.summary ?? null,
      topics: data.topics ? JSON.stringify(data.topics) : null,
      key_findings: data.key_findings ? JSON.stringify(data.key_findings) : null,
      methodology: data.methodology ?? null,
      page_count: data.page_count ?? null,
      indexing_status: data.indexing_status,
      indexing_error: data.indexing_error ?? null,
    });
  }

  markFailed(id: number, error: string) {
    this.db.prepare(
      `UPDATE papers SET indexing_status = 'failed', indexing_error = ? WHERE id = ?`
    ).run(error, id);
  }

  listRecent(limit: number = 20): IndexedPaper[] {
    const rows = this.db.prepare(
      'SELECT * FROM papers ORDER BY added_at DESC LIMIT ?'
    ).all(limit) as any[];
    return rows.map(r => this.rowToPaper(r));
  }

  private rowToPaper(row: any): IndexedPaper {
    let authors: string[] = [];
    let topics: string[] = [];
    let key_findings: string[] = [];

    try { authors = JSON.parse(row.authors || '[]'); } catch { authors = []; }
    try { topics = JSON.parse(row.topics || '[]'); } catch { topics = []; }
    try { key_findings = JSON.parse(row.key_findings || '[]'); } catch { key_findings = []; }

    return { ...row, authors, topics, key_findings };
  }

  close() {
    this.db.close();
  }
}
