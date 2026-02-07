#!/bin/bash
# install.sh - Quick installation script for Claude Router Frontend

set -e

echo "🚀 Claude Router Frontend - Installation Script"
echo "================================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 18+ first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18+ required (found: $(node -v))"
    exit 1
fi

echo "✅ Node.js version: $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found"
    exit 1
fi

echo "✅ npm version: $(npm -v)"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Installation failed"
    exit 1
fi

echo ""
echo "✅ Dependencies installed successfully!"
echo ""

# Check for .env file
if [ ! -f .env ]; then
    echo "⚠️  No .env file found"
    echo "📝 Creating .env from template..."
    
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "✅ Created .env file"
        echo ""
        echo "⚠️  IMPORTANT: Edit .env and add your Supabase credentials:"
        echo "   - VITE_SUPABASE_ANON_KEY"
        echo ""
        echo "   nano .env"
        echo ""
    else
        echo "❌ .env.example not found"
        exit 1
    fi
else
    echo "✅ .env file exists"
    echo ""
fi

# Type check
echo "🔍 Running type check..."
npm run type-check

if [ $? -ne 0 ]; then
    echo "⚠️  Type check found issues (this is usually OK for first install)"
else
    echo "✅ Type check passed"
fi

echo ""
echo "================================================"
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Edit .env and add your VITE_SUPABASE_ANON_KEY"
echo "  2. Run: npm run dev"
echo "  3. Open: http://localhost:3000"
echo ""
echo "For full documentation, see README.md"
echo "For quick start, see docs/QUICKSTART.md"
echo "================================================"
