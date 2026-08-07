const express = require('express');
const DelayRequest = require('../models/DelayRequest');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { sendSuccess, sendError } = require('../utils/helpers');

const router = express.Router();

function mapDelay(req) {
  return {
    id: req._id,
    empName: req.empName,
    dept: req.dept,
    requestedTime: req.requestedTime,
    reason: req.reason,
    status: req.status,
    userId: req.userId,
  };
}

// GET /api/delay-requests
router.get('/', protect, authorize('view_team_attendance'), async (_req, res) => {
  try {
    const requests = await DelayRequest.find().sort({ createdAt: -1 });
    return sendSuccess(res, { delayRequests: requests.map(mapDelay) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/delay-requests/mine
router.get('/mine', protect, async (req, res) => {
  try {
    const requests = await DelayRequest.find({ userId: req.user._id }).sort({ createdAt: -1 });
    return sendSuccess(res, { delayRequests: requests.map(mapDelay) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/delay-requests
router.post('/', protect, async (req, res) => {
  try {
    const { requestedTime, reason } = req.body;

    if (!requestedTime || !reason) {
      return sendError(res, 'Requested time and reason are required');
    }

    const request = await DelayRequest.create({
      userId: req.user._id,
      empName: req.user.name,
      dept: req.user.dept,
      requestedTime,
      reason,
      status: 'Pending',
    });

    return sendSuccess(res, { delayRequest: mapDelay(request) }, 'Delay request submitted', 201);
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// PATCH /api/delay-requests/:id
router.patch('/:id', protect, authorize('view_team_attendance'), async (req, res) => {
  try {
    const { status } = req.body;

    if (!['Approved', 'Rejected'].includes(status)) {
      return sendError(res, 'Status must be Approved or Rejected');
    }

    const request = await DelayRequest.findById(req.params.id);

    if (!request) {
      return sendError(res, 'Delay request not found', 404);
    }

    request.status = status;
    await request.save();

    return sendSuccess(res, { delayRequest: mapDelay(request) }, `Delay request ${status.toLowerCase()}`);
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
