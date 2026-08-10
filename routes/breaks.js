const express = require('express');
const BreakLog = require('../models/BreakLog');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const {
  sendSuccess,
  sendError,
  formatTime,
  formatDate,
  formatBreakDuration,
} = require('../utils/helpers');
const {
  BREAK_DURATION_SECONDS,
  computeBreakState,
} = require('../utils/breaks');

const router = express.Router();

function mapBreak(log, today = formatDate()) {
  if (!log) return null;
  const state = computeBreakState(log, today);
  return {
    date: log.date,
    startTime: log.startTime,
    endTime: log.endTime,
    duration: log.duration || formatBreakDuration(state.usedSeconds),
    status: state.breakStatus,
    usedSeconds: state.usedSeconds,
    remainingSeconds: state.remainingSeconds,
    allowanceSeconds: state.allowanceSeconds,
    usedLabel: formatBreakDuration(state.usedSeconds),
    remainingLabel: formatBreakDuration(state.remainingSeconds),
    sessions: (log.sessions || []).map((s) => ({
      startTime: s.startTime,
      endTime: s.endTime,
      durationSeconds: s.durationSeconds,
      duration: formatBreakDuration(s.durationSeconds || 0),
    })),
  };
}

function mapStaffBreak(log) {
  const mapped = mapBreak(log);
  return {
    ...mapped,
    empName: log.userId?.name || 'Unknown',
    dept: log.userId?.dept || 'General',
    empId: log.userId?.employeeId || '',
    avatar: log.userId?.avatar || '👤',
  };
}

function statusPayload(log, today) {
  const state = computeBreakState(log, today);
  return {
    breakStatus: state.breakStatus,
    isBreakActive: state.isBreakActive,
    breakSecondsLeft: state.remainingSeconds,
    breakSecondsUsed: state.usedSeconds,
    breakAllowanceSeconds: state.allowanceSeconds,
    breakUsedLabel: formatBreakDuration(state.usedSeconds),
    breakRemainingLabel: formatBreakDuration(state.remainingSeconds),
    breakLog: log ? mapBreak(log, today) : null,
  };
}

async function autoCompleteIfExhausted(log, today) {
  if (!log || log.status !== 'active') return log;
  const state = computeBreakState(log, today);
  if (state.remainingSeconds > 0) return log;

  const endTime = formatTime();
  const elapsed = state.sessionElapsedSeconds;
  const nextUsed = Math.min(state.allowanceSeconds, state.storedUsedSeconds + elapsed);
  log.sessions = [
    ...(log.sessions || []),
    {
      startTime: log.startTime,
      endTime,
      durationSeconds: elapsed,
    },
  ];
  log.usedSeconds = nextUsed;
  log.endTime = endTime;
  log.duration = formatBreakDuration(nextUsed);
  log.status = 'completed';
  await log.save();
  return log;
}

// GET /api/breaks/all/today — org-wide break logs (HR / Super Admin / Manager)
router.get('/all/today', protect, authorize('view_all_attendance'), async (_req, res) => {
  try {
    const today = formatDate();
    const logs = await BreakLog.find({
      date: today,
      status: { $in: ['active', 'available', 'completed'] },
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
    return sendSuccess(res, { breakLogs: logs.map((l) => mapBreak(l, l.date)) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/breaks/status
router.get('/status', protect, async (req, res) => {
  try {
    const today = formatDate();
    let log = await BreakLog.findOne({ userId: req.user._id, date: today });
    if (log) {
      log = await autoCompleteIfExhausted(log, today);
    }
    return sendSuccess(res, statusPayload(log, today));
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

    if (log) {
      log = await autoCompleteIfExhausted(log, today);
    }

    const state = computeBreakState(log, today);
    if (state.remainingSeconds <= 0) {
      return sendError(res, 'Daily 1-hour break already used');
    }

    const startTime = formatTime();
    const allowance = state.allowanceSeconds || BREAK_DURATION_SECONDS;

    if (log) {
      log.startTime = startTime;
      log.endTime = '';
      log.status = 'active';
      log.allowanceSeconds = allowance;
      if (typeof log.usedSeconds !== 'number') {
        log.usedSeconds = state.storedUsedSeconds;
      }
      await log.save();
    } else {
      log = await BreakLog.create({
        userId: req.user._id,
        date: today,
        startTime,
        status: 'active',
        usedSeconds: 0,
        allowanceSeconds: allowance,
        sessions: [],
      });
    }

    return sendSuccess(
      res,
      {
        ...statusPayload(log, today),
        breakLog: mapBreak(log, today),
      },
      'Break started',
    );
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

    const state = computeBreakState(log, today);
    const endTime = formatTime();
    const elapsed = state.sessionElapsedSeconds;
    const nextUsed = Math.min(
      state.allowanceSeconds,
      state.storedUsedSeconds + elapsed,
    );
    const remaining = Math.max(0, state.allowanceSeconds - nextUsed);

    log.sessions = [
      ...(log.sessions || []),
      {
        startTime: log.startTime,
        endTime,
        durationSeconds: elapsed,
      },
    ];
    log.usedSeconds = nextUsed;
    log.endTime = endTime;
    log.duration = formatBreakDuration(nextUsed);
    log.status = remaining > 0 ? 'available' : 'completed';
    await log.save();

    return sendSuccess(
      res,
      {
        ...statusPayload(log, today),
        breakLog: mapBreak(log, today),
      },
      remaining > 0
        ? `Break paused — ${formatBreakDuration(remaining)} remaining`
        : 'Break completed for today',
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
