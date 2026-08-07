const express = require('express');
const Menu = require('../models/Menu');
const MenuCatalog = require('../models/MenuCatalog');
const MenuFeedback = require('../models/MenuFeedback');
const LunchReservation = require('../models/LunchReservation');
const AttendanceLog = require('../models/AttendanceLog');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { sendSuccess, sendError, formatTime, formatDate } = require('../utils/helpers');
const {
  ACTIVE_EMPLOYEE_FILTER,
  getTodayAbsentUsers,
} = require('../utils/absences');

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

  return {
    date: menu.date,
    items,
    catalogItemIds: (menu.catalogItemIds || []).map((id) => id.toString()),
    ...legacy,
    updatedBy: menu.updatedBy || 'Not set',
    lastUpdated: menu.lastUpdated || '—',
    isLunchActive: menu.isLunchActive !== false,
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

// GET /api/catering/catalog — food item library
router.get('/catalog', protect, async (_req, res) => {
  try {
    const items = await MenuCatalog.find({ isActive: true }).sort({
      category: 1,
      name: 1,
    });
    return sendSuccess(res, { items: items.map(mapCatalogItem) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/catering/catalog — HR adds reusable item
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

// DELETE /api/catering/catalog/:id
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

// GET /api/catering/menu/today
router.get('/menu/today', protect, async (_req, res) => {
  try {
    const menu = await getOrCreateTodayMenu();
    return sendSuccess(res, { menu: await mapMenu(menu) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// PUT /api/catering/menu/today — HR picks items from catalog for today
router.put('/menu/today', protect, authorize('manage_catering'), async (req, res) => {
  try {
    const today = formatDate();
    const { catalogItemIds, isLunchActive } = req.body;

    if (!Array.isArray(catalogItemIds) || catalogItemIds.length === 0) {
      return sendError(res, 'Select at least one item from the menu library');
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

    return sendSuccess(res, { menu: await mapMenu(menu) }, 'Today\'s lunch menu published');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/catering/menu/feedback
router.get('/menu/feedback', protect, async (_req, res) => {
  try {
    const menu = await getOrCreateTodayMenu();
    const todayItemIds = await getTodayMenuItemIds(menu);
    const today = formatDate();

    const query =
      todayItemIds.length > 0
        ? { itemId: { $in: todayItemIds } }
        : { date: today };

    const feedback = await MenuFeedback.find(query)
      .sort({ createdAt: -1 })
      .limit(100);

    const formatted = feedback.map((f) => ({
      id: f._id.toString(),
      itemId: f.itemId,
      employeeName: f.employeeName,
      dept: f.dept,
      liked: f.liked,
      comment: f.comment,
      time: f.time,
    }));

    return sendSuccess(res, { feedback: formatted });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/catering/menu/feedback
router.post('/menu/feedback', protect, async (req, res) => {
  try {
    const { itemId, liked, comment } = req.body;

    if (!itemId) {
      return sendError(res, 'itemId is required');
    }

    const menu = await getOrCreateTodayMenu();
    const todayItemIds = await getTodayMenuItemIds(menu);
    if (todayItemIds.length > 0 && !todayItemIds.includes(itemId)) {
      return sendError(res, 'Item is not on today\'s menu');
    }

    const today = formatDate();
    const feedback = await MenuFeedback.create({
      itemId,
      userId: req.user._id,
      employeeName: req.user.name,
      dept: req.user.dept,
      liked: liked !== false,
      comment: comment || '',
      time: formatTime(),
      date: today,
    });

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
        },
      },
      'Feedback submitted',
      201,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/catering/menu/feedback/:itemId/like — toggle like
router.post('/menu/feedback/:itemId/like', protect, async (req, res) => {
  try {
    const { itemId } = req.params;
    const menu = await getOrCreateTodayMenu();
    const todayItemIds = await getTodayMenuItemIds(menu);
    if (todayItemIds.length > 0 && !todayItemIds.includes(itemId)) {
      return sendError(res, 'Item is not on today\'s menu');
    }

    const existing = await MenuFeedback.findOne({ userId: req.user._id, itemId });

    if (existing) {
      existing.liked = !existing.liked;
      existing.time = formatTime();
      await existing.save();
      return sendSuccess(res, { liked: existing.liked }, 'Like toggled');
    }

    const feedback = await MenuFeedback.create({
      itemId,
      userId: req.user._id,
      employeeName: req.user.name,
      dept: req.user.dept,
      liked: true,
      comment: '',
      time: formatTime(),
      date: formatDate(),
    });

    return sendSuccess(res, { liked: feedback.liked }, 'Liked', 201);
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/catering/lunch/reservations
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

// GET /api/catering/lunch/my-reservation
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

// POST /api/catering/lunch/reservations
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

// GET /api/catering/analytics — HR headcount for food ordering
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
