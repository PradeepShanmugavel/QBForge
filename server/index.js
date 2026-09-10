require('dotenv').config();
const express = require('express');
const cors = require('cors');

const examlyRoutes = require('./routes/examly');
const groqRoutes   = require('./routes/groq');
const executeRoutes = require('./routes/execute');

const app  = express();
const PORT = process.env.PORT || 3001;

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
