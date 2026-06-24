// scripts/create-admin.js
// Uso: node scripts/create-admin.js "Nome" "email@clinica.com" "senhaForte123"
// Roda manualmente no servidor — nunca exponha isso como rota HTTP.

require('dotenv').config();
const bcrypt = require('bcrypt');
const { query, pool } = require('../src/db/pool');

const BCRYPT_ROUNDS = 12;

async function criarAdmin(nome, email, senha) {
  if (!nome || !email || !senha) {
    console.error('Uso: node create-admin.js "Nome" "email" "senha"');
    process.exit(1);
  }
  if (senha.length < 10) {
    console.error('Senha do admin deve ter no mínimo 10 caracteres.');
    process.exit(1);
  }

  const senhaHash = await bcrypt.hash(senha, BCRYPT_ROUNDS);

  try {
    const { rows } = await query(
      `INSERT INTO admins (nome, email, senha_hash)
       VALUES ($1, $2, $3)
       RETURNING id, nome, email`,
      [nome.trim(), email.toLowerCase().trim(), senhaHash]
    );
    console.log('Admin criado com sucesso:', rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      console.error('Já existe um admin com esse e-mail.');
    } else {
      console.error('Erro ao criar admin:', err.message);
    }
  } finally {
    await pool.end();
  }
}

const [, , nome, email, senha] = process.argv;
criarAdmin(nome, email, senha);
