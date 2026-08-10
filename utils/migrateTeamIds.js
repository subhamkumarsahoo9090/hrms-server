/**
 * Backfill User.teamIds from legacy User.teamId.
 * Usage: npm run migrate:team-ids
 */
require('dotenv').config();
const mongoose = require('mongoose');
const colors = require('colors');
const connectDB = require('../config/db');
const User = require('../models/User');

async function migrate() {
  await connectDB();
  console.log(colors.bold('\n=== Backfill teamIds from teamId ===\n'));

  const users = await User.find({
    teamId: { $ne: null },
    $or: [{ teamIds: { $exists: false } }, { teamIds: { $size: 0 } }, { teamIds: null }],
  });

  let updated = 0;
  for (const user of users) {
    const ids = new Set();
    if (user.teamId) ids.add(String(user.teamId));
    for (const t of user.teamIds || []) ids.add(String(t));
    user.teamIds = [...ids];
    await user.save();
    updated += 1;
  }

  // Also sync anyone whose teamId is missing from teamIds
  const allWithTeam = await User.find({ teamId: { $ne: null } });
  let synced = 0;
  for (const user of allWithTeam) {
    const key = String(user.teamId);
    const has = (user.teamIds || []).some((t) => String(t) === key);
    if (!has) {
      user.teamIds = [...(user.teamIds || []), user.teamId];
      await user.save();
      synced += 1;
    }
  }

  console.log(colors.green(`✓ Backfilled ${updated} users`));
  console.log(colors.green(`✓ Synced primary into teamIds for ${synced} users\n`));
  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((err) => {
  console.error(colors.red(err));
  process.exit(1);
});
