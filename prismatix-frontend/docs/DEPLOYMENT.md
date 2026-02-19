# Deployment Guide - Prismatix Frontend

Complete guide for deploying your Prismatix Frontend to production.

## Pre-Deployment Checklist

- [ ] All environment variables configured
- [ ] Router endpoint accessible and tested
- [ ] Production build successful (`npm run build`)
- [ ] No TypeScript errors (`npm run type-check`)
- [ ] Supabase project in production mode
- [ ] CORS configured on Edge Function

## Platform-Specific Guides

### 1. Vercel (Recommended)

**Why Vercel:**
- Zero-config deployment for React apps
- Automatic HTTPS
- Global CDN
- Generous free tier
- Built-in environment variable management

**Steps:**

```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy (first time)
vercel

# Deploy to production
vercel --prod
```

**Environment Variables:**
Go to Vercel Dashboard → Your Project → Settings → Environment Variables

Add:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_ROUTER_ENDPOINT`

**Custom Domain:**
Vercel Dashboard → Your Project → Settings → Domains

**Auto-deploy from Git:**
1. Push code to GitHub
2. Import in Vercel Dashboard
3. Auto-deploys on every push to main

---

### 2. Netlify

**Why Netlify:**
- Simple drag-and-drop deployment
- Built-in form handling
- Split testing capabilities
- Functions support

**Steps:**

```bash
# Install Netlify CLI
npm i -g netlify-cli

# Login
netlify login

# Initialize
netlify init

# Build and deploy
netlify deploy --prod
```

**Or via Netlify Drop:**
1. Run `npm run build`
2. Go to https://app.netlify.com/drop
3. Drag `dist/` folder

**Environment Variables:**
Netlify Dashboard → Site Settings → Build & Deploy → Environment

**netlify.toml config:**
```toml
[build]
  command = "npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

---

### 3. Cloudflare Pages

**Why Cloudflare:**
- Global edge network
- Unlimited bandwidth (free)
- Built-in analytics
- Workers integration

**Steps:**

1. Push code to GitHub
2. Go to Cloudflare Dashboard → Pages
3. Connect repository
4. Build settings:
   - Build command: `npm run build`
   - Build output: `dist`
5. Add environment variables
6. Deploy

**Wrangler CLI:**
```bash
npm i -g wrangler
wrangler login
wrangler pages project create prismatix
wrangler pages deploy dist
```

---

### 4. AWS Amplify

**Why AWS Amplify:**
- Tight AWS integration
- Backend capabilities
- CI/CD pipeline
- Monitoring & analytics

**Steps:**

```bash
# Install Amplify CLI
npm i -g @aws-amplify/cli

# Configure
amplify configure

# Initialize
amplify init

# Add hosting
amplify add hosting

# Publish
amplify publish
```

**Build settings (amplify.yml):**
```yaml
version: 1
frontend:
  phases:
    preBuild:
      commands:
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: dist
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
```

---

### 5. Docker + Any Cloud

**Why Docker:**
- Consistent environments
- Works anywhere
- Full control
- Scalable

**Dockerfile:**
```dockerfile
# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

**nginx.conf:**
```nginx
server {
    listen 80;
    server_name _;
    
    root /usr/share/nginx/html;
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    location /health {
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
}
```

**Deploy to any cloud:**
```bash
# Build image
docker build -t prismatix .

# Run locally
docker run -p 8080:80 prismatix

# Tag for registry
docker tag prismatix your-registry/prismatix:latest

# Push
docker push your-registry/prismatix:latest
```

---

### 6. GitHub Pages

**Why GitHub Pages:**
- Free hosting
- Simple setup
- Version control integration

**Steps:**

1. Install gh-pages: `npm i -D gh-pages`

2. Add to package.json:
```json
{
  "homepage": "https://username.github.io/repo-name",
  "scripts": {
    "predeploy": "npm run build",
    "deploy": "gh-pages -d dist"
  }
}
```

3. Deploy: `npm run deploy`

4. Enable in GitHub: Settings → Pages → Source: gh-pages branch

**Note:** GitHub Pages doesn't support environment variables. Use a config file or build-time replacement.

---

## Security Hardening

### 1. Environment Variables

**Never commit:**
- `.env` files
- API keys
- Secrets

**Add to `.gitignore`:**
```
.env
.env.local
.env.production
```

### 2. HTTPS Only

All platforms above provide free HTTPS. Always use it.

### 3. Content Security Policy

Add to `index.html`:
```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self'; 
               connect-src 'self' https://*.supabase.co; 
               script-src 'self' 'unsafe-inline'; 
               style-src 'self' 'unsafe-inline';">
```

### 4. Rate Limiting

Implement on Edge Function side to prevent abuse.

---

## Performance Optimization

### 1. Build Optimization

**vite.config.ts:**
```typescript
export default defineConfig({
  build: {
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },
});
```

### 2. Code Splitting

Already implemented in provided vite.config.ts

### 3. Asset Optimization

```bash
# Install image optimizer
npm i -D vite-plugin-imagemin

# Use in vite.config.ts
import viteImagemin from 'vite-plugin-imagemin';

plugins: [
  react(),
  viteImagemin({
    gifsicle: { optimizationLevel: 7 },
    optipng: { optimizationLevel: 7 },
    mozjpeg: { quality: 80 },
    pngquant: { quality: [0.8, 0.9] },
    svgo: { plugins: [{ removeViewBox: false }] },
  }),
]
```

---

## Monitoring & Analytics

### 1. Error Tracking (Sentry)

```bash
npm i @sentry/react
```

```typescript
// main.tsx
import * as Sentry from '@sentry/react';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
});
```

### 2. Analytics (Vercel Analytics)

```bash
npm i @vercel/analytics
```

```typescript
// App.tsx
import { Analytics } from '@vercel/analytics/react';

<>
  <ChatInterface />
  <Analytics />
</>
```

### 3. Performance Monitoring

```typescript
// Add to main.tsx
if (import.meta.env.PROD) {
  // Report web vitals
  import('web-vitals').then(({ getCLS, getFID, getFCP, getLCP, getTTFB }) => {
    getCLS(console.log);
    getFID(console.log);
    getFCP(console.log);
    getLCP(console.log);
    getTTFB(console.log);
  });
}
```

---

## CI/CD Pipeline Example (GitHub Actions)

**.github/workflows/deploy.yml:**
```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Type check
        run: npm run type-check
        
      - name: Build
        run: npm run build
        env:
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
          VITE_ROUTER_ENDPOINT: ${{ secrets.VITE_ROUTER_ENDPOINT }}
          
      - name: Deploy to Vercel
        run: npx vercel --prod --token=${{ secrets.VERCEL_TOKEN }}
```

---

## Post-Deployment

### 1. Verify Deployment

- [ ] Chat interface loads
- [ ] Environment variables working
- [ ] Router endpoint reachable
- [ ] Models routing correctly
- [ ] Streaming working
- [ ] No console errors

### 2. Test Production

```bash
# Run production build locally
npm run build
npm run preview

# Load test
npx autocannon http://localhost:4173 -c 100 -d 10
```

### 3. Monitor

- Check error rates
- Monitor response times
- Watch Edge Function logs
- Review user feedback

---

## Rollback Strategy

### Quick Rollback (Vercel/Netlify)

Both platforms keep previous deployments. Rollback via dashboard.

### Git-based Rollback

```bash
# Find last working commit
git log --oneline

# Revert
git revert <commit-hash>

# Force deploy
vercel --prod
```

### Docker Rollback

```bash
# Tag previous version
docker pull your-registry/prismatix:previous

# Redeploy
kubectl rollout undo deployment/prismatix
```

---

## Cost Estimates

| Platform | Free Tier | After Free Tier |
|----------|-----------|-----------------|
| Vercel | 100GB bandwidth | $20/mo Pro |
| Netlify | 100GB bandwidth | $19/mo Pro |
| Cloudflare | Unlimited | $20/mo Pro (optional) |
| AWS Amplify | 5GB/mo | ~$0.15/GB |
| GitHub Pages | Unlimited (100GB repos) | Free |

**Recommendation:** Start with Vercel or Netlify free tier. Upgrade as needed.

---

## Support

For deployment issues:
- Check platform-specific documentation
- Review build logs
- Test locally with `npm run preview`
- Verify environment variables
- Check CORS configuration

---

**Ready to deploy?** Choose your platform and follow the guide! 🚀
