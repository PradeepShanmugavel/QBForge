require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const examlyRoutes = require('./routes/examly');
const groqRoutes   = require('./routes/groq');
const executeRoutes = require('./routes/execute');

const app  = express();
const PORT = process.env.PORT || 3001;

// In production (deployed), the client is pre-built to static files and
// served from this SAME process/origin — no separate Vite server, no CORS
// needed for the frontend<->API calls since they're same-origin. Locally in
// dev, Vite's own dev server handles the frontend on :5173 and proxies /api
// calls here instead, so this block only activates when a build exists.
const clientDist = path.join(__dirname, '..', 'client', 'dist');
const hasClientBuild = fs.existsSync(path.join(clientDist, 'index.html'));

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://admin.neostark872.examly.io'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token', 'x-school-id']
}));
app.use(express.json({ limit: '10mb' }));

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/examly', examlyRoutes);
app.use('/api/groq',   groqRoutes);
app.use('/api/execute', executeRoutes);

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', time: new Date().toISOString() })
);

// ── Serve the built frontend (production only) ─────────────────────────────
if (hasClientBuild) {
  app.use(express.static(clientDist));
  // SPA fallback: any non-API, non-file route serves index.html so the
  // client's own React state (not a URL router) takes over from there.
  app.get(/^(?!\/api\/|\/health).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// ── Catch-all error handler ─────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 TestPack server running on http://localhost:${PORT}`);
  console.log(`   Groq key  : ${process.env.GROQ_API_KEY ? '✓ loaded' : '✗ MISSING — add to .env'}`);
  console.log(`   Examly URL: ${process.env.EXAMLY_BASE_URL || '✗ MISSING — add to .env'}\n`);
});
