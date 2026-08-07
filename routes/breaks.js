const express = require('express');
const BreakLog = require('../models/BreakLog');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { sendSuccess, sendError, formatTime, formatDate, formatBreakDuration } = require('../utils/helpers');

const router = express.Router();
const BREAK_DURATION_SECONDS = 3600;

function mapBreak(log) {
  return {
    date: log.date,
    startTime: log.startTime,
    endTime: log.endTime,
    duration: log.duration,
    status: log.status,
  };
}

function mapStaffBreak(log) {
  return {
    ...mapBreak(log),
    empName: log.userId?.name || 'Unknown',
    dept: log.userId?.dept || 'General',
    empId: log.userId?.employeeId || '',
    avatar: log.userId?.avatar || '👤',
  };
}

// GET /api/breaks/all/today — org-wide break logs (HR / Super Admin)
router.get('/all/today', protect, authorize('view_all_attendance'), async (_req, res) => {
  try {
    const today = formatDate();
    const logs = await BreakLog.find({
      date: today,
      status: { $in: ['active', 'completed'] },
    })
      .populate('userId', 'name dept employeeId avatar')
      .sort({ startTime: 1 });

    return sendSuccess(res, {
      date: today,
      breakLogs: logs.map(mapStaffBreak),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/breaks/logs
router.get('/logs', protect, async (req, res) => {
  try {
    const logs = await BreakLog.find({ userId: req.user._id }).sort({ date: -1 }).limit(14);
    return sendSuccess(res, { breakLogs: logs.map(mapBreak) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/breaks/status
router.get('/status', protect, async (req, res) => {
  try {
    const today = formatDate();
    const log = await BreakLog.findOne({ userId: req.user._id, date: today });

    if (!log || log.status === 'not_started') {
      return sendSuccess(res, { breakStatus: 'not_started', isBreakActive: false, breakSecondsLeft: BREAK_DURATION_SECONDS });
    }

    if (log.status === 'completed') {
      return sendSuccess(res, { breakStatus: 'completed', isBreakActive: false, breakSecondsLeft: 0, breakLog: mapBreak(log) });
    }

    const startMs = new Date(`${today} ${log.startTime}`).getTime();
    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    const remaining = Math.max(0, BREAK_DURATION_SECONDS - elapsed);

    return sendSuccess(res, {
      breakStatus: remaining > 0 ? 'active' : 'completed',
      isBreakActive: remaining > 0,
      breakSecondsLeft: remaining,
      breakLog: mapBreak(log),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/breaks/start
router.post('/start', protect, authorize('break_in_out'), async (req, res) => {
  try {
    const today = formatDate();
    let log = await BreakLog.findOne({ userId: req.user._id, date: today });

    if (log && log.status === 'active') {
      return sendError(res, 'Break already in progress');
    }

    if (log && log.status === 'completed') {
      return sendError(res, 'Daily break already used');
    }

    const startTime = formatTime();

    if (log) {
      log.startTime = startTime;
      log.status = 'active';
      await log.save();
    } else {
      log = await BreakLog.create({
        userId: req.user._id,
        date: today,
        startTime,
        status: 'active',
      });
    }

    return sendSuccess(res, { breakLog: mapBreak(log), breakSecondsLeft: BREAK_DURATION_SECONDS }, 'Break started');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/breaks/end
router.post('/end', protect, authorize('break_in_out'), async (req, res) => {
  try {
    const today = formatDate();
    const log = await BreakLog.findOne({ userId: req.user._id, date: today });

    if (!log || log.status !== 'active') {
      return sendError(res, 'No active break to end');
    }

    const endTime = formatTime();
    log.endTime = endTime;
    log.status = 'completed';

    const startMs = new Date(`${today} ${log.startTime}`).getTime();
    const endMs = Date.now();
    const durationSec = Math.min(BREAK_DURATION_SECONDS, Math.floor((endMs - startMs) / 1000));
    log.duration = formatBreakDuration(durationSec);

    await log.save();

    return sendSuccess(res, { breakLog: mapBreak(log) }, 'Break ended');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
