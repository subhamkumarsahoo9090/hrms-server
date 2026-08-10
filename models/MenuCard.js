const mongoose = require('mongoose');

/**
 * Reusable lunch menu "card" — HR builds cards from catalog dishes,
 * then schedules a card onto one or more calendar dates.
 */
const menuCardSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    catalogItemIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuCatalog' }],
      default: [],
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
      index: true,
    },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: '' },
    createdById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

menuCardSchema.index({ name: 1, companyId: 1 });

module.exports = mongoose.model('MenuCard', menuCardSchema);
