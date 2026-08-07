const mongoose = require('mongoose');

const menuSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true },
    catalogItemIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'MenuCatalog' },
    ],
    // Legacy fields kept for backward compatibility during migration
    mainCourse: { type: String, default: '' },
    sides: { type: String, default: '' },
    dessert: { type: String, default: '' },
    veganOption: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
    lastUpdated: { type: String, default: '' },
    isLunchActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Menu', menuSchema);
