require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');

let client = null;
let db = null;

async function connect(uri = process.env.MONGO_URI, dbname = 'tools_inventory') {
  try {
    // If already connected, return the existing db handle
    if (db) {
      return db;
    }

    client = new MongoClient(uri, {
      serverApi: { version: ServerApiVersion.v1 }
    });

    await client.connect();
    db = client.db(dbname);

    console.log("Successfully connected to MongoDB");
    return db;
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    throw error; // rethrow so index.js can handle it
  }
}

module.exports = { connect };