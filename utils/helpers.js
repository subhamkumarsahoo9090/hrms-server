const mongoose = require('mongoose');

const { DEFAULT_SHIFT_START, DEFAULT_SHIFT_END } = require('../constants/shifts');
const { isValidShiftTime } = require('./shiftTime');
const TEAM_AVATAR_URLS = require('./teamAvatarUrls');

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const TEAM_AVATAR_BY_NAME = new Map(
  Object.entries(TEAM_AVATAR_URLS).map(([name, url]) => [
    normalizeName(name),
    url,
  ]),
);

function resolveAvatar(avatar, name) {
  if (typeof avatar === 'string') {
    if (/^https?:\/\//i.test(avatar) || avatar.startsWith('/uploads/')) {
      return avatar;
    }
  }
  const teamUrl = TEAM_AVATAR_BY_NAME.get(normalizeName(name));
  return teamUrl || avatar || '👤';
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatBreakDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Match user by employeeId (e.g. EMP005) or MongoDB _id without invalid casts */
function buildUserLookupFilter(id) {
  const filters = [{ employeeId: String(id) }];
  if (mongoose.isObjectIdOrHexString(id)) {
    filters.push({ _id: id });
  }
  return { $or: filters };
}

function sendSuccess(res, data, message = 'Success', statusCode = 200) {
  return res.status(statusCode).json({ success: true, message, data });
}

function sendError(res, message, statusCode = 400) {
  return res.status(statusCode).json({ success: false, message });
}

function sanitizeUser(user) {
  const obj = user.toObject ? user.toObject() : { ...user };
  delete obj.password;
  delete obj.__v;
  const mongoId = obj._id != null ? String(obj._id) : null;
  return {
    /** Display / HR code (EMP005) — kept as `id` for mobile app compatibility */
    id: obj.employeeId || mongoId,
    employeeId: obj.employeeId || null,
    /** MongoDB ObjectId string — use this for API path params that expect ObjectId */
    _id: mongoId,
    name: obj.name,
    role: obj.role,
    systemRole: obj.systemRole,
    dept: obj.dept,
    status: obj.status,
    avatar: resolveAvatar(obj.avatar, obj.name),
    delayCount: obj.delayCount,
    salary: obj.salary,
    phone: obj.phone || '',
    email: obj.email,
    shiftStart: obj.shiftStart || DEFAULT_SHIFT_START,
    shiftEnd: obj.shiftEnd || DEFAULT_SHIFT_END,
    isActive: obj.isActive !== false,
    lastLoginAt: obj.lastLoginAt ? new Date(obj.lastLoginAt).toISOString() : null,
    createdAt: obj.createdAt ? new Date(obj.createdAt).toISOString() : null,
    updatedAt: obj.updatedAt ? new Date(obj.updatedAt).toISOString() : null,
    companyId: obj.companyId ? String(obj.companyId) : null,
    branchId: obj.branchId ? String(obj.branchId) : null,
    departmentId: obj.departmentId ? String(obj.departmentId) : null,
    teamId: obj.teamId ? String(obj.teamId) : null,
    teamIds: Array.isArray(obj.teamIds) ? obj.teamIds.map((id) => String(id)) : [],
    managerId: obj.managerId ? String(obj.managerId) : null,
  };
}

function validateShiftTimes(shiftStart, shiftEnd) {
  if (shiftStart !== undefined && !isValidShiftTime(shiftStart)) {
    return 'shiftStart must be in format like 10:00 AM';
  }
  if (shiftEnd !== undefined && !isValidShiftTime(shiftEnd)) {
    return 'shiftEnd must be in format like 07:00 PM';
  }
  return null;
}

/** Next EMP### in this company (max existing number + 1). Avoids count-based collisions. */
async function nextEmployeeId(User, companyId) {
  const filter = { employeeId: { $regex: /^EMP\d+$/i } };
  if (companyId) filter.companyId = companyId;
  const users = await User.find(filter).select('employeeId').lean();
  let max = 0;
  for (const u of users) {
    const n = parseInt(String(u.employeeId).replace(/\D/g, ''), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return `EMP${String(max + 1).padStart(3, '0')}`;
}

function duplicateKeyMessage(err) {
  const key = err?.keyPattern || {};
  if (key.email) return 'This email is already registered';
  if (key.employeeId) return 'Employee ID already exists — retry create';
  return 'Duplicate email or employee ID in this company';
}

module.exports = {
  formatTime,
  formatDate,
  formatBreakDuration,
  buildUserLookupFilter,
  sendSuccess,
  sendError,
  sanitizeUser,
  resolveAvatar,
  validateShiftTimes,
  nextEmployeeId,
  duplicateKeyMessage,
};
