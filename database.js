const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'maria.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now')),
    last_login DATETIME
  );

  CREATE TABLE IF NOT EXISTS game_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    level INTEGER DEFAULT 0,
    name_player TEXT DEFAULT 'username',
    age INTEGER DEFAULT 24,
    subject INTEGER DEFAULT 0,
    subject_name TEXT DEFAULT '',
    resources_json TEXT DEFAULT '{"resources":[]}',
    heart_json TEXT DEFAULT '{"valueHeart":5,"timeHeartCurrent":0,"timeHeartInfinite":0,"lastTimeEnd":0}',
    pack_json TEXT DEFAULT '{"listPack":[],"listShowPack":[]}',
    level2_json TEXT DEFAULT '{}',
    level3_json TEXT DEFAULT '{}',
    settings_json TEXT DEFAULT '{"sfxVolume":1.0,"musicVolume":1.0,"muteVibra":0}',
    skills_json TEXT DEFAULT '{"unlocked":[]}',
    updated_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Migrate: add email column if not exists (for existing databases)
try {
  db.exec(`ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''`);
} catch (e) {
  // Column already exists — ignore
}

// Migrate: add skills_json column if not exists
try {
  db.exec(`ALTER TABLE game_data ADD COLUMN skills_json TEXT DEFAULT '{"unlocked":[]}'`);
} catch (e) {
  // Column already exists — ignore
}

// Migrate: add level4_json column if not exists (quiz answers)
try {
  db.exec(`ALTER TABLE game_data ADD COLUMN level4_json TEXT DEFAULT '{}'`);
} catch (e) {
  // Column already exists — ignore
}

// Migrate: add analytics_json column if not exists (derived metrics)
try {
  db.exec(`ALTER TABLE game_data ADD COLUMN analytics_json TEXT DEFAULT '{}'`);
} catch (e) {
  // Column already exists — ignore
}

// Migrate: add persona_json column if not exists (Level 1 persona + reflections)
try {
  db.exec(`ALTER TABLE game_data ADD COLUMN persona_json TEXT DEFAULT '{}'`);
} catch (e) {
  // Column already exists — ignore
}

// ========== SESSION HISTORY & ANALYTICS TRACKING ==========

db.exec(`
  CREATE TABLE IF NOT EXISTS play_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_number INTEGER NOT NULL,
    started_at DATETIME NOT NULL DEFAULT (datetime('now')),
    ended_at DATETIME,
    end_reason TEXT DEFAULT 'unknown',
    duration_seconds INTEGER,
    level_at_start INTEGER DEFAULT 0,
    level_at_end INTEGER,
    badges_at_start INTEGER DEFAULT 0,
    badges_at_end INTEGER,
    save_count INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON play_sessions(user_id);

  CREATE TABLE IF NOT EXISTS game_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_id INTEGER,
    snapshot_number INTEGER NOT NULL,
    save_trigger TEXT DEFAULT 'unknown',
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),

    level INTEGER DEFAULT 0,
    name_player TEXT,
    age INTEGER,
    subject INTEGER,
    subject_name TEXT,

    ai_send_count_level2 INTEGER DEFAULT 0,
    ai_send_count_level3 INTEGER DEFAULT 0,
    total_refine_count INTEGER DEFAULT 0,
    optional_filters_used INTEGER DEFAULT 0,
    optional_filters TEXT,
    c1_first_ai_prompt INTEGER DEFAULT 0,
    c2_lesson_cocreator INTEGER DEFAULT 0,
    c3_inclusive_planner INTEGER DEFAULT 0,
    c4_feedback_architect INTEGER DEFAULT 0,
    c5_iteration_champion INTEGER DEFAULT 0,
    persona_type TEXT,
    quiz_answers_count INTEGER DEFAULT 0,

    badges_unlocked TEXT,
    badges_count INTEGER DEFAULT 0,
    percent_level2 INTEGER DEFAULT 0,
    percent_level3 INTEGER DEFAULT 0,
    lesson_sections_count INTEGER DEFAULT 0,
    feedback_suggestions_count INTEGER DEFAULT 0,

    persona_json TEXT,
    level2_json TEXT,
    level3_json TEXT,
    level4_json TEXT,
    skills_json TEXT,
    settings_json TEXT,
    analytics_json TEXT,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES play_sessions(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_user ON game_snapshots(user_id);
  CREATE INDEX IF NOT EXISTS idx_snapshots_session ON game_snapshots(session_id);
  CREATE INDEX IF NOT EXISTS idx_snapshots_created ON game_snapshots(created_at);
`);

// ========== HELPER FUNCTIONS ==========

function createSession(userId) {
  const last = db.prepare(
    'SELECT COALESCE(MAX(session_number), 0) AS n FROM play_sessions WHERE user_id = ?'
  ).get(userId);
  const sessionNumber = last.n + 1;

  const gameData = db.prepare('SELECT level, skills_json FROM game_data WHERE user_id = ?').get(userId);
  const levelAtStart = gameData ? gameData.level : 0;
  let badgesAtStart = 0;
  if (gameData && gameData.skills_json) {
    try { badgesAtStart = (JSON.parse(gameData.skills_json).unlocked || []).length; } catch (e) {}
  }

  const result = db.prepare(`
    INSERT INTO play_sessions (user_id, session_number, level_at_start, badges_at_start)
    VALUES (?, ?, ?, ?)
  `).run(userId, sessionNumber, levelAtStart, badgesAtStart);

  return Number(result.lastInsertRowid);
}

function endSession(userId, sessionId, reason) {
  const session = db.prepare(
    'SELECT id, started_at FROM play_sessions WHERE id = ? AND user_id = ? AND ended_at IS NULL'
  ).get(sessionId, userId);
  if (!session) return;

  const gameData = db.prepare('SELECT level, skills_json FROM game_data WHERE user_id = ?').get(userId);
  const levelAtEnd = gameData ? gameData.level : 0;
  let badgesAtEnd = 0;
  if (gameData && gameData.skills_json) {
    try { badgesAtEnd = (JSON.parse(gameData.skills_json).unlocked || []).length; } catch (e) {}
  }

  db.prepare(`
    UPDATE play_sessions SET
      ended_at = datetime('now'),
      end_reason = ?,
      duration_seconds = CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER),
      level_at_end = ?,
      badges_at_end = ?
    WHERE id = ?
  `).run(reason, levelAtEnd, badgesAtEnd, sessionId);
}

function appendSnapshot(userId, data) {
  const last = db.prepare(
    'SELECT COALESCE(MAX(snapshot_number), 0) AS n FROM game_snapshots WHERE user_id = ?'
  ).get(userId);
  const snapshotNumber = last.n + 1;

  let analytics = {};
  try { analytics = JSON.parse(data.analyticsJson) || {}; } catch (e) {}

  let skills = { unlocked: [] };
  try { skills = JSON.parse(data.skillsJson) || { unlocked: [] }; } catch (e) {}

  let level3 = {};
  try { level3 = JSON.parse(data.level3Json) || {}; } catch (e) {}

  const currentHash = level3.currentContextHash || '';
  const sections = (level3.listDataTitleTeach || []).filter(s => s.contextHash === currentHash);
  const feedbackCount = (level3.listFeedbackSuggestions || []).length;

  db.prepare(`
    INSERT INTO game_snapshots (
      user_id, session_id, snapshot_number, save_trigger,
      level, name_player, age, subject, subject_name,
      ai_send_count_level2, ai_send_count_level3, total_refine_count,
      optional_filters_used, optional_filters,
      c1_first_ai_prompt, c2_lesson_cocreator, c3_inclusive_planner,
      c4_feedback_architect, c5_iteration_champion,
      persona_type, quiz_answers_count,
      badges_unlocked, badges_count,
      percent_level2, percent_level3,
      lesson_sections_count, feedback_suggestions_count,
      persona_json, level2_json, level3_json, level4_json,
      skills_json, settings_json, analytics_json
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?
    )
  `).run(
    userId, data.sessionId || null, snapshotNumber, data.saveTrigger || 'unknown',
    data.level, data.namePlayer, data.age, data.subject, data.subjectName,
    analytics.aiSendCountLevel2 || 0, analytics.aiSendCountLevel3 || 0, analytics.totalRefineCount || 0,
    analytics.optionalFiltersUsed || 0, analytics.optionalFilters || '',
    analytics.c1_firstAIPrompt ? 1 : 0, analytics.c2_lessonCoCreator ? 1 : 0, analytics.c3_inclusivePlanner ? 1 : 0,
    analytics.c4_feedbackArchitect ? 1 : 0, analytics.c5_iterationChampion ? 1 : 0,
    analytics.personaType || '', analytics.quizAnswersCount || 0,
    JSON.stringify(skills.unlocked || []), (skills.unlocked || []).length,
    level3.percentLevel2 || 0, level3.percentLevel3 || 0,
    sections.length, feedbackCount,
    data.personaJson, data.level2Json, data.level3Json, data.level4Json,
    data.skillsJson, data.settingsJson, data.analyticsJson
  );

  if (data.sessionId) {
    db.prepare('UPDATE play_sessions SET save_count = save_count + 1 WHERE id = ? AND user_id = ?')
      .run(data.sessionId, userId);
  }
}

db.createSession = createSession;
db.endSession = endSession;
db.appendSnapshot = appendSnapshot;

module.exports = db;
