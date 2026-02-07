# Claude Router V2

Intelligent Claude model router with streaming support and React frontend.

## Project Structure

```
claude-router-frontend/  → React + Vite + TypeScript frontend
supabase/               → Edge Functions backend
SQL/                    → Database schemas
Tests/                  → Test suites
```

## Quick Start

### Frontend Development

```bash
cd claude-router-frontend
npm install
npm run dev
```

### Environment Variables

Create `claude-router-frontend/.env`:

```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
VITE_ROUTER_ENDPOINT=your_router_endpoint
```

## Deployment

### Vercel (Frontend)

```bash
vercel --prod
```

### Supabase (Backend)

```bash
supabase functions deploy
```

## Features

- 🧠 Intelligent Model Routing (Opus, Sonnet, Haiku)
- ⚡ Real-time Streaming Responses
- 🎨 Technical Developer UI
- 🔒 Supabase Authentication
- 📊 Complexity Visualization

## Documentation

- [Frontend Documentation](claude-router-frontend/README.md)
- [Router Context](supabase/router-stream-context.md)

## License

MIT
