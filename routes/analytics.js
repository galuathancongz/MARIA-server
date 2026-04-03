const express = require('express');
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

// GET /api/analytics/snapshots — query snapshots for current user
router.get('/snapshots', (req, res) => {
  try {
    const { sessionId, from, to, limit } = req.query;
    const targetUserId = req.userId;

    let sql = 'SELECT * FROM game_snapshots WHERE user_id = ?';
    const params = [targetUserId];

    if (sessionId) {
      sql += ' AND session_id = ?';
      params.push(parseInt(sessionId));
    }
    if (from) {
      sql += ' AND created_at >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND created_at <= ?';
      params.push(to);
    }

    sql += ' ORDER BY snapshot_number ASC';

    if (limit) {
      sql += ' LIMIT ?';
      params.push(parseInt(limit));
    }

    const snapshots = db.prepare(sql).all(...params);
    res.json({ success: true, snapshots });
  } catch (err) {
    console.error('Snapshots query error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/analytics/summary — aggregated metrics for current user
router.get('/summary', (req, res) => {
  try {
    const targetUserId = req.userId;

    const sessionStats = db.prepare(`
      SELECT
        COUNT(*) AS total_sessions,
        AVG(duration_seconds) AS avg_duration_seconds,
        SUM(save_count) AS total_saves,
        AVG(badges_at_end - badges_at_start) AS avg_badges_per_session
      FROM play_sessions
      WHERE user_id = ? AND duration_seconds IS NOT NULL
    `).get(targetUserId);

    const latestSnapshot = db.prepare(`
      SELECT * FROM game_snapshots
      WHERE user_id = ?
      ORDER BY snapshot_number DESC LIMIT 1
    `).get(targetUserId);

    const competencyProgression = db.prepare(`
      SELECT snapshot_number, created_at, level, badges_count,
             c1_first_ai_prompt, c2_lesson_cocreator, c3_inclusive_planner,
             c4_feedback_architect, c5_iteration_champion,
             ai_send_count_level2, ai_send_count_level3,
             total_refine_count, persona_type
      FROM game_snapshots
      WHERE user_id = ?
      ORDER BY snapshot_number ASC
    `).all(targetUserId);

    res.json({
      success: true,
      userId: targetUserId,
      sessions: {
        totalSessions: sessionStats.total_sessions || 0,
        avgDurationSeconds: Math.round(sessionStats.avg_duration_seconds || 0),
        totalSaves: sessionStats.total_saves || 0,
        avgBadgesPerSession: Math.round((sessionStats.avg_badges_per_session || 0) * 10) / 10
      },
      latestSnapshot: latestSnapshot || null,
      competencyProgression
    });
  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/analytics/overview — aggregate stats across ALL users
router.get('/overview', (req, res) => {
  try {
    const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get();

    const sessionStats = db.prepare(`
      SELECT
        COUNT(*) AS total_sessions,
        AVG(duration_seconds) AS avg_duration,
        COUNT(DISTINCT user_id) AS active_users
      FROM play_sessions
      WHERE duration_seconds IS NOT NULL
    `).get();

    const competencyStats = db.prepare(`
      SELECT
        SUM(c1_first_ai_prompt) AS c1_count,
        SUM(c2_lesson_cocreator) AS c2_count,
        SUM(c3_inclusive_planner) AS c3_count,
        SUM(c4_feedback_architect) AS c4_count,
        SUM(c5_iteration_champion) AS c5_count,
        COUNT(DISTINCT user_id) AS users_with_snapshots
      FROM (
        SELECT user_id,
          MAX(c1_first_ai_prompt) AS c1_first_ai_prompt,
          MAX(c2_lesson_cocreator) AS c2_lesson_cocreator,
          MAX(c3_inclusive_planner) AS c3_inclusive_planner,
          MAX(c4_feedback_architect) AS c4_feedback_architect,
          MAX(c5_iteration_champion) AS c5_iteration_champion
        FROM game_snapshots
        GROUP BY user_id
      )
    `).get();

    const triggerStats = db.prepare(`
      SELECT save_trigger, COUNT(*) AS count
      FROM game_snapshots
      GROUP BY save_trigger
      ORDER BY count DESC
    `).all();

    const personaDistribution = db.prepare(`
      SELECT persona_type, COUNT(DISTINCT user_id) AS user_count
      FROM game_snapshots
      WHERE persona_type IS NOT NULL AND persona_type != ''
      GROUP BY persona_type
      ORDER BY user_count DESC
    `).all();

    res.json({
      success: true,
      totalUsers: userCount.count,
      sessions: {
        totalSessions: sessionStats.total_sessions || 0,
        avgDurationSeconds: Math.round(sessionStats.avg_duration || 0),
        activeUsers: sessionStats.active_users || 0
      },
      competencies: competencyStats,
      saveTriggers: triggerStats,
      personaDistribution
    });
  } catch (err) {
    console.error('Overview error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
