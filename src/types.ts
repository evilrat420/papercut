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
  openalex_id?: string;
  core_id?: string;
  open_access?: boolean;
  oa_url?: string;
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

export interface ProviderConfig {
  enabled: boolean;
  priority?: number;
  apiKey?: string;
  email?: string;
}

export interface ProviderCapabilities {
  search: boolean;
  details: boolean;
  citations: boolean;
  references: boolean;
  download: boolean;
  doiLookup: boolean;
  oaDiscovery: boolean;
}

export interface SearchFilterOptions {
  year?: number;
  yearRange?: { from?: number; to?: number };
}

export interface PaperProvider {
  id: string;
  name: string;
  capabilities: ProviderCapabilities;
  priority: number;
  search(query: string, limit: number, options?: SearchFilterOptions): Promise<PaperSearchResult[]>;
  getDetails?(externalId: string): Promise<PaperSearchResult | null>;
  getCitations?(externalId: string, limit: number): Promise<PaperSearchResult[]>;
  getReferences?(externalId: string, limit: number): Promise<PaperSearchResult[]>;
  resolveByDoi?(doi: string): Promise<PaperSearchResult | null>;
  resolveDownloadUrl?(doi: string): Promise<string | null>;
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
