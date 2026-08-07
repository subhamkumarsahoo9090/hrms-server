const mongoose = require('mongoose');

const menuCatalogSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['main', 'side', 'dessert', 'vegan'],
      required: true,
    },
    description: { type: String, default: '', trim: true },
    emoji: { type: String, default: '🍽️' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true },
);

menuCatalogSchema.index({ category: 1, name: 1 });

module.exports = mongoose.model('MenuCatalog', menuCatalogSchema);
