#!/usr/bin/env node

import { PapercutServer } from './server.js';

const server = new PapercutServer();
server.run().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
