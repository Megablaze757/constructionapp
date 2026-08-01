# 🏗️ BuilderOS — The Complete Business System for Construction Owners

*Buy back your time. Run the business without living inside it.*

Status: draft spec
Scope: whole-system vision, feature set, roadmap

---

## Table of Contents

1. [System Overview & Philosophy](#1-system-overview--philosophy)
2. [Complete Feature Specification](#2-complete-feature-specification)
3. [Owner Dashboard Module](#3-owner-dashboard-module)
4. [Automation Engine](#4-automation-engine)
5. [SOP & Systemization Module](#5-sop--systemization-module)
6. [Team & Subcontractor Management](#6-team--subcontractor-management)
7. [Client Care & Sales Module](#7-client-care--sales-module)
8. [Financial Intelligence Module](#8-financial-intelligence-module)
9. [Integration Ecosystem](#9-integration-ecosystem)
10. [Security & Privacy](#10-security--privacy)
11. [Deployment Strategy](#11-deployment-strategy)
12. [Complete Implementation Roadmap (12 Months)](#12-complete-implementation-roadmap-12-months)
13. [Success Metrics & KPIs](#13-success-metrics--kpis)
14. [Cost Breakdown](#14-cost-breakdown)
15. [Maintenance & Evolution](#15-maintenance--evolution)
16. [Next Steps](#16-next-steps)

Related detail specs:

- [Auto-Quoting & AI Estimating Module](auto-quoting/README.md)
- [Auto-Quoting — UI wireframes & AI assistant spec](auto-quoting/ui-and-ai-spec.md)

---

## 1. System Overview & Philosophy

### 1.1 Core Vision

Most construction business owners are brilliant at the trade and trapped inside the business.
They started as a labourer, tradesperson, or site hand — and are now the person chasing payments,
firefighting staff problems, and unable to take a day off without something breaking. BuilderOS
exists to install the systems, delegation structure, and visibility that let an owner run the
business instead of being run by it.

This mirrors the core premise behind coaches like Joe Carr (Stellar Scaffolding, Joe Carr
Construction Academy): comfort never builds anything great, but chaos doesn't scale — **systems
do**.

### 1.2 Core Principles

- **Owner-independence first** — every feature should reduce how much the business needs the
  owner physically present.
- **Exception-based visibility** — don't show the owner everything; show them only what needs
  their decision.
- **Systems over heroics** — every recurring task becomes an SOP, not a favour someone remembers
  to do.
- **Cash is oxygen** — payment chasing and cash flow visibility are first-class citizens, not an
  afterthought.
- **Field-first design** — built for someone on a site in the rain with gloves on, not an office
  worker at a desk.

### 1.3 Interaction Methods

1. **Mobile app (primary)** — built for site use, one-handed, big touch targets, works with poor
   signal.
2. **Owner dashboard (web)** — command centre for the person running the business.
3. **WhatsApp/SMS bridge** — many tradespeople live in WhatsApp; meet them there.
4. **Voice notes → text** — log site issues by talking, not typing.

---

## 2. Complete Feature Specification

### 2.1 Core Features (Always Available)

| Feature | Description | Priority |
| --- | --- | --- |
| Job/Project Tracker | Every active job, status, address, key dates | P0 |
| SOP Library | Pre-built + custom checklists per job/role type | P0 |
| Staff/Sub Directory | Contact, reliability rating, assigned jobs | P0 |
| Daily Site Log | Field team logs progress/issues without owner on-site | P0 |
| Owner Dashboard | Single view of cash, jobs, team, risk | P0 |
| Push/SMS Alerts | Only exceptions that need owner action | P0 |
| Photo/Doc Upload | Site photos, signed docs, variations | P1 |
| Offline Mode | Log site data with no signal, sync later | P1 |

### 2.2 Business Operations Features (P0)

| Module | Features |
| --- | --- |
| Job Management | Job stages, timeline, materials, site notes, risk flags |
| Staff/Sub Management | Reliability scoring, availability, assigned jobs, onboarding checklist |
| Client Care | Enquiry → appraisal → booked → completed pipeline, scheduled check-ins |
| Financial Ops | Invoicing, payment chasing, job profitability, cash flow forecast |
| Delegation Tracking | Who owns what task, due dates, photo proof of completion |
| Incident/Issue Log | Site problems logged with resolution owner and status |

### 2.3 Growth & Retention Features (P1)

| Module | Features |
| --- | --- |
| Client CRM | Full enquiry-to-completion pipeline, review capture |
| Referral Engine | Auto-prompt happy clients post-completion for referrals/reviews |
| Personal Brand Assistant | Prompts + templates for owner to post progress/wins |
| Quoting/Estimating | Templated quotes, margin checks before sending |

### 2.4 Owner Wellbeing Features (P1)

| Module | Features |
| --- | --- |
| Time-Back Tracker | Hours the owner spent on tasks a system/staff member could own |
| Burnout Signal | Combines hours worked, unresolved alerts, and check-in mood |
| Weekly Owner Review | "This week you were needed for X. Here's what to systemize next." |

### 2.5 Advanced Features (P2)

| Feature | Description |
| --- | --- |
| Predictive Cash Flow | Forecasts shortfalls before they hit, based on invoice aging + job pipeline |
| Reliability Prediction | Flags a sub/staff member trending toward being a risk before they cause a delay |
| Auto-SOP Generator | AI turns a voice note of "how I do X" into a formatted SOP |
| Scenario Planning | "What if I take 2 weeks off — what breaks?" |

---

## 3. Owner Dashboard Module

### 3.1 Dashboard Architecture

A single pane of glass showing everything the owner needs to make decisions — nothing they don't.

```
┌─────────────────────────────────────────────────────────────────┐
│  [Jobs]  [Dashboard]  [Team]  [Clients]  [Cash]  [SOPs]         │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐ │
│  │  OUTSTANDING │  CASH IN 30D │  ACTIVE JOBS │  AT-RISK JOBS│ │
│  │   £14,200    │   £38,900    │   9 running  │   2 flagged  │ │
│  │  3 overdue   │   ↑ 6%       │   6 on track │   view →     │ │
│  └──────────────┴──────────────┴──────────────┴──────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │         JOB STATUS OVERVIEW                                │ │
│  │  [████████░░] 14 Elm St scaffold (75% — on schedule)       │ │
│  │  [██████░░░░] Riverside extension (60% — sub delay flagged)│ │
│  │  [██████████] Oak Rd re-roof (complete — awaiting invoice) │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────┬────────────────────────────────────┐ │
│  │  NEEDS YOUR DECISION    │   THIS WEEK'S TIME-BACK             │ │
│  │  ● Client dispute       │   You were pulled in 4x for        │ │
│  │    Riverside job        │   things staff could own.          │ │
│  │  ● Sub reliability drop │   → Suggest: delegate materials    │ │
│  │    (Dave, 3rd late job) │     ordering to site lead.          │ │
│  └────────────────────────┴────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Dashboard Widgets (Fully Customizable)

**Financial**

- Cash position + 30/60/90-day forecast
- Outstanding invoices with aging buckets
- Job profitability (quoted vs actual cost)
- Payment chasing status (auto-reminder stage)

**Jobs**

- Active jobs with status colour coding
- At-risk job list (behind schedule, disputed, unstaffed)
- Site log activity feed
- Variations/change orders pending approval

**Team**

- Staff/sub reliability leaderboard
- Assigned jobs per person
- Onboarding checklist completion for new hires
- Availability calendar

**Clients**

- Enquiry → booked conversion funnel
- Overdue client check-ins
- Post-completion review/referral status

**Owner wellbeing**

- Time-back tracker (hours reclaimed vs hours pulled in)
- Weekly "what to systemize next" suggestion
- Days since last full day off

### 3.3 Adding & Managing Jobs

**Create job profile**

1. Tap **New Job**.
2. Fill in client, address, job type, quoted value, target dates.
3. Attach the relevant SOP template (e.g. "Scaffold Erect — Domestic").
4. Assign staff/subs.
5. Job appears on the dashboard and staff mobile view instantly.

**Job types supported (configurable templates)**

- Scaffolding / access
- General building / extensions
- Roofing
- Groundworks
- Renovation / fit-out
- Electrical / plumbing (trade-specific)
- Multi-trade / main contractor

### 3.4 Real-Time Alerts (Exception-Based Only)

- "Riverside job flagged 2 days behind — sub reported delay"
- "Invoice #204 now 14 days overdue — auto-reminder sent"
- "Dave has been late to site 3 times this month"
- "Client hasn't responded to appraisal booking in 5 days"
- "Cash flow projected below £5k threshold in 18 days"

---

## 4. Automation Engine

### 4.1 No-Code Automation Builder

```
WHEN [Trigger]
IF [Condition]
THEN [Action]
ELSE [Alternative Action]
```

### 4.2 Triggers (20+)

| Category | Triggers |
| --- | --- |
| Job | Job created, stage changed, marked at-risk, completed |
| Financial | Invoice sent, invoice overdue (7/14/30d), payment received |
| Team | Sub marked late, staff onboarded, task overdue |
| Client | Enquiry received, appraisal booked, review not left |
| Site Log | Issue logged, photo uploaded, incident reported |

### 4.3 Actions (25+)

| Category | Actions |
| --- | --- |
| Communication | Send SMS/WhatsApp, email, push notification |
| Financial | Generate invoice, send payment reminder, flag for owner |
| Job | Create job, update stage, assign staff/sub |
| Client | Book appraisal, send check-in message, request review |
| Documents | Generate SOP-based checklist, attach signed doc |

### 4.4 Pre-Built Automation Templates

**Business**

1. **Payment chasing** — invoice unpaid 7 days → friendly reminder → 14 days → firmer reminder →
   30 days → alert owner.
2. **New sub onboarding** — sub added → send onboarding SOP checklist → track completion.
3. **Client care cadence** — job booked → auto-schedule check-in touchpoints at key milestones.
   Mirrors the "effective client care" model: don't just chase the sale, maintain trust through
   the job.
4. **Job risk detection** — job stage unchanged 5+ days past target → flag "at-risk" → notify
   owner.
5. **Post-completion loop** — job marked complete → request review → prompt referral ask.

**Owner wellbeing**

1. **Weekly time-back review** — Sunday evening → summarize what pulled the owner in that a
   system or person could have handled.
2. **Delegation nudge** — same task type flagged to the owner 3+ times → suggest turning it into
   an SOP or assigning ownership.

---

## 5. SOP & Systemization Module

### 5.1 Why This Is the Core of the App

The single biggest failure mode for growing construction businesses is that everything lives in
the owner's head. When the van breaks down, when a client complains, when a new starter needs
training — if there's no written system, it all funnels back to the owner. This module exists to
get that knowledge out of the owner's head and into something staff can run without them.

### 5.2 Features

- **SOP library** — pre-built templates by job type and role (site lead, labourer, office admin)
- **Voice-to-SOP** — owner records a voice note explaining how they do something; AI converts it
  into a structured checklist
- **Role-based visibility** — staff only see the SOPs relevant to their role and current job
- **Version control** — SOPs update centrally, so no one is working from an outdated printed sheet
- **Completion tracking** — photo/checkbox proof that a step was actually done, not just claimed

### 5.3 Starter SOP Categories

- New job setup
- Site safety checks
- Materials ordering & delivery
- Client handover
- Vehicle/equipment breakdown response
- New staff/sub onboarding
- End-of-job snagging & sign-off

---

## 6. Team & Subcontractor Management

### 6.1 Reliability Scoring

Every staff member and sub gets a reliability score based on:

- On-time arrival to site
- Job completion vs deadline
- Quality flags / rework incidents
- Communication responsiveness

This turns "I have a feeling Dave's been unreliable lately" into a data-backed decision.

### 6.2 Delegation Tracking

- Every task has one clearly assigned owner
- Due dates and photo-proof of completion
- Escalation to the owner only if overdue past a grace window

### 6.3 Onboarding

- Standardized onboarding checklist per role
- New hire sees their SOPs, contacts, and first-job checklist automatically

---

## 7. Client Care & Sales Module

### 7.1 The Three-Stage Pipeline

Modelled on the enquiry-to-instruction framework: rapport-building appraisal → informed decision
→ booked job. The app tracks every enquiry through:

1. **Enquiry received** — auto-logged, owner/office notified
2. **Appraisal booked** — calendar-integrated, reminders sent
3. **Job booked & scheduled** — converts into a job profile automatically

### 7.2 Ongoing Client Care

- Scheduled check-in touchpoints through the life of the job, not just at sale and completion
- Client-facing status updates (photos, % complete) sent automatically at milestones
- Post-completion review and referral request

### 7.3 Why This Matters

Untrained staff handling client contact can do more harm than good. This module gives every staff
member a script/SOP for client touchpoints, so client care doesn't depend on who happens to answer
the phone.

---

## 8. Financial Intelligence Module

### 8.1 Core Financial Views

- **Cash position** — live bank-synced balance + 30/60/90-day forecast
- **Invoice aging** — at-a-glance who owes what and for how long
- **Job profitability** — quoted cost vs actual cost per job, margin by job type
- **Payment chasing** — automated reminder cadence with escalation to owner if unresolved

### 8.2 Quoting & Estimating

- Templated quotes by job type
- Margin check before a quote is sent (flags if margin is below threshold)
- Quote-to-job conversion tracking

Specced in full in the [Auto-Quoting & AI Estimating Module](auto-quoting/README.md).

---

## 9. Integration Ecosystem

### 9.1 Supported Integrations

| Category | Integrations |
| --- | --- |
| Accounting | QuickBooks, Xero, Sage |
| Payments | Stripe, GoCardless, bank feeds (Open Banking) |
| Messaging | WhatsApp Business, SMS, Email |
| Calendar | Google Calendar, Outlook |
| Storage | Google Drive, Dropbox |
| Site/Trade Tools | Buildertrend, Procore (import/export) |
| Compliance (UK) | HMRC (CIS), Companies House |

### 9.2 Custom Integrations

- REST API for custom connections
- Webhook support (inbound/outbound)
- CSV import/export for legacy systems

---

## 10. Security & Privacy

- **Transport** — TLS 1.3, HTTPS everywhere
- **Data** — AES-256 encryption at rest
- **Authentication** — strong password + optional 2FA, role-based access (owner sees everything,
  staff see only their scope)
- **Backups** — daily encrypted backups
- **Data control** — export anytime, delete on request, full audit trail

---

## 11. Deployment Strategy

| Option | Use Case | Cost |
| --- | --- | --- |
| Cloud hosted | Fastest setup, hands-off | $20–60/month |
| Self-hosted | Full control | $10–20/month (VPS) |

**Recommended stack**

- Frontend: PWA (installs like a native app on iOS/Android) + responsive web dashboard
- Backend: Node/Postgres or similar, hosted on Render/Fly.io/DigitalOcean
- Offline-first sync for field logging with poor site signal
- Push notifications via PWA, with SMS/WhatsApp fallback

---

## 12. Complete Implementation Roadmap (12 Months)

### Phase 0 — Foundation (Month 1)

**Goal:** get a builder out of "headless chicken" mode.

- Job tracker (create, view, status)
- SOP library (starter templates, custom upload)
- Staff/sub directory
- Basic invoicing + manual payment tracking

**Success criteria:** owner can see every active job and who's on it in one place.

### Phase 1 — Delegation & Systems Layer (Months 2–3)

**Goal:** let the owner step back without it falling apart.

- Task assignment with photo-proof completion
- Role-based SOP visibility
- Daily site log (field team logs without owner on-site)
- Client check-in workflow at job milestones

**Success criteria:** owner isn't the bottleneck for daily job updates.

### Phase 2 — Visibility & Control (Months 4–5)

**Goal:** owner dashboard becomes the single source of truth.

- Cash flow dashboard + invoice aging
- Job profitability tracking
- Reliability scoring for staff/subs
- Exception-based alerts (only what needs owner action)

**Success criteria:** owner checks one dashboard instead of five conversations to know business
health.

### Phase 3 — Automation Engine (Months 6–7)

**Goal:** remove recurring manual work.

- Payment chasing automation
- Job risk detection automation
- Client care cadence automation
- New sub/staff onboarding automation

**Success criteria:** owner stops manually chasing invoices and client updates.

### Phase 4 — Growth & Retention Layer (Months 8–9)

**Goal:** move from surviving to scaling.

- Full client CRM (enquiry → booked → completed)
- Review/referral capture
- Quoting/estimating with margin checks
- Personal brand content prompts for the owner

**Success criteria:** pipeline visibility and consistent lead flow, not just reactive job intake.

### Phase 5 — Owner Wellbeing Layer (Month 10)

**Goal:** make the "buy back your time" promise measurable.

- Time-back tracker
- Weekly owner review + systemization suggestions
- Burnout signal tracking

**Success criteria:** owner can see, in numbers, how much less they're needed month over month.

### Phase 6 — Advanced Intelligence (Month 11)

**Goal:** predictive, not just reactive.

- Predictive cash flow forecasting
- Reliability prediction (flag risk before it causes a delay)
- Auto-SOP generator (voice note → checklist)
- Scenario planning ("what breaks if I take 2 weeks off")

### Phase 7 — Polish & Scale (Month 12)

**Goal:** production-ready system.

- Offline mode for field logging
- Performance optimization
- Full documentation + onboarding flow for new customers
- Optional: coaching/community layer (SOP templates, benchmarking, accountability check-ins) as
  an upsell tier

---

## 13. Success Metrics & KPIs

### 13.1 System Performance

| Metric | Target |
| --- | --- |
| Dashboard load time | <3 seconds |
| Site log sync (post-offline) | <5 seconds |
| Uptime | 99.9% |

### 13.2 Owner Time-Back

| Metric | Target |
| --- | --- |
| Owner hours pulled into day-to-day ops | −50% by month 6 |
| Days off per month without disruption | 4+ by month 9 |
| Tasks with a clear non-owner owner | >80% |

### 13.3 Business Metrics

| Metric | Target |
| --- | --- |
| Invoice aging (avg days to payment) | −30% |
| Job on-time completion rate | >85% |
| Client review/referral capture rate | >50% of completed jobs |
| Staff/sub reliability score improvement | +15% avg |

---

## 14. Cost Breakdown

| Item | Cost |
| --- | --- |
| Domain name | $10–15/year |
| Hosting (VPS or PaaS) | $10–30/month |
| Database (Postgres/Supabase) | $0–25/month |
| SMS/WhatsApp API usage | $0–40/month (volume-based) |
| AI features (voice-to-SOP, predictions) | $0–50/month (usage-based) |
| **Total (minimal)** | **$20–40/month** |
| **Total (full-featured)** | **$80–150/month** |

---

## 15. Maintenance & Evolution

- **Weekly** — sync health checks, automation log review
- **Monthly** — feature request review, cost optimization, reliability-score model tuning
- **Quarterly** — security audit, new integration additions, SOP template library expansion
- **Continuous** — owner feedback loop ("what's still pulling you into the business that
  shouldn't be") feeds directly into the next systemization priorities

---

## 16. Next Steps

1. **Confirm build priority** — validating with real builders first, or building an MVP straight
   away?
2. **Pick Phase 0 scope** — job tracker + SOP library + staff directory is the minimum lovable
   product.
3. **Decide trade focus** — start narrow (e.g. scaffolding) before generalizing to all trades; a
   focused wedge is easier to sell into and iterate on.
4. **Choose the stack** — PWA + Node/Postgres is the fastest path to a working Phase 0.

Any single phase can be expanded into a detailed build spec with screens, data models, and user
stories — the [auto-quoting module](auto-quoting/README.md) is the worked example of that.
