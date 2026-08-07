const fs = require('fs');
const path = require('path');

function isStoredAvatar(avatar) {
  return typeof avatar === 'string' && avatar.startsWith('/uploads/avatars/');
}

function deleteStoredAvatar(avatar) {
  if (!isStoredAvatar(avatar)) return;
  const filePath = path.join(__dirname, '..', avatar);
  fs.unlink(filePath, () => {});
}

module.exports = { isStoredAvatar, deleteStoredAvatar };
