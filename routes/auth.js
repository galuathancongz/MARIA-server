const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { authenticateToken, generateToken } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
router.post('/register', (req, res) => {
  console.log('[register] body:', JSON.stringify(req.body));
  try {
    const { username, password, email = '' } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }

    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({ success: false, message: 'Username must be 3-50 characters' });
    }

    if (password.length < 4 || password.length > 100) {
      return res.status(400).json({ success: false, message: 'Password must be 4-100 characters' });
    }

    if (email && email.length > 0 && !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }

    // Check if username exists
    console.log('[register] checking existing...');
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ success: false, message: 'Username already exists' });
    }

    // Hash password and insert
    console.log('[register] hashing password...');
    const passwordHash = bcrypt.hashSync(password, 10);
    console.log('[register] inserting user...');
    const result = db.prepare('INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)').run(username, passwordHash, email || '');
    const userId = result.lastInsertRowid;
    console.log('[register] userId:', userId);

    // Create empty game_data row for new user
    db.prepare('INSERT INTO game_data (user_id, name_player) VALUES (?, ?)').run(userId, username);
    console.log('[register] game_data inserted');

    // Generate token
    const token = generateToken(userId, username);
    console.log('[register] token generated');

    // Update last_login
    db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(userId);

    res.json({
      success: true,
      token,
      userId: Number(userId),
      username
    });
  } catch (err) {
    console.error('[register] ERROR:', err.constructor.name, '-', err.message);
    console.error(err.stack);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }

    // Find user
    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    // Verify password
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    // Generate token
    const token = generateToken(user.id, user.username);

    // Update last_login
    db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(user.id);

    res.json({
      success: true,
      token,
      userId: user.id,
      username: user.username
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/auth/logout (just validates token, client discards it)
router.post('/logout', authenticateToken, (req, res) => {
  res.json({ success: true, message: 'Logged out' });
});

// GET /api/auth/me (check token validity + get user info)
router.get('/me', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT id, username, created_at, last_login FROM users WHERE id = ?').get(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, user });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
