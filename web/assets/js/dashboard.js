import './pwa.js';
import { api, ownerToken, API_BASE, price, titleCase, formatDate, esc, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);

const banner = (kind, html) =>
  ($('banner').innerHTML = `<div class="card"><div class="card-body"><div class="notice notice-${kind}">${html}</div></div></div>`);

async function boot() {
  if (!API_BASE || !ownerToken.get()) {
    return banner('bad', 'Not configured. Set your owner token on the <a href="index.html">quotes screen</a>.');
  }
  await load();
}

async function load() {
  try {
    render(await api.dashboard());
    $('banner').innerHTML = '';
  } catch (err) {
    banner('bad', err instanceof ApiError && err.status === 401
      ? '<strong>Token rejected.</strong> Check it on the <a href="index.html">quotes screen</a>.'
      : `<strong>Error.</strong> ${esc(err.message)}`);
  }
}

$('refresh-btn').addEventListener('click', load);

function render(d) {
  renderTiles(d.headline);
  renderDecisions(d.decisions);
  renderRisks(d.at_risk);
  renderJobs(d.jobs);
  renderCash(d.cash);
  renderMargin(d.margin);
  renderReliability(d.reliability);
}

/* ------------------------------------------------------------------ tiles */

function renderTiles(h) {
  const tile = (label, value, sub, tone = '') => `
    <div class="tile ${tone}">
      <span class="tile-label">${label}</span>
      <span class="tile-value">${value}</span>
      <span class="tile-sub">${sub}</span>
    </div>`;

  $('tiles').innerHTML = [
    tile('Outstanding', price(h.outstanding),
      h.overdue_count ? `${h.overdue_count} overdue` : 'none overdue',
      h.overdue_amount > 0 ? 'is-bad' : ''),
    tile('Cash in 30d', price(h.cash_next_30), 'expected', ''),
    tile('Active jobs', h.active_jobs, `${h.on_track_jobs} on track`, ''),
    tile('At risk', h.at_risk_jobs, h.at_risk_jobs ? 'see below' : 'all clear',
      h.at_risk_jobs > 0 ? 'is-bad' : 'is-ok'),
  ].join('');
}

/* -------------------------------------------------------------- decisions */

function renderDecisions(d) {
  const rows = [
    ...d.escalated.map((t) => ({
      tone: 'bad',
      title: t.title,
      detail: `${t.person_name || 'unassigned'} · ${t.days_late} days past due · ${esc(t.site_address || t.client_name || '')}`,
      href: `jobs.html?id=${encodeURIComponent(t.job_id)}`,
    })),
    ...d.unread_issues.map((l) => ({
      tone: 'bad',
      title: `${titleCase(l.kind)} on ${l.site_address || l.client_name}`,
      detail: l.body,
      href: `jobs.html?id=${encodeURIComponent(l.job_id)}`,
    })),
    ...d.unassigned.map((t) => ({
      tone: 'warn',
      title: t.title,
      detail: `Nobody owns this · ${esc(t.site_address || t.client_name || '')}`,
      href: `jobs.html?id=${encodeURIComponent(t.job_id)}`,
    })),
    ...d.awaiting_photo.map((t) => ({
      tone: 'warn',
      title: t.title,
      detail: 'Ticked off but the photo proof is missing',
      href: `jobs.html?id=${encodeURIComponent(t.job_id)}`,
    })),
  ];

  $('decisions-card').hidden = rows.length === 0;
  $('decisions').innerHTML = rows.map((r) => `
    <a class="quote-item" href="${r.href}">
      <span class="who">${r.tone === 'bad' ? '<span class="dot"></span> ' : ''}${esc(r.title)}</span>
      <span class="badge ${r.tone === 'bad' ? 'badge-bad' : 'badge-warn'}">${r.tone === 'bad' ? 'now' : 'soon'}</span>
      <span class="meta">${esc(r.detail)}</span>
    </a>`).join('');
}

/* ------------------------------------------------------------------ risks */

function renderRisks(risks) {
  $('risk-card').hidden = risks.length === 0;
  $('risks').innerHTML = risks.map((r) => `
    <a class="quote-item" href="jobs.html?id=${encodeURIComponent(r.job_id)}">
      <span class="who">${esc(r.client_name)}</span>
      <span class="badge badge-bad">${r.severity} issue${r.severity > 1 ? 's' : ''}</span>
      <span class="meta">${esc(r.site_address || '')}</span>
      <span class="meta">${r.reasons.map((x) => esc(x.text)).join(' · ')}</span>
    </a>`).join('');
}

/* ------------------------------------------------------------------- jobs */

function renderJobs(jobs) {
  $('jobs').innerHTML = jobs.length
    ? jobs.map((j) => `
        <a class="quote-item" href="jobs.html?id=${encodeURIComponent(j.id)}">
          <span class="who">${esc(j.site_address || j.client_name)}</span>
          <span class="badge ${j.at_risk ? 'badge-bad' : 'badge-ok'}">${j.percent}%</span>
          <span class="meta">
            ${esc(j.client_name)} · ${esc(titleCase(j.job_type))} · ${esc(j.status.replace('_', ' '))}
            ${j.target_end ? ` · due ${esc(formatDate(j.target_end))}` : ''}
          </span>
          <span class="meta">👷 ${j.crew.length ? j.crew.map(esc).join(', ') : '<em>nobody assigned</em>'}</span>
          <span class="progress" style="grid-column:1/-1;margin-top:6px">
            <span style="width:${j.percent}%;background:var(--${j.at_risk ? 'bad' : 'ok'})"></span>
          </span>
        </a>`).join('')
    : '<div class="card-body muted">No jobs running.</div>';
}

/* ------------------------------------------------------------------- cash */

function renderCash(cash) {
  const f = cash.forecast;
  $('cash').innerHTML = `
    <div class="total-row"><span class="label">Owed to you</span><span class="value">${price(cash.outstanding)}</span></div>
    ${cash.overdue_amount > 0
      ? `<div class="notice notice-bad">${price(cash.overdue_amount)} of that is already overdue.</div>`
      : '<div class="notice notice-ok">Nothing overdue.</div>'}
    <div class="aging">
      <div class="aging-cell ${f.overdue > 0 ? 'is-late' : ''}">
        <span class="aging-label">late</span><span class="aging-amount">${price(f.overdue)}</span>
      </div>
      <div class="aging-cell"><span class="aging-label">30 days</span><span class="aging-amount">${price(f.d30)}</span></div>
      <div class="aging-cell"><span class="aging-label">60 days</span><span class="aging-amount">${price(f.d60)}</span></div>
      <div class="aging-cell"><span class="aging-label">90 days</span><span class="aging-amount">${price(f.d90)}</span></div>
    </div>
    ${cash.needs_chasing.length ? `
      <div class="notice notice-warn"><strong>Chase first</strong>
        <ul>${cash.needs_chasing.map((n) => `<li>${esc(n.client_name)} — ${price(n.outstanding)}, ${n.days_overdue} days late</li>`).join('')}</ul>
      </div>` : ''}
    ${f.assumptions.length ? `
      <details class="sop-detail">
        <summary>What this forecast assumes</summary>
        <ul class="sop-steps">${f.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
      </details>` : ''}`;
}

/* ----------------------------------------------------------------- margin */

function renderMargin(m) {
  if (!m) {
    $('margin').innerHTML = '<p class="muted" style="margin:0">No live jobs to measure.</p>';
    return;
  }
  const tone = m.over_budget_jobs > 0 ? 'badge-bad' : 'badge-ok';
  $('margin').innerHTML = `
    <div class="total-row">
      <span class="label">Quoted margin</span>
      <span><span class="badge badge-ok">${m.quoted_margin}%</span> <span class="muted">on ${m.jobs} live job${m.jobs > 1 ? 's' : ''}</span></span>
    </div>
    <div class="total-row">
      <span class="label">Cost booked so far</span>
      <span class="value" style="font-size:20px">${price(m.cost_so_far)}</span>
    </div>
    ${m.margin_so_far === null
      // Never show a margin derived from no data — see marginHealth().
      ? '<div class="notice notice-warn">No costs logged against live jobs yet, so there is nothing to compare the quote against.</div>'
      : `<div class="total-row">
           <span class="label">Margin so far</span>
           <span><span class="badge ${tone}">${m.margin_so_far}%</span>
           <span class="muted">based on ${m.jobs_with_costs} of ${m.jobs} jobs</span></span>
         </div>`}
    ${m.over_budget_jobs > 0
      ? `<div class="notice notice-bad">${m.over_budget_jobs} job${m.over_budget_jobs > 1 ? 's are' : ' is'} already past the expected cost.</div>`
      : ''}`;
}

/* ------------------------------------------------------------ reliability */

function renderReliability(r) {
  const scored = r.board.filter((b) => b.score !== null);
  const unscored = r.board.filter((b) => b.score === null);

  $('reliability').innerHTML = `
    ${r.concerns.length ? `
      <div class="notice notice-bad"><strong>Worth a conversation</strong>
        <ul>${r.concerns.map((c) => `<li>${esc(c.name)} (${c.score}) — ${c.reasons.map(esc).join('; ')}</li>`).join('')}</ul>
      </div>` : ''}

    ${scored.length ? scored.map((b) => `
      <div class="total-row">
        <span>${esc(b.name)} <span class="muted">${esc(b.role || b.kind)}</span></span>
        <span><span class="badge ${b.score >= 80 ? 'badge-ok' : b.score >= 60 ? 'badge-warn' : 'badge-bad'}">${b.score}</span></span>
      </div>
      <div class="muted" style="font-size:13px;margin:-4px 0 6px">
        ${b.on_time}/${b.with_deadline} on time
        ${b.escalations ? ` · ${b.escalations} escalated` : ''}
        ${b.proof_required ? ` · ${b.proof_supplied}/${b.proof_required} photo proofs` : ''}
      </div>`).join('')
      : '<p class="muted" style="margin:0">Nobody has enough completed tasks to score yet.</p>'}

    ${unscored.length ? `<p class="muted" style="margin:0">Not enough history yet: ${unscored.map((b) => esc(b.name)).join(', ')}.</p>` : ''}

    <details class="sop-detail">
      <summary>What this score is built from</summary>
      <ul class="sop-steps">${r.measured.map((m) => `<li>✔ ${esc(m)}</li>`).join('')}</ul>
      <p class="muted" style="margin:0"><strong>Not measured yet</strong> — deliberately left out rather than guessed:</p>
      <ul class="sop-steps">${r.not_measured.map((m) => `<li>✘ ${esc(m)}</li>`).join('')}</ul>
    </details>`;
}

boot();
