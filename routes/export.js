const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const PDFDocument = require('pdfkit');
const db = require('../database');
const { JWT_SECRET } = require('../middleware/auth');

const fs = require('fs');
const https = require('https');

const router = express.Router();

// ── Font (Unicode support for Vietnamese) ───────────────────────────────────
// Auto-download Noto Sans TTF from Google Fonts if not present.
// No need to manually copy fonts — works on any OS.
const FONTS_DIR    = path.join(__dirname, '..', 'fonts');
const FONT_REGULAR = path.join(FONTS_DIR, 'NotoSans-Regular.ttf');
const FONT_BOLD    = path.join(FONTS_DIR, 'NotoSans-Bold.ttf');

const FONT_URLS = {
  [FONT_REGULAR]: 'https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf',
  [FONT_BOLD]:    'https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Bold.ttf',
};
function ensureFonts() {
  if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true });
  for (const [filePath, url] of Object.entries(FONT_URLS)) {
    if (!fs.existsSync(filePath)) {
      console.log(`[Export] Downloading font: ${path.basename(filePath)}...`);
      try {
        // Sync download at startup
        const { execSync } = require('child_process');
        execSync(`curl -sL "${url}" -o "${filePath}"`, { timeout: 30000 });
        console.log(`[Export] Font downloaded: ${path.basename(filePath)}`);
      } catch (e) {
        console.error(`[Export] Failed to download font: ${e.message}`);
      }
    }
  }
}
ensureFonts();

// Auth via query param (?token=...) since browser opens URL directly
function authenticateQuery(req, res, next) {
  const token = req.query.token;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Token required' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.username = decoded.username;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Invalid or expired token' });
  }
}

router.use(authenticateQuery);

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeParse(json) {
  if (!json || json === '{}') return {};
  try { return JSON.parse(json); } catch { return {}; }
}

// Section names matching LessonPlanTemplate.cs (GDD Level 3 Scene 3)
const SECTION_NAMES = [
  'Lesson title',                      // 0
  'Learning objective',                // 1
  'Introduction starter activity',     // 2
  'Main learning activity',            // 3
  'Assessment / reflection',           // 4
  'Differentiation / inclusion notes', // 5
  'Materials / set up requirements',   // 6
];

function getSectionName(index) {
  return SECTION_NAMES[index] || `Section ${index}`;
}

// Filter names matching FilterTable.cs
const FILTER_NAMES = [
  'Differentiation required',     // 0
  'Time-constrained lesson',      // 1
  'Accessibility support',        // 2
  'Multilingual classroom',       // 3
];

function getFilterName(index) {
  return FILTER_NAMES[index] || `Filter ${index}`;
}

// Subject names
const SUBJECT_NAMES = ['History', 'Science', 'English', 'Math'];

function getSubjectName(index) {
  return SUBJECT_NAMES[index] || `Subject ${index}`;
}

// Design challenges matching DesignChallengeTable.cs [subjectIndex][topicIndex]
const DESIGN_CHALLENGES = [
  // Subject 0: History
  [
    { topic: 'Ancient civilisations', lo: 'Compare cultural innovations between two civilisations', constraint: 'Must use collaborative group work or presentations' },
    { topic: 'Colonialism', lo: 'Critically examine impact on local cultures', constraint: 'Must include student voice / reflection element' },
    { topic: 'Timeline construction', lo: 'Sequence events in a historical period', constraint: 'Must support students with visual and linguistic scaffolds' },
  ],
  // Subject 1: Science
  [
    { topic: 'States of matter', lo: 'Explore how materials change form', constraint: 'Must use low-cost materials for an experiment' },
    { topic: 'Ecosystems', lo: 'Understand food chains and interdependence', constraint: 'Must involve a creative storytelling or role-play element' },
    { topic: 'Scientific method', lo: 'Teach prediction, testing and reflection', constraint: 'Must be adaptable for learners with different literacy levels' },
  ],
  // Subject 2: English
  [
    { topic: 'Narrative writing', lo: 'Help students write from a different character\'s perspective', constraint: 'Must use visual or voice-based creative prompts' },
    { topic: 'Persuasive language', lo: 'Teach students to structure arguments and counterpoints', constraint: 'Must include a debate or roleplay component' },
  ],
  // Subject 3: Math
  [
    { topic: 'Fractions', lo: 'Design a visual real world activity', constraint: 'Must use common materials (e.g. food, money, paper shapes)' },
    { topic: 'Algebraic thinking', lo: 'Help students solve and simplify expressions', constraint: 'Must include step-by-step AI-guided practice' },
    { topic: 'Measurement', lo: 'Compare perimeter and area of everyday objects', constraint: 'Must include a hands-on physical movement activity' },
  ],
];

function getChallenge(subjectIndex, topicIndex) {
  if (subjectIndex >= 0 && subjectIndex < DESIGN_CHALLENGES.length) {
    const topics = DESIGN_CHALLENGES[subjectIndex];
    if (topicIndex >= 0 && topicIndex < topics.length) return topics[topicIndex];
  }
  return { topic: 'Unknown', lo: '', constraint: '' };
}

function drawLine(doc) {
  doc.strokeColor('#CCCCCC').lineWidth(0.5)
    .moveTo(doc.x, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(0.5);
}

function sectionTitle(doc, title) {
  doc.font(FONT_BOLD).fontSize(12).fillColor('#1565C0').text(title);
  doc.fillColor('#000000').moveDown(0.3);
}

function infoRow(doc, label, value) {
  doc.font(FONT_BOLD).fontSize(10).text(`${label}: `, { continued: true });
  doc.font(FONT_REGULAR).text(value || 'N/A');
}

function checkPageBreak(doc, minSpace) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - (minSpace || 80)) {
    doc.addPage();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/export/lesson-plan
// ══════════════════════════════════════════════════════════════════════════════
router.get('/lesson-plan', (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM game_data WHERE user_id = ?').get(req.userId);
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId);

    if (!data) {
      return res.status(404).json({ success: false, message: 'No game data found' });
    }

    const playerName = data.name_player || 'Player';
    const subjectName = data.subject_name || 'Unknown';
    const level3 = safeParse(data.level3_json);
    const analytics = safeParse(data.analytics_json);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="lesson-plan-${playerName}.pdf"`);
    doc.pipe(res);

    // ── Title ────────────────────────────────────────────────────────────
    doc.fontSize(22).font(FONT_BOLD).text('MARIA Teaching Classroom', { align: 'center' });
    doc.fontSize(16).text('Lesson Plan', { align: 'center' });
    doc.moveDown(1);
    drawLine(doc);

    // ── Derive text from indices ─────────────────────────────────────────
    const subjectIdx = level3.subjectIndex ?? 0;
    const topicIdx = level3.topicIndex ?? 0;
    const challenge = getChallenge(subjectIdx, topicIdx);
    const filterIdxs = level3.filterIndices || [];
    const filterNames = filterIdxs.map(i => getFilterName(i));

    // ── Info ─────────────────────────────────────────────────────────────
    doc.fontSize(11).font(FONT_REGULAR);
    infoRow(doc, 'Teacher', playerName);
    infoRow(doc, 'Username', user ? user.username : 'N/A');
    infoRow(doc, 'Subject', getSubjectName(subjectIdx));
    infoRow(doc, 'Topic', challenge.topic);
    infoRow(doc, 'Teaching Persona', analytics.personaType);
    infoRow(doc, 'Export Date', new Date().toLocaleDateString('vi-VN'));
    doc.moveDown(0.5);
    drawLine(doc);

    // ── Learning Objective ───────────────────────────────────────────────
    sectionTitle(doc, 'Learning Objective');
    doc.font(FONT_REGULAR).fontSize(10)
      .text(challenge.lo || '(Not set)', { lineGap: 3 });
    doc.moveDown(0.5);

    // ── Design Constraint ────────────────────────────────────────────────
    sectionTitle(doc, 'Design Constraint');
    doc.font(FONT_REGULAR).fontSize(10)
      .text(challenge.constraint || '(None)', { lineGap: 3 });
    doc.moveDown(0.5);

    // ── Differentiation Filters ──────────────────────────────────────────
    sectionTitle(doc, 'Differentiation Filters');
    doc.font(FONT_REGULAR).fontSize(10)
      .text(filterNames.length > 0 ? filterNames.join(', ') : '(None selected)');
    doc.moveDown(0.5);
    drawLine(doc);

    // ── Lesson Sections ─────────────────────────────────────────────────
    sectionTitle(doc, 'Lesson Plan Sections');

    // Filter sections by current context hash
    const currentHash = level3.currentContextHash || '';
    const sections = (level3.listDataTitleTeach || [])
      .filter(s => s.contextHash === currentHash)
      .sort((a, b) => a.index - b.index);

    if (sections.length > 0) {
      const tableX = doc.x;
      const colTitle = 150;
      const colContent = 350;

      // Header
      doc.font(FONT_BOLD).fontSize(9);
      const headerY = doc.y;
      doc.text('Section', tableX, headerY, { width: colTitle });
      doc.text('Content', tableX + colTitle, headerY, { width: colContent });
      doc.moveDown(0.3);
      drawLine(doc);

      // Rows
      doc.fontSize(9);
      for (const s of sections) {
        checkPageBreak(doc);
        const rowY = doc.y;
        doc.font(FONT_BOLD).text(getSectionName(s.index), tableX, rowY, { width: colTitle });
        const titleEndY = doc.y;
        doc.font(FONT_REGULAR).text(s.content || '', tableX + colTitle, rowY, { width: colContent, lineGap: 2 });
        const contentEndY = doc.y;
        doc.y = Math.max(titleEndY, contentEndY);
        doc.moveDown(0.3);
      }
    } else {
      doc.font(FONT_REGULAR).fontSize(10).text('(No sections recorded)');
    }
    doc.moveDown(0.5);
    drawLine(doc);

    // ── Student Work & Feedback ──────────────────────────────────────────
    sectionTitle(doc, 'Student Work & Feedback');
    checkPageBreak(doc);
    doc.font(FONT_REGULAR).fontSize(10);

    if (level3.studentWork) {
      doc.font(FONT_BOLD).text('Student Work:');
      doc.font(FONT_REGULAR).text(level3.studentWork, { lineGap: 2 });
      doc.moveDown(0.3);
    }

    const feedback = level3.listFeedbackSuggestions || [];
    if (feedback.length > 0) {
      doc.font(FONT_BOLD).text('Feedback Suggestions:');
      doc.font(FONT_REGULAR);
      const typeNames = { 0: 'Strength', 1: 'Improvement', 2: 'Next Step' };
      for (const f of feedback) {
        doc.text(`  - [${typeNames[f.type] || f.type}] ${f.text}`, { lineGap: 2 });
      }
    } else {
      doc.text('(No feedback recorded)');
    }
    doc.moveDown(0.5);
    drawLine(doc);

    // ── AI Mentor Feedback (Scene 7) ─────────────────────────────────────
    if (level3.personalisedFeedback) {
      sectionTitle(doc, 'AI Mentor Personalised Feedback');
      checkPageBreak(doc);
      doc.font(FONT_REGULAR).fontSize(10).text(level3.personalisedFeedback, { lineGap: 3 });
      doc.moveDown(0.5);
    }

    // ── Progress ─────────────────────────────────────────────────────────
    if (level3.percentLevel2 || level3.percentLevel3) {
      sectionTitle(doc, 'Progress');
      infoRow(doc, 'Level 2 Progress', `${level3.percentLevel2 || 0}%`);
      infoRow(doc, 'Level 3 Progress', `${level3.percentLevel3 || 0}%`);
      doc.moveDown(0.5);
    }

    // ── Footer ───────────────────────────────────────────────────────────
    doc.moveDown(1);
    drawLine(doc);
    doc.fontSize(8).fillColor('#888888')
      .text(`Generated by MARIA Teaching Classroom`, { align: 'center' });

    doc.end();
  } catch (err) {
    console.error('Export lesson-plan error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Export failed' });
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/export/growth-report
// ══════════════════════════════════════════════════════════════════════════════
router.get('/growth-report', (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM game_data WHERE user_id = ?').get(req.userId);
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId);

    if (!data) {
      return res.status(404).json({ success: false, message: 'No game data found' });
    }

    const playerName = data.name_player || 'Player';
    const level3 = safeParse(data.level3_json);
    const level4 = safeParse(data.level4_json);
    const analytics = safeParse(data.analytics_json);
    const skills = safeParse(data.skills_json);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="growth-report-${playerName}.pdf"`);
    doc.pipe(res);

    // ── Title ────────────────────────────────────────────────────────────
    doc.fontSize(22).font(FONT_BOLD).text('MARIA Teaching Classroom', { align: 'center' });
    doc.fontSize(16).text('Player Growth Report', { align: 'center' });
    doc.moveDown(1);
    drawLine(doc);

    // ── Player Info ──────────────────────────────────────────────────────
    doc.fontSize(11).font(FONT_REGULAR);
    infoRow(doc, 'Name', playerName);
    infoRow(doc, 'Username', user ? user.username : 'N/A');
    infoRow(doc, 'Age', `${data.age || 'N/A'}`);
    infoRow(doc, 'Teaching Persona', analytics.personaType);
    infoRow(doc, 'Level Reached', `${data.level || 0}`);
    infoRow(doc, 'Subject', data.subject_name);
    infoRow(doc, 'Export Date', new Date().toLocaleDateString('vi-VN'));
    doc.moveDown(0.5);
    drawLine(doc);

    // ── GenAI Competencies Table ─────────────────────────────────────────
    sectionTitle(doc, 'GenAI Competencies');

    const competencies = [
      { name: 'C1: Prompting & Ideation',        achieved: analytics.c1_firstAIPrompt,     evidence: 'Used AI prompt in Tutorial' },
      { name: 'C2: Lesson Co-design',             achieved: analytics.c2_lessonCoCreator,   evidence: 'Built lesson with AI 5+ times' },
      { name: 'C3: Differentiation & Inclusion',  achieved: analytics.c3_inclusivePlanner,  evidence: 'Applied differentiation filters' },
      { name: 'C4: Feedback & Assessment',         achieved: analytics.c4_feedbackArchitect, evidence: 'Gave structured feedback' },
      { name: 'C5: Iterative Refinement',          achieved: analytics.c5_iterationChampion, evidence: 'Refined lesson 3+ times' },
    ];

    const tableX = 50;
    // Header
    doc.font(FONT_BOLD).fontSize(9);
    const hY = doc.y;
    doc.text('Competency', tableX, hY, { width: 200 });
    doc.text('Status', tableX + 200, hY, { width: 80 });
    doc.text('Evidence', tableX + 280, hY, { width: 220 });
    doc.moveDown(0.3);
    drawLine(doc);

    // Rows
    doc.fontSize(9);
    for (const c of competencies) {
      const rowY = doc.y;
      doc.font(FONT_REGULAR).text(c.name, tableX, rowY, { width: 200 });
      doc.fillColor(c.achieved ? '#2E7D32' : '#E65100')
        .text(c.achieved ? 'Achieved' : 'Developing', tableX + 200, rowY, { width: 80 });
      doc.fillColor('#000000')
        .text(c.achieved ? c.evidence : '', tableX + 280, rowY, { width: 220 });
      doc.moveDown(0.3);
    }
    doc.moveDown(0.5);
    drawLine(doc);

    // ── Inclusivity Assessment ───────────────────────────────────────────
    sectionTitle(doc, 'Inclusivity Assessment');

    const fIdxs = level3.filterIndices || [];
    const hasFilters = fIdxs.length > 0;
    const hasFeedback = (level3.listFeedbackSuggestions || []).length > 0;
    // Filter indices: 0=Differentiation, 1=Time-constrained, 2=Accessibility, 3=Multilingual

    const dimensions = [
      { name: 'Differentiation',      strength: fIdxs.includes(0),
        sText: 'Used differentiation strategies',           gText: 'Only used standard format tasks' },
      { name: 'Accessibility',        strength: fIdxs.includes(2),
        sText: 'Included scaffolds for diverse learners',   gText: 'Did not adjust for learner differences' },
      { name: 'Cultural Relevance',   strength: fIdxs.includes(3),
        sText: 'Localised examples for context',            gText: 'Used generic content without local context' },
      { name: 'Student Voice',        strength: hasFeedback,
        sText: 'Included peer reflection and journaling',   gText: 'Focused on content delivery only' },
      { name: 'Gender Inclusivity',   strength: hasFilters,
        sText: 'Used neutral language, diverse examples',   gText: 'Lacked diverse representation' },
      { name: 'Feedback Responsive',  strength: analytics.c4_feedbackArchitect && (analytics.totalRefineCount || 0) > 0,
        sText: 'Revised lesson from student feedback',      gText: 'Superficially acknowledged feedback' },
    ];

    checkPageBreak(doc);
    doc.font(FONT_BOLD).fontSize(9);
    const iY = doc.y;
    doc.text('Dimension', tableX, iY, { width: 120 });
    doc.text('Strengths', tableX + 120, iY, { width: 190 });
    doc.text('Areas to Grow', tableX + 310, iY, { width: 190 });
    doc.moveDown(0.3);
    drawLine(doc);

    doc.fontSize(9);
    for (const dim of dimensions) {
      checkPageBreak(doc, 40);
      const rowY = doc.y;
      doc.font(FONT_BOLD).fillColor('#000000').text(dim.name, tableX, rowY, { width: 120 });
      doc.font(FONT_REGULAR);
      if (dim.strength) {
        doc.fillColor('#2E7D32').text(dim.sText, tableX + 120, rowY, { width: 190 });
        doc.fillColor('#999999').text('-', tableX + 310, rowY, { width: 190 });
      } else {
        doc.fillColor('#999999').text('-', tableX + 120, rowY, { width: 190 });
        doc.fillColor('#E65100').text(dim.gText, tableX + 310, rowY, { width: 190 });
      }
      doc.fillColor('#000000');
      doc.moveDown(0.4);
    }
    doc.moveDown(0.5);
    drawLine(doc);

    // ── Engagement Stats ─────────────────────────────────────────────────
    sectionTitle(doc, 'Engagement Stats');
    doc.font(FONT_REGULAR).fontSize(10);
    infoRow(doc, 'AI Prompts (Level 2)', `${analytics.aiSendCountLevel2 || 0}`);
    infoRow(doc, 'AI Prompts (Level 3)', `${analytics.aiSendCountLevel3 || 0}`);
    infoRow(doc, 'Total Refines', `${analytics.totalRefineCount || 0}`);
    infoRow(doc, 'Filters Used', `${analytics.optionalFiltersUsed || 0}`);

    const quizAnswers = (level4.listQuestion || []).length;
    infoRow(doc, 'Quiz Questions Answered', `${quizAnswers}`);

    const badgeCount = (skills.unlocked || []).length;
    infoRow(doc, 'Badges Earned', `${badgeCount} / 20`);

    // ── Badges List ──────────────────────────────────────────────────────
    if (badgeCount > 0) {
      doc.moveDown(0.5);
      sectionTitle(doc, 'Badges Unlocked');
      doc.font(FONT_REGULAR).fontSize(9);
      for (const badge of skills.unlocked) {
        doc.text(`  - ${badge}`);
      }
    }

    // ── Footer ───────────────────────────────────────────────────────────
    doc.moveDown(1);
    drawLine(doc);
    doc.fontSize(8).fillColor('#888888')
      .text(`Generated by MARIA Teaching Classroom`, { align: 'center' });

    doc.end();
  } catch (err) {
    console.error('Export growth-report error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Export failed' });
    }
  }
});

module.exports = router;
