const Holiday = require('../models/Holiday');
const { toObjectId } = require('./scope');

const DEFAULT_HOLIDAYS = [
  { name: 'Republic Day', date: '2026-01-26' },
  { name: 'Holi', date: '2026-03-14' },
  { name: 'Good Friday', date: '2026-04-03' },
  { name: 'Independence Day', date: '2026-08-15' },
  { name: 'Gandhi Jayanti', date: '2026-10-02' },
  { name: 'Diwali', date: '2026-10-20' },
  { name: 'Christmas', date: '2026-12-25' },
];

function formatHolidayDate(iso) {
  try {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  } catch {
    return iso;
  }
}

function mapHoliday(h) {
  return {
    id: String(h._id),
    name: h.name,
    date: h.date,
    dateLabel: formatHolidayDate(h.date),
    optional: Boolean(h.optional),
    companyId: h.companyId ? String(h.companyId) : null,
    branchId: h.branchId ? String(h.branchId) : null,
    createdAt: h.createdAt ? new Date(h.createdAt).toISOString() : null,
  };
}

async function ensureDefaults(companyIds) {
  for (const cid of companyIds) {
    const companyObjId = toObjectId(cid);
    if (!companyObjId) continue;
    const count = await Holiday.countDocuments({ companyId: companyObjId });
    if (count > 0) continue;
    await Holiday.insertMany(
      DEFAULT_HOLIDAYS.map((h) => ({
        ...h,
        companyId: companyObjId,
        branchId: null,
      })),
    );
  }
}

module.exports = {
  DEFAULT_HOLIDAYS,
  formatHolidayDate,
  mapHoliday,
  ensureDefaults,
};
