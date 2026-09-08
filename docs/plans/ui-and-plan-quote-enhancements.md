# Implementation Plan: BuilderOS UI Overhaul & AI Plan/Template Quote Generator

## Overview
Overhaul BuilderOS's visual design with a modern, high-contrast, professional theme and implement file ingestion for building plans, architectural drawings, and pre-existing quote templates. The AI drafting engine will parse these inputs alongside site photos and job descriptions to produce accurate quote drafts.

## Architecture Decisions
- **Browser-Side Plan Processing (`web/assets/js/plans.js`)**: Convert uploaded PDF plans into high-resolution canvas frames (downscaled to max 1600px edge JPEG) and extract text content where available. This allows Groq multimodal vision models to read plans directly without requiring heavy backend image conversion tools.
- **Modern CSS Tokens (`web/assets/app.css`)**: Revamp design tokens, buttons, inputs, dropzones, badges, and card elevation while preserving high contrast for field legibility.
- **Unified AI Payloads (`worker/src/groq.js`)**: Extend the AI request payload to include plan images and document context, with explicit prompt rules for scaling dimensions and extracting pre-existing template structures.

## Task List

### Phase 1: Design System & UI Overhaul
- [ ] **Task 1: Overhaul CSS Design System (`web/assets/app.css`)**
  - Acceptance: Modernized CSS custom properties, elevated cards, glassmorphic topbar, refined buttons (`.btn-primary`, `.btn-secondary`, `.btn-ghost`), status badges, drag-and-drop zone styling, and mobile responsiveness.
  - Verify: Visual inspection and responsive UI check across `index.html` and `builder.html`.

### Phase 2: Plan & Template Ingestion Engine
- [ ] **Task 2: Create Plan & Document Reader (`web/assets/js/plans.js`)**
  - Acceptance: Supports PDF plans, plan images (PNG/JPG), TXT/CSV quote templates. Renders PDF pages to base64 images for Groq vision model analysis.
  - Verify: Unit test / manual test uploading sample PDF plan and text template.
- [ ] **Task 3: Integrate Dropzone & Upload UI in Quote Builder (`web/builder.html` & `web/assets/js/builder.js`)**
  - Acceptance: Interactive drag-and-drop zone in `builder.html` supporting plans, quote templates, and site photos with real-time file preview cards.
  - Verify: Upload files in builder, check payload generated for AI draft request.

### Phase 3: AI Draft Engine & Worker Payload Sync
- [ ] **Task 4: Update Groq Vision Prompt & Worker Handler (`worker/src/groq.js` & `worker/paste/`)**
  - Acceptance: Groq prompt instructs model to analyze building plans (scaling dimensions, floor plans, wall areas) and match pre-existing quote template items.
  - Verify: Run `npm test` in `worker/` and verify unit tests pass.
- [ ] **Task 5: Rebuild Generated Assets & Verify Stack**
  - Acceptance: Run `npm run build:generated` in `worker/` so `worker/paste/ai-worker.js` and `web/assets/` stay in sync with zero diff.
  - Verify: `git status` clean after build; `npm test` passes.

### Phase 4: Commit & Deploy
- [ ] **Task 6: Commit and Deploy via GitHub Actions**
  - Acceptance: Push to `main`, verify `Deploy web to GitHub Pages` workflow succeeds and live site is updated.
  - Verify: Live URL check at `https://megablaze757.github.io/constructionapp/`.

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Large PDF plans exceeding payload limits | High | Downscale PDF page renders to max 1600px JPEG at 0.82 quality in browser before sending |
| Groq vision model rate limits | Medium | Fallback to text summary extraction if vision call is unavailable |