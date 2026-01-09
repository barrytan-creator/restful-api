// middleware.js
const jwt = require('jsonwebtoken');

// Middleware to verify JWT
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    return res.sendStatus(401);
  }

  jwt.verify(token, process.env.JWT_SECRET, function (err, tokenData) {
    if (err) {
      return res.sendStatus(401);
    } else {
      req.tokenData = tokenData;
      next();
    }
  });
}


module.exports = { verifyToken };