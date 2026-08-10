const express = require('express');
const SystemSettings = require('../models/SystemSettings');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { ROLE_LABELS, PERMISSION_MATRIX } = require('../constants/permissions');
const { sendSuccess, sendError } = require('../utils/helpers');
const { writeAudit } = require('../utils/audit');

const router = express.Router();

const DEFAULT_SETTINGS = {
  companyName: 'HR Core',
  tagline: 'Transforming Knowledge into Wealth',
  workHoursStart: '09:00 AM',
  workHoursEnd: '06:00 PM',
  breakDurationMinutes: 60,
  lateThresholdMinutes: 15,
  payrollCycleDay: 1,
  biometricEnabled: true,
  emailNotifications: true,
};

// GET /api/settings
router.get('/', protect, authorize('manage_system_settings'), async (_req, res) => {
  try {
    const stored = await SystemSettings.find();
    const settings = { ...DEFAULT_SETTINGS };

    stored.forEach((s) => {
      settings[s.key] = s.value;
    });

    return sendSuccess(res, { settings });
  } catch (e) {
    return sendError(res, e.message, 500);
  }
});

// PATCH /api/settings
router.patch('/', protect, authorize('manage_system_settings'), async (req, res) => {
  try {
    const updates = req.body;

    for (const [key, value] of Object.entries(updates)) {
      await SystemSettings.findOneAndUpdate(
        { key },
        { key, value, updatedBy: req.user.name },
        { upsert: true }
      );
    }

    await writeAudit({
      actor: req.user,
      action: `Updated system settings (${Object.keys(updates).join(', ')})`,
      category: 'config',
      entityType: 'settings',
      meta: { keys: Object.keys(updates) },
    });

    const stored = await SystemSettings.find();
    const settings = { ...DEFAULT_SETTINGS };
    stored.forEach((s) => {
      settings[s.key] = s.value;
    });

    return sendSuccess(res, { settings }, 'Settings updated');
  } catch (e) {
    return sendError(res, e.message, 500);
  }
});

// GET /api/settings/roles — public role & permission reference
router.get('/roles', protect, async (_req, res) => {
  try {
    return sendSuccess(res, {
      roles: ROLE_LABELS,
      permissionMatrix: PERMISSION_MATRIX,
      hierarchy: [
        'Company Owner (CEO)',
        '└── Super Admin',
        '    └── Branch Head',
        '        ├── HR (branch-scoped)',
        '        ├── Manager (team-scoped)',
        '        ├── Developer / Sales / Designer / …',
        '        └── Custom Roles',
      ],
    });
  } catch (e) {
    return sendError(res, e.message, 500);
  }
});

module.exports = router;
