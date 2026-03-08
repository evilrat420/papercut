export interface PaperSearchResult {
  provider: string;
  externalId: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  venue?: string;
  doi?: string;
  arxivId?: string;
  md5?: string;
  citationCount?: number;
  pdfUrl?: string;
  downloadUrls: string[];
  tldr?: string;
  fieldsOfStudy?: string[];
  fileInfo?: string;
}

export interface IndexedPaper {
  id: number;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  venue?: string;
  doi?: string;
  arxiv_id?: string;
  md5?: string;
  file_path?: string;
  file_size?: number;
  page_count?: number;
  full_text?: string;
  summary?: string;
  topics?: string[];
  key_findings?: string[];
  methodology?: string;
  added_at: string;
  provider: string;
  external_id: string;
  file_format?: string;
  indexing_status: 'pending' | 'indexed' | 'failed' | 'skipped';
  indexing_error?: string;
}

export interface HaikuIndexResult {
  title: string;
  authors: string[];
  abstract: string;
  keyTopics: string[];
  summary: string;
  methodology: string;
  keyFindings: string[];
}

export interface DownloadProgress {
  phase: 'downloading' | 'extracting' | 'indexing' | 'complete' | 'failed';
  bytesDownloaded: number;
  totalBytes?: number;
  message: string;
}

export interface SearchOptions {
  query: string;
  providers?: string[];
  limit?: number;
  year?: number;
  yearRange?: { from?: number; to?: number };
}

export interface PaperProvider {
  id: string;
  name: string;
  search(query: string, limit: number, options?: { year?: number; yearRange?: { from?: number; to?: number } }): Promise<PaperSearchResult[]>;
  getDetails?(externalId: string): Promise<PaperSearchResult | null>;
  getCitations?(externalId: string, limit: number): Promise<PaperSearchResult[]>;
  getReferences?(externalId: string, limit: number): Promise<PaperSearchResult[]>;
}

export interface LibraryStats {
  totalPapers: number;
  indexedCount: number;
  pendingCount: number;
  failedCount: number;
  totalSizeBytes: number;
}

export type FileFormat = 'pdf' | 'epub' | 'txt' | 'html' | 'unknown';

export interface TextExtraction {
  text: string;
  pageCount: number;
  format: FileFormat;
  metadata: {
    title?: string;
    author?: string;
    subject?: string;
  };
}
