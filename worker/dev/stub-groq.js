/**
 * A stand-in for Groq, for local development without an API key and for
 * end-to-end tests.
 *
 * It does two useful things beyond returning a canned draft:
 *   - asserts the Worker actually sent structured-output constraints, so a
 *     regression that drops response_format shows up here rather than as a
 *     mysteriously loose draft in production;
 *   - answers from the template it was given, so the line_code guardrail is
 *     exercised for real.
 *
 * Run: node dev/stub-groq.js [port]
 */

import { createServer } from 'node:http';

const port = Number(process.argv[2] || 8799);

/** Set STUB_MODE=bad to make it return a contract-violating draft. */
const MODE = process.env.STUB_MODE || 'good';

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }

    const problems = [];
    // Either constraint is acceptable — the Worker tries json_schema and falls
    // back to json_object on models that do not serve it. What is never
    // acceptable is asking for unconstrained prose.
    const format = payload.response_format?.type;
    if (format !== 'json_schema' && format !== 'json_object') {
      problems.push('request did not constrain the response to JSON');
    }
    if (format === 'json_schema' && payload.response_format?.json_schema?.strict !== true) {
      problems.push('json_schema mode did not set strict: true');
    }
    // In json_object mode the schema travels in the system prompt instead.
    const schemaText = format === 'json_schema'
      ? JSON.stringify(payload.response_format?.json_schema?.schema ?? {})
      : String(payload.messages?.find((m) => m.role === 'system')?.content ?? '');
    for (const word of ['price', 'cost', 'rate', 'total']) {
      if (schemaText.includes(`"${word}`)) problems.push(`schema exposes a "${word}" field to the model`);
    }
    if (problems.length) {
      console.error('[stub] REJECTED:', problems.join('; '));
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: problems.join('; ') } }));
      return;
    }

    // A multimodal request sends content as an array of text and image parts.
    const content = payload.messages?.find((m) => m.role === 'user')?.content ?? '{}';
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    const images = parts.filter((p) => p.type === 'image_url');
    const text = parts.find((p) => p.type === 'text')?.text ?? '{}';

    let ctx = {};
    try {
      ctx = JSON.parse(text);
    } catch { /* leave empty */ }

    // The Worker should never say photos are attached when they are not.
    if ((ctx.site_photos_attached ?? 0) !== images.length) {
      console.error(`[stub] REJECTED: prompt says ${ctx.site_photos_attached} photos, request carried ${images.length}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'photo count mismatch between prompt and payload' } }));
      return;
    }

    const codes = (ctx.matched_template?.line_items ?? []).map((l) => l.line_code);
    console.log(`[stub] drafting for "${(ctx.job_description || '').slice(0, 50)}" · ${images.length} photo(s) · codes: ${codes.join(', ')}`);

    const draft = MODE === 'bad' ? badDraft(codes)
      : MODE === 'photo-liar' ? photoLiarDraft(codes)
        : goodDraft(codes, ctx, images.length);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'stub-1',
      model: payload.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(draft) } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    }));
  });
});

/** The worked example from docs/auto-quoting/ui-and-ai-spec.md §2.5. */
function goodDraft(codes, ctx, photoCount = 0) {
  const has = (c) => codes.includes(c);
  const items = [];

  if (has('scaffold_erect')) {
    // With a photo to look at, the erect line is scaled off the elevation rather
    // than guessed from the wording — a different provenance, still an estimate.
    items.push(photoCount > 0 ? {
      line_code: 'scaffold_erect',
      description: 'Scaffold erect',
      quantity_estimate: 48,
      unit: 'm2',
      source: 'photo_inferred',
      confidence: 'medium',
      note: 'Scaled off the rear elevation photo against the door height — roughly 8m wide by 6m to eaves. Confirm on site.',
    } : {
      line_code: 'scaffold_erect',
      description: 'Scaffold erect',
      quantity_estimate: 45,
      unit: 'm2',
      source: 'ai_inferred',
      confidence: 'medium',
      note: "Estimated from '2 lifts, rear of property' — confirm actual measurement on site",
    });
  }
  if (has('scaffold_hire')) {
    items.push({
      line_code: 'scaffold_hire',
      description: 'Scaffold hire',
      quantity_estimate: 5,
      unit: 'days',
      source: 'explicit_in_description',
      confidence: 'high',
      note: null,
    });
  }
  if (has('scaffold_dismantle')) {
    items.push({
      line_code: 'scaffold_dismantle',
      description: 'Dismantle',
      quantity_estimate: 1,
      unit: 'job',
      source: 'template_default',
      confidence: 'high',
      note: null,
    });
  }
  if (!items.length && codes.length) {
    items.push({
      line_code: codes[0],
      description: ctx.matched_template.line_items[0].description,
      quantity_estimate: 1,
      unit: ctx.matched_template.line_items[0].unit || 'job',
      source: 'template_default',
      confidence: 'high',
      note: null,
    });
  }

  return {
    job_type: ctx.matched_template?.job_type || 'domestic_scaffold_erect',
    confidence: 'medium',
    line_items: items,
    assumptions: [
      'Assumed standard domestic access scaffold, not industrial',
      'Assumed no special permit/road closure required — not mentioned',
    ],
    flags_for_owner_review: photoCount > 0
      ? [
        'Scaffold m² was scaled off a photo — measure before sending',
        'Photo shows the rear elevation only; the sides are not visible',
        'No mention of ground conditions — confirm access is clear',
      ]
      : [
        'Scaffold m² is an estimate — confirm before sending',
        'No mention of ground conditions — confirm access is clear',
      ],
  };
}

/** Claims to have measured a photo that was never attached. */
function photoLiarDraft(codes) {
  return {
    job_type: 'domestic_scaffold_erect',
    confidence: 'medium',
    line_items: [{
      line_code: codes[0] || 'scaffold_erect',
      description: 'Scaffold erect',
      quantity_estimate: 48,
      unit: 'm2',
      source: 'photo_inferred',
      confidence: 'medium',
      note: 'Scaled off the site photo against the door height',
    }],
    assumptions: [],
    flags_for_owner_review: [],
  };
}

/** Violates the contract in two ways the wire schema cannot catch. */
function badDraft(codes) {
  return {
    job_type: 'domestic_scaffold_erect',
    confidence: 'high',
    line_items: [
      {
        line_code: codes[0] || 'scaffold_erect',
        description: 'Scaffold erect',
        quantity_estimate: 45,
        unit: 'm2',
        source: 'ai_inferred',
        confidence: 'high',   // inferred cannot be high
        note: null,           // and must carry a note
      },
    ],
    assumptions: [],
    flags_for_owner_review: [],
  };
}

server.listen(port, '127.0.0.1', () => {
  console.log(`[stub] Groq stub listening on http://127.0.0.1:${port} (mode: ${MODE})`);
});
