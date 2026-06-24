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
