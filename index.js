// index.js
const express = require('express');
require('dotenv').config();
const cors = require('cors');
const { connect } = require("./db");
const { ObjectId } = require('mongodb');

// SETUP EXPRESS
const app = express();
app.use(cors());
app.use(express.json());

// SETUP DATABASE
const mongoUri = process.env.MONGO_URI;
const dbName = "tools_inventory";

// Validation helper
async function validateTool(db, request) {
  const { name, category, quantity, rack, status, purchaseDate } = request;

  if (!name || !category || !quantity || !rack || !status || !purchaseDate) {
    return { success: false, error: "Missing fields" };
  }

  // Optional: validate category against a categories collection
  const categoryDoc = await db.collection('categories').findOne({ name: category });
  if (!categoryDoc) {
    return { success: false, error: "Invalid category" };
  }

  const newTool = {
    name,
    category: { _id: categoryDoc._id, name: categoryDoc.name },
    quantity,
    rack,
    status,
    purchaseDate: new Date(purchaseDate)
  };

  return { success: true, newTool, error: null };
}

async function main() {
  const db = await connect(mongoUri, dbName);

  // ROUTES
  app.get('/test', (req, res) => {
    res.json({ message: "Hello world" });
  });

  app.get('/tools', async (req, res) => {
    const tools = await db.collection('tools').find().project({
      name: 1, category: 1, quantity: 1, rack: 1, status: 1, purchaseDate: 1
    }).toArray();
    res.json({ tools });
  });

  app.post('/tools', async (req, res) => {
    const status = await validateTool(db, req.body);
    if (!status.success) {
      return res.status(400).json({ error: status.error });
    }
    const result = await db.collection('tools').insertOne(status.newTool);
    res.status(201).json({ message: "Tool created", toolId: result.insertedId });
  });

  app.put('/tools/:id', async (req, res) => {
    const toolId = req.params.id;
    const status = await validateTool(db, req.body);
    if (status.success) {
      await db.collection('tools').updateOne(
        { _id: new ObjectId(toolId) },
        { $set: status.newTool }
      );
      res.json({ message: "Tool updated successfully" });
    } else {
      res.status(400).json({ error: status.error });
    }
  });

  app.delete('/tools/:id', async (req, res) => {
    try {
      const toolId = req.params.id;
      const result = await db.collection('tools').deleteOne({ _id: new ObjectId(toolId) });
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json({ message: "Deleted successfully" });
    } catch (e) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  });
}
main();

// START SERVER
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server has started on port ${PORT}`);
});