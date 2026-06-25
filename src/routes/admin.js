const express = require('express');
const { query } = require('../db/pool');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// ============================================================
// GET /api/admin/agendamentos — todos os agendamentos
// ============================================================
router.get('/agendamentos', adminAuth, async (req, res) => {
  const { data, status } = req.query;
  try {
    let sql = `
      SELECT a.id, a.servico, a.data_hora, a.status, a.observacoes,
             a.valor, a.forma_pagamento, a.pago, a.pago_em,
             p.nome AS paciente_nome, p.email AS paciente_email,
             pgp_sym_decrypt(p.telefone, $1) AS telefone,
             d.nome AS dentista_nome
      FROM agendamentos a
      JOIN pacientes p ON p.id = a.paciente_id
      LEFT JOIN dentistas d ON d.id = a.dentista_id
      WHERE 1=1`;
    const params = [process.env.TELEFONE_CRYPT_KEY];

    if (data) {
      params.push(data);
      sql += ` AND DATE(a.data_hora) = $${params.length}::date`;
    }
    if (status) {
      params.push(status);
      sql += ` AND a.status = $${params.length}`;
    }

    sql += ' ORDER BY a.data_hora ASC';

    const { rows } = await query(sql, params);
    res.json({ agendamentos: rows });
  } catch (err) {
    console.error('[ADMIN AGENDAMENTOS]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar agendamentos.' });
  }
});

// ============================================================
// PATCH /api/admin/agendamentos/:id — atualiza status
// ============================================================
router.patch('/agendamentos/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const statusValidos = ['pendente', 'confirmado', 'cancelado', 'realizado'];

  if (!statusValidos.includes(status)) {
    return res.status(400).json({ erro: 'Status inválido.' });
  }

  try {
    const { rows } = await query(
      `UPDATE agendamentos SET status = $1, atualizado_em = NOW()
       WHERE id = $2 RETURNING id, status`,
      [status, id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Agendamento não encontrado.' });

    console.log(`[ADMIN] ${req.admin.email} alterou agendamento ${id} para ${status}`);

    res.json({ mensagem: 'Status atualizado.', agendamento: rows[0] });
  } catch (err) {
    console.error('[ADMIN PATCH]', err.message);
    res.status(500).json({ erro: 'Erro ao atualizar.' });
  }
});

// ============================================================
// GET /api/admin/pacientes — todos os pacientes
// ============================================================
router.get('/pacientes', adminAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, nome, sobrenome, email,
              pgp_sym_decrypt(telefone, $1) AS telefone,
              data_nasc, ativo, criado_em
       FROM pacientes ORDER BY criado_em DESC`,
      [process.env.TELEFONE_CRYPT_KEY]
    );
    res.json({ pacientes: rows });
  } catch (err) {
    console.error('[ADMIN PACIENTES]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar pacientes.' });
  }
});

// ============================================================
// GET /api/admin/dentistas — todos os dentistas
// ============================================================
router.get('/dentistas', adminAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, nome, sobrenome, cro, especialidade, ativo FROM dentistas ORDER BY nome`
    );
    res.json({ dentistas: rows });
  } catch (err) {
    console.error('[ADMIN DENTISTAS]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar dentistas.' });
  }
});

// ============================================================
// POST /api/admin/dentistas — adiciona dentista
// ============================================================
router.post('/dentistas', adminAuth, async (req, res) => {
  const { nome, sobrenome, cro, especialidade, email } = req.body;
  if (!nome || !cro) return res.status(400).json({ erro: 'Nome e CRO obrigatórios.' });
  try {
    const { rows } = await query(
      `INSERT INTO dentistas (nome, sobrenome, cro, especialidade, email, senha_hash)
       VALUES ($1, $2, $3, $4, $5, 'placeholder') RETURNING id, nome, cro`,
      [nome, sobrenome || '', cro, especialidade || '', email || '']
    );

    console.log(`[ADMIN] ${req.admin.email} adicionou dentista ${rows[0].nome}`);

    res.status(201).json({ mensagem: 'Dentista adicionado.', dentista: rows[0] });
  } catch (err) {
    console.error('[ADMIN DENTISTA POST]', err.message);
    res.status(500).json({ erro: 'Erro ao adicionar dentista.' });
  }
});

// ============================================================
// GET /api/admin/pacientes/buscar?q=... — busca paciente por
// nome ou email, para o autocomplete da tela de novo agendamento.
// Telefone fica fora da busca porque é criptografado (BYTEA) —
// ver migração 001 para detalhes.
// ============================================================
router.get('/pacientes/buscar', adminAuth, async (req, res) => {
  const termo = (req.query.q || '').trim();

  if (termo.length < 2) {
    return res.json({ pacientes: [] });
  }

  try {
    const { rows } = await query(
      `SELECT id, nome, sobrenome, email,
              pgp_sym_decrypt(telefone, $2) AS telefone
       FROM pacientes
       WHERE LOWER(nome) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1)
       ORDER BY nome
       LIMIT 10`,
      [`%${termo}%`, process.env.TELEFONE_CRYPT_KEY]
    );
    res.json({ pacientes: rows });
  } catch (err) {
    console.error('[ADMIN PACIENTES BUSCAR]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar pacientes.' });
  }
});

// ============================================================
// POST /api/admin/pacientes — cadastro rápido pelo admin
// (ex: paciente que ligou por telefone e ainda não tem conta
// no site). Fica sem senha utilizável até que o próprio paciente
// crie uma conta normalmente pelo site com o mesmo email.
// ============================================================
router.post('/pacientes', adminAuth, async (req, res) => {
  const { nome, sobrenome, email, telefone } = req.body;

  if (!nome || !email) {
    return res.status(400).json({ erro: 'Nome e email são obrigatórios.' });
  }

  try {
    const { rows: existente } = await query(
      'SELECT id FROM pacientes WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    if (existente.length) {
      return res.status(409).json({ erro: 'Já existe um paciente com esse email.', pacienteId: existente[0].id });
    }

    const { rows } = await query(
      `INSERT INTO pacientes (nome, sobrenome, email, telefone, senha_hash, cadastrado_por_admin)
       VALUES ($1, $2, $3, pgp_sym_encrypt($4, $5), NULL, TRUE)
       RETURNING id, nome, sobrenome, email`,
      [nome, sobrenome || '', email, telefone || '', process.env.TELEFONE_CRYPT_KEY]
    );

    console.log(`[ADMIN] ${req.admin.email} cadastrou paciente ${rows[0].email} manualmente`);

    res.status(201).json({ mensagem: 'Paciente cadastrado.', paciente: rows[0] });
  } catch (err) {
    console.error('[ADMIN PACIENTE POST]', err.message);
    res.status(500).json({ erro: 'Erro ao cadastrar paciente.' });
  }
});

// ============================================================
// POST /api/admin/agendamentos — cria agendamento manualmente
// (recepção marcando consulta por telefone, por exemplo).
// Aceita valor/forma de pagamento opcionalmente; se não vierem,
// o agendamento nasce com pago = false e pode ser editado depois.
// ============================================================
router.post('/agendamentos', adminAuth, async (req, res) => {
  const { pacienteId, dentistaId, servico, dataHora, observacoes, valor, formaPagamento, pago } = req.body;

  if (!pacienteId || !servico || !dataHora) {
    return res.status(400).json({ erro: 'Paciente, serviço e data/hora são obrigatórios.' });
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(pacienteId)) {
    return res.status(400).json({ erro: 'Paciente inválido.' });
  }
  if (dentistaId && !uuidRegex.test(dentistaId)) {
    return res.status(400).json({ erro: 'Dentista inválido.' });
  }
  if (formaPagamento && !['dinheiro', 'pix', 'cartao'].includes(formaPagamento)) {
    return res.status(400).json({ erro: 'Forma de pagamento inválida.' });
  }

  const { rows: pacienteExiste } = await query('SELECT id FROM pacientes WHERE id = $1', [pacienteId]);
  if (!pacienteExiste.length) {
    return res.status(400).json({ erro: 'Paciente não encontrado.' });
  }

  try {
    const { rows } = await query(
      `INSERT INTO agendamentos
         (paciente_id, dentista_id, servico, data_hora, observacoes, status,
          valor, forma_pagamento, pago, pago_em, criado_por_admin)
       VALUES ($1, $2, $3, $4, $5, 'confirmado', $6, $7, $8, $9, TRUE)
       RETURNING id, servico, data_hora, status, valor, forma_pagamento, pago`,
      [
        pacienteId,
        dentistaId || null,
        servico,
        new Date(dataHora).toISOString(),
        observacoes ? observacoes.substring(0, 500) : null,
        valor || null,
        formaPagamento || null,
        !!pago,
        pago ? new Date().toISOString() : null,
      ]
    );

    console.log(`[ADMIN] ${req.admin.email} criou agendamento manual ${rows[0].id}`);

    res.status(201).json({ mensagem: 'Agendamento criado.', agendamento: rows[0] });
  } catch (err) {
    console.error('[ADMIN AGENDAMENTO POST]', err.message);
    res.status(500).json({ erro: 'Erro ao criar agendamento.' });
  }
});

// ============================================================
// PATCH /api/admin/agendamentos/:id/pagamento — marca ou
// atualiza o pagamento de um agendamento já existente.
// ============================================================
router.patch('/agendamentos/:id/pagamento', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { valor, formaPagamento, pago } = req.body;

  if (formaPagamento && !['dinheiro', 'pix', 'cartao'].includes(formaPagamento)) {
    return res.status(400).json({ erro: 'Forma de pagamento inválida.' });
  }

  try {
    const { rows } = await query(
      `UPDATE agendamentos
       SET valor = COALESCE($1, valor),
           forma_pagamento = COALESCE($2, forma_pagamento),
           pago = $3,
           pago_em = CASE WHEN $3 THEN NOW() ELSE NULL END,
           atualizado_em = NOW()
       WHERE id = $4
       RETURNING id, valor, forma_pagamento, pago, pago_em`,
      [valor || null, formaPagamento || null, !!pago, id]
    );

    if (!rows.length) return res.status(404).json({ erro: 'Agendamento não encontrado.' });

    console.log(`[ADMIN] ${req.admin.email} atualizou pagamento do agendamento ${id}`);

    res.json({ mensagem: 'Pagamento atualizado.', agendamento: rows[0] });
  } catch (err) {
    console.error('[ADMIN PAGAMENTO PATCH]', err.message);
    res.status(500).json({ erro: 'Erro ao atualizar pagamento.' });
  }
});

// ============================================================
// GET /api/admin/stats — estatísticas gerais
// ============================================================
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const { rows: ag } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pendente') AS pendentes,
        COUNT(*) FILTER (WHERE status = 'confirmado') AS confirmados,
        COUNT(*) FILTER (WHERE status = 'cancelado') AS cancelados,
        COUNT(*) FILTER (WHERE status = 'realizado') AS realizados,
        COUNT(*) FILTER (WHERE DATE(data_hora) = CURRENT_DATE) AS hoje
      FROM agendamentos`);
    const { rows: pac } = await query(`SELECT COUNT(*) AS total FROM pacientes`);
    res.json({ agendamentos: ag[0], pacientes: pac[0] });
  } catch (err) {
    console.error('[ADMIN STATS]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar stats.' });
  }
});

module.exports = router;
