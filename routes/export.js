const express = require('express');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const db = require('../database');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

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

function drawLine(doc) {
  doc.strokeColor('#CCCCCC').lineWidth(0.5)
    .moveTo(doc.x, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(0.5);
}

function sectionTitle(doc, title) {
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1565C0').text(title);
  doc.fillColor('#000000').moveDown(0.3);
}

function infoRow(doc, label, value) {
  doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
  doc.font('Helvetica').text(value || 'N/A');
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
    doc.fontSize(22).font('Helvetica-Bold').text('MARIA Teaching Classroom', { align: 'center' });
    doc.fontSize(16).text('Lesson Plan', { align: 'center' });
    doc.moveDown(1);
    drawLine(doc);

    // ── Info ─────────────────────────────────────────────────────────────
    doc.fontSize(11).font('Helvetica');
    infoRow(doc, 'Teacher', playerName);
    infoRow(doc, 'Username', user ? user.username : 'N/A');
    infoRow(doc, 'Subject', subjectName);
    infoRow(doc, 'Topic', level3.topic);
    infoRow(doc, 'Teaching Persona', analytics.personaType);
    infoRow(doc, 'Export Date', new Date().toLocaleDateString('vi-VN'));
    doc.moveDown(0.5);
    drawLine(doc);

    // ── Learning Objective ───────────────────────────────────────────────
    sectionTitle(doc, 'Learning Objective');
    doc.font('Helvetica').fontSize(10)
      .text(level3.learningObjective || '(Not set)', { lineGap: 3 });
    doc.moveDown(0.5);

    // ── Design Constraints ───────────────────────────────────────────────
    sectionTitle(doc, 'Design Constraints');
    doc.font('Helvetica').fontSize(10)
      .text(level3.designContraints || '(None)', { lineGap: 3 });
    doc.moveDown(0.5);

    // ── Differentiation Filters ──────────────────────────────────────────
    const filters = level3.optionalFilters || [];
    sectionTitle(doc, 'Differentiation Filters');
    doc.font('Helvetica').fontSize(10)
      .text(filters.length > 0 ? filters.join(', ') : '(None selected)');
    doc.moveDown(0.5);
    drawLine(doc);

    // ── Lesson Activities ────────────────────────────────────────────────
    sectionTitle(doc, 'Lesson Activities');
    const activities = (level3.listDataTitleTeach || [])
      .filter(a => a.topic === level3.topic);

    if (activities.length > 0) {
      const tableX = doc.x;
      const colTitle = 150;
      const colContent = 350;

      // Header
      doc.font('Helvetica-Bold').fontSize(9);
      const headerY = doc.y;
      doc.text('Section', tableX, headerY, { width: colTitle });
      doc.text('Content', tableX + colTitle, headerY, { width: colContent });
      doc.moveDown(0.3);
      drawLine(doc);

      // Rows
      doc.fontSize(9);
      for (const act of activities) {
        checkPageBreak(doc);
        const rowY = doc.y;
        doc.font('Helvetica-Bold').text(act.title || '', tableX, rowY, { width: colTitle });
        const titleEndY = doc.y;
        doc.font('Helvetica').text(act.content || '', tableX + colTitle, rowY, { width: colContent, lineGap: 2 });
        const contentEndY = doc.y;
        doc.y = Math.max(titleEndY, contentEndY);
        doc.moveDown(0.3);
      }
    } else {
      doc.font('Helvetica').fontSize(10).text('(No activities recorded)');
    }
    doc.moveDown(0.5);
    drawLine(doc);

    // ── Student Work & Feedback ──────────────────────────────────────────
    sectionTitle(doc, 'Student Work & Feedback');
    checkPageBreak(doc);
    doc.font('Helvetica').fontSize(10);

    if (level3.studentWork) {
      doc.font('Helvetica-Bold').text('Student Work:');
      doc.font('Helvetica').text(level3.studentWork, { lineGap: 2 });
      doc.moveDown(0.3);
    }

    const feedback = level3.listFeedbackSuggestions || [];
    if (feedback.length > 0) {
      doc.font('Helvetica-Bold').text('Feedback Suggestions:');
      doc.font('Helvetica');
      const typeNames = { 0: 'Strength', 1: 'Improvement', 2: 'Next Step' };
      for (const f of feedback) {
        doc.text(`  - [${typeNames[f.type] || f.type}] ${f.text}`, { lineGap: 2 });
      }
    } else {
      doc.text('(No feedback recorded)');
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
    doc.fontSize(22).font('Helvetica-Bold').text('MARIA Teaching Classroom', { align: 'center' });
    doc.fontSize(16).text('Player Growth Report', { align: 'center' });
    doc.moveDown(1);
    drawLine(doc);

    // ── Player Info ──────────────────────────────────────────────────────
    doc.fontSize(11).font('Helvetica');
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
    doc.font('Helvetica-Bold').fontSize(9);
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
      doc.font('Helvetica').text(c.name, tableX, rowY, { width: 200 });
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

    const filters = level3.optionalFilters || [];
    const filtersLower = filters.map(f => (f || '').toLowerCase());
    const hasFeedback = (level3.listFeedbackSuggestions || []).length > 0;

    const dimensions = [
      { name: 'Differentiation',      strength: filters.length > 0,
        sText: 'Used differentiation strategies',           gText: 'Only used standard format tasks' },
      { name: 'Accessibility',        strength: filtersLower.some(f => f.includes('accessib')),
        sText: 'Included scaffolds for diverse learners',   gText: 'Did not adjust for learner differences' },
      { name: 'Cultural Relevance',   strength: filtersLower.some(f => f.includes('cultur') || f.includes('local')),
        sText: 'Localised examples for context',            gText: 'Used generic content without local context' },
      { name: 'Student Voice',        strength: hasFeedback,
        sText: 'Included peer reflection and journaling',   gText: 'Focused on content delivery only' },
      { name: 'Gender Inclusivity',   strength: filtersLower.some(f => f.includes('gender') || f.includes('inclus')),
        sText: 'Used neutral language, diverse examples',   gText: 'Lacked diverse representation' },
      { name: 'Feedback Responsive',  strength: analytics.c4_feedbackArchitect && (analytics.totalRefineCount || 0) > 0,
        sText: 'Revised lesson from student feedback',      gText: 'Superficially acknowledged feedback' },
    ];

    checkPageBreak(doc);
    doc.font('Helvetica-Bold').fontSize(9);
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
      doc.font('Helvetica-Bold').fillColor('#000000').text(dim.name, tableX, rowY, { width: 120 });
      doc.font('Helvetica');
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
    doc.font('Helvetica').fontSize(10);
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
      doc.font('Helvetica').fontSize(9);
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
