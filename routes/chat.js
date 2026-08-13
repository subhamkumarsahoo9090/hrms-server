const express = require('express');
const ChatMessage = require('../models/ChatMessage');
const { MESSAGE_TYPES } = require('../models/ChatMessage');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Team = require('../models/Team');
const { protect } = require('../middleware/auth');
const { uploadChat } = require('../middleware/uploadChat');
const {
  isCompanyWideRole,
  isBranchScopedRole,
  isTeamScopedRole,
} = require('../constants/permissions');
const { toObjectId } = require('../utils/scope');
const { getUserTeamIdList } = require('../utils/teamMembership');
const {
  sendSuccess,
  sendError,
  formatTime,
  buildUserLookupFilter,
  resolveAvatar,
} = require('../utils/helpers');

const router = express.Router();

async function resolveOwnerCompanyIds(user) {
  const memberships = await CompanyMembership.find({ userId: user._id });
  const owned = await Company.find({ ownerUserId: user._id });
  return [
    ...new Set(
      [
        ...memberships.map((m) => String(m.companyId)),
        ...owned.map((c) => String(c._id)),
        user.companyId ? String(user.companyId) : null,
      ].filter(Boolean),
    ),
  ];
}

/** CEO may keep active companyId elsewhere — still reachable via Company.ownerUserId */
async function resolveCompanyOwnerUserId(companyId) {
  if (!companyId) return null;
  const company = await Company.findById(companyId).select('ownerUserId');
  return company?.ownerUserId || null;
}

async function resolveUser(id) {
  if (!id) return null;
  return User.findOne({ ...buildUserLookupFilter(id), isActive: { $ne: false } });
}

function mapContact(u) {
  return {
    userId: String(u._id),
    employeeId: u.employeeId,
    name: u.name,
    avatar: resolveAvatar(u.avatar, u.name),
    role: u.role,
    dept: u.dept,
    systemRole: u.systemRole,
    companyId: u.companyId ? String(u.companyId) : null,
    branchId: u.branchId ? String(u.branchId) : null,
  };
}

function mapMessage(msg, currentUserId) {
  const senderId = msg.sender?._id?.toString() || msg.sender?.toString();
  const receiverId = msg.receiver?._id?.toString() || msg.receiver?.toString();
  const attachment = msg.attachment || {};
  return {
    id: msg._id.toString(),
    senderId,
    receiverId,
    messageType: msg.messageType || 'text',
    text: msg.text || '',
    codeLanguage: msg.codeLanguage || '',
    attachment: attachment.url
      ? {
          url: attachment.url,
          fileName: attachment.fileName || '',
          mimeType: attachment.mimeType || '',
          size: attachment.size || 0,
        }
      : null,
    read: msg.read,
    createdAt: msg.createdAt.toISOString(),
    time: formatTime(msg.createdAt),
    isMine: senderId === String(currentUserId),
  };
}

/**
 * Official chat contacts — same org visibility pattern as directory/tasks:
 * owner → owned companies · SA → company · BH/HR → branch · manager → team · staff → branch peers
 */
async function listScopedContacts(actor) {
  if (actor.systemRole === 'company_owner') {
    const companyIds = await resolveOwnerCompanyIds(actor);
    if (!companyIds.length) return [];
    return User.find({
      isActive: { $ne: false },
      _id: { $ne: actor._id },
      companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
    })
      .select('name avatar role dept employeeId systemRole companyId branchId')
      .sort({ name: 1 });
  }

  // Super Admin — whole company + company owner (even if owner's active company differs)
  if (actor.systemRole === 'super_admin') {
    if (!actor.companyId) return [];
    const ownerUserId = await resolveCompanyOwnerUserId(actor.companyId);
    return User.find({
      isActive: { $ne: false },
      _id: { $ne: actor._id },
      $or: [
        { companyId: actor.companyId },
        ...(ownerUserId ? [{ _id: ownerUserId }] : []),
      ],
    })
      .select('name avatar role dept employeeId systemRole companyId branchId')
      .sort({ name: 1 });
  }

  if (isCompanyWideRole(actor.systemRole)) {
    if (!actor.companyId) return [];
    return User.find({
      isActive: { $ne: false },
      _id: { $ne: actor._id },
      companyId: actor.companyId,
    })
      .select('name avatar role dept employeeId systemRole companyId branchId')
      .sort({ name: 1 });
  }

  if (isBranchScopedRole(actor.systemRole)) {
    if (!actor.companyId || !actor.branchId) return [];
    const ownerUserId = await resolveCompanyOwnerUserId(actor.companyId);
    return User.find({
      isActive: { $ne: false },
      _id: { $ne: actor._id },
      $or: [
        {
          companyId: actor.companyId,
          $or: [
            { branchId: actor.branchId },
            { systemRole: { $in: ['super_admin', 'company_owner'] } },
          ],
        },
        ...(ownerUserId ? [{ _id: ownerUserId }] : []),
      ],
    })
      .select('name avatar role dept employeeId systemRole companyId branchId')
      .sort({ name: 1 });
  }

  if (isTeamScopedRole(actor.systemRole) || actor.systemRole === 'manager') {
    const teamIds = getUserTeamIdList(actor);
    const managed = await Team.find({
      managerId: actor._id,
      ...(actor.companyId ? { companyId: actor.companyId } : {}),
    }).select('_id');
    const allTeamIds = [
      ...new Set([...teamIds.map(String), ...managed.map((t) => String(t._id))]),
    ]
      .map((id) => toObjectId(id))
      .filter(Boolean);

    const ownerUserId = await resolveCompanyOwnerUserId(actor.companyId);
    const or = [{ managerId: actor._id }, { systemRole: 'super_admin' }];
    if (ownerUserId) or.push({ _id: ownerUserId });
    if (allTeamIds.length) {
      or.push({ teamId: { $in: allTeamIds } });
      or.push({ teamIds: { $in: allTeamIds } });
    }
    if (actor.branchId) {
      or.push({
        branchId: actor.branchId,
        systemRole: { $in: ['hr', 'branch_head'] },
      });
    } else {
      or.push({ systemRole: { $in: ['hr', 'branch_head'] } });
    }

    return User.find({
      isActive: { $ne: false },
      _id: { $ne: actor._id },
      $or: [
        { companyId: actor.companyId, $or: or },
        ...(ownerUserId ? [{ _id: ownerUserId }] : []),
      ],
    })
      .select('name avatar role dept employeeId systemRole companyId branchId')
      .sort({ name: 1 });
  }

  // Staff — same branch peers + manager + company leadership + owner
  if (!actor.companyId) return [];
  const ownerUserId = await resolveCompanyOwnerUserId(actor.companyId);
  const or = [
    { systemRole: { $in: ['super_admin', 'company_owner'] } },
  ];
  if (actor.managerId) or.push({ _id: actor.managerId });
  if (actor.branchId) {
    or.push({ branchId: actor.branchId });
  }
  const teamIds = getUserTeamIdList(actor);
  if (teamIds.length) {
    or.push({ teamId: { $in: teamIds } });
    or.push({ teamIds: { $in: teamIds } });
  }

  return User.find({
    isActive: { $ne: false },
    _id: { $ne: actor._id },
    $or: [
      { companyId: actor.companyId, $or: or },
      ...(ownerUserId ? [{ _id: ownerUserId }] : []),
    ],
  })
    .select('name avatar role dept employeeId systemRole companyId branchId')
    .sort({ name: 1 });
}

async function canChatWith(actor, target) {
  if (!actor || !target) return false;
  if (String(actor._id) === String(target._id)) return false;
  if (target.isActive === false) return false;

  if (actor.systemRole === 'company_owner') {
    const owned = await resolveOwnerCompanyIds(actor);
    return Boolean(target.companyId && owned.includes(String(target.companyId)));
  }

  // Super Admin ↔ Company Owner of their company (two-way)
  if (
    actor.systemRole === 'super_admin' &&
    target.systemRole === 'company_owner' &&
    actor.companyId
  ) {
    const ownerUserId = await resolveCompanyOwnerUserId(actor.companyId);
    if (ownerUserId && String(ownerUserId) === String(target._id)) return true;
  }
  if (
    actor.systemRole === 'company_owner' &&
    target.systemRole === 'super_admin' &&
    target.companyId
  ) {
    const owned = await resolveOwnerCompanyIds(actor);
    if (owned.includes(String(target.companyId))) return true;
  }

  const contacts = await listScopedContacts(actor);
  return contacts.some((c) => String(c._id) === String(target._id));
}

function previewText(msg) {
  const type = msg.messageType || 'text';
  if (type === 'image') return msg.text?.trim() ? msg.text : '📷 Image';
  if (type === 'document') {
    return msg.attachment?.fileName
      ? `📎 ${msg.attachment.fileName}`
      : '📎 Document';
  }
  if (type === 'code') return msg.text?.trim() ? `</> ${msg.text.slice(0, 60)}` : '</> Code';
  return msg.text || '';
}

// GET /api/chat/contacts
router.get('/contacts', protect, async (req, res) => {
  try {
    const users = await listScopedContacts(req.user);
    const scopeLabel =
      req.user.systemRole === 'company_owner'
        ? 'All owned companies'
        : isCompanyWideRole(req.user.systemRole)
          ? 'Company-wide'
          : isBranchScopedRole(req.user.systemRole)
            ? 'Your branch'
            : isTeamScopedRole(req.user.systemRole)
              ? 'Your team + leadership'
              : 'Your branch peers';

    return sendSuccess(res, {
      contacts: users.map(mapContact),
      scope: scopeLabel,
    });
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
      .populate('sender', 'name avatar role dept employeeId systemRole companyId branchId')
      .populate('receiver', 'name avatar role dept employeeId systemRole companyId branchId');

    const conversationMap = new Map();

    messages.forEach((msg) => {
      const sender = msg.sender;
      const receiver = msg.receiver;
      if (!sender?._id || !receiver?._id) return;

      const isSender = String(sender._id) === String(userId);
      const partner = isSender ? receiver : sender;
      const partnerId = String(partner._id);

      if (!conversationMap.has(partnerId)) {
        const unread = messages.filter(
          (m) =>
            m.receiver &&
            String(m.receiver._id) === String(userId) &&
            m.sender &&
            String(m.sender._id) === partnerId &&
            !m.read,
        ).length;

        conversationMap.set(partnerId, {
          partnerId,
          partnerEmployeeId: partner.employeeId,
          partnerName: partner.name,
          partnerAvatar: resolveAvatar(partner.avatar, partner.name),
          partnerRole: partner.role,
          partnerDept: partner.dept,
          partnerSystemRole: partner.systemRole,
          lastMessage: previewText(msg),
          lastMessageType: msg.messageType || 'text',
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

// GET /api/chat/messages/:partnerId
router.get('/messages/:partnerId', protect, async (req, res) => {
  try {
    const partner = await resolveUser(req.params.partnerId);
    if (!partner) return sendError(res, 'User not found', 404);

    const allowed = await canChatWith(req.user, partner);
    if (!allowed) {
      return sendError(res, 'Forbidden — user is outside your chat scope', 403);
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
      .limit(req.query.after ? 100 : 300);

    return sendSuccess(res, {
      messages: messages.map((m) => mapMessage(m, userId)),
      partner: mapContact(partner),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

async function createChatMessage(req, res, payload) {
  const { receiverId, text, messageType, codeLanguage, attachment } = payload;

  if (!receiverId) return sendError(res, 'receiverId is required');

  const type = MESSAGE_TYPES.includes(messageType) ? messageType : 'text';
  const body = String(text || '').trim();

  if (type === 'text' && !body) {
    return sendError(res, 'Message text is required');
  }
  if (type === 'code' && !body) {
    return sendError(res, 'Code content is required');
  }
  if ((type === 'image' || type === 'document') && !attachment?.url) {
    return sendError(res, 'Attachment is required');
  }

  const receiver = await resolveUser(receiverId);
  if (!receiver) return sendError(res, 'Receiver not found', 404);
  if (String(receiver._id) === String(req.user._id)) {
    return sendError(res, 'Cannot send message to yourself');
  }

  const allowed = await canChatWith(req.user, receiver);
  if (!allowed) {
    return sendError(res, 'Forbidden — receiver is outside your chat scope', 403);
  }

  const message = await ChatMessage.create({
    companyId: req.user.companyId || receiver.companyId || null,
    sender: req.user._id,
    receiver: receiver._id,
    messageType: type,
    text: body,
    codeLanguage: type === 'code' ? String(codeLanguage || '').slice(0, 40) : '',
    attachment: attachment || undefined,
    read: false,
  });

  return sendSuccess(
    res,
    { message: mapMessage(message, req.user._id) },
    'Message sent',
    201,
  );
}

// POST /api/chat/messages — text or code (JSON)
router.post('/messages', protect, async (req, res) => {
  try {
    const { receiverId, text, messageType, codeLanguage } = req.body;
    return await createChatMessage(req, res, {
      receiverId,
      text,
      messageType: messageType || 'text',
      codeLanguage,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/chat/messages/upload — image or document (multipart)
router.post('/messages/upload', protect, (req, res) => {
  uploadChat.single('file')(req, res, async (err) => {
    if (err) {
      return sendError(res, err.message || 'Upload failed', 400);
    }
    try {
      if (!req.file) return sendError(res, 'file is required');

      const receiverId = req.body.receiverId;
      const caption = req.body.text || '';
      const mime = req.file.mimetype || '';
      const isImage = mime.startsWith('image/');
      const messageType =
        req.body.messageType === 'document' || !isImage ? 'document' : 'image';

      const attachment = {
        url: `/uploads/chat/${req.file.filename}`,
        fileName: req.file.originalname || req.file.filename,
        mimeType: mime,
        size: req.file.size || 0,
      };

      return await createChatMessage(req, res, {
        receiverId,
        text: caption,
        messageType,
        attachment,
      });
    } catch (e) {
      return sendError(res, e.message, 500);
    }
  });
});

// PATCH /api/chat/read/:partnerId
router.patch('/read/:partnerId', protect, async (req, res) => {
  try {
    const partner = await resolveUser(req.params.partnerId);
    if (!partner) return sendError(res, 'User not found', 404);

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
