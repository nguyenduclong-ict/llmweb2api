import dotenv from 'dotenv';
dotenv.config();

import { initDatabase } from './app/database';
import { createServer } from './app/server';
import { registerProvider } from './providers/core/manager';
import { deepseekProvider } from './providers/deepseek';
import { chatgptProvider } from './providers/chatgpt';
import { qwenProvider } from './providers/qwen';
import { zaiProvider } from './providers/zai';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function main(): Promise<void> {
  await initDatabase();
  console.log('[DB] Database initialized');

  registerProvider(deepseekProvider);
  console.log('[PROVIDER] Registered: deepseek');

  registerProvider(chatgptProvider);
  console.log('[PROVIDER] Registered: chatgpt');

  registerProvider(qwenProvider);
  console.log('[PROVIDER] Registered: qwen');

  registerProvider(zaiProvider);
  console.log('[PROVIDER] Registered: zai');

  const app = createServer();

  app.listen(PORT, HOST, () => {
    console.log(`[SERVER] llmweb2api running on http://${HOST}:${PORT}`);
    console.log(`[SERVER] OpenAI endpoint:    POST /v1/chat/completions`);
    console.log(`[SERVER] OpenAI endpoint:    POST /v1/responses`);
    console.log(`[SERVER] Anthropic endpoint: POST /v1/messages`);
    console.log(`[SERVER] Gemini endpoint:    POST /v1/models/:model`);
    console.log(`[SERVER] Health check:       GET  /health`);
  });
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
