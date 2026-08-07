const express = require('express');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { sendSuccess, sendError, formatTime, buildUserLookupFilter } = require('../utils/helpers');

const router = express.Router();

async function resolveUser(id) {
  if (!id) return null;
  return User.findOne({ ...buildUserLookupFilter(id), isActive: true });
}

function mapMessage(msg, currentUserId) {
  const senderId = msg.sender?._id?.toString() || msg.sender?.toString();
  const receiverId = msg.receiver?._id?.toString() || msg.receiver?.toString();
  return {
    id: msg._id.toString(),
    senderId,
    receiverId,
    text: msg.text,
    read: msg.read,
    createdAt: msg.createdAt.toISOString(),
    time: formatTime(msg.createdAt),
    isMine: senderId === currentUserId.toString(),
  };
}

// GET /api/chat/contacts — all users except self (any role can chat)
router.get('/contacts', protect, async (req, res) => {
  try {
    const users = await User.find({
      isActive: true,
      _id: { $ne: req.user._id },
    }).sort({ name: 1 });

    const contacts = users.map((u) => ({
      userId: u._id.toString(),
      employeeId: u.employeeId,
      name: u.name,
      avatar: u.avatar,
      role: u.role,
      dept: u.dept,
      systemRole: u.systemRole,
    }));

    return sendSuccess(res, { contacts });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/chat/conversations
router.get('/conversations', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const messages = await ChatMessage.find({
      $or: [{ sender: userId }, { receiver: userId }],
    })
      .sort({ createdAt: -1 })
      .populate('sender', 'name avatar role dept employeeId systemRole')
      .populate('receiver', 'name avatar role dept employeeId systemRole');

    const conversationMap = new Map();

    messages.forEach((msg) => {
      const isSender = msg.sender._id.toString() === userId.toString();
      const partner = isSender ? msg.receiver : msg.sender;
      const partnerId = partner._id.toString();

      if (!conversationMap.has(partnerId)) {
        const unread = messages.filter(
          (m) =>
            m.receiver._id.toString() === userId.toString() &&
            m.sender._id.toString() === partnerId &&
            !m.read,
        ).length;

        conversationMap.set(partnerId, {
          partnerId,
          partnerEmployeeId: partner.employeeId,
          partnerName: partner.name,
          partnerAvatar: partner.avatar,
          partnerRole: partner.role,
          partnerDept: partner.dept,
          partnerSystemRole: partner.systemRole,
          lastMessage: msg.text,
          lastMessageTime: formatTime(msg.createdAt),
          lastMessageAt: msg.createdAt.toISOString(),
          unreadCount: unread,
        });
      }
    });

    const conversations = Array.from(conversationMap.values()).sort(
      (a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt),
    );

    const totalUnread = await ChatMessage.countDocuments({
      receiver: userId,
      read: false,
    });

    return sendSuccess(res, { conversations, totalUnread });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/chat/messages/:partnerId?after=ISO
router.get('/messages/:partnerId', protect, async (req, res) => {
  try {
    const partner = await resolveUser(req.params.partnerId);
    if (!partner) {
      return sendError(res, 'User not found', 404);
    }

    const userId = req.user._id;
    const partnerId = partner._id;
    const query = {
      $or: [
        { sender: userId, receiver: partnerId },
        { sender: partnerId, receiver: userId },
      ],
    };

    if (req.query.after) {
      query.createdAt = { $gt: new Date(req.query.after) };
    }

    const messages = await ChatMessage.find(query)
      .sort({ createdAt: 1 })
      .limit(req.query.after ? 100 : 200)
      .populate('sender', 'name avatar')
      .populate('receiver', 'name avatar');

    return sendSuccess(res, {
      messages: messages.map((m) => mapMessage(m, userId)),
      partner: {
        userId: partner._id.toString(),
        employeeId: partner.employeeId,
        name: partner.name,
        avatar: partner.avatar,
        role: partner.role,
        dept: partner.dept,
        systemRole: partner.systemRole,
      },
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/chat/messages
router.post('/messages', protect, async (req, res) => {
  try {
    const { receiverId, text } = req.body;

    if (!receiverId || !text?.trim()) {
      return sendError(res, 'receiverId and text are required');
    }

    const receiver = await resolveUser(receiverId);
    if (!receiver) {
      return sendError(res, 'Receiver not found', 404);
    }

    if (receiver._id.toString() === req.user._id.toString()) {
      return sendError(res, 'Cannot send message to yourself');
    }

    const message = await ChatMessage.create({
      sender: req.user._id,
      receiver: receiver._id,
      text: text.trim(),
      read: false,
    });

    await message.populate('sender', 'name avatar');
    await message.populate('receiver', 'name avatar');

    return sendSuccess(
      res,
      { message: mapMessage(message, req.user._id) },
      'Message sent',
      201,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// PATCH /api/chat/read/:partnerId
router.patch('/read/:partnerId', protect, async (req, res) => {
  try {
    const partner = await resolveUser(req.params.partnerId);
    if (!partner) {
      return sendError(res, 'User not found', 404);
    }

    await ChatMessage.updateMany(
      {
        sender: partner._id,
        receiver: req.user._id,
        read: false,
      },
      { read: true },
    );

    return sendSuccess(res, null, 'Messages marked as read');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
