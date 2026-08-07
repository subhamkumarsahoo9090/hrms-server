const express = require('express');
const { protect } = require('../middleware/auth');
const { sendSuccess, sendError } = require('../utils/helpers');
const {
  buildNotifications,
  dismissNotification,
  dismissAllNotifications,
} = require('../utils/notifications');

const router = express.Router();

// GET /api/notifications
router.get('/', protect, async (req, res) => {
  try {
    const data = await buildNotifications(req.user);
    return sendSuccess(res, data);
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/notifications/dismiss-all
router.post('/dismiss-all', protect, async (req, res) => {
  try {
    await dismissAllNotifications(req.user);
    return sendSuccess(res, { unreadCount: 0 }, 'All notifications dismissed');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/notifications/:key/dismiss
router.post('/:key/dismiss', protect, async (req, res) => {
  try {
    await dismissNotification(req.user._id, decodeURIComponent(req.params.key));
    const data = await buildNotifications(req.user);
    return sendSuccess(res, data, 'Notification dismissed');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
