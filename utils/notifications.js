const AttendanceLog = require('../models/AttendanceLog');
const ChatMessage = require('../models/ChatMessage');
const DelayRequest = require('../models/DelayRequest');
const Email = require('../models/Email');
const LunchReservation = require('../models/LunchReservation');
const Menu = require('../models/Menu');
const Message = require('../models/Message');
const NotificationDismissal = require('../models/NotificationDismissal');
const { hasPermission } = require('../constants/permissions');
const { formatDate, formatTime } = require('./helpers');
const { getTodayAbsentUsers } = require('./absences');

function formatNotificationTime(date) {
  if (!date) return 'Just now';
  const then = new Date(date).getTime();
  const diff = Date.now() - then;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return formatTime(new Date(date));
}

function isWorkingDay(date = new Date()) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

async function getDismissedKeys(userId) {
  const rows = await NotificationDismissal.find({ userId }).select('key');
  return new Set(rows.map((row) => row.key));
}

function pushItem(items, dismissedSet, item) {
  if (dismissedSet.has(item.id)) return;
  items.push(item);
}

async function buildNotifications(user) {
  const today = formatDate();
  const dismissedSet = await getDismissedKeys(user._id);
  const items = [];
  const now = new Date();

  if (isWorkingDay(now)) {
    const todayLog = await AttendanceLog.findOne({ userId: user._id, date: today });
    if (!todayLog?.timeIn) {
      pushItem(items, dismissedSet, {
        id: `attendance:checkin:${today}`,
        type: 'attendance',
        title: 'Check in reminder',
        message: 'You have not checked in yet today. Tap to open Time & Attendance.',
        emoji: '📋',
        time: 'Today',
        actionTab: 'attendance',
      });
    } else if (todayLog.timeIn && !todayLog.timeOut) {
      pushItem(items, dismissedSet, {
        id: `attendance:checkout:${today}`,
        type: 'attendance',
        title: 'Still checked in',
        message: `You checked in at ${todayLog.timeIn}. Remember to check out before leaving.`,
        emoji: '⏰',
        time: formatNotificationTime(todayLog.updatedAt),
        actionTab: 'attendance',
      });
    }
  }

  const chatUnread = await ChatMessage.countDocuments({
    receiver: user._id,
    read: false,
  });
  if (chatUnread > 0) {
    pushItem(items, dismissedSet, {
      id: 'chat:unread',
      type: 'chat',
      title: `${chatUnread} unread chat message${chatUnread > 1 ? 's' : ''}`,
      message: 'Open Live Chat to read and reply to your conversations.',
      emoji: '💬',
      time: 'Now',
      actionTab: 'communications',
    });
  }

  const menu = await Menu.findOne({ date: today });
  if (menu?.isLunchActive !== false && menu?.updatedAt) {
    const itemCount = menu.catalogItemIds?.length || 0;
    if (itemCount > 0) {
      pushItem(items, dismissedSet, {
        id: `menu:${today}:${menu.updatedAt.toISOString()}`,
        type: 'catering',
        title: "Today's lunch menu is ready",
        message: menu.updatedBy
          ? `${menu.updatedBy} updated today's menu. View items in Catering.`
          : 'See today\'s dishes and pick your lunch preference.',
        emoji: '🍲',
        time: formatNotificationTime(menu.updatedAt),
        actionTab: 'catering',
      });
    }
  }

  const myReservation = await LunchReservation.findOne({ userId: user._id, date: today });
  if (menu?.isLunchActive !== false && !myReservation) {
    pushItem(items, dismissedSet, {
      id: `lunch:reservation:${today}`,
      type: 'catering',
      title: 'Choose your lunch',
      message: 'You have not selected Standard, Vegan, or Opt-Out for today yet.',
      emoji: '🥗',
      time: 'Today',
      actionTab: 'catering',
    });
  }

  const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const myDelayUpdates = await DelayRequest.find({
    userId: user._id,
    status: { $in: ['Approved', 'Rejected'] },
    updatedAt: { $gte: recentCutoff },
  })
    .sort({ updatedAt: -1 })
    .limit(5);

  myDelayUpdates.forEach((delay) => {
    pushItem(items, dismissedSet, {
      id: `delay:status:${delay._id.toString()}:${delay.status}`,
      type: 'delay',
      title: `Delay request ${delay.status.toLowerCase()}`,
      message: `Your ${delay.requestedTime} delay request was ${delay.status.toLowerCase()}.`,
      emoji: delay.status === 'Approved' ? '✅' : '❌',
      time: formatNotificationTime(delay.updatedAt),
      actionTab: 'attendance',
    });
  });

  const myPendingDelay = await DelayRequest.findOne({
    userId: user._id,
    status: 'Pending',
  }).sort({ createdAt: -1 });

  if (myPendingDelay) {
    pushItem(items, dismissedSet, {
      id: `delay:pending:mine:${myPendingDelay._id.toString()}`,
      type: 'delay',
      title: 'Delay request pending',
      message: `Your request for ${myPendingDelay.requestedTime} is awaiting manager approval.`,
      emoji: '⏳',
      time: formatNotificationTime(myPendingDelay.createdAt),
      actionTab: 'attendance',
    });
  }

  if (hasPermission(user.systemRole, 'view_team_attendance')) {
    const pendingDelays = await DelayRequest.find({ status: 'Pending' })
      .sort({ createdAt: -1 })
      .limit(10);

    if (pendingDelays.length > 0) {
      pushItem(items, dismissedSet, {
        id: `delay:pending:team:${today}:${pendingDelays.length}`,
        type: 'delay',
        title: `${pendingDelays.length} delay request${pendingDelays.length > 1 ? 's' : ''} pending`,
        message: pendingDelays
          .slice(0, 3)
          .map((d) => `${d.empName} (${d.dept})`)
          .join(', ') + (pendingDelays.length > 3 ? '…' : ''),
        emoji: '⚠️',
        time: formatNotificationTime(pendingDelays[0].createdAt),
        actionTab: 'attendance',
      });
    }
  }

  if (hasPermission(user.systemRole, 'view_absent_users')) {
    const absentUsers = await getTodayAbsentUsers();
    if (absentUsers.length > 0) {
      pushItem(items, dismissedSet, {
        id: `team:absent:${today}:${absentUsers.length}`,
        type: 'team',
        title: `${absentUsers.length} absent today`,
        message: absentUsers
          .slice(0, 3)
          .map((u) => u.name)
          .join(', ') + (absentUsers.length > 3 ? '…' : ''),
        emoji: '🏠',
        time: 'Today',
        actionTab: 'home',
      });
    }
  }

  const broadcasts = await Message.find({
    unread: true,
    recipients: user._id,
  })
    .sort({ createdAt: -1 })
    .limit(5);

  broadcasts.forEach((msg) => {
    pushItem(items, dismissedSet, {
      id: `broadcast:${msg._id.toString()}`,
      type: 'broadcast',
      title: msg.subject,
      message: msg.preview || msg.body?.slice(0, 120) || 'New company announcement.',
      emoji: '📢',
      time: msg.time || formatNotificationTime(msg.createdAt),
      actionTab: 'home',
    });
  });

  if (hasPermission(user.systemRole, 'view_emails')) {
    const emails = await Email.find({ userId: user._id, unread: true })
      .sort({ createdAt: -1 })
      .limit(5);

    emails.forEach((email) => {
      pushItem(items, dismissedSet, {
        id: `email:${email._id.toString()}`,
        type: 'email',
        title: email.subject,
        message: email.preview || 'You have a new inbox message.',
        emoji: '✉️',
        time: email.time || formatNotificationTime(email.createdAt),
        actionTab: 'home',
      });
    });
  }

  return {
    notifications: items,
    unreadCount: items.length,
  };
}

async function dismissNotification(userId, key) {
  await NotificationDismissal.updateOne(
    { userId, key },
    { $set: { dismissedAt: new Date() } },
    { upsert: true },
  );
}

async function dismissAllNotifications(user) {
  const { notifications } = await buildNotifications(user);
  if (notifications.length === 0) return;

  await Promise.all(
    notifications.map((item) => dismissNotification(user._id, item.id)),
  );
}

module.exports = {
  buildNotifications,
  dismissNotification,
  dismissAllNotifications,
};
