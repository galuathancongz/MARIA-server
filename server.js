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

app.use('/api/auth', authRoutes);
app.use('/api/gamedata', gamedataRoutes);
app.use('/api/export', exportRoutes);

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

app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`MARIA Teaching Server`);
  console.log(`Running on port ${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log(`=================================`);
});
