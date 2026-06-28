const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { query, withTransaction } = require('../db/pool');
const crypto = require('crypto');

// Helper: HMAC-SHA256 do CPF usando chave secreta do .env.
// Diferente de hash simples, isso impede ataques de rainbow table,
// já que sem a chave secreta não é possível pré-computar os hashes.
function cpfParaHash(cpf) {
  const limpo = cpf.replace(/\D/g, '');
  return crypto.createHmac('sha256', process.env.CPF_HMAC_SECRET).update(limpo).digest('hex');
}

const router = express.Router();

const BCRYPT_ROUNDS = 12;

// ============================================================
// POST /api/auth/cadastro
// ============================================================
router.post('/cadastro', async (req, res) => {
  const { nome, sobrenome, email, cpf, dataNasc, telefone, senha } = req.body;

  if (!nome || !sobrenome || !email || !cpf || !senha) {
    return res.status(400).json({ erro: 'Campos obrigatórios ausentes.' });
  }

  // Limite de tamanho — sem isso, nada impede o envio de strings
  // muito grandes (ex: vários MB) nesses campos antes de chegar ao banco.
  if (nome.length > 100 || sobrenome.length > 100 || email.length > 150) {
    return res.status(400).json({ erro: 'Um ou mais campos excedem o tamanho máximo permitido.' });
  }

  if (senha.length < 8) {
    return res.status(400).json({ erro: 'Senha deve ter no mínimo 8 caracteres.' });
  }

  // Bloqueia os casos mais triviais (mesmo caractere repetido,
  // sequência numérica simples, ou senhas extremamente comuns)
  // sem exigir regras complexas de composição — só evita o pior
  // caso. Comparação exata contra a lista, não por prefixo: uma
  // senha real como "Senha1234" não deve ser confundida com a
  // senha trivial "senha123" só porque compartilha letras iniciais.
  const senhaMinuscula = senha.toLowerCase();
  const senhasComuns = ['password', 'password123', 'senha123', '12345678', 'qwerty123', '11111111', '00000000'];
  const senhaTrivial =
    /^(.)\1*$/.test(senha) ||
    /^(?:0123456789|1234567890|123456789|12345678)$/.test(senha) ||
    senhasComuns.includes(senhaMinuscula);
  if (senhaTrivial) {
    return res.status(400).json({ erro: 'Essa senha é muito simples. Escolha uma senha mais segura.' });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ erro: 'E-mail inválido.' });
  }

  try {
    const { rows: existeEmail } = await query(
      'SELECT id FROM pacientes WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (existeEmail.length) {
      return res.status(409).json({ erro: 'E-mail já cadastrado.' });
    }

    const cpfHash = cpfParaHash(cpf);
    const { rows: existeCpf } = await query(
      'SELECT id FROM pacientes WHERE cpf_hash = $1',
      [cpfHash]
    );
    if (existeCpf.length) {
      return res.status(409).json({ erro: 'CPF já cadastrado.' });
    }

    const senhaHash = await bcrypt.hash(senha, BCRYPT_ROUNDS);

    // Telefone criptografado com pgcrypto (PGP symmetric), usando a chave do .env.
    // pgp_sym_encrypt retorna bytea — por isso a coluna telefone agora é BYTEA.
    const { rows } = await query(
      `INSERT INTO pacientes (nome, sobrenome, email, cpf_hash, data_nasc, telefone, senha_hash)
       VALUES ($1, $2, $3, $4, $5, pgp_sym_encrypt($6, $7), $8)
       RETURNING id, nome, email`,
      [
        nome.trim(),
        sobrenome.trim(),
        email.toLowerCase().trim(),
        cpfHash,
        dataNasc || null,
        telefone || '',
        process.env.TELEFONE_CRYPT_KEY,
        senhaHash,
      ]
    );

    const paciente = rows[0];

    await query(
      'INSERT INTO log_acesso (paciente_id, email, ip, evento) VALUES ($1, $2, $3, $4)',
      [paciente.id, paciente.email, req.ip, 'CADASTRO_OK']
    );

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
    // Violação de unicidade do banco (código 23505) — a última linha
    // de defesa contra condição de corrida: as checagens de SELECT
    // acima dão uma mensagem amigável no caso comum, mas duas
    // requisições quase simultâneas ainda poderiam passar por elas
    // antes de qualquer uma inserir. O índice único no banco garante
    // que isso nunca resulta em cadastro duplicado de fato — só
    // precisamos tratar o erro aqui para devolver uma mensagem clara
    // em vez de um 500 genérico.
    if (err.code === '23505') {
      const detalhe = err.constraint && err.constraint.includes('cpf')
        ? 'CPF já cadastrado.'
        : 'E-mail já cadastrado.';
      return res.status(409).json({ erro: detalhe });
    }
    console.error('[CADASTRO] Erro:', err.message);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
});

// ============================================================
// POST /api/auth/login  (sem alterações — login não toca telefone/CPF)
// ============================================================
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'E-mail e senha são obrigatórios.' });
  }

  try {
    const { rows } = await query(
      'SELECT id, nome, email, senha_hash, ativo FROM pacientes WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    const paciente = rows[0];
    const senhaCorreta = paciente
      ? await bcrypt.compare(senha, paciente.senha_hash)
      : false;

    if (!paciente || !senhaCorreta || !paciente.ativo) {
      await query(
        'INSERT INTO log_acesso (email, ip, evento, detalhes) VALUES ($1, $2, $3, $4)',
        [email, req.ip, 'LOGIN_FAIL', paciente ? 'senha_incorreta' : 'email_nao_encontrado']
      );
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
    }

    await query(
      'INSERT INTO log_acesso (paciente_id, email, ip, evento) VALUES ($1, $2, $3, $4)',
      [paciente.id, paciente.email, req.ip, 'LOGIN_OK']
    );

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
