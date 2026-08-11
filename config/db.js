const mongoose = require('mongoose');
const colors = require('colors');

async function connectDB() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/hrcore';

  try {
    const conn = await mongoose.connect(uri);
    console.log(colors.cyan.bold(`MongoDB connected: ${conn.connection.host}`));
    await dropLegacyUserIndexes();
  } catch (err) {
    console.error(colors.red.bold(`MongoDB connection error: ${err.message}`));
    process.exit(1);
  }
}

/** Old global unique indexes block multi-company (email / EMP ids must be unique per company only). */
async function dropLegacyUserIndexes() {
  try {
    const collection = mongoose.connection.collection('users');
    const indexes = await collection.indexes();
    for (const idx of indexes) {
      const keys = Object.keys(idx.key || {});
      if (
        idx.unique &&
        keys.length === 1 &&
        (keys[0] === 'email' || keys[0] === 'employeeId')
      ) {
        await collection.dropIndex(idx.name);
        console.log(colors.yellow(`Dropped legacy unique index: ${idx.name}`));
      }
    }
  } catch (err) {
    console.log(colors.gray(`Legacy user index check skipped: ${err.message}`));
  }
}

module.exports = connectDB;
