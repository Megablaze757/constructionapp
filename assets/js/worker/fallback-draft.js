/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/fallback-draft.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * The draft you get when no AI is connected.
 *
 * The app has to be usable before the owner has a Groq key, a Worker, or a
 * proxy — otherwise "set up your infrastructure" stands between them and their
 * first quote. So when nothing can read the description, the template still
 * produces a starting point.
 *
 * What it must not do is pretend. Every line comes back `template_default` at
 * medium confidence with a note saying the description was never read, which
 * puts an amber dot on it and holds the send gate shut until the owner has been
 * through the lot. A template default the owner has checked is a real quote; a
 * template default dressed up as an estimate is a lie the client pays for.
 */

/**
 * Build a contract-shaped draft from the template alone.
 *
 * @param {{job_type: string, line_items: Array<object>}} template
 * @returns {{ok: true, draft: object} | {ok: false, error: string}}
 */
export function templateDraft(template) {
  const items = template?.line_items ?? [];
  // Optional lines are the estimator's judgement call, so an unread description
  // cannot make it. Fall back to the whole list only when nothing is compulsory.
  const chosen = items.filter((li) => li.always_include);
  const source = chosen.length ? chosen : items;

  const lineItems = source
    .map((li) => ({
      line_code: li.line_code,
      description: li.description,
      quantity_estimate: Number(li.default_quantity) > 0 ? Number(li.default_quantity) : 1,
      unit: li.unit,
      source: 'template_default',
      confidence: 'medium',
      note: 'From the template — no AI is connected, so your description was not read. Check this against the job.',
    }));

  if (!lineItems.length) {
    return { ok: false, error: 'The template for this job type has no line items to start from.' };
  }

  return {
    ok: true,
    draft: {
      job_type: template.job_type,
      confidence: 'medium',
      line_items: lineItems,
      assumptions: [
        'Every quantity is the template default. Nothing was read from your description.',
      ],
      flags_for_owner_review: [
        'No AI is connected, so this is the template rather than an estimate of this job.',
        'Check every quantity on site before sending — especially anything that varies by elevation, access or duration.',
      ],
    },
  };
}
