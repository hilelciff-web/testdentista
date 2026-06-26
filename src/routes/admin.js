const express = require('express');
const { query } = require('../db/pool');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// ============================================================
// GET /api/admin/agendamentos — todos os agendamentos
// ============================================================
router.get('/agendamentos', adminAuth, async (req, res) => {
  const { data, status, dataInicio, dataFim, dentistaId } = req.query;
  try {
    let sql = `
      SELECT a.id, a.servico, a.data_hora, a.status, a.observacoes,
             a.valor, a.forma_pagamento, a.pago, a.pago_em,
             a.paciente_id, a.dentista_id,
             COALESCE((SELECT SUM(valor) FROM pagamentos WHERE agendamento_id = a.id), 0) AS total_pago,
             p.nome AS paciente_nome, p.email AS paciente_email,
             pgp_sym_decrypt(p.telefone, $1) AS telefone,
             d.nome AS dentista_nome, d.especialidade AS dentista_especialidade
      FROM agendamentos a
      JOIN pacientes p ON p.id = a.paciente_id
      LEFT JOIN dentistas d ON d.id = a.dentista_id
      WHERE 1=1`;
    const params = [process.env.TELEFONE_CRYPT_KEY];

    if (data) {
      params.push(data);
      sql += ` AND DATE(a.data_hora) = $${params.length}::date`;
    }
    // Intervalo de datas (usado pela grade semanal) — independente do
    // filtro de "data" única, para não quebrar quem já chama com "data".
    if (dataInicio) {
      params.push(dataInicio);
      sql += ` AND DATE(a.data_hora) >= $${params.length}::date`;
    }
    if (dataFim) {
      params.push(dataFim);
      sql += ` AND DATE(a.data_hora) <= $${params.length}::date`;
    }
    if (status) {
      params.push(status);
      sql += ` AND a.status = $${params.length}`;
    }
    if (dentistaId) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(dentistaId)) {
        return res.status(400).json({ erro: 'Dentista inválido.' });
      }
      params.push(dentistaId);
      sql += ` AND a.dentista_id = $${params.length}`;
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
  const statusValidos = ['pendente', 'confirmado', 'cancelado', 'realizado', 'faltou'];

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
// GET /api/admin/pacientes/:id — detalhe de um paciente +
// histórico completo de agendamentos (para a tela de histórico).
// Fica DEPOIS de /pacientes/buscar de propósito: o Express casa
// rotas na ordem declarada, e ':id' casaria com a palavra "buscar"
// se viesse primeiro.
// ============================================================
router.get('/pacientes/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ erro: 'Paciente inválido.' });
  }

  try {
    const { rows: pacienteRows } = await query(
      `SELECT id, nome, sobrenome, email,
              pgp_sym_decrypt(telefone, $2) AS telefone,
              data_nasc, ativo, criado_em, cadastrado_por_admin
       FROM pacientes WHERE id = $1`,
      [id, process.env.TELEFONE_CRYPT_KEY]
    );
    if (!pacienteRows.length) return res.status(404).json({ erro: 'Paciente não encontrado.' });

    const { rows: historico } = await query(
      `SELECT a.id, a.servico, a.data_hora, a.status, a.observacoes,
              a.valor, a.forma_pagamento, a.pago, a.pago_em,
              COALESCE((SELECT SUM(valor) FROM pagamentos WHERE agendamento_id = a.id), 0) AS total_pago,
              d.nome AS dentista_nome, d.especialidade AS dentista_especialidade
       FROM agendamentos a
       LEFT JOIN dentistas d ON d.id = a.dentista_id
       WHERE a.paciente_id = $1
       ORDER BY a.data_hora DESC`,
      [id]
    );

    const totais = historico.reduce((acc, a) => {
      acc.totalConsultas += 1;
      if (a.status === 'realizado') acc.realizadas += 1;
      if (a.status === 'cancelado') acc.canceladas += 1;
      const totalPagoConsulta = Number(a.total_pago || 0);
      acc.totalPago += totalPagoConsulta;
      if (a.valor != null && a.status !== 'cancelado') {
        const falta = Math.max(0, Number(a.valor) - totalPagoConsulta);
        acc.totalPendente += falta;
      }
      return acc;
    }, { totalConsultas: 0, realizadas: 0, canceladas: 0, totalPago: 0, totalPendente: 0 });

    const { rows: planos } = await query(
      `SELECT pt.id, pt.titulo, pt.valor_total, pt.status,
              COUNT(a.id) AS total_etapas,
              COUNT(a.id) FILTER (WHERE a.status = 'realizado') AS etapas_realizadas
       FROM planos_tratamento pt
       LEFT JOIN agendamentos a ON a.plano_tratamento_id = pt.id
       WHERE pt.paciente_id = $1
       GROUP BY pt.id
       ORDER BY pt.criado_em DESC`,
      [id]
    );

    res.json({ paciente: pacienteRows[0], historico, totais, planos });
  } catch (err) {
    console.error('[ADMIN PACIENTE DETALHE]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar paciente.' });
  }
});

// ============================================================
// PATCH /api/admin/pacientes/:id — edita dados de cadastro
// (nome, sobrenome, email, telefone). Não altera senha aqui.
// ============================================================
router.patch('/pacientes/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { nome, sobrenome, email, telefone } = req.body;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ erro: 'Paciente inválido.' });
  }
  if (!nome || !email) {
    return res.status(400).json({ erro: 'Nome e email são obrigatórios.' });
  }

  try {
    const { rows: emailEmUso } = await query(
      'SELECT id FROM pacientes WHERE LOWER(email) = LOWER($1) AND id != $2',
      [email, id]
    );
    if (emailEmUso.length) {
      return res.status(409).json({ erro: 'Esse email já está em uso por outro paciente.' });
    }

    const { rows } = await query(
      `UPDATE pacientes
       SET nome = $1, sobrenome = $2, email = $3, telefone = pgp_sym_encrypt($4, $5)
       WHERE id = $6
       RETURNING id, nome, sobrenome, email`,
      [nome, sobrenome || '', email, telefone || '', process.env.TELEFONE_CRYPT_KEY, id]
    );

    if (!rows.length) return res.status(404).json({ erro: 'Paciente não encontrado.' });

    console.log(`[ADMIN] ${req.admin.email} editou cadastro do paciente ${id}`);

    res.json({ mensagem: 'Cadastro atualizado.', paciente: rows[0] });
  } catch (err) {
    console.error('[ADMIN PACIENTE PATCH]', err.message);
    res.status(500).json({ erro: 'Erro ao atualizar paciente.' });
  }
});

// ============================================================
// GET /api/admin/dentistas — todos os profissionais
// (dentistas, higienistas, recepção, etc. — qualquer profissão)
// ============================================================
router.get('/dentistas', adminAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, nome, sobrenome, cro, especialidade, foto_url, ativo FROM dentistas ORDER BY nome`
    );
    res.json({ dentistas: rows });
  } catch (err) {
    console.error('[ADMIN DENTISTAS]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar dentistas.' });
  }
});

// ============================================================
// POST /api/admin/dentistas — adiciona profissional. O campo
// "especialidade" funciona como a profissão em texto livre
// (Dentista, Ortodontista, Higienista, Recepcionista, etc.).
// CRO é opcional — só faz sentido para quem de fato tem registro.
// ============================================================
router.post('/dentistas', adminAuth, async (req, res) => {
  const { nome, sobrenome, cro, especialidade, email, fotoUrl } = req.body;
  if (!nome || !especialidade) {
    return res.status(400).json({ erro: 'Nome e profissão são obrigatórios.' });
  }
  try {
    const { rows } = await query(
      `INSERT INTO dentistas (nome, sobrenome, cro, especialidade, email, foto_url, senha_hash)
       VALUES ($1, $2, $3, $4, $5, $6, 'placeholder') RETURNING id, nome, cro, especialidade, foto_url`,
      [nome, sobrenome || '', cro || null, especialidade, email || '', fotoUrl || null]
    );

    console.log(`[ADMIN] ${req.admin.email} adicionou profissional ${rows[0].nome}`);

    res.status(201).json({ mensagem: 'Profissional adicionado.', dentista: rows[0] });
  } catch (err) {
    console.error('[ADMIN DENTISTA POST]', err.message);
    res.status(500).json({ erro: 'Erro ao adicionar profissional.' });
  }
});

// ============================================================
// DELETE /api/admin/dentistas/:id — remove um profissional.
// Não deleta de fato se houver agendamentos vinculados (FK),
// nesse caso apenas desativa, para não perder o histórico.
// ============================================================
router.delete('/dentistas/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) return res.status(400).json({ erro: 'Profissional inválido.' });

  try {
    const { rows: temAgendamentos } = await query(
      'SELECT id FROM agendamentos WHERE dentista_id = $1 LIMIT 1',
      [id]
    );

    if (temAgendamentos.length) {
      // Tem histórico vinculado — não apaga de verdade, só desativa
      // (assim some da lista de "ativos" mas o histórico continua íntegro).
      await query('UPDATE dentistas SET ativo = FALSE WHERE id = $1', [id]);
      console.log(`[ADMIN] ${req.admin.email} desativou profissional ${id} (tinha agendamentos vinculados)`);
      return res.json({ mensagem: 'Profissional tem histórico de agendamentos — foi desativado em vez de excluído.', desativado: true });
    }

    const { rows } = await query('DELETE FROM dentistas WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) return res.status(404).json({ erro: 'Profissional não encontrado.' });

    console.log(`[ADMIN] ${req.admin.email} excluiu profissional ${id}`);

    res.json({ mensagem: 'Profissional excluído.', desativado: false });
  } catch (err) {
    console.error('[ADMIN DENTISTA DELETE]', err.message);
    res.status(500).json({ erro: 'Erro ao excluir profissional.' });
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
// PATCH /api/admin/agendamentos/:id/remarcar — muda data/hora
// (e opcionalmente o dentista) de um agendamento existente,
// preservando o histórico de pagamento e o status atual.
// ============================================================
router.patch('/agendamentos/:id/remarcar', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { dataHora, dentistaId } = req.body;

  if (!dataHora) {
    return res.status(400).json({ erro: 'Nova data e horário são obrigatórios.' });
  }

  const novaData = new Date(dataHora);
  if (isNaN(novaData.getTime())) {
    return res.status(400).json({ erro: 'Data inválida.' });
  }

  let dentistaIdValido = undefined; // undefined = não alterar o dentista atual
  if (dentistaId !== undefined) {
    if (dentistaId === null || dentistaId === '') {
      dentistaIdValido = null; // remove o dentista do agendamento
    } else {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(dentistaId)) {
        return res.status(400).json({ erro: 'Dentista inválido.' });
      }
      dentistaIdValido = dentistaId;
    }
  }

  try {
    let rows;
    if (dentistaIdValido === undefined) {
      // Não tocar no dentista — só atualiza a data/hora.
      ({ rows } = await query(
        `UPDATE agendamentos SET data_hora = $1, atualizado_em = NOW()
         WHERE id = $2 RETURNING id, data_hora, dentista_id, status`,
        [novaData.toISOString(), id]
      ));
    } else {
      // dentistaIdValido pode ser um UUID válido OU null (remover dentista) —
      // nos dois casos queremos sobrescrever de fato, por isso não usamos COALESCE aqui.
      ({ rows } = await query(
        `UPDATE agendamentos SET data_hora = $1, dentista_id = $2, atualizado_em = NOW()
         WHERE id = $3 RETURNING id, data_hora, dentista_id, status`,
        [novaData.toISOString(), dentistaIdValido, id]
      ));
    }

    if (!rows.length) return res.status(404).json({ erro: 'Agendamento não encontrado.' });

    console.log(`[ADMIN] ${req.admin.email} remarcou agendamento ${id} para ${novaData.toISOString()}`);

    res.json({ mensagem: 'Consulta remarcada.', agendamento: rows[0] });
  } catch (err) {
    console.error('[ADMIN REMARCAR]', err.message);
    res.status(500).json({ erro: 'Erro ao remarcar consulta.' });
  }
});

// ============================================================
// Helper: recalcula os campos derivados em agendamentos (pago,
// pago_em, forma_pagamento) a partir da soma real de pagamentos.
// Mantém compatibilidade com código antigo que ainda lê esses
// campos booleanos, mesmo com o novo sistema de pagamento parcial.
// ============================================================
async function recalcularStatusPagamento(agendamentoId) {
  const { rows: agRows } = await query('SELECT valor FROM agendamentos WHERE id = $1', [agendamentoId]);
  if (!agRows.length) return null;
  const valorTotal = agRows[0].valor;

  const { rows: somaRows } = await query(
    'SELECT COALESCE(SUM(valor), 0) AS total_pago, MAX(pago_em) AS ultimo_pagamento, MAX(forma_pagamento) AS ultima_forma FROM pagamentos WHERE agendamento_id = $1',
    [agendamentoId]
  );
  const totalPago = Number(somaRows[0].total_pago);
  const pagoCompleto = valorTotal != null && totalPago >= Number(valorTotal);

  await query(
    `UPDATE agendamentos
     SET pago = $1, pago_em = $2, forma_pagamento = $3, atualizado_em = NOW()
     WHERE id = $4`,
    [pagoCompleto, totalPago > 0 ? somaRows[0].ultimo_pagamento : null, somaRows[0].ultima_forma, agendamentoId]
  );

  return {
    valorTotal: valorTotal != null ? Number(valorTotal) : null,
    totalPago,
    faltaPagar: valorTotal != null ? Math.max(0, Number(valorTotal) - totalPago) : null,
    pagoCompleto,
  };
}

// ============================================================
// GET /api/admin/agendamentos/:id/pagamentos — lista todos os
// pagamentos (parciais ou totais) já registrados para a consulta,
// e o resumo de quanto falta pagar.
// ============================================================
router.get('/agendamentos/:id/pagamentos', adminAuth, async (req, res) => {
  const { id } = req.params;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) return res.status(400).json({ erro: 'Agendamento inválido.' });

  try {
    const { rows: agRows } = await query('SELECT id, servico, valor FROM agendamentos WHERE id = $1', [id]);
    if (!agRows.length) return res.status(404).json({ erro: 'Agendamento não encontrado.' });

    const { rows: pagamentos } = await query(
      'SELECT id, valor, forma_pagamento, pago_em, observacao FROM pagamentos WHERE agendamento_id = $1 ORDER BY pago_em ASC',
      [id]
    );

    const valorTotal = agRows[0].valor != null ? Number(agRows[0].valor) : null;
    const totalPago = pagamentos.reduce((s, p) => s + Number(p.valor), 0);
    const faltaPagar = valorTotal != null ? Math.max(0, valorTotal - totalPago) : null;

    res.json({
      agendamento: agRows[0],
      pagamentos,
      valorTotal,
      totalPago,
      faltaPagar,
    });
  } catch (err) {
    console.error('[ADMIN PAGAMENTOS GET]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar pagamentos.' });
  }
});

// ============================================================
// POST /api/admin/agendamentos/:id/pagamentos — registra um novo
// pagamento (parcial ou que completa o total) para a consulta.
// ============================================================
router.post('/agendamentos/:id/pagamentos', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { valor, formaPagamento, observacao } = req.body;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) return res.status(400).json({ erro: 'Agendamento inválido.' });
  if (!valor || Number(valor) <= 0) return res.status(400).json({ erro: 'Informe um valor de pagamento maior que zero.' });
  if (!formaPagamento || !['dinheiro', 'pix', 'cartao'].includes(formaPagamento)) {
    return res.status(400).json({ erro: 'Forma de pagamento inválida.' });
  }

  try {
    const { rows: agRows } = await query('SELECT id, valor FROM agendamentos WHERE id = $1', [id]);
    if (!agRows.length) return res.status(404).json({ erro: 'Agendamento não encontrado.' });

    await query(
      `INSERT INTO pagamentos (agendamento_id, valor, forma_pagamento, observacao)
       VALUES ($1, $2, $3, $4)`,
      [id, Number(valor), formaPagamento, observacao ? observacao.substring(0, 300) : null]
    );

    const resumo = await recalcularStatusPagamento(id);

    console.log(`[ADMIN] ${req.admin.email} registrou pagamento de R$${valor} no agendamento ${id}`);

    res.status(201).json({ mensagem: 'Pagamento registrado.', resumo });
  } catch (err) {
    console.error('[ADMIN PAGAMENTO POST]', err.message);
    res.status(500).json({ erro: 'Erro ao registrar pagamento.' });
  }
});

// ============================================================
// DELETE /api/admin/pagamentos/:id — remove um pagamento
// registrado por engano, recalculando o status da consulta.
// ============================================================
router.delete('/pagamentos/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) return res.status(400).json({ erro: 'Pagamento inválido.' });

  try {
    const { rows } = await query('DELETE FROM pagamentos WHERE id = $1 RETURNING agendamento_id', [id]);
    if (!rows.length) return res.status(404).json({ erro: 'Pagamento não encontrado.' });

    const resumo = await recalcularStatusPagamento(rows[0].agendamento_id);

    console.log(`[ADMIN] ${req.admin.email} removeu pagamento ${id}`);

    res.json({ mensagem: 'Pagamento removido.', resumo });
  } catch (err) {
    console.error('[ADMIN PAGAMENTO DELETE]', err.message);
    res.status(500).json({ erro: 'Erro ao remover pagamento.' });
  }
});

// ============================================================
// PATCH /api/admin/agendamentos/:id/pagamento — marca ou
// atualiza o pagamento de um agendamento já existente.
// (rota antiga, mantida por compatibilidade com o atalho rápido
// "✓ pago" da grade — marca como totalmente pago de uma vez,
// criando um pagamento único equivalente ao valor total)
// ============================================================
router.patch('/agendamentos/:id/pagamento', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { valor, formaPagamento, pago } = req.body;

  if (formaPagamento && !['dinheiro', 'pix', 'cartao'].includes(formaPagamento)) {
    return res.status(400).json({ erro: 'Forma de pagamento inválida.' });
  }

  try {
    const { rows: agRows } = await query('SELECT id, valor FROM agendamentos WHERE id = $1', [id]);
    if (!agRows.length) return res.status(404).json({ erro: 'Agendamento não encontrado.' });

    // Se um valor de consulta foi enviado e ainda não havia um definido,
    // grava o valor total da consulta antes de registrar o pagamento.
    if (valor && agRows[0].valor == null) {
      await query('UPDATE agendamentos SET valor = $1 WHERE id = $2', [Number(valor), id]);
    }

    if (pago) {
      // Atalho "marcar tudo como pago": registra um pagamento único
      // pelo valor total da consulta (o que já estiver definido).
      const { rows: agAtual } = await query('SELECT valor FROM agendamentos WHERE id = $1', [id]);
      const valorAPagar = agAtual[0].valor != null ? Number(agAtual[0].valor) : Number(valor || 0);
      if (valorAPagar > 0) {
        await query(
          `INSERT INTO pagamentos (agendamento_id, valor, forma_pagamento) VALUES ($1, $2, $3)`,
          [id, valorAPagar, formaPagamento || 'dinheiro']
        );
      }
    }

    const resumo = await recalcularStatusPagamento(id);

    console.log(`[ADMIN] ${req.admin.email} atualizou pagamento do agendamento ${id}`);

    res.json({ mensagem: 'Pagamento atualizado.', resumo });
  } catch (err) {
    console.error('[ADMIN PAGAMENTO PATCH]', err.message);
    res.status(500).json({ erro: 'Erro ao atualizar pagamento.' });
  }
});

// ============================================================
// GET /api/admin/resumo-dia?data=YYYY-MM-DD — números rápidos
// para os cartões no topo da tela de Agenda: quantas consultas
// hoje, quanto falta receber hoje, quanto já entrou hoje, e
// quantas faltas (no-show) na semana corrente. Sem "data", usa
// o dia de hoje.
// ============================================================
router.get('/resumo-dia', adminAuth, async (req, res) => {
  const data = req.query.data || new Date().toISOString().split('T')[0];

  try {
    const { rows: hojeRows } = await query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(
                GREATEST(a.valor - COALESCE((SELECT SUM(valor) FROM pagamentos WHERE agendamento_id = a.id), 0), 0)
              ) FILTER (WHERE a.status IN ('confirmado', 'realizado') AND a.valor IS NOT NULL), 0) AS pendente_hoje
       FROM agendamentos a
       WHERE DATE(a.data_hora) = $1::date AND a.status != 'cancelado'`,
      [data]
    );

    const { rows: recebidoRows } = await query(
      `SELECT COALESCE(SUM(valor), 0) AS recebido_hoje
       FROM pagamentos
       WHERE DATE(pago_em) = $1::date`,
      [data]
    );

    // Faltas (no-show) na semana corrente. Calculado em JS (domingo a
    // sábado) para usar a mesma convenção da grade semanal do frontend,
    // em vez de date_trunc('week', ...) do Postgres, que usa segunda
    // como início — misturar as duas convenções geraria contagem errada.
    const dataRef = new Date(data + 'T12:00:00');
    const domingo = new Date(dataRef);
    domingo.setDate(domingo.getDate() - domingo.getDay());
    const proximoDomingo = new Date(domingo);
    proximoDomingo.setDate(proximoDomingo.getDate() + 7);

    const { rows: faltasRows } = await query(
      `SELECT COUNT(*) AS faltas_semana
       FROM agendamentos
       WHERE status = 'faltou'
         AND data_hora >= $1::date
         AND data_hora < $2::date`,
      [domingo.toISOString().split('T')[0], proximoDomingo.toISOString().split('T')[0]]
    );

    res.json({
      data,
      totalConsultasHoje: Number(hojeRows[0].total),
      pendenteHoje: Number(hojeRows[0].pendente_hoje),
      recebidoHoje: Number(recebidoRows[0].recebido_hoje),
      faltasSemana: Number(faltasRows[0].faltas_semana),
    });
  } catch (err) {
    console.error('[ADMIN RESUMO DIA]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar resumo do dia.' });
  }
});

// ============================================================
// GET /api/admin/caixa?data=YYYY-MM-DD — fechamento de caixa do
// dia: total recebido por forma de pagamento + lista de
// pendências (consultas realizadas/confirmadas mas não pagas).
// Sem "data" no query, usa o dia de hoje.
// ============================================================
router.get('/caixa', adminAuth, async (req, res) => {
  const data = req.query.data || new Date().toISOString().split('T')[0];

  try {
    // Cada linha de "pagamentos" conta no caixa do dia em que ela
    // ocorreu — isso inclui pagamentos parciais, mesmo que a consulta
    // ainda não esteja totalmente paga.
    const { rows: recebidos } = await query(
      `SELECT pg.id, pg.valor, pg.forma_pagamento, pg.pago_em,
              a.servico, p.nome AS paciente_nome
       FROM pagamentos pg
       JOIN agendamentos a ON a.id = pg.agendamento_id
       JOIN pacientes p ON p.id = a.paciente_id
       WHERE DATE(pg.pago_em) = $1::date
       ORDER BY pg.pago_em ASC`,
      [data]
    );

    const porFormaPagamento = recebidos.reduce((acc, r) => {
      const forma = r.forma_pagamento || 'não informado';
      acc[forma] = (acc[forma] || 0) + Number(r.valor || 0);
      return acc;
    }, {});

    const totalRecebido = recebidos.reduce((soma, r) => soma + Number(r.valor || 0), 0);

    // Pendências: consultas do dia que já aconteceram (ou foram
    // confirmadas) e ainda têm saldo a receber (parcial ou total).
    const { rows: pendentesRaw } = await query(
      `SELECT a.id, a.servico, a.data_hora, a.status, a.valor,
              p.nome AS paciente_nome,
              COALESCE((SELECT SUM(valor) FROM pagamentos WHERE agendamento_id = a.id), 0) AS total_pago
       FROM agendamentos a
       JOIN pacientes p ON p.id = a.paciente_id
       WHERE DATE(a.data_hora) = $1::date
         AND a.status IN ('confirmado', 'realizado')
       ORDER BY a.data_hora ASC`,
      [data]
    );

    const pendentes = pendentesRaw
      .map(p => ({ ...p, falta_pagar: p.valor != null ? Math.max(0, Number(p.valor) - Number(p.total_pago)) : null }))
      .filter(p => p.falta_pagar === null || p.falta_pagar > 0);

    res.json({
      data,
      totalRecebido,
      porFormaPagamento,
      recebidos,
      pendentes,
    });
  } catch (err) {
    console.error('[ADMIN CAIXA]', err.message);
    res.status(500).json({ erro: 'Erro ao gerar fechamento de caixa.' });
  }
});

// ============================================================
// GET /api/admin/planos?pacienteId=... — lista planos de
// tratamento. Sem pacienteId, lista todos (visão geral).
// ============================================================
router.get('/planos', adminAuth, async (req, res) => {
  const { pacienteId } = req.query;
  try {
    let sql = `
      SELECT pt.id, pt.titulo, pt.valor_total, pt.status, pt.observacoes, pt.criado_em,
             p.nome AS paciente_nome, p.id AS paciente_id,
             COUNT(a.id) AS total_etapas,
             COUNT(a.id) FILTER (WHERE a.status = 'realizado') AS etapas_realizadas,
             COALESCE(SUM(a.valor) FILTER (WHERE a.pago = TRUE), 0) AS total_pago
      FROM planos_tratamento pt
      JOIN pacientes p ON p.id = pt.paciente_id
      LEFT JOIN agendamentos a ON a.plano_tratamento_id = pt.id
      WHERE 1=1`;
    const params = [];

    if (pacienteId) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(pacienteId)) {
        return res.status(400).json({ erro: 'Paciente inválido.' });
      }
      params.push(pacienteId);
      sql += ` AND pt.paciente_id = $${params.length}`;
    }

    sql += ' GROUP BY pt.id, p.nome, p.id ORDER BY pt.criado_em DESC';

    const { rows } = await query(sql, params);
    res.json({ planos: rows });
  } catch (err) {
    console.error('[ADMIN PLANOS GET]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar planos de tratamento.' });
  }
});

// ============================================================
// GET /api/admin/planos/:id — detalhe de um plano + todas as
// etapas (agendamentos vinculados), em ordem cronológica.
// ============================================================
router.get('/planos/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) return res.status(400).json({ erro: 'Plano inválido.' });

  try {
    const { rows: planoRows } = await query(
      `SELECT pt.id, pt.titulo, pt.valor_total, pt.status, pt.observacoes, pt.criado_em,
              p.nome AS paciente_nome, p.id AS paciente_id
       FROM planos_tratamento pt
       JOIN pacientes p ON p.id = pt.paciente_id
       WHERE pt.id = $1`,
      [id]
    );
    if (!planoRows.length) return res.status(404).json({ erro: 'Plano não encontrado.' });

    const { rows: etapas } = await query(
      `SELECT a.id, a.servico, a.data_hora, a.status, a.valor, a.forma_pagamento, a.pago,
              d.nome AS dentista_nome
       FROM agendamentos a
       LEFT JOIN dentistas d ON d.id = a.dentista_id
       WHERE a.plano_tratamento_id = $1
       ORDER BY a.data_hora ASC`,
      [id]
    );

    const totalPago = etapas.filter(e => e.pago).reduce((s, e) => s + Number(e.valor || 0), 0);

    res.json({ plano: planoRows[0], etapas, totalPago });
  } catch (err) {
    console.error('[ADMIN PLANO DETALHE]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar plano de tratamento.' });
  }
});

// ============================================================
// POST /api/admin/planos — cria um novo plano de tratamento
// (a "pasta" que vai agrupar as etapas/agendamentos).
// ============================================================
router.post('/planos', adminAuth, async (req, res) => {
  const { pacienteId, titulo, valorTotal, observacoes } = req.body;

  if (!pacienteId || !titulo) {
    return res.status(400).json({ erro: 'Paciente e título são obrigatórios.' });
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(pacienteId)) return res.status(400).json({ erro: 'Paciente inválido.' });

  const { rows: pacienteExiste } = await query('SELECT id FROM pacientes WHERE id = $1', [pacienteId]);
  if (!pacienteExiste.length) return res.status(400).json({ erro: 'Paciente não encontrado.' });

  try {
    const { rows } = await query(
      `INSERT INTO planos_tratamento (paciente_id, titulo, valor_total, observacoes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, titulo, valor_total, status`,
      [pacienteId, titulo, valorTotal || null, observacoes ? observacoes.substring(0, 500) : null]
    );

    console.log(`[ADMIN] ${req.admin.email} criou plano de tratamento "${titulo}"`);

    res.status(201).json({ mensagem: 'Plano de tratamento criado.', plano: rows[0] });
  } catch (err) {
    console.error('[ADMIN PLANO POST]', err.message);
    res.status(500).json({ erro: 'Erro ao criar plano de tratamento.' });
  }
});

// ============================================================
// POST /api/admin/planos/:id/etapas — adiciona uma etapa ao
// plano. Cria um agendamento normal já vinculado ao plano, então
// a etapa aparece na agenda/grade como qualquer outra consulta.
// ============================================================
router.post('/planos/:id/etapas', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { servico, dentistaId, dataHora, valor, observacoes } = req.body;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) return res.status(400).json({ erro: 'Plano inválido.' });
  if (!servico || !dataHora) return res.status(400).json({ erro: 'Serviço e data/hora são obrigatórios.' });
  if (dentistaId && !uuidRegex.test(dentistaId)) return res.status(400).json({ erro: 'Dentista inválido.' });

  try {
    const { rows: planoRows } = await query('SELECT id, paciente_id FROM planos_tratamento WHERE id = $1', [id]);
    if (!planoRows.length) return res.status(404).json({ erro: 'Plano não encontrado.' });
    const plano = planoRows[0];

    const { rows } = await query(
      `INSERT INTO agendamentos
         (paciente_id, dentista_id, servico, data_hora, observacoes, status, valor, plano_tratamento_id, criado_por_admin)
       VALUES ($1, $2, $3, $4, $5, 'confirmado', $6, $7, TRUE)
       RETURNING id, servico, data_hora, status, valor`,
      [
        plano.paciente_id,
        dentistaId || null,
        servico,
        new Date(dataHora).toISOString(),
        observacoes ? observacoes.substring(0, 500) : null,
        valor || null,
        id,
      ]
    );

    console.log(`[ADMIN] ${req.admin.email} adicionou etapa ao plano ${id}`);

    res.status(201).json({ mensagem: 'Etapa adicionada ao plano.', etapa: rows[0] });
  } catch (err) {
    console.error('[ADMIN ETAPA POST]', err.message);
    res.status(500).json({ erro: 'Erro ao adicionar etapa.' });
  }
});

// ============================================================
// PATCH /api/admin/planos/:id — atualiza status/título/valor
// do plano (ex: marcar como concluído ou cancelado).
// ============================================================
router.patch('/planos/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { titulo, valorTotal, status, observacoes } = req.body;

  if (status && !['em_andamento', 'concluido', 'cancelado'].includes(status)) {
    return res.status(400).json({ erro: 'Status inválido.' });
  }

  try {
    const { rows } = await query(
      `UPDATE planos_tratamento
       SET titulo = COALESCE($1, titulo),
           valor_total = COALESCE($2, valor_total),
           status = COALESCE($3, status),
           observacoes = COALESCE($4, observacoes),
           atualizado_em = NOW()
       WHERE id = $5
       RETURNING id, titulo, valor_total, status`,
      [titulo || null, valorTotal || null, status || null, observacoes || null, id]
    );

    if (!rows.length) return res.status(404).json({ erro: 'Plano não encontrado.' });

    console.log(`[ADMIN] ${req.admin.email} atualizou plano ${id}`);

    res.json({ mensagem: 'Plano atualizado.', plano: rows[0] });
  } catch (err) {
    console.error('[ADMIN PLANO PATCH]', err.message);
    res.status(500).json({ erro: 'Erro ao atualizar plano.' });
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
