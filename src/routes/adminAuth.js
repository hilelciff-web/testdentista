// src/routes/adminAuth.js
const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { query } = require('../db/pool');

const router = express.Router();

// ============================================================
// POST /api/admin/login
// ============================================================
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'E-mail e senha são obrigatórios.' });
  }

  try {
    const { rows } = await query(
      'SELECT id, nome, email, senha_hash, ativo FROM admins WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    const admin = rows[0];
    // Mesma lógica do login de paciente: roda o compare mesmo se não achar,
    // pra não dar timing attack revelando se o e-mail existe ou não.
    const senhaCorreta = admin
      ? await bcrypt.compare(senha, admin.senha_hash)
      : await bcrypt.compare(senha, '$2b$12$invalidoinvalidoinvalidoinvalidoinvalido');

    if (!admin || !senhaCorreta || !admin.ativo) {
      await query(
        'INSERT INTO log_acesso_admin (email, ip, evento, detalhes) VALUES ($1, $2, $3, $4)',
        [email, req.ip, 'LOGIN_FAIL', admin ? 'senha_incorreta' : 'email_nao_encontrado']
      );
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
    }

    await query(
      'INSERT INTO log_acesso_admin (admin_id, email, ip, evento) VALUES ($1, $2, $3, $4)',
      [admin.id, admin.email, req.ip, 'LOGIN_OK']
    );

    // Token separado do token de paciente — marcado com role: 'admin'
    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: 'admin' },
      process.env.JWT_ADMIN_SECRET,
      { expiresIn: '4h' } // sessão de admin mais curta que a de paciente
    );

    res.json({
      token,
      admin: { id: admin.id, nome: admin.nome, email: admin.email },
    });

  } catch (err) {
    console.error('[ADMIN LOGIN] Erro:', err.message);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
});

module.exports = router;
