const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve WebGL build as static files (same folder deployment)
// Put your WebGL build files in Server/public/
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
const authRoutes = require('./routes/auth');
const gamedataRoutes = require('./routes/gamedata');
const exportRoutes = require('./routes/export');
const sessionRoutes = require('./routes/sessions');
const analyticsRoutes = require('./routes/analytics');

app.use('/api/auth', authRoutes);
app.use('/api/gamedata', gamedataRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/analytics', analyticsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Fallback: serve index.html for WebGL
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).json({ message: 'Not found' });
    }
  });
});

// Cleanup orphaned sessions (open > 24h) every hour
const db = require('./database');
setInterval(() => {
  try {
    const result = db.prepare(`
      UPDATE play_sessions SET
        ended_at = datetime('now'),
        end_reason = 'timeout',
        duration_seconds = CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER),
        level_at_end = COALESCE(level_at_end, level_at_start),
        badges_at_end = COALESCE(badges_at_end, badges_at_start)
      WHERE ended_at IS NULL AND started_at < datetime('now', '-24 hours')
    `).run();
    if (result.changes > 0) {
      console.log(`[Cleanup] Closed ${result.changes} orphaned session(s)`);
    }
  } catch (err) {
    console.error('[Cleanup] Error:', err);
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`MARIA Teaching Server`);
  console.log(`Running on port ${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log(`=================================`);
});
