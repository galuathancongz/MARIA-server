const express = require('express');
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// POST /api/gamedata/save
router.post('/save', (req, res) => {
  try {
    const userId = req.userId;
    const {
      level,
      namePlayer,
      age,
      subject,
      subjectName,
      level2Json,
      level3Json,
      settingsJson,
      skillsJson,
      level4Json,
      analyticsJson
    } = req.body;

    const stmt = db.prepare(`
      INSERT INTO game_data (user_id, level, name_player, age, subject, subject_name,
        level2_json, level3_json, settings_json,
        skills_json, level4_json, analytics_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        level = excluded.level,
        name_player = excluded.name_player,
        age = excluded.age,
        subject = excluded.subject,
        subject_name = excluded.subject_name,
        level2_json = excluded.level2_json,
        level3_json = excluded.level3_json,
        settings_json = excluded.settings_json,
        skills_json = excluded.skills_json,
        level4_json = excluded.level4_json,
        analytics_json = excluded.analytics_json,
        updated_at = datetime('now')
    `);

    stmt.run(
      userId,
      level ?? 0,
      namePlayer ?? 'username',
      age ?? 24,
      subject ?? 0,
      subjectName ?? '',
      level2Json ?? '{}',
      level3Json ?? '{}',
      settingsJson ?? '{}',
      skillsJson ?? '{"unlocked":[]}',
      level4Json ?? '{}',
      analyticsJson ?? '{}'
    );

    res.json({ success: true, message: 'Game data saved' });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/gamedata/load
router.get('/load', (req, res) => {
  try {
    const userId = req.userId;

    const data = db.prepare('SELECT * FROM game_data WHERE user_id = ?').get(userId);

    if (!data) {
      // Create default data for user
      db.prepare('INSERT INTO game_data (user_id) VALUES (?)').run(userId);
      const newData = db.prepare('SELECT * FROM game_data WHERE user_id = ?').get(userId);
      return res.json({
        success: true,
        data: formatGameData(newData)
      });
    }

    res.json({
      success: true,
      data: formatGameData(data)
    });
  } catch (err) {
    console.error('Load error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

function formatGameData(row) {
  return {
    level: row.level,
    namePlayer: row.name_player,
    age: row.age,
    subject: row.subject,
    subjectName: row.subject_name,
    level2Json: row.level2_json,
    level3Json: row.level3_json,
    settingsJson: row.settings_json,
    skillsJson: row.skills_json ?? '{"unlocked":[]}',
    level4Json: row.level4_json ?? '{}',
    analyticsJson: row.analytics_json ?? '{}',
    updatedAt: row.updated_at
  };
}

module.exports = router;
