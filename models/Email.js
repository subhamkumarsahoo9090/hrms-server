const mongoose = require('mongoose');

const emailSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    from: { type: String, required: true },
    subject: { type: String, required: true },
    preview: { type: String, required: true },
    body: { type: String, default: '' },
    time: { type: String, default: '' },
    unread: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Email', emailSchema);
