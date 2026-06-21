const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');

// Verifica token JWT em rotas protegidas
async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token de autenticação ausente.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Confirma que o paciente ainda existe e está ativo
    const { rows } = await query(
      'SELECT id, nome, email FROM pacientes WHERE id = $1 AND ativo = TRUE',
      [payload.id]
    );

    if (!rows.length) {
      return res.status(401).json({ erro: 'Sessão inválida ou conta desativada.' });
    }

    req.paciente = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
    }
    return res.status(401).json({ erro: 'Token inválido.' });
  }
}

module.exports = authMiddleware;
