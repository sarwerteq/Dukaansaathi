const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "insecure_dev_secret_change_me";

function signToken(user) {
  return jwt.sign(
    { id: user.id, shopId: user.shop_id, name: user.name, role: user.role },
    SECRET,
    { expiresIn: "30d" }
  );
}

// Every protected route uses req.user.shopId to scope its SQL queries.
// This is what keeps one shop's data invisible to another shop.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = req.cookies?.ds_token || bearer;

  if (!token) {
    return res.status(401).json({ error: "Not logged in. Please log in." });
  }
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

module.exports = { signToken, requireAuth, SECRET };
