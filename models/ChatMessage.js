const mongoose = require('mongoose');

const MESSAGE_TYPES = ['text', 'image', 'code', 'document'];

const chatMessageSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    messageType: {
      type: String,
      enum: MESSAGE_TYPES,
      default: 'text',
      index: true,
    },
    /** Plain text, caption, or code body */
    text: { type: String, default: '', trim: true, maxlength: 20000 },
    /** Optional language hint for code snippets */
    codeLanguage: { type: String, default: '', trim: true, maxlength: 40 },
    attachment: {
      url: { type: String, default: '' },
      fileName: { type: String, default: '' },
      mimeType: { type: String, default: '' },
      size: { type: Number, default: 0 },
    },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

chatMessageSchema.index({ sender: 1, receiver: 1, createdAt: -1 });
chatMessageSchema.index({ receiver: 1, read: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
module.exports.MESSAGE_TYPES = MESSAGE_TYPES;
