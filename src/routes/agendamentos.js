const express = require('express');
const { query, withTransaction } = require('../db/pool');
const auth = require('../middleware/auth');

const router = express.Router();

// Serviços permitidos (whitelist — nunca confie no input puro)
const SERVICOS_VALIDOS = [
  'Clareamento dental',
  'Ortodontia — avaliação',
  'Limpeza e prevenção',
  'Implante dental',
  'Facetas de porcelana',
  'Odontopediatria',
];

// ============================================================
// GET /api/agendamentos/dentistas — lista profissionais ativos
// (pública). Usada tanto para popular o <select> do formulário
// de agendamento quanto para a seção "Nossa equipe" do site.
// ============================================================
router.get('/dentistas', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, nome, sobrenome, especialidade, foto_url FROM dentistas WHERE ativo = TRUE ORDER BY nome`
    );
    res.json({ dentistas: rows });
  } catch (err) {
    console.error('[AGENDAMENTOS DENTISTAS]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar dentistas.' });
  }
});

// ============================================================
// GET /api/agendamentos — lista agendamentos do paciente logado
// ============================================================
router.get('/', auth, async (req, res) => {
  try {
    // RLS garante que paciente só vê os próprios dados.
    await query(`SELECT set_config('app.paciente_id', $1, true)`, [req.paciente.id]);

    const { rows } = await query(
      `SELECT
         a.id, a.servico, a.data_hora, a.status, a.observacoes,
         d.nome AS dentista_nome, d.especialidade
       FROM agendamentos a
       LEFT JOIN dentistas d ON d.id = a.dentista_id
       WHERE a.paciente_id = $1
       ORDER BY a.data_hora DESC`,
      [req.paciente.id]
    );

    res.json({ agendamentos: rows });
  } catch (err) {
    console.error('[AGENDAMENTOS GET]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar agendamentos.' });
  }
});

// ============================================================
// POST /api/agendamentos — cria novo agendamento
// ============================================================
router.post('/', auth, async (req, res) => {
  const { servico, dentistaId, dataHora, observacoes } = req.body;

  if (!SERVICOS_VALIDOS.includes(servico)) {
    return res.status(400).json({ erro: 'Serviço inválido.' });
  }

  if (!dataHora) {
    return res.status(400).json({ erro: 'Data e horário são obrigatórios.' });
  }

  const dataAgend = new Date(dataHora);
  if (dataAgend <= new Date()) {
    return res.status(400).json({ erro: 'A data deve ser no futuro.' });
  }

  // Validação extra: se um dentistaId foi enviado, confirma que é um
  // UUID válido e que existe de fato — evita erro de tipo no Postgres
  // e evita salvar um dentista inexistente.
  let dentistaIdValido = null;
  if (dentistaId) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(dentistaId)) {
      return res.status(400).json({ erro: 'Dentista inválido.' });
    }
    const { rows: existe } = await query('SELECT id FROM dentistas WHERE id = $1 AND ativo = TRUE', [dentistaId]);
    if (!existe.length) {
      return res.status(400).json({ erro: 'Dentista não encontrado.' });
    }
    dentistaIdValido = dentistaId;
  }

  try {
    const { rows } = await query(
      `INSERT INTO agendamentos
         (paciente_id, dentista_id, servico, data_hora, observacoes, status)
       VALUES ($1, $2, $3, $4, $5, 'pendente')
       RETURNING id, servico, data_hora, status`,
      [
        req.paciente.id,
        dentistaIdValido,
        servico,
        dataAgend.toISOString(),
        observacoes ? observacoes.substring(0, 500) : null,
      ]
    );

    res.status(201).json({
      mensagem: 'Agendamento criado com sucesso!',
      agendamento: rows[0],
    });
  } catch (err) {
    console.error('[AGENDAMENTOS POST]', err.message);
    res.status(500).json({ erro: 'Erro ao criar agendamento.' });
  }
});

// ============================================================
// PATCH /api/agendamentos/:id/cancelar
// ============================================================
router.patch('/:id/cancelar', auth, async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await query(
      `UPDATE agendamentos
       SET status = 'cancelado', atualizado_em = NOW()
       WHERE id = $1 AND paciente_id = $2 AND status = 'pendente'
       RETURNING id, status`,
      [id, req.paciente.id]
    );

    if (!rows.length) {
      return res.status(404).json({ erro: 'Agendamento não encontrado ou já cancelado.' });
    }

    res.json({ mensagem: 'Agendamento cancelado.', agendamento: rows[0] });
  } catch (err) {
    console.error('[AGENDAMENTOS PATCH]', err.message);
    res.status(500).json({ erro: 'Erro ao cancelar agendamento.' });
  }
});

// ============================================================
// GET /api/agendamentos/horarios — horários disponíveis
// ============================================================
router.get('/horarios', async (req, res) => {
  const { data, dentistaId } = req.query;

  if (!data) return res.status(400).json({ erro: 'Data obrigatória.' });

  try {
    const { rows: ocupados } = await query(
      `SELECT data_hora FROM agendamentos
       WHERE DATE(data_hora) = $1::date
         AND ($2::uuid IS NULL OR dentista_id = $2::uuid)
         AND status NOT IN ('cancelado')`,
      [data, dentistaId || null]
    );

    const horariosOcupados = ocupados.map(r =>
      new Date(r.data_hora).getHours()
    );

    const todos = [8, 9, 10, 11, 13, 14, 15, 16];
    const disponiveis = todos.map(h => ({
      hora:       `${String(h).padStart(2,'0')}:00`,
      disponivel: !horariosOcupados.includes(h),
    }));

    res.json({ horarios: disponiveis });
  } catch (err) {
    console.error('[HORARIOS]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar horários.' });
  }
});

module.exports = router;
