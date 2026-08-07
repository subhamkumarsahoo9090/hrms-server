const User = require('../models/User');
const AttendanceLog = require('../models/AttendanceLog');
const Absence = require('../models/Absence');
const { formatDate } = require('./helpers');

const ACTIVE_EMPLOYEE_FILTER = {
  isActive: true,
  systemRole: { $ne: 'super_admin' },
};

function mapAbsentUser(emp, reason) {
  return {
    id: emp.employeeId,
    name: emp.name,
    dept: emp.dept,
    reason,
    avatar: emp.avatar || '👤',
  };
}

/**
 * Live absent list for today:
 * - Skips remote workers (working off-site, not absent)
 * - Skips anyone who checked in today
 * - Includes on-leave staff and HR-recorded absences for today only
 */
async function getTodayAbsentUsers(date = formatDate()) {
  const [employees, checkedInUserIds, explicitAbsences] = await Promise.all([
    User.find(ACTIVE_EMPLOYEE_FILTER).select(
      'employeeId name dept avatar status',
    ),
    AttendanceLog.find({
      date,
      timeIn: { $exists: true, $ne: '' },
    }).distinct('userId'),
    Absence.find({ date }),
  ]);

  const checkedIn = new Set(checkedInUserIds.map((id) => id.toString()));
  const employeesByEmpId = new Map(
    employees.map((emp) => [emp.employeeId, emp]),
  );

  const absentMap = new Map();

  for (const emp of employees) {
    if (emp.status === 'Remote') continue;
    if (checkedIn.has(emp._id.toString())) continue;

    const recorded = explicitAbsences.find((a) => a.empId === emp.employeeId);
    if (recorded) {
      absentMap.set(emp.employeeId, mapAbsentUser(emp, recorded.reason));
      continue;
    }

    if (emp.status === 'On Leave') {
      absentMap.set(emp.employeeId, mapAbsentUser(emp, 'On Leave'));
    }
  }

  // Ignore orphan absence rows (e.g. deleted or invalid employee IDs)
  for (const absence of explicitAbsences) {
    if (absentMap.has(absence.empId)) continue;
    const emp = employeesByEmpId.get(absence.empId);
    if (!emp || emp.status === 'Remote') continue;
    if (checkedIn.has(emp._id.toString())) continue;
    absentMap.set(absence.empId, mapAbsentUser(emp, absence.reason));
  }

  return Array.from(absentMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

module.exports = {
  ACTIVE_EMPLOYEE_FILTER,
  getTodayAbsentUsers,
};
