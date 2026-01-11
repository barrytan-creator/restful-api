require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { connect } = require('./db'); // must export connect(uri, dbName)
const { ObjectId } = require('mongodb');
const { generateSearchParams, generateTool } = require('./gemini'); // your gemini helper

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

// Helper: generate JWT (ensure user id is string)
function generateAccessToken(userId, email) {
  return jwt.sign(
    { user_id: String(userId), email },
    process.env.JWT_SECRET,
    { expiresIn: '3d' }
  );
}

/**
 * validateTool - Validates and normalizes tool data to match DB structure
 * - Accepts aliases: specs/specification -> specifications
 * - Auto-creates missing categories and tags
 * - Returns { success: false, error, ... } or { success: true, newTool, error: null }
 */
async function validateTool(db, request) {
  const {
    name,
    category,
    brand,
    model,
    purchaseDate,
    quantity,
    location,
    specifications,
    specs,
    specification,
    maintenance,
    tags,
    description,
    status
  } = request || {};

  // Handle field aliases: specifications is the canonical field
  const effectiveSpecs = specifications || specs || specification;

  // Collect missing fields
  const missing = [];
  if (!name) missing.push('name');
  if (!category) missing.push('category');
  if (!brand) missing.push('brand');
  if (!model) missing.push('model');
  if (purchaseDate === undefined || purchaseDate === null || purchaseDate === '') missing.push('purchaseDate');
  if (quantity === undefined || quantity === null) missing.push('quantity');
  if (!location) missing.push('location');
  if (!effectiveSpecs) missing.push('specifications');
  if (!Array.isArray(tags) || tags.length === 0) missing.push('tags');

  if (missing.length) {
    return { success: false, error: 'Missing fields', missing };
  }

  // Validate category (stored as string)
  const categoryName = (category || '').toString().trim();
  if (!categoryName) return { success: false, error: 'Invalid category' };

  // Auto-create category if it doesn't exist
  const categoryExists = await db.collection('categories').findOne({ name: categoryName });
  if (!categoryExists) {
    await db.collection('categories').insertOne({ name: categoryName, createdAt: new Date() });
  }

  // Validate tags (stored as string array)
  const tagNames = tags.map(t => (t || '').toString().trim()).filter(Boolean);
  const existingTags = await db.collection('tags').find({ name: { $in: tagNames } }).toArray();
  const existingNames = existingTags.map(t => t.name);
  const toCreate = tagNames.filter(n => !existingNames.includes(n));

  if (toCreate.length) {
    const inserts = toCreate.map(n => ({ name: n, createdAt: new Date() }));
    try {
      await db.collection('tags').insertMany(inserts, { ordered: false });
    } catch (err) {
      if (!err.code || err.code !== 11000) {
        console.error('insertMany tags error:', err);
        return { success: false, error: 'Failed to create tags' };
      }
    }
  }

  // Build normalized tool object matching actual DB structure
  const newTool = {
    name,
    category: categoryName,  // String, not object
    brand,
    model,
    purchaseDate,  // Keep as string (DB stores as string)
    quantity,
    location,
    specifications: effectiveSpecs,  // Array of {name, value, unit} objects
    maintenance: maintenance || [],
    tags: tagNames,  // String array
    status: status || 'available'
  };

  if (description) newTool.description = description;

  return { success: true, newTool, error: null };
}

async function main() {
  const db = await connect(mongoUri, dbName);
  console.log('Connected DB name:', db.databaseName);

  // require middleware here to avoid circular dependency problems
  const { verifyToken } = require('./middleware');
  console.log('verifyToken type:', typeof verifyToken); // should print 'function'

  // Basic test route
  app.get('/test', (req, res) => res.json({ message: 'Hello world' }));

  // Helper endpoints for clients to fetch allowed values
  app.get('/categories', async (req, res) => {
    try {
      const categories = await db.collection('categories').distinct('name');
      res.json({ categories });
    } catch (err) {
      console.error('GET /categories error:', err);
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  });

  app.get('/tags', async (req, res) => {
    try {
      const tags = await db.collection('tags').distinct('name');
      res.json({ tags });
    } catch (err) {
      console.error('GET /tags error:', err);
      res.status(500).json({ error: 'Failed to fetch tags' });
    }
  });

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
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

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
      const { name, category, brand, model, location, status, tags } = req.query;
      const criteria = {};

      if (name) criteria['name'] = { $regex: name, $options: 'i' };

      // category stored as string
      if (category) {
        const list = category.split(',').map(s => s.trim()).filter(Boolean);
        if (list.length) criteria['category'] = { $in: list };
      }

      if (brand) criteria['brand'] = { $in: brand.split(',').map(s => s.trim()) };
      if (model) criteria['model'] = { $in: model.split(',').map(s => s.trim()) };
      if (location) criteria['location'] = { $in: location.split(',').map(s => s.trim()) };
      if (status) criteria['status'] = { $in: status.split(',').map(s => s.trim()) };

      // tags stored as string array
      if (tags) {
        const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
        if (tagList.length) {
          const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regexList = tagList.map(t => new RegExp('^\\s*' + escape(t) + '\\s*$', 'i'));
          criteria['tags'] = { $in: regexList };
        }
      }

      const tools = await db.collection('tools').find(criteria).toArray();
      res.json({ tools });
    } catch (error) {
      console.error('GET /tools error:', error);
      res.status(500).json({ error: 'Failed to fetch tools' });
    }
  });

  // POST new tool (protected)
  app.post('/tools', verifyToken, async (req, res) => {
    try {
      console.log('Create tool body:', JSON.stringify(req.body, null, 2));
      const status = await validateTool(db, req.body);
      if (!status.success) {
        return res.status(400).json(status);
      }

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
      console.log('Update tool body:', JSON.stringify(req.body, null, 2));
      const status = await validateTool(db, req.body);
      if (!status.success) {
        return res.status(400).json(status);
      }

      await db.collection('tools').updateOne(
        { _id: new ObjectId(toolId) },
        { $set: status.newTool }
      );
      res.json({ message: 'Tool updated successfully' });
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
      
      // Gather available lists
      const allCategories = await db.collection('categories').distinct('name');
      const allLocations = await db.collection('tools').distinct('location');
      const allStatuses = await db.collection('tools').distinct('status');

      // Call gemini helper
      const searchParams = await generateSearchParams(query, allCategories, allLocations, allStatuses);
      console.log('AI searchParams:', searchParams);

      const criteria = {};

      // If AI returned explicit toolNames -> strict match
      if (Array.isArray(searchParams.toolNames) && searchParams.toolNames.length) {
        const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        criteria.name = { $in: searchParams.toolNames.map(t => new RegExp('^\\s*' + escape(t) + '\\s*$', 'i')) };
      } else if (searchParams.requestedParameters && searchParams.requestedParameters.length) {
        // If user asked for parameters but no toolNames, try best single match by keyword
        const knownTools = await db.collection('tools').distinct('name');
        const qLower = query.toLowerCase();
        const matched = knownTools.find(t => qLower.includes(t.toLowerCase()));
        if (matched) {
          const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          criteria.name = { $regex: '^\\s*' + escape(matched) + '\\s*$', $options: 'i' };
        } else {
          return res.json({
            tools: [],
            message: 'Request could not be fulfilled'
          });
        }
      } else {
        // Broad intent -> use categories/locations/statuses
        if (searchParams.categories && searchParams.categories.length) {
          criteria['category'] = { $in: searchParams.categories };
        }

        if (searchParams.locations && searchParams.locations.length) {
          criteria['location'] = { $in: searchParams.locations };
        }

        if (searchParams.statuses && searchParams.statuses.length) {
          criteria['status'] = { $in: searchParams.statuses };
        }
      }

      // Build projection if requestedParameters present
      const projection = {};
      if (searchParams.requestedParameters && searchParams.requestedParameters.length) {
        projection.name = 1;
        projection.specifications = 1;  // Always include specifications for parameter queries
        searchParams.requestedParameters.forEach(p => {
          if (p === 'model') projection.model = 1;
          else if (p === 'brand') projection.brand = 1;
        });
      }

      const tools = await db.collection('tools').find(criteria).project(Object.keys(projection).length ? projection : {}).toArray();

      if (!tools || tools.length === 0) {
        return res.json({
          tools: [],
          message: 'Request could not be fulfilled'
        });
      }

      // If specific parameters requested, filter specifications array
      if (searchParams.requestedParameters && searchParams.requestedParameters.length) {
        tools.forEach(tool => {
          if (tool.specifications && Array.isArray(tool.specifications)) {
            tool.specifications = tool.specifications.filter(spec => 
              searchParams.requestedParameters.includes(spec.name)
            );
          }
        });
      }

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

      if (!req.body || !req.body.toolText) {
        return res.status(400).json({ error: 'toolText is required' });
      }

      const toolText = req.body.toolText;
      const allCategories = await db.collection('categories').distinct('name');
      const allStatuses = await db.collection('tools').distinct('status');

      let newTool = await generateTool(toolText, allCategories, allStatuses);

      if (!newTool || !newTool.name) {
        return res.status(400).json({ error: 'AI did not produce a valid tool' });
      }

      // Validate category exists (stored as string)
      const categoryExists = await db.collection('categories').findOne({ name: newTool.category });
      if (!categoryExists) {
        // Auto-create category
        await db.collection('categories').insertOne({ name: newTool.category, createdAt: new Date() });
      }

      // Validate and auto-create tags (stored as string array)
      if (newTool.tags && newTool.tags.length) {
        const existingTags = await db.collection('tags').find({ name: { $in: newTool.tags } }).toArray();
        const existingNames = existingTags.map(t => t.name);
        const toCreate = newTool.tags.filter(n => !existingNames.includes(n));
        
        if (toCreate.length) {
          const inserts = toCreate.map(n => ({ name: n, createdAt: new Date() }));
          await db.collection('tags').insertMany(inserts, { ordered: false }).catch(err => {
            if (err.code !== 11000) throw err;
          });
        }
      }

      // Handle field aliases - normalize to 'specifications'
      if (newTool.specs && !newTool.specifications) {
        newTool.specifications = newTool.specs;
        delete newTool.specs;
      }
      if (newTool.specification && !newTool.specifications) {
        newTool.specifications = newTool.specification;
        delete newTool.specification;
      }

      // Keep purchaseDate as string (DB stores as string, not Date object)
      // No conversion needed

      console.log('AI newTool normalized:', JSON.stringify(newTool, null, 2));

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