// src/middleware/adminAuth.js
const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');

async function adminAuthMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token de autenticação ausente.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Secret DIFERENTE do JWT_SECRET de paciente — um token de paciente
    // nunca pode ser usado pra acessar rota admin, mesmo que vazado.
    const payload = jwt.verify(token, process.env.JWT_ADMIN_SECRET);

    if (payload.role !== 'admin') {
      return res.status(403).json({ erro: 'Acesso não autorizado.' });
    }

    const { rows } = await query(
      'SELECT id, nome, email FROM admins WHERE id = $1 AND ativo = TRUE',
      [payload.id]
    );

    if (!rows.length) {
      return res.status(401).json({ erro: 'Sessão inválida ou conta desativada.' });
    }

    req.admin = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
    }
    return res.status(401).json({ erro: 'Token inválido.' });
  }
}

module.exports = adminAuthMiddleware;
