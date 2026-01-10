// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { connect } = require('./db'); // must export connect(uri, dbName)
const { ObjectId } = require('mongodb');
const { generateSearchParams, generateTool } = require('./gemini'); // your gemini helper
const { verifyToken } = require('./middleware'); // must export verifyToken(req,res,next)

const app = express();

// Tolerate clients that accidentally send Content-Type with no body for GET/DELETE
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'DELETE') && req.headers['content-type']) {
    delete req.headers['content-type'];
  }
  next();
});

app.use(cors());
app.use(express.json());

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'tools_inventory';

// Helper: generate JWT
function generateAccessToken(userId, email) {
  return jwt.sign(
    { user_id: userId, email },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// Validation helper for tools (expects tags to be array of tag names)
async function validateTool(db, request) {
  const { name, category, quantity, rack, status, purchaseDate, tags } = request;

  if (!name || !category || !quantity || !rack || !status || !purchaseDate || !tags) {
    return { success: false, error: 'Missing fields' };
  }

  const categoryDoc = await db.collection('categories').findOne({ name: category });
  if (!categoryDoc) return { success: false, error: 'Invalid category' };

  // Expect tags to be array of names; find matching tag docs
  const tagDocs = await db.collection('tags').find({ name: { $in: tags } }).toArray();
  if (tagDocs.length !== tags.length) return { success: false, error: 'One or more tags is invalid' };

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
  console.log('Connected DB name:', db.databaseName);

  // Basic test route
  app.get('/test', (req, res) => res.json({ message: 'Hello world' }));

  // AUTH: register
  app.post('/users', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

      const existingUser = await db.collection('users').findOne({ email });
      if (existingUser) return res.status(400).json({ error: 'User already exists' });

      const passwordHash = await bcrypt.hash(password, 12);
      const result = await db.collection('users').insertOne({ email, password: passwordHash });

      res.status(201).json({ message: 'User registered successfully', userId: result.insertedId });
    } catch (error) {
      console.error('POST /users error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // AUTH: login
  app.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = await db.collection('users').findOne({ email });
      if (!user) return res.status(401).json({ error: 'Invalid login' });

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) return res.status(401).json({ error: 'Invalid login' });

      const accessToken = generateAccessToken(user._id, user.email);
      res.json({ accessToken });
    } catch (error) {
      console.error('POST /login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // GET tools (public)
  app.get('/tools', async (req, res) => {
    try {
      const { name, category, rack, status, tags } = req.query;
      const criteria = {};

      if (name) criteria['name'] = { $regex: name, $options: 'i' };
      if (category) criteria['category'] = { $in: category.split(',').map(s => s.trim()) };
      if (rack) criteria['rack'] = { $in: rack.split(',').map(s => s.trim()) };
      if (status) criteria['status'] = { $in: status.split(',').map(s => s.trim()) };

      if (tags) {
        const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
        if (tagList.length) {
          const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regexList = tagList.map(t => new RegExp('^\\s*' + escape(t) + '\\s*$', 'i'));
          criteria['$or'] = [
            { tags: { $in: regexList } },        // tags as strings
            { 'tags.name': { $in: regexList } } // tags as objects
          ];
        }
      }

      const tools = await db.collection('tools').find(criteria).project({
        name: 1, category: 1, quantity: 1, rack: 1, status: 1, purchaseDate: 1, tags: 1
      }).toArray();

      res.json({ tools });
    } catch (error) {
      console.error('GET /tools error:', error);
      res.status(500).json({ error: 'Failed to fetch tools' });
    }
  });

  // POST new tool (protected)
  app.post('/tools', verifyToken, async (req, res) => {
    try {
      const status = await validateTool(db, req.body);
      if (!status.success) return res.status(400).json({ error: status.error });

      const result = await db.collection('tools').insertOne(status.newTool);
      res.status(201).json({ message: 'Tool created', toolId: result.insertedId });
    } catch (error) {
      console.error('POST /tools error:', error);
      res.status(500).json({ error: 'Failed to create tool' });
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
        res.json({ message: 'Tool updated successfully' });
      } else {
        res.status(400).json({ error: status.error });
      }
    } catch (error) {
      console.error('PUT /tools/:id error:', error);
      res.status(500).json({ error: 'Failed to update tool' });
    }
  });

  // DELETE tool (protected)
  app.delete('/tools/:id', verifyToken, async (req, res) => {
    try {
      const toolId = req.params.id;
      const result = await db.collection('tools').deleteOne({ _id: new ObjectId(toolId) });
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ message: 'Deleted successfully' });
    } catch (error) {
      console.error('DELETE /tools/:id error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // AI GET tools - uses gemini.generateSearchParams
  app.get('/ai/tools', async (req, res) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({ error: 'AI service not configured' });
      }

      const query = req.query.q || '';
      // gather available lists for the AI prompt
      const allCategories = await db.collection('categories').distinct('name');
      const allRacks = await db.collection('tools').distinct('rack');
      const allStatuses = await db.collection('tools').distinct('status');

      // call the gemini helper
      const searchParams = await generateSearchParams(query, allCategories, allRacks, allStatuses);
      console.log('AI searchParams:', searchParams);

      const criteria = {};

      // 1) If AI returned explicit toolNames -> strict match
      if (Array.isArray(searchParams.toolNames) && searchParams.toolNames.length) {
        const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        criteria.name = { $in: searchParams.toolNames.map(t => new RegExp('^\\s*' + escape(t) + '\\s*$', 'i')) };
      } else if (searchParams.requestedParameters && searchParams.requestedParameters.length) {
        // 2) If user asked for parameters but no toolNames, try best single match by keyword
        const knownTools = await db.collection('tools').distinct('name');
        const qLower = query.toLowerCase();
        const matched = knownTools.find(t => qLower.includes(t.toLowerCase()));
        if (matched) {
          const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          criteria.name = { $regex: '^\\s*' + escape(matched) + '\\s*$', $options: 'i' };
        } else {
          // no confident match -> return empty result with message
          return res.json({
            tools: [],
            message: 'Request could not be fulfilled'
          });
        }
      } else {
        // 3) broad intent -> use categories/racks/statuses
        if (searchParams.categories && searchParams.categories.length) criteria.category = { $in: searchParams.categories };
        if (searchParams.racks && searchParams.racks.length) criteria.rack = { $in: searchParams.racks };
        if (searchParams.statuses && searchParams.statuses.length) criteria.status = { $in: searchParams.statuses };
      }

      // Build projection if requestedParameters present (map common params to fields)
      const projection = {};
      if (searchParams.requestedParameters && searchParams.requestedParameters.length) {
        // always include name
        projection.name = 1;
        searchParams.requestedParameters.forEach(p => {
          const param = p.toLowerCase();
          if (param === 'model') projection.model = 1;
          else if (param === 'brand') projection.brand = 1;
          else if (param === 'specifications' || param === 'weight' || param === 'batterycapacity' || param === 'voltage') {
            projection.specifications = 1;
          } else {
            // default: include specifications so unknown params can be inspected
            projection.specifications = 1;
          }
        });
      }

      const tools = await db.collection('tools').find(criteria).project(Object.keys(projection).length ? projection : {}).toArray();

      // If no match in DB, return empty array with message as requested
      if (!tools || tools.length === 0) {
        return res.json({
          tools: [],
          message: 'Request could not be fulfilled'
        });
      }

      // Success
      res.json({ tools });
    } catch (error) {
      console.error('GET /ai/tools error:', error);
      res.status(500).json({ error: 'AI search failed' });
    }
  });

  // AI POST tool (protected) - parse text into tool object using gemini.generateTool
  app.post('/ai/tools', verifyToken, async (req, res) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({ error: 'AI service not configured' });
      }

      const toolText = req.body.toolText;
      const allCategories = await db.collection('categories').distinct('name');
      const allStatuses = await db.collection('tools').distinct('status');

      const newTool = await generateTool(toolText, allCategories, allStatuses);

      const categoryDoc = await db.collection('categories').findOne({ name: newTool.category });
      if (!categoryDoc) return res.status(404).json({ error: "AI used a category that doesn't exist" });

      newTool.category = categoryDoc;
      const tagDocs = await db.collection('tags').find({ name: { $in: newTool.tags || [] } }).toArray();
      newTool.tags = tagDocs;

      const result = await db.collection('tools').insertOne(newTool);
      res.json({ toolId: result.insertedId });
    } catch (error) {
      console.error('POST /ai/tools error:', error);
      res.status(500).json({ error: 'AI tool creation failed' });
    }
  });

  // Protected test route
  app.get('/protected', verifyToken, (req, res) => {
    res.json({ message: 'This is a protected route', tokenData: req.tokenData });
  });
}

// Start server after main() completes
main()
  .then(() => {
    app.listen(process.env.PORT || 4000, () => {
      console.log('Server has started');
      console.log('JWT_SECRET loaded:', !!process.env.JWT_SECRET);
    });
  })
  .catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });