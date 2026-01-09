// index.js
const express = require('express');
require('dotenv').config();
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { connect } = require("./db");
const { ObjectId } = require('mongodb');
const { generateSearchParams, generateTool } = require('./gemini');
const { verifyToken } = require("./middleware");

const app = express();
app.use(cors());
app.use(express.json());

const mongoUri = process.env.MONGO_URI;
const dbName = "tools_inventory";

// Helper: generate JWT
function generateAccessToken(userId, email) {
  return jwt.sign(
    { user_id: userId, email },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

// Validation helper for tools
async function validateTool(db, request) {
  const { name, category, quantity, rack, status, purchaseDate, tags } = request;

  if (!name || !category || !quantity || !rack || !status || !purchaseDate || !tags) {
    return { success: false, error: "Missing fields" };
  }

  const categoryDoc = await db.collection('categories').findOne({ name: category });
  if (!categoryDoc) {
    return { success: false, error: "Invalid category" };
  }

  const tagDocs = await db.collection('tags').find({ name: { $in: tags } }).toArray();
  if (tagDocs.length !== tags.length) {
    return { success: false, error: "One or more tags is invalid" };
  }

  const newTool = {
    name,
    category: { _id: categoryDoc._id, name: categoryDoc.name },
    quantity,
    rack,
    status,
    purchaseDate: new Date(purchaseDate),
    tags: tagDocs
  };

  return { success: true, newTool, error: null };
}

async function main() {
  const db = await connect(mongoUri, dbName);

  // ROUTES
  app.get('/test', (req, res) => res.json({ message: "Hello world" }));

  // 🔐 AUTH ROUTES
  app.post('/users', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: "Email and password required" });

      const existingUser = await db.collection('users').findOne({ email });
      if (existingUser) return res.status(400).json({ error: "User already exists" });

      const passwordHash = await bcrypt.hash(password, 12);
      const result = await db.collection('users').insertOne({ email, password: passwordHash });

      res.status(201).json({ message: "User registered successfully", userId: result.insertedId });
    } catch (error) {
      res.status(500).json({ error: "Registration failed" });
    }
  });

  app.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = await db.collection("users").findOne({ email });
      if (!user) return res.status(401).json({ error: "Invalid login" });

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) return res.status(401).json({ error: "Invalid login" });

      const accessToken = generateAccessToken(user._id, user.email);
      res.json({ accessToken });
    } catch (error) {
      res.status(500).json({ error: "Login failed" });
    }
  });

  // GET tools (public)
  app.get('/tools', async (req, res) => {
    try {
      const { name, category, rack, status, tags } = req.query;
      const criteria = {};

      if (name) criteria["name"] = { $regex: name, $options: "i" };
      if (category) criteria["category.name"] = { $in: category.split(",") };
      if (rack) criteria["rack"] = { $in: rack.split(",") };
      if (status) criteria["status"] = { $in: status.split(",") };
      if (tags) criteria["tags.name"] = { $in: tags.split(",") };

      const tools = await db.collection('tools').find(criteria).project({
        name: 1, category: 1, quantity: 1, rack: 1, status: 1, purchaseDate: 1, tags: 1
      }).toArray();

      res.json({ tools });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tools" });
    }
  });

  // POST new tool (protected)
  app.post('/tools', verifyToken, async (req, res) => {
    try {
      const status = await validateTool(db, req.body);
      if (!status.success) return res.status(400).json({ error: status.error });

      const result = await db.collection('tools').insertOne(status.newTool);
      res.status(201).json({ message: "Tool created", toolId: result.insertedId });
    } catch (error) {
      res.status(500).json({ error: "Failed to create tool" });
    }
  });

  // PUT update tool (protected)
  app.put('/tools/:id', verifyToken, async (req, res) => {
    try {
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
    } catch (error) {
      res.status(500).json({ error: "Failed to update tool" });
    }
  });

  // DELETE tool (protected)
  app.delete('/tools/:id', verifyToken, async (req, res) => {
    try {
      const toolId = req.params.id;
      const result = await db.collection('tools').deleteOne({ _id: new ObjectId(toolId) });
      if (result.deletedCount === 0) return res.status(404).json({ error: "Not found" });
      res.json({ message: "Deleted successfully" });
    } catch (error) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // AI GET tools
  app.get('/ai/tools', async (req, res) => {
    try {
      const query = req.query.q;
      const allCategories = await db.collection('categories').distinct('name');
      const allRacks = await db.collection('tools').distinct('rack');
      const allStatuses = await db.collection('tools').distinct('status');
      const allTags = await db.collection('tags').distinct('name');

      const searchParams = await generateSearchParams(query, allCategories, allRacks, allStatuses, allTags);
      const criteria = {};

      if (searchParams.categories?.length) criteria["category.name"] = { $in: searchParams.categories };
      if (searchParams.racks?.length) criteria["rack"] = { $in: searchParams.racks };
      if (searchParams.statuses?.length) criteria["status"] = { $in: searchParams.statuses };
      if (searchParams.tags?.length) criteria["tags.name"] = { $in: searchParams.tags };

      const tools = await db.collection('tools').find(criteria).toArray();
      res.json({ tools });
    } catch (error) {
      res.status(500).json({ error: "AI search failed" });
    }
  });

  // AI POST tool (protected)
  app.post('/ai/tools', verifyToken, async (req, res) => {
    try {
      const toolText = req.body.toolText;
      const allCategories = await db.collection('categories').distinct('name');
      const allStatuses = await db.collection('tools').distinct('status');
      const allTags = await db.collection('tags').distinct('name');

      const newTool = await generateTool(toolText, allCategories, allStatuses, allTags);

      const categoryDoc = await db.collection('categories').findOne({ name: newTool.category });
      if (!categoryDoc) {
        return res.status(404).json({ error: "AI used a category that doesn't exist" });
      }

      newTool.category = categoryDoc;

      const tagDocs = await db.collection('tags').find({ name: { $in: newTool.tags } }).toArray();
      newTool.tags = tagDocs;

      const result = await db.collection('tools').insertOne(newTool);
      res.json({ toolId: result.insertedId });
    } catch (error) {
      res.status(500).json({ error: "AI tool creation failed" });
    }
  });

  // Protected test route (optional)
  app.get('/protected', verifyToken, (req, res) => {
    res.json({
      message: "This is a protected route",
      tokenData: req.tokenData
    });
  });
}

main();

app.listen(process.env.PORT || 3000, () => {
  console.log("Server has started");
});

