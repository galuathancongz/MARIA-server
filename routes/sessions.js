const express = require('express');
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

// POST /api/sessions/end — close an active session
router.post('/end', (req, res) => {
  try {
    const { sessionId, reason } = req.body || {};
    if (sessionId) {
      db.endSession(req.userId, sessionId, reason || 'close');
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Session end error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/sessions/history — list all sessions for current user
router.get('/history', (req, res) => {
  try {
    const sessions = db.prepare(`
      SELECT id, session_number, started_at, ended_at, end_reason,
             duration_seconds, level_at_start, level_at_end,
             badges_at_start, badges_at_end, save_count
      FROM play_sessions
      WHERE user_id = ?
      ORDER BY session_number DESC
    `).all(req.userId);

    res.json({ success: true, sessions });
  } catch (err) {
    console.error('Session history error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
