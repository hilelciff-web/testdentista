const { Pool } = require('pg');
require('dotenv').config();

// Pool de conexões com configurações seguras
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  // SSL obrigatório em produção. O Railway usa certificado autoassinado
  // mesmo na rede interna/privada — por isso rejectUnauthorized precisa
  // ser false aqui. A conexão ainda é criptografada (TLS), só não valida
  // a cadeia de certificado contra uma CA pública. Isso é uma prática
  // aceita para conexões dentro da rede privada do próprio provedor.
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,

  // Limites do pool
  max: 20,                 // máximo de conexões simultâneas
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Teste de conexão ao iniciar
pool.on('connect', () => {
  console.log('[DB] Nova conexão estabelecida');
});

pool.on('error', (err) => {
  console.error('[DB] Erro inesperado no pool:', err.message);
});

// Helper: query parametrizada (prepared statement automático)
// NUNCA concatene valores diretamente — use sempre $1, $2, $3...
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`[DB] Query lenta (${duration}ms):`, text.substring(0, 80));
    }
    return res;
  } catch (err) {
    console.error('[DB] Erro na query:', err.message);
    throw err;
  }
}

// Helper: transação segura
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, withTransaction, pool };
