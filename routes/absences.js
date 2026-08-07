const express = require('express');
const Absence = require('../models/Absence');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { sendSuccess, sendError, formatDate } = require('../utils/helpers');
const { getTodayAbsentUsers } = require('../utils/absences');

const router = express.Router();

function mapAbsence(a) {
  return {
    id: a.empId,
    name: a.name,
    dept: a.dept,
    reason: a.reason,
    avatar: a.avatar,
  };
}

// GET /api/absences/today
router.get('/today', protect, authorize('view_absent_users'), async (_req, res) => {
  try {
    const today = formatDate();
    const absentUsers = await getTodayAbsentUsers(today);
    return sendSuccess(res, { absentUsers, date: today });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/absences — HR records absence
router.post('/', protect, authorize('edit_employees'), async (req, res) => {
  try {
    const { empId, name, dept, reason, avatar } = req.body;

    if (!empId || !name || !reason) {
      return sendError(res, 'empId, name, and reason are required');
    }

    const employee = await User.findOne({ employeeId: empId, isActive: true });
    if (!employee) {
      return sendError(res, 'Employee not found', 404);
    }

    const today = formatDate();
    const absence = await Absence.findOneAndUpdate(
      { empId, date: today },
      {
        userId: employee._id,
        empId,
        name: employee.name,
        dept: employee.dept || dept || 'General',
        reason,
        avatar: employee.avatar || avatar || '👤',
        date: today,
      },
      { upsert: true, new: true },
    );

    return sendSuccess(res, { absentUser: mapAbsence(absence) }, 'Absence recorded', 201);
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// DELETE /api/absences/:empId
router.delete('/:empId', protect, authorize('edit_employees'), async (req, res) => {
  try {
    const today = formatDate();
    await Absence.findOneAndDelete({ empId: req.params.empId, date: today });
    return sendSuccess(res, null, 'Absence removed');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
