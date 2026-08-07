const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    from: { type: String, required: true },
    fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    subject: { type: String, required: true },
    preview: { type: String, required: true },
    body: { type: String, default: '' },
    time: { type: String, default: '' },
    unread: { type: Boolean, default: true },
    isBroadcast: { type: Boolean, default: false },
    recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Message', messageSchema);
