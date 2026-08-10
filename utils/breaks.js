const BREAK_DURATION_SECONDS = 3600;

function parseDurationToSeconds(duration) {
  if (!duration || typeof duration !== 'string') return 0;
  const parts = duration.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

function getAllowance(log) {
  const n = Number(log?.allowanceSeconds);
  return n > 0 ? n : BREAK_DURATION_SECONDS;
}

/** Closed-session used seconds (excludes active open segment). */
function getStoredUsedSeconds(log) {
  if (!log) return 0;
  if (typeof log.usedSeconds === 'number' && !Number.isNaN(log.usedSeconds)) {
    return Math.max(0, log.usedSeconds);
  }
  if (Array.isArray(log.sessions) && log.sessions.length) {
    return log.sessions.reduce(
      (sum, s) => sum + (Number(s.durationSeconds) || 0),
      0,
    );
  }
  if (log.duration) return parseDurationToSeconds(log.duration);
  return 0;
}

function sessionElapsedSeconds(log, today) {
  if (!log || log.status !== 'active' || !log.startTime) return 0;
  const startMs = new Date(`${today} ${log.startTime}`).getTime();
  if (Number.isNaN(startMs)) return 0;
  return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
}

function computeBreakState(log, today) {
  const allowance = getAllowance(log);
  const storedUsed = Math.min(allowance, getStoredUsedSeconds(log));
  const liveElapsed = sessionElapsedSeconds(log, today);
  const remainingForSession = Math.max(0, allowance - storedUsed);
  const cappedElapsed = Math.min(liveElapsed, remainingForSession);
  const liveUsed = Math.min(allowance, storedUsed + cappedElapsed);
  const remaining = Math.max(0, allowance - liveUsed);

  let breakStatus = 'not_started';
  if (!log || (!storedUsed && log.status === 'not_started' && !liveElapsed)) {
    breakStatus = 'not_started';
  } else if (log.status === 'active' && remaining > 0) {
    breakStatus = 'active';
  } else if (remaining <= 0) {
    breakStatus = 'completed';
  } else if (storedUsed > 0) {
    breakStatus = 'available';
  } else if (log.status === 'completed') {
    breakStatus = remaining > 0 ? 'available' : 'completed';
  } else if (log.status === 'available') {
    breakStatus = 'available';
  } else if (log.status === 'active' && remaining <= 0) {
    breakStatus = 'completed';
  }

  return {
    allowanceSeconds: allowance,
    usedSeconds: liveUsed,
    storedUsedSeconds: storedUsed,
    remainingSeconds: remaining,
    breakStatus,
    isBreakActive: breakStatus === 'active',
    sessionElapsedSeconds: cappedElapsed,
  };
}

module.exports = {
  BREAK_DURATION_SECONDS,
  parseDurationToSeconds,
  getAllowance,
  getStoredUsedSeconds,
  sessionElapsedSeconds,
  computeBreakState,
};
