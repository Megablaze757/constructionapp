# Spec: BuilderOS UI Overhaul & AI Plan/Template Quote Generator

## Objective
Transform BuilderOS into a modern, high-grade construction quote builder with:
1. A professional, sleek UI/UX design (modern typography, dark/light theme refinements, fluid card layouts, drag-and-drop upload zones, status badges, and polished micro-interactions).
2. Multi-format file ingestion (PDF plans, architectural drawings, pre-existing quote templates, and site photos).
3. AI-powered quote drafting from uploaded plans, drawings, or existing template files via Groq multimodal vision/text models.

## Tech Stack
- **Frontend**: Plain ES modules (HTML5, Modern CSS custom properties, vanilla JS modules, PDF.js / Canvas rendering for PDF plans).
- **Backend/AI**: Cloudflare Workers + D1 database + Groq AI API (`llama-3.3-70b-versatile` for text/documents, `meta-llama/llama-4-maverick-17b-128e-instruct` for vision/plans).
- **Deployment**: GitHub Actions → GitHub Pages (Frontend) + Cloudflare Workers (Backend).

## Commands
```bash
# Local web server
cd web && python3 -m http.server 8788 --bind 127.0.0.1

# Run unit tests
cd worker && npm test

# Run generated assets sync
cd worker && npm run build:generated

# Run end-to-end tests
cd worker && npm run e2e
```

## Project Structure
```
web/
  assets/
    app.css           → Refactored modern CSS design system
    js/
      builder.js      → Quote builder logic & AI drafting integration
      plans.js        → Plan/Document parsing & downscaling (PDF, images, text)
      photos.js       → Site photo downscaling & handling
      api.js          → Worker & AI service client
worker/
  src/
    groq.js           → AI prompt builder & Groq API client
    paste/            → Paste-in Cloudflare Worker handler
```

## Key Requirements & Acceptance Criteria

### 1. Modern UI / UX Overhaul
- **CSS Design System**: Refresh `app.css` with a refined color palette, subtle shadows, rounded borders, modern typography, glassmorphism topbar, and clear visual hierarchy.
- **Drag & Drop Upload Zone**: Interactive drop zone supporting multiple files (PDFs, PNG/JPG plans, previous quote templates).
- **Interactive Quote Builder**: Fluid layout for reviewing AI-drafted lines, confidence scores, notes, and instant price adjustments.

### 2. Plan & Existing Quote Template Ingestion
- **Plan Processing**: Support uploading PDF building plans and blueprints. Convert PDF pages to images or extract text in browser for AI analysis.
- **Template Ingestion**: Allow users to drop in previous quote PDFs, images, or text documents to train/match the AI's line items and style.
- **Groq Integration**: Pass plan images/text along with templates and job descriptions to Groq vision/text models.

### 3. Success Criteria
- User can drag and drop a PDF plan or quote template directly into Quote Builder.
- AI extracts quantities, line items, and scope notes from the plan/document.
- Site UI displays a clear, modern, intuitive interface with instant totals and seamless editing.
- All unit tests pass and generated files remain in sync.

## Boundaries
- **Always**: Maintain offline-first local mode capability in WebAssembly/IndexedDB.
- **Ask First**: Schema-breaking database migrations on Cloudflare D1.
- **Never**: Hardcode API keys or expose secrets in frontend assets.