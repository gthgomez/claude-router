# 🚀 Quick Start Guide - Prismatix Frontend

Get your Prismatix Frontend running in **3 minutes**.

## Prerequisites

- Node.js 18+ installed
- Supabase anon key for your project
- Router Edge Function deployed

## Step 1: Clone & Install (1 min)

```bash
# Create new project directory
mkdir prismatix-frontend
cd prismatix-frontend

# Copy all provided files into this directory
# (ChatInterface.tsx, ModelIndicator.tsx, smartFetch.ts, etc.)

# Install dependencies
npm install
```

## Step 2: Configure Environment (30 sec)

```bash
# Copy example env file
cp .env.example .env

# Edit .env and add your Supabase anon key
nano .env
```

**Required in `.env`:**
```env
VITE_SUPABASE_ANON_KEY=your_actual_anon_key_here
```

## Step 3: Start Development Server (30 sec)

```bash
npm run dev
```

Your app will open at `http://localhost:3000` 🎉

## Verify It's Working

1. Type a simple message like "Hello"
   - Should route to **Haiku 4.5** (simple query)
   
2. Type "Write a comprehensive analysis of quantum computing"
   - Should route to **Opus 4.5** (complex query)
   
3. Type "Implement a binary search in Python"
   - Should route to **Sonnet 4.5** (coding task)

## Project Structure

```
prismatix-frontend/
├── src/
│   ├── ChatInterface.tsx      ← Main chat UI
│   ├── ModelIndicator.tsx     ← Model display
│   ├── smartFetch.ts          ← API layer
│   ├── config.ts              ← Config
│   ├── types.ts               ← TypeScript types
│   ├── App.tsx                ← Root component
│   └── main.tsx               ← Entry point
├── index.html                 ← HTML template
├── vite.config.ts             ← Build config
├── tsconfig.json              ← TypeScript config
├── package.json               ← Dependencies
├── .env                       ← Environment vars (create this!)
└── README.md                  ← Full documentation
```

## Troubleshooting

### "Router returned 401 Unauthorized"
- Check your `VITE_SUPABASE_ANON_KEY` in `.env`
- Restart the dev server after changing `.env`

### "Network error" or "CORS error"
- Verify router endpoint URL is correct
- Check Edge Function is deployed and accessible

### Blank screen
- Open browser console (F12) for error details
- Verify all files are in correct locations
- Run `npm run type-check` to find TypeScript errors

### Models not showing correctly
- Check browser console for `X-Router-Model` header
- Verify router is returning model info in response

## Next Steps

1. **Customize styling**: Edit colors in `ChatInterface.tsx`
2. **Add features**: Extend `types.ts` for new functionality
3. **Deploy**: See `README.md` for deployment guides
4. **Authentication**: Add Supabase auth for multi-user support

## Production Build

```bash
# Build optimized production bundle
npm run build

# Preview production build locally
npm run preview
```

Build output will be in `dist/` directory.

## Need Help?

- Check full `README.md` for detailed documentation
- Review `types.ts` for API contracts
- Examine `config.ts` for configuration options
- Check browser console for error messages

## Model Selection Examples

| Query | Selected Model | Reason |
|-------|---------------|--------|
| "Hi" | Haiku 4.5 | Simple greeting |
| "Explain recursion" | Sonnet 4.5 | Technical explanation |
| "Write a Node.js API" | Sonnet 4.5 | Coding task |
| "Deep analysis of climate change" | Opus 4.5 | Complex research |
| "Fix this bug: ..." | Sonnet 4.5 | Debugging |
| "What's 2+2?" | Haiku 4.5 | Trivial math |

---

**Ready to build?** Start with `npm run dev` and explore! 🚀

