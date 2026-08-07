const express = require('express');
const Message = require('../models/Message');
const Email = require('../models/Email');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { sendSuccess, sendError, formatTime } = require('../utils/helpers');

const router = express.Router();

function mapMessage(msg) {
  return {
    id: msg._id.toString(),
    from: msg.from,
    subject: msg.subject,
    preview: msg.preview,
    time: msg.time,
    unread: msg.unread,
  };
}

function mapEmail(email) {
  return {
    id: email._id.toString(),
    from: email.from,
    subject: email.subject,
    preview: email.preview,
    time: email.time,
    unread: email.unread,
  };
}

// GET /api/communications/messages
router.get('/messages', protect, authorize('view_messages'), async (_req, res) => {
  try {
    const messages = await Message.find().sort({ createdAt: -1 }).limit(50);
    return sendSuccess(res, { messages: messages.map(mapMessage) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/communications/emails
router.get('/emails', protect, authorize('view_emails'), async (req, res) => {
  try {
    const emails = await Email.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50);
    return sendSuccess(res, { emails: emails.map(mapEmail) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/communications/messages/broadcast
router.post('/messages/broadcast', protect, authorize('manage_messages'), async (req, res) => {
  try {
    const { subject, body } = req.body;

    if (!subject || !body) {
      return sendError(res, 'Subject and body are required');
    }

    const staff = await User.find({ isActive: true, systemRole: { $ne: 'super_admin' } });

    const message = await Message.create({
      from: `${req.user.name} (${req.user.role})`,
      fromUserId: req.user._id,
      subject,
      preview: body.slice(0, 120),
      body,
      time: formatTime(),
      unread: true,
      isBroadcast: true,
      recipients: staff.map((s) => s._id),
    });

    return sendSuccess(res, { message: mapMessage(message) }, 'Broadcast sent', 201);
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// PATCH /api/communications/messages/:id/read
router.patch('/messages/:id/read', protect, authorize('view_messages'), async (req, res) => {
  try {
    const message = await Message.findByIdAndUpdate(req.params.id, { unread: false }, { new: true });
    if (!message) return sendError(res, 'Message not found', 404);
    return sendSuccess(res, { message: mapMessage(message) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// PATCH /api/communications/emails/:id/read
router.patch('/emails/:id/read', protect, authorize('view_emails'), async (req, res) => {
  try {
    const email = await Email.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { unread: false },
      { new: true }
    );
    if (!email) return sendError(res, 'Email not found', 404);
    return sendSuccess(res, { email: mapEmail(email) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
