// middleware.js
const jwt = require('jsonwebtoken');

// Middleware to verify JWT
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  console.log("Auth header:", authHeader); // debug: shows what client sent

  const token = authHeader && authHeader.split(" ")[1];
  console.log("Token extracted:", token); // debug: shows extracted token or undefined

  if (!token) {
    return res.sendStatus(401);
  }

  jwt.verify(token, process.env.JWT_SECRET, function (err, tokenData) {
    if (err) {
      console.log("JWT verify error:", err && err.message);
      return res.sendStatus(401);
    } else {
      req.tokenData = tokenData;
      next();
    }
  });
}

module.exports = { verifyToken };