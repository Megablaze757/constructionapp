/**
 * Run the paste-into-the-dashboard AI worker locally, over plain HTTP.
 *
 *   node dev/ai-worker-server.mjs [port]
 *
 * Same file that goes into Cloudflare, same env vars, on Node instead of the
 * edge. It exists so the browser fallback can be exercised against a real AI
 * worker without deploying one — and so a mistake in the generated file shows up
 * here rather than after someone has pasted it into their dashboard.
 *
 * Reads GROQ_API_KEY, GROQ_BASE_URL, ALLOWED_ORIGINS, AI_SHARED_TOKEN and the
 * model overrides from the environment. Point GROQ_BASE_URL at dev/stub-groq.js
 * to run the whole thing without a key.
 */

import { createServer } from 'node:http';
import worker from '../paste/ai-worker.js';

const port = Number(process.argv[2] || 8790);

const env = {
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  GROQ_BASE_URL: process.env.GROQ_BASE_URL || '',
  GROQ_MODEL: process.env.GROQ_MODEL || '',
  GROQ_VISION_MODEL: process.env.GROQ_VISION_MODEL || '',
  GROQ_STRUCTURED_OUTPUTS: process.env.GROQ_STRUCTURED_OUTPUTS || '',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',
  AI_SHARED_TOKEN: process.env.AI_SHARED_TOKEN || '',
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });

  try {
    const out = await worker.fetch(request, env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`AI worker on http://127.0.0.1:${port}  (groq: ${env.GROQ_BASE_URL || 'api.groq.com'}, key: ${env.GROQ_API_KEY ? 'set' : 'MISSING'})`);
});
