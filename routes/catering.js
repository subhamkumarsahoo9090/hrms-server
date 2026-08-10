const express = require('express');
const Menu = require('../models/Menu');
const MenuCatalog = require('../models/MenuCatalog');
const MenuCard = require('../models/MenuCard');
const MenuFeedback = require('../models/MenuFeedback');
const LunchReservation = require('../models/LunchReservation');
const AttendanceLog = require('../models/AttendanceLog');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { hasPermission } = require('../constants/permissions');
const { sendSuccess, sendError, formatTime, formatDate } = require('../utils/helpers');
const {
  ACTIVE_EMPLOYEE_FILTER,
  getTodayAbsentUsers,
} = require('../utils/absences');
const { ensureDefaultDishes } = require('../utils/seedMenuDishes');

const router = express.Router();

const CATEGORY_EMOJI = {
  main: '🍗',
  side: '🥗',
  dessert: '🍫',
  vegan: '🥑',
};

const CATEGORY_LABEL = {
  main: 'Main Course',
  side: 'Side Dish',
  dessert: 'Dessert',
  vegan: 'Vegan Option',
};

function mapCatalogItem(item) {
  if (!item) return null;
  return {
    id: item._id.toString(),
    name: item.name,
    category: item.category,
    description: item.description || '',
    emoji: item.emoji || CATEGORY_EMOJI[item.category] || '🍽️',
    isActive: item.isActive !== false,
    createdBy: item.createdBy || '',
  };
}

function legacyItemsFromMenu(menu) {
  const items = [];
  if (menu.mainCourse) {
    items.push({
      id: 'legacy-main',
      name: menu.mainCourse,
      category: 'main',
      description: menu.sides ? `Sides: ${menu.sides}` : '',
      emoji: '🍗',
    });
  }
  if (menu.veganOption) {
    items.push({
      id: 'legacy-vegan',
      name: menu.veganOption,
      category: 'vegan',
      description: '',
      emoji: '🥑',
    });
  }
  if (menu.dessert) {
    items.push({
      id: 'legacy-dessert',
      name: menu.dessert,
      category: 'dessert',
      description: '',
      emoji: '🍫',
    });
  }
  return items;
}

async function resolveMenuItems(menu) {
  if (menu.catalogItemIds?.length) {
    const catalog = await MenuCatalog.find({
      _id: { $in: menu.catalogItemIds },
      isActive: true,
    });
    const byId = new Map(catalog.map((c) => [c._id.toString(), c]));
    return menu.catalogItemIds
      .map((id) => mapCatalogItem(byId.get(id.toString())))
      .filter(Boolean);
  }
  return legacyItemsFromMenu(menu);
}

function deriveLegacyFields(items) {
  const mains = items.filter((i) => i.category === 'main');
  const sides = items.filter((i) => i.category === 'side');
  const desserts = items.filter((i) => i.category === 'dessert');
  const vegan = items.filter((i) => i.category === 'vegan');

  return {
    mainCourse: mains.map((i) => i.name).join(', ') || 'Not set',
    sides: sides.map((i) => i.name).join(', ') || '',
    dessert: desserts.map((i) => i.name).join(', ') || 'Not set',
    veganOption: vegan.map((i) => i.name).join(', ') || 'Not set',
  };
}

async function mapMenu(menu) {
  const items = await resolveMenuItems(menu);
  const legacy = deriveLegacyFields(items);
  let card = null;
  if (menu.menuCardId) {
    const c = await MenuCard.findById(menu.menuCardId).select('name description');
    if (c) {
      card = { id: String(c._id), name: c.name, description: c.description || '' };
    }
  }

  return {
    date: menu.date,
    items,
    catalogItemIds: (menu.catalogItemIds || []).map((id) => id.toString()),
    menuCardId: menu.menuCardId ? String(menu.menuCardId) : null,
    menuCard: card,
    ...legacy,
    updatedBy: menu.updatedBy || 'Not set',
    lastUpdated: menu.lastUpdated || '—',
    isLunchActive: menu.isLunchActive !== false,
  };
}

async function mapCard(card) {
  const catalog = await MenuCatalog.find({
    _id: { $in: card.catalogItemIds || [] },
    isActive: true,
  });
  const byId = new Map(catalog.map((c) => [c._id.toString(), c]));
  const items = (card.catalogItemIds || [])
    .map((id) => mapCatalogItem(byId.get(id.toString())))
    .filter(Boolean);

  const schedules = await Menu.find({ menuCardId: card._id })
    .select('date isLunchActive')
    .sort({ date: 1 })
    .limit(60);

  return {
    id: String(card._id),
    name: card.name,
    description: card.description || '',
    catalogItemIds: (card.catalogItemIds || []).map((id) => String(id)),
    items,
    itemCount: items.length,
    isActive: card.isActive !== false,
    createdBy: card.createdBy || '',
    schedules: schedules.map((s) => ({
      date: s.date,
      isLunchActive: s.isLunchActive !== false,
    })),
    createdAt: card.createdAt ? new Date(card.createdAt).toISOString() : null,
  };
}

async function getOrCreateTodayMenu() {
  const today = formatDate();
  let menu = await Menu.findOne({ date: today });

  if (!menu) {
    menu = await Menu.create({
      date: today,
      catalogItemIds: [],
      updatedBy: 'Not set',
      lastUpdated: '—',
      isLunchActive: false,
    });
  }

  return menu;
}

async function getTodayMenuItemIds(menu) {
  const items = await resolveMenuItems(menu);
  return items.map((item) => item.id);
}

function normalizeDate(input) {
  const raw = String(input || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

async function scheduleCardOnDate(card, date, user) {
  const validItems = await MenuCatalog.find({
    _id: { $in: card.catalogItemIds },
    isActive: true,
  });
  if (validItems.length < 4) {
    throw new Error('Menu card must have at least 4 active dishes');
  }

  const validIds = (card.catalogItemIds || []).filter((id) =>
    validItems.some((v) => String(v._id) === String(id)),
  );

  const update = {
    catalogItemIds: validIds,
    menuCardId: card._id,
    updatedBy: `${user.name} (${user.role || user.systemRole})`,
    lastUpdated: `${formatTime()} · ${date}`,
    isLunchActive: true,
  };

  let menu = await Menu.findOne({ date });
  if (menu) {
    Object.assign(menu, update);
    await menu.save();
  } else {
    menu = await Menu.create({ date, ...update });
  }
  return menu;
}

router.get('/catalog', protect, async (_req, res) => {
  try {
    await ensureDefaultDishes(MenuCatalog);
    const items = await MenuCatalog.find({ isActive: true }).sort({
      category: 1,
      name: 1,
    });
    return sendSuccess(res, { items: items.map(mapCatalogItem) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.post('/catalog', protect, authorize('manage_catering'), async (req, res) => {
  try {
    const { name, category, description, emoji } = req.body;

    if (!name?.trim()) {
      return sendError(res, 'Item name is required');
    }
    if (!category || !['main', 'side', 'dessert', 'vegan'].includes(category)) {
      return sendError(res, 'Valid category (main, side, dessert, vegan) is required');
    }

    const item = await MenuCatalog.create({
      name: name.trim(),
      category,
      description: description?.trim() || '',
      emoji: emoji || CATEGORY_EMOJI[category] || '🍽️',
      createdBy: `${req.user.name} (${req.user.role})`,
    });

    return sendSuccess(
      res,
      { item: mapCatalogItem(item) },
      'Menu item added to library',
      201,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.delete(
  '/catalog/:id',
  protect,
  authorize('manage_catering'),
  async (req, res) => {
    try {
      const item = await MenuCatalog.findByIdAndUpdate(
        req.params.id,
        { isActive: false },
        { new: true },
      );
      if (!item) {
        return sendError(res, 'Menu item not found', 404);
      }
      return sendSuccess(res, null, 'Menu item removed from library');
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

router.get('/cards', protect, async (req, res) => {
  try {
    await ensureDefaultDishes(MenuCatalog);
    const cards = await MenuCard.find({ isActive: true }).sort({ updatedAt: -1 });
    const mapped = [];
    for (const c of cards) {
      mapped.push(await mapCard(c));
    }
    return sendSuccess(res, {
      cards: mapped,
      canManage: hasPermission(req.user.systemRole, 'manage_catering'),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.post('/cards', protect, authorize('manage_catering'), async (req, res) => {
  try {
    const { name, description, catalogItemIds } = req.body;
    if (!name?.trim()) return sendError(res, 'Card name is required');
    if (!Array.isArray(catalogItemIds) || catalogItemIds.length < 4) {
      return sendError(res, 'Select at least 4 dishes for a menu card');
    }

    const validItems = await MenuCatalog.find({
      _id: { $in: catalogItemIds },
      isActive: true,
    });
    if (validItems.length < 4) {
      return sendError(res, 'At least 4 valid catalog dishes are required');
    }

    const orderedIds = catalogItemIds
      .map(String)
      .filter((id, idx, arr) => arr.indexOf(id) === idx)
      .filter((id) => validItems.some((v) => String(v._id) === id));

    const card = await MenuCard.create({
      name: name.trim(),
      description: description?.trim() || '',
      catalogItemIds: orderedIds,
      companyId: req.user.companyId || null,
      createdBy: `${req.user.name} (${req.user.role || req.user.systemRole})`,
      createdById: req.user._id,
    });

    return sendSuccess(res, { card: await mapCard(card) }, 'Menu card created', 201);
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.patch('/cards/:id', protect, authorize('manage_catering'), async (req, res) => {
  try {
    const card = await MenuCard.findById(req.params.id);
    if (!card || card.isActive === false) {
      return sendError(res, 'Menu card not found', 404);
    }

    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return sendError(res, 'Card name cannot be empty');
      card.name = name;
    }
    if (req.body.description !== undefined) {
      card.description = String(req.body.description || '').trim();
    }
    if (req.body.catalogItemIds !== undefined) {
      if (!Array.isArray(req.body.catalogItemIds) || req.body.catalogItemIds.length < 4) {
        return sendError(res, 'Select at least 4 dishes for a menu card');
      }
      const validItems = await MenuCatalog.find({
        _id: { $in: req.body.catalogItemIds },
        isActive: true,
      });
      if (validItems.length < 4) {
        return sendError(res, 'At least 4 valid catalog dishes are required');
      }
      card.catalogItemIds = req.body.catalogItemIds
        .map(String)
        .filter((id, idx, arr) => arr.indexOf(id) === idx)
        .filter((id) => validItems.some((v) => String(v._id) === id));
    }

    await card.save();
    return sendSuccess(res, { card: await mapCard(card) }, 'Menu card updated');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.delete('/cards/:id', protect, authorize('manage_catering'), async (req, res) => {
  try {
    const card = await MenuCard.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true },
    );
    if (!card) return sendError(res, 'Menu card not found', 404);
    return sendSuccess(res, null, 'Menu card archived');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.post(
  '/cards/:id/schedule',
  protect,
  authorize('manage_catering'),
  async (req, res) => {
    try {
      const card = await MenuCard.findById(req.params.id);
      if (!card || card.isActive === false) {
        return sendError(res, 'Menu card not found', 404);
      }

      const datesRaw = Array.isArray(req.body.dates)
        ? req.body.dates
        : [req.body.date || formatDate()];
      const dates = [...new Set(datesRaw.map(normalizeDate).filter(Boolean))];
      if (!dates.length) {
        return sendError(res, 'Provide date or dates as YYYY-MM-DD');
      }

      const menus = [];
      for (const date of dates) {
        const menu = await scheduleCardOnDate(card, date, req.user);
        menus.push(await mapMenu(menu));
      }

      return sendSuccess(
        res,
        { menus, card: await mapCard(card) },
        dates.length === 1
          ? `Menu card scheduled for ${dates[0]}`
          : `Menu card scheduled for ${dates.length} dates`,
      );
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

router.get('/menu', protect, async (req, res) => {
  try {
    const date = normalizeDate(req.query.date) || formatDate();
    const menu = await Menu.findOne({ date });
    if (!menu) {
      return sendSuccess(res, {
        menu: {
          date,
          items: [],
          catalogItemIds: [],
          menuCardId: null,
          menuCard: null,
          mainCourse: 'Not set',
          sides: '',
          dessert: 'Not set',
          veganOption: 'Not set',
          updatedBy: 'Not set',
          lastUpdated: '—',
          isLunchActive: false,
        },
        canManage: hasPermission(req.user.systemRole, 'manage_catering'),
      });
    }
    return sendSuccess(res, {
      menu: await mapMenu(menu),
      canManage: hasPermission(req.user.systemRole, 'manage_catering'),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.get('/menu/today', protect, async (req, res) => {
  try {
    const menu = await getOrCreateTodayMenu();
    return sendSuccess(res, {
      menu: await mapMenu(menu),
      canManage: hasPermission(req.user.systemRole, 'manage_catering'),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.put('/menu/today', protect, authorize('manage_catering'), async (req, res) => {
  try {
    const today = formatDate();
    const { catalogItemIds, isLunchActive, menuCardId } = req.body;

    if (menuCardId) {
      const card = await MenuCard.findById(menuCardId);
      if (!card || card.isActive === false) {
        return sendError(res, 'Menu card not found', 404);
      }
      const menu = await scheduleCardOnDate(card, today, req.user);
      if (isLunchActive === false) {
        menu.isLunchActive = false;
        await menu.save();
      }
      return sendSuccess(res, { menu: await mapMenu(menu) }, "Today's lunch menu published");
    }

    if (!Array.isArray(catalogItemIds) || catalogItemIds.length === 0) {
      return sendError(res, 'Select a menu card or at least one catalog item');
    }

    const validItems = await MenuCatalog.find({
      _id: { $in: catalogItemIds },
      isActive: true,
    });

    if (validItems.length === 0) {
      return sendError(res, 'No valid menu items selected');
    }

    const validIds = validItems.map((item) => item._id);
    let menu = await Menu.findOne({ date: today });
    const update = {
      catalogItemIds: validIds,
      menuCardId: null,
      updatedBy: `${req.user.name} (${req.user.role})`,
      lastUpdated: `${formatTime()} Today`,
      isLunchActive: isLunchActive !== false,
    };

    if (menu) {
      Object.assign(menu, update);
      await menu.save();
    } else {
      menu = await Menu.create({ date: today, ...update });
    }

    return sendSuccess(res, { menu: await mapMenu(menu) }, "Today's lunch menu published");
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.get('/menu/feedback', protect, async (req, res) => {
  try {
    const menu = await getOrCreateTodayMenu();
    const todayItemIds = await getTodayMenuItemIds(menu);
    const today = formatDate();

    const query =
      todayItemIds.length > 0
        ? { itemId: { $in: todayItemIds }, date: today }
        : { date: today };

    const feedback = await MenuFeedback.find(query).sort({ createdAt: -1 }).limit(200);

    const formatted = feedback.map((f) => ({
      id: f._id.toString(),
      itemId: f.itemId,
      userId: f.userId ? String(f.userId) : null,
      employeeName: f.employeeName,
      dept: f.dept,
      liked: f.liked,
      comment: f.comment,
      time: f.time,
      date: f.date,
    }));

    const summaryByItem = {};
    todayItemIds.forEach((id) => {
      summaryByItem[id] = { likes: 0, dislikes: 0, comments: 0 };
    });
    feedback.forEach((f) => {
      if (!summaryByItem[f.itemId]) {
        summaryByItem[f.itemId] = { likes: 0, dislikes: 0, comments: 0 };
      }
      if (f.liked) summaryByItem[f.itemId].likes += 1;
      else summaryByItem[f.itemId].dislikes += 1;
      if (f.comment && String(f.comment).trim()) {
        summaryByItem[f.itemId].comments += 1;
      }
    });

    const myFeedback = feedback
      .filter((f) => String(f.userId) === String(req.user._id))
      .map((f) => ({
        id: f._id.toString(),
        itemId: f.itemId,
        liked: f.liked,
        comment: f.comment || '',
        time: f.time,
      }));

    return sendSuccess(res, {
      feedback: formatted,
      summaryByItem,
      myFeedback,
      date: today,
      canReview: todayItemIds.length > 0,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.post('/menu/feedback', protect, async (req, res) => {
  try {
    const { itemId, liked, comment } = req.body;

    if (!itemId) {
      return sendError(res, 'itemId is required');
    }

    const menu = await getOrCreateTodayMenu();
    const todayItemIds = await getTodayMenuItemIds(menu);
    if (todayItemIds.length === 0) {
      return sendError(res, "No lunch menu published for today");
    }
    if (!todayItemIds.includes(String(itemId))) {
      return sendError(res, "Item is not on today's menu");
    }

    const today = formatDate();
    let feedback = await MenuFeedback.findOne({
      userId: req.user._id,
      itemId: String(itemId),
      date: today,
    });

    const likedValue =
      liked === undefined || liked === null ? true : Boolean(liked);
    const commentValue =
      comment !== undefined ? String(comment).trim().slice(0, 500) : undefined;

    if (feedback) {
      if (liked !== undefined && liked !== null) feedback.liked = likedValue;
      if (commentValue !== undefined) feedback.comment = commentValue;
      feedback.employeeName = req.user.name;
      feedback.dept = req.user.dept || '';
      feedback.time = formatTime();
      await feedback.save();
    } else {
      feedback = await MenuFeedback.create({
        itemId: String(itemId),
        userId: req.user._id,
        employeeName: req.user.name,
        dept: req.user.dept || '',
        liked: likedValue,
        comment: commentValue || '',
        time: formatTime(),
        date: today,
      });
    }

    return sendSuccess(
      res,
      {
        feedback: {
          id: feedback._id.toString(),
          itemId: feedback.itemId,
          employeeName: feedback.employeeName,
          dept: feedback.dept,
          liked: feedback.liked,
          comment: feedback.comment,
          time: feedback.time,
          date: feedback.date,
        },
      },
      'Review saved',
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.post('/menu/feedback/:itemId/like', protect, async (req, res) => {
  try {
    const { itemId } = req.params;
    const menu = await getOrCreateTodayMenu();
    const todayItemIds = await getTodayMenuItemIds(menu);
    if (todayItemIds.length === 0) {
      return sendError(res, "No lunch menu published for today");
    }
    if (!todayItemIds.includes(String(itemId))) {
      return sendError(res, "Item is not on today's menu");
    }

    const today = formatDate();
    // body.liked = true | false; if omitted, toggle
    let nextLiked;
    if (req.body && (req.body.liked === true || req.body.liked === false)) {
      nextLiked = Boolean(req.body.liked);
    }

    let existing = await MenuFeedback.findOne({
      userId: req.user._id,
      itemId: String(itemId),
      date: today,
    });

    if (existing) {
      existing.liked =
        nextLiked === undefined ? !existing.liked : nextLiked;
      existing.time = formatTime();
      existing.employeeName = req.user.name;
      existing.dept = req.user.dept || '';
      await existing.save();
      return sendSuccess(
        res,
        { liked: existing.liked, feedbackId: String(existing._id) },
        existing.liked ? 'Liked' : 'Disliked',
      );
    }

    const feedback = await MenuFeedback.create({
      itemId: String(itemId),
      userId: req.user._id,
      employeeName: req.user.name,
      dept: req.user.dept || '',
      liked: nextLiked === undefined ? true : nextLiked,
      comment: '',
      time: formatTime(),
      date: today,
    });

    return sendSuccess(
      res,
      { liked: feedback.liked, feedbackId: String(feedback._id) },
      feedback.liked ? 'Liked' : 'Disliked',
      201,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.get('/lunch/reservations', protect, async (_req, res) => {
  try {
    const today = formatDate();
    const reservations = await LunchReservation.find({ date: today });
    const formatted = reservations.map((r) => ({
      empId: r.empId,
      name: r.name,
      dept: r.dept,
      selection: r.selection,
      notes: r.notes,
    }));
    return sendSuccess(res, { reservations: formatted });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.get('/lunch/my-reservation', protect, async (req, res) => {
  try {
    const today = formatDate();
    const reservation = await LunchReservation.findOne({
      userId: req.user._id,
      date: today,
    });
    return sendSuccess(res, { reservation: reservation || null });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.post('/lunch/reservations', protect, async (req, res) => {
  try {
    const { selection, notes } = req.body;
    const valid = ['Standard', 'Vegan', 'Opt-Out'];

    if (!selection || !valid.includes(selection)) {
      return sendError(res, 'Selection must be Standard, Vegan, or Opt-Out');
    }

    const today = formatDate();
    let reservation = await LunchReservation.findOne({
      userId: req.user._id,
      date: today,
    });

    const data = {
      date: today,
      userId: req.user._id,
      empId: req.user.employeeId,
      name: req.user.name,
      dept: req.user.dept,
      selection,
      notes: notes || '',
    };

    if (reservation) {
      Object.assign(reservation, data);
      await reservation.save();
    } else {
      reservation = await LunchReservation.create(data);
    }

    return sendSuccess(
      res,
      {
        reservation: {
          empId: reservation.empId,
          name: reservation.name,
          dept: reservation.dept,
          selection: reservation.selection,
          notes: reservation.notes,
        },
      },
      'Lunch reservation updated',
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.get('/analytics', protect, authorize('manage_catering'), async (_req, res) => {
  try {
    const today = formatDate();

    const [reservations, onDutyToday, absentUsers, headcount, remoteCount] =
      await Promise.all([
        LunchReservation.find({ date: today }),
        AttendanceLog.countDocuments({
          date: today,
          timeIn: { $exists: true, $ne: '' },
        }),
        getTodayAbsentUsers(today),
        User.countDocuments(ACTIVE_EMPLOYEE_FILTER),
        User.countDocuments({ ...ACTIVE_EMPLOYEE_FILTER, status: 'Remote' }),
      ]);

    const absentToday = absentUsers.length;
    const attendancePresent = onDutyToday;
    const lunchPortionsNeeded = onDutyToday;

    const optOutCount = reservations.filter((r) => r.selection === 'Opt-Out').length;
    const standardCount = reservations.filter((r) => r.selection === 'Standard').length;
    const veganCount = reservations.filter((r) => r.selection === 'Vegan').length;
    const activeReservations = reservations.filter(
      (r) => r.selection !== 'Opt-Out',
    ).length;

    const reservationTotal = Math.max(reservations.length, 1);
    const activeReservationTotal = Math.max(activeReservations, 1);

    const extrapolatedTotalEating =
      lunchPortionsNeeded > 0 && activeReservations > 0
        ? Math.min(
            lunchPortionsNeeded,
            Math.round(
              (activeReservations / reservationTotal) * lunchPortionsNeeded,
            ) || lunchPortionsNeeded,
          )
        : lunchPortionsNeeded;

    const estimatedStandardNeeded =
      activeReservations > 0
        ? Math.round(
            extrapolatedTotalEating * (standardCount / activeReservationTotal),
          )
        : Math.ceil(extrapolatedTotalEating * 0.75);

    const estimatedVeganNeeded =
      activeReservations > 0
        ? Math.round(
            extrapolatedTotalEating * (veganCount / activeReservationTotal),
          )
        : Math.max(0, extrapolatedTotalEating - estimatedStandardNeeded);

    const portionsPrepared = estimatedStandardNeeded + estimatedVeganNeeded;
    const surplusCount = Math.max(0, portionsPrepared - extrapolatedTotalEating);

    return sendSuccess(res, {
      calculations: {
        headcount,
        remoteCount,
        attendancePresent,
        absentToday,
        lunchPortionsNeeded,
        activeReservations,
        optOutCount,
        standardReservationCount: standardCount,
        veganReservationCount: veganCount,
        extrapolatedTotalEating,
        estimatedStandardNeeded,
        estimatedVeganNeeded,
        portionsPrepared,
        surplusCount,
        shortageRisk: extrapolatedTotalEating > portionsPrepared,
        absentUsers,
      },
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
module.exports.CATEGORY_LABEL = CATEGORY_LABEL;
