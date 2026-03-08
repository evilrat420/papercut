import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { DownloadProgress } from '../types.js';

export class ProgressReporter {
  private server: Server;

  constructor(server: Server) {
    this.server = server;
  }

  async report(progressToken: string | number | undefined, progress: DownloadProgress): Promise<void> {
    if (!progressToken) return;

    try {
      await this.server.notification({
        method: 'notifications/progress',
        params: {
          progressToken,
          total: progress.totalBytes || 0,
          progress: progress.bytesDownloaded,
          message: progress.message,
        } as any,
      });
    } catch {
      // Best-effort: swallow notification errors
    }
  }
}
