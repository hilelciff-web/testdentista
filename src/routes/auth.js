const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { query, withTransaction } = require('../db/pool');

const router = express.Router();

// Número de rounds do bcrypt (12 = seguro e razoavelmente rápido)
const BCRYPT_ROUNDS = 12;

// ============================================================
// POST /api/auth/cadastro
// ============================================================
router.post('/cadastro', async (req, res) => {
  const { nome, sobrenome, email, cpf, dataNasc, telefone, senha } = req.body;

  // Validações básicas (use também validação no frontend)
  if (!nome || !sobrenome || !email || !cpf || !senha) {
    return res.status(400).json({ erro: 'Campos obrigatórios ausentes.' });
  }

  if (senha.length < 8) {
    return res.status(400).json({ erro: 'Senha deve ter no mínimo 8 caracteres.' });
  }

  // Valida formato de e-mail simples
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ erro: 'E-mail inválido.' });
  }

  try {
    // Verifica duplicidade ANTES de criar o hash (economiza CPU)
    // Prepared statement: $1 é o parâmetro — nunca concatenado
    const { rows: existe } = await query(
      'SELECT id FROM pacientes WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (existe.length) {
      return res.status(409).json({ erro: 'E-mail já cadastrado.' });
    }

    // Hash da senha com bcrypt (salt gerado automaticamente)
    const senhaHash = await bcrypt.hash(senha, BCRYPT_ROUNDS);

    // CPF: hash para verificação futura (não armazenamos em texto plano)
    // Em produção, use criptografia reversível (pgcrypto) para consulta por CPF
    const cpfLimpo = cpf.replace(/\D/g, '');
    const cpfHash  = await bcrypt.hash(cpfLimpo, BCRYPT_ROUNDS);

    // Inserção segura com todos os valores parametrizados
    const { rows } = await query(
      `INSERT INTO pacientes (nome, sobrenome, email, cpf_hash, data_nasc, telefone, senha_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, nome, email`,
      [
        nome.trim(),
        sobrenome.trim(),
        email.toLowerCase().trim(),
        cpfHash,
        dataNasc || null,
        telefone || null,
        senhaHash,
      ]
    );

    const paciente = rows[0];

    // Log de auditoria
    await query(
      'INSERT INTO log_acesso (paciente_id, email, ip, evento) VALUES ($1, $2, $3, $4)',
      [paciente.id, paciente.email, req.ip, 'CADASTRO_OK']
    );

    // Gera JWT
    const token = jwt.sign(
      { id: paciente.id, email: paciente.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.status(201).json({
      mensagem: 'Conta criada com sucesso!',
      token,
      paciente: { id: paciente.id, nome: paciente.nome, email: paciente.email },
    });

  } catch (err) {
    console.error('[CADASTRO] Erro:', err.message);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
});

// ============================================================
// POST /api/auth/login
// ============================================================
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'E-mail e senha são obrigatórios.' });
  }

  try {
    // Busca o paciente pelo e-mail (prepared statement)
    const { rows } = await query(
      'SELECT id, nome, email, senha_hash, ativo FROM pacientes WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    // Segurança: mesma mensagem de erro para usuário inexistente ou senha errada
    // Isso evita que o atacante descubra quais e-mails estão cadastrados
    const paciente = rows[0];
    const senhaCorreta = paciente
      ? await bcrypt.compare(senha, paciente.senha_hash)
      : false;

    if (!paciente || !senhaCorreta || !paciente.ativo) {
      // Log da tentativa falha
      await query(
        'INSERT INTO log_acesso (email, ip, evento, detalhes) VALUES ($1, $2, $3, $4)',
        [email, req.ip, 'LOGIN_FAIL', paciente ? 'senha_incorreta' : 'email_nao_encontrado']
      );
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
    }

    // Log de sucesso
    await query(
      'INSERT INTO log_acesso (paciente_id, email, ip, evento) VALUES ($1, $2, $3, $4)',
      [paciente.id, paciente.email, req.ip, 'LOGIN_OK']
    );

    // Gera JWT com expiração
    const token = jwt.sign(
      { id: paciente.id, email: paciente.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.json({
      token,
      paciente: { id: paciente.id, nome: paciente.nome, email: paciente.email },
    });

  } catch (err) {
    console.error('[LOGIN] Erro:', err.message);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
});

module.exports = router;
