const mongoose = require('mongoose');
const colors = require('colors');

async function connectDB() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/hrcore';

  try {
    const conn = await mongoose.connect(uri);
    console.log(colors.cyan.bold(`MongoDB connected: ${conn.connection.host}`));
  } catch (err) {
    console.error(colors.red.bold(`MongoDB connection error: ${err.message}`));
    process.exit(1);
  }
}

module.exports = connectDB;
