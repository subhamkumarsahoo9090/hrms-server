const { DEFAULT_SHIFT_START } = require('../constants/shifts');

/** Parse "10:00 AM" / "07:30 PM" to minutes since midnight */
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3].toUpperCase();

  if (meridiem === 'PM' && hours !== 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;

  return hours * 60 + minutes;
}

function isValidShiftTime(timeStr) {
  return parseTimeToMinutes(timeStr) !== null;
}

function isLateCheckIn(checkInTime, shiftStart = DEFAULT_SHIFT_START) {
  const checkInMinutes = parseTimeToMinutes(checkInTime);
  const shiftMinutes = parseTimeToMinutes(shiftStart);
  if (checkInMinutes === null || shiftMinutes === null) return false;
  return checkInMinutes > shiftMinutes;
}

function formatShiftLabel(start, end) {
  return `${start} – ${end}`;
}

module.exports = {
  parseTimeToMinutes,
  isValidShiftTime,
  isLateCheckIn,
  formatShiftLabel,
};
