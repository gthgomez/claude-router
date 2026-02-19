# Project Structure

Complete file organization for Prismatix Frontend.

## Directory Tree

```
prismatix-frontend/
│
├── src/                          # Source files
│   ├── ChatInterface.tsx         # Main chat interface component
│   ├── ModelIndicator.tsx        # Model selection indicator
│   ├── smartFetch.ts             # API communication layer
│   ├── config.ts                 # Configuration & environment
│   ├── types.ts                  # TypeScript type definitions
│   ├── utils.ts                  # Helper utilities
│   ├── App.tsx                   # Root application component
│   └── main.tsx                  # Application entry point
│
├── public/                       # Static assets (optional)
│   └── favicon.ico
│
├── dist/                         # Build output (generated)
│   ├── index.html
│   ├── assets/
│   └── ...
│
├── node_modules/                 # Dependencies (generated)
│
├── index.html                    # HTML template
├── vite.config.ts                # Vite build configuration
├── tsconfig.json                 # TypeScript configuration
├── package.json                  # Project dependencies
├── .env                          # Environment variables (create this!)
├── .env.example                  # Environment template
├── .gitignore                    # Git ignore rules
│
└── Documentation/
    ├── README.md                 # Full project documentation
    ├── QUICKSTART.md             # Quick setup guide
    ├── DEPLOYMENT.md             # Deployment instructions
    └── PROJECT_STRUCTURE.md      # This file
```

## File Purposes

### Core Application (`src/`)

| File | Purpose | Lines | Dependencies |
|------|---------|-------|--------------|
| `ChatInterface.tsx` | Main UI with streaming, messages, input | ~400 | React, smartFetch, ModelIndicator |
| `ModelIndicator.tsx` | Visual model display with animations | ~150 | React, config, types |
| `smartFetch.ts` | API calls, streaming, conversation management | ~100 | config, types |
| `config.ts` | Environment vars, constants, model configs | ~50 | - |
| `types.ts` | TypeScript interfaces for type safety | ~50 | - |
| `utils.ts` | Helper functions (formatting, clipboard, etc) | ~200 | types |
| `App.tsx` | Root component wrapper | ~20 | ChatInterface |
| `main.tsx` | ReactDOM render, env validation | ~30 | React, ReactDOM, App |

### Configuration Files

| File | Purpose |
|------|---------|
| `vite.config.ts` | Build tool configuration, optimization, dev server |
| `tsconfig.json` | TypeScript compiler options, strict mode |
| `package.json` | Dependencies, scripts, project metadata |
| `.env` | **Your secrets** - must create, never commit |
| `.env.example` | Template for environment variables |

### Documentation

| File | Purpose | Audience |
|------|---------|----------|
| `README.md` | Comprehensive documentation | Developers |
| `QUICKSTART.md` | 3-minute setup guide | New users |
| `DEPLOYMENT.md` | Production deployment | DevOps/Deployment |
| `PROJECT_STRUCTURE.md` | File organization | Contributors |

### Generated Files (Do Not Edit)

```
dist/              ← Build output from npm run build
node_modules/      ← Dependencies from npm install
```

## File Dependencies Graph

```
main.tsx
  └─→ App.tsx
       └─→ ChatInterface.tsx
            ├─→ ModelIndicator.tsx
            │    ├─→ config.ts
            │    └─→ types.ts
            ├─→ smartFetch.ts
            │    ├─→ config.ts
            │    └─→ types.ts
            ├─→ types.ts
            └─→ utils.ts (optional)
                 └─→ types.ts
```

## Import Flow

```typescript
// Typical import hierarchy
config.ts         ← No dependencies (foundational)
  ↓
types.ts          ← Uses config for type hints
  ↓
smartFetch.ts     ← Uses config + types
  ↓
ModelIndicator.tsx ← Uses config + types
  ↓
ChatInterface.tsx  ← Uses all above
  ↓
App.tsx           ← Uses ChatInterface
  ↓
main.tsx          ← Bootstraps App
```

## Size Breakdown

| Component | Uncompressed | Gzipped |
|-----------|--------------|---------|
| React + ReactDOM | ~140KB | ~45KB |
| Application code | ~25KB | ~8KB |
| Styles (embedded) | ~10KB | ~3KB |
| **Total** | **~175KB** | **~56KB** |

## Lines of Code

```
ChatInterface.tsx    ≈ 400 lines
ModelIndicator.tsx   ≈ 150 lines
utils.ts             ≈ 200 lines
smartFetch.ts        ≈ 100 lines
Other TS/TSX files   ≈ 150 lines
────────────────────────────────
Total                ≈ 1,000 lines
```

## Key Architectural Decisions

### 1. **Monolithic Component Styles**
- Styles embedded in components
- No separate CSS files
- Reduces HTTP requests
- Easier to deploy

### 2. **Type-First Development**
- Strong TypeScript throughout
- No `any` types
- Catches errors at compile time

### 3. **Streaming-First Design**
- Native ReadableStream API
- No intermediate buffers
- Real-time user feedback

### 4. **Environment-Based Config**
- All secrets in `.env`
- Never hardcoded
- Easy to change per environment

### 5. **Platform-Agnostic**
- Works on Vercel, Netlify, AWS, etc.
- Docker support
- Static export capable

## Setup Sequence

```
1. Clone/Create directory
   ↓
2. Copy all files to project root
   ↓
3. npm install (creates node_modules/)
   ↓
4. Create .env file (from .env.example)
   ↓
5. npm run dev (starts dev server)
   ↓
6. npm run build (creates dist/)
   ↓
7. Deploy dist/ to hosting platform
```

## Development Workflow

```
Edit source files in src/
  ↓
Hot reload updates browser
  ↓
Test changes
  ↓
npm run type-check (verify types)
  ↓
npm run build (create production bundle)
  ↓
npm run preview (test production build)
  ↓
Deploy to production
```

## Customization Points

### Easy Customization
- **Colors**: Edit `config.ts` → `MODELS` object
- **Fonts**: Edit inline styles in `ChatInterface.tsx`
- **Model routing**: Handled by backend, no frontend changes needed
- **Text**: Edit component strings directly

### Medium Complexity
- **Add features**: Extend `types.ts`, update components
- **Analytics**: Add to `main.tsx` or `App.tsx`
- **Auth**: Integrate Supabase auth in `smartFetch.ts`

### Advanced
- **Backend changes**: Modify router endpoint
- **Streaming protocol**: Update `smartFetch.ts`
- **Build optimization**: Edit `vite.config.ts`

## File Creation Order (If Building From Scratch)

1. `types.ts` - Foundation
2. `config.ts` - Configuration
3. `smartFetch.ts` - API layer
4. `ModelIndicator.tsx` - Sub-component
5. `utils.ts` - Helpers
6. `ChatInterface.tsx` - Main component
7. `App.tsx` - Wrapper
8. `main.tsx` - Entry
9. `index.html` - Template
10. Config files (vite, tsconfig, package)

## Common Modifications

### Change Model Colors
```typescript
// config.ts
MODELS: {
  'opus-4.5': {
    color: '#YOUR_COLOR', // ← Change here
```

### Add New Message Type
```typescript
// types.ts
export interface Message {
  // ... existing fields
  isError?: boolean; // ← Add field
}

// ChatInterface.tsx - update rendering
```

### Custom Platform Detection
```typescript
// config.ts
PLATFORM: 'your-custom-platform' as const
```

## Testing Strategy

```
Unit Tests         → smartFetch.ts, utils.ts
Integration Tests  → ChatInterface.tsx user flows
E2E Tests          → Full conversation flow
Manual Testing     → Model routing verification
```

## Performance Monitoring Points

```
main.tsx           → App initialization
smartFetch.ts      → API latency
ChatInterface.tsx  → Render performance
ModelIndicator.tsx → Animation smoothness
```

---

**Navigate this structure** using your editor's file tree or command line! 🗂️

