import './db.js';
import { start } from './http.js';
import { startWorker } from './worker.js';
import { closeBrowser } from './render/renderer.js';

startWorker();
await start();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await closeBrowser(); process.exit(0); });
