/**
 * Sync existing users' avatar field to Cloudinary team photo URLs (by name).
 * Does not overwrite uploaded /uploads/avatars/* paths.
 *
 * Run from backend/: node utils/syncTeamAvatars.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const colors = require('colors');
const connectDB = require('../config/db');
const User = require('../models/User');
const TEAM_AVATAR_URLS = require('./teamAvatarUrls');

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const BY_NAME = new Map(
  Object.entries(TEAM_AVATAR_URLS).map(([name, url]) => [
    normalizeName(name),
    url,
  ]),
);

async function syncTeamAvatars() {
  await connectDB();

  const users = await User.find().select('name avatar');
  let updated = 0;
  let skipped = 0;

  for (const user of users) {
    const photoUrl = BY_NAME.get(normalizeName(user.name));
    if (!photoUrl) {
      skipped += 1;
      continue;
    }

    const current = user.avatar || '';
    const isUpload = current.startsWith('/uploads/');
    const alreadySet = current === photoUrl;
    if (isUpload || alreadySet) {
      skipped += 1;
      continue;
    }

    user.avatar = photoUrl;
    await user.save();
    updated += 1;
    console.log(colors.green(`  ✓ ${user.name}`));
  }

  console.log(
    colors.green.bold(
      `\n✓ Synced avatars. Updated ${updated}, skipped ${skipped}.\n`,
    ),
  );
  await mongoose.disconnect();
  process.exit(0);
}

syncTeamAvatars().catch((err) => {
  console.error(colors.red(err));
  process.exit(1);
});
