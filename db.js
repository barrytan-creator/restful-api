// db.js
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');

let client = null;
let db = null;

async function connect(uri = process.env.MONGO_URI, dbname = 'tools_inventory') {
  if (db) {
    return db; // always return the database handle
  }

  client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1 }
  });

  await client.connect();
  db = client.db(dbname);

  console.log("Successfully connected to Mongo");
  return db;
}

module.exports = { connect };