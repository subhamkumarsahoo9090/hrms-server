const mongoose = require('mongoose');

const notificationDismissalSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true },
    dismissedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

notificationDismissalSchema.index({ userId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('NotificationDismissal', notificationDismissalSchema);
