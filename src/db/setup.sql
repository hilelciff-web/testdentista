-- ============================================================
-- SETUP SEGURO — Clínica Sorriso Saudável
-- PostgreSQL com todas as camadas de segurança aplicadas
-- ============================================================

-- 1. CRIAR BANCO E EXTENSÕES
CREATE DATABASE dentista_db
  ENCODING 'UTF8'
  LC_COLLATE 'pt_BR.UTF-8'
  LC_CTYPE 'pt_BR.UTF-8';

\c dentista_db;

-- pgcrypto: hashing bcrypt de senhas
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- pgaudit: auditoria de queries
CREATE EXTENSION IF NOT EXISTS pgaudit;
-- uuid: IDs não-sequenciais (dificulta enumeração)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 2. ROLES COM MENOR PRIVILÉGIO
-- ============================================================

-- Role da aplicação web (sem DELETE, sem DDL)
CREATE ROLE app_role;
GRANT CONNECT ON DATABASE dentista_db TO app_role;
GRANT USAGE ON SCHEMA public TO app_role;

-- Role somente leitura (relatórios, suporte)
CREATE ROLE read_role;
GRANT CONNECT ON DATABASE dentista_db TO read_role;
GRANT USAGE ON SCHEMA public TO read_role;

-- Usuário da aplicação
CREATE USER app_user WITH PASSWORD 'troque_por_senha_forte' CONNECTION LIMIT 50;
GRANT app_role TO app_user;

-- Usuário de leitura
CREATE USER read_user WITH PASSWORD 'troque_por_senha_forte_2' CONNECTION LIMIT 10;
GRANT read_role TO read_user;

-- ============================================================
-- 3. TABELAS
-- ============================================================

CREATE TABLE pacientes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome        TEXT NOT NULL,
  sobrenome   TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  -- CPF criptografado com pgcrypto (nunca em texto plano)
  cpf_hash    TEXT NOT NULL,
  data_nasc   DATE,
  telefone    TEXT,
  -- Senha com hash bcrypt via pgcrypto
  senha_hash  TEXT NOT NULL,
  ativo       BOOLEAN DEFAULT TRUE,
  criado_em   TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE dentistas (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome      TEXT NOT NULL,
  cro       TEXT NOT NULL UNIQUE,
  especialidade TEXT NOT NULL,
  ativo     BOOLEAN DEFAULT TRUE
);

CREATE TABLE agendamentos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  paciente_id   UUID NOT NULL REFERENCES pacientes(id) ON DELETE RESTRICT,
  dentista_id   UUID REFERENCES dentistas(id) ON DELETE RESTRICT,
  servico       TEXT NOT NULL,
  data_hora     TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente','confirmado','cancelado','realizado')),
  observacoes   TEXT,
  criado_em     TIMESTAMPTZ DEFAULT NOW(),
  -- Auditoria: quem criou/alterou
  criado_por    TEXT DEFAULT current_user,
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE log_acesso (
  id          SERIAL PRIMARY KEY,
  paciente_id UUID REFERENCES pacientes(id),
  email       TEXT,
  ip          INET,
  evento      TEXT NOT NULL,  -- LOGIN_OK, LOGIN_FAIL, LOGOUT
  detalhes    TEXT,
  criado_em   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. ÍNDICES (performance + segurança)
-- ============================================================

CREATE INDEX idx_pacientes_email ON pacientes(email);
CREATE INDEX idx_agendamentos_paciente ON agendamentos(paciente_id);
CREATE INDEX idx_agendamentos_data ON agendamentos(data_hora);
CREATE INDEX idx_log_acesso_paciente ON log_acesso(paciente_id);
CREATE INDEX idx_log_acesso_criado ON log_acesso(criado_em);

-- ============================================================
-- 5. ROW LEVEL SECURITY — paciente vê apenas seus próprios dados
-- ============================================================

ALTER TABLE agendamentos ENABLE ROW LEVEL SECURITY;

CREATE POLICY paciente_ve_proprios_agendamentos
  ON agendamentos
  FOR ALL
  USING (paciente_id::text = current_setting('app.paciente_id', TRUE));

-- Admin (app_role com bypass) pode ver tudo
ALTER TABLE agendamentos FORCE ROW LEVEL SECURITY;

-- ============================================================
-- 6. PERMISSÕES GRANULARES
-- ============================================================

-- app_role: só o necessário, sem DELETE em produção
GRANT SELECT, INSERT, UPDATE ON pacientes TO app_role;
GRANT SELECT, INSERT, UPDATE ON agendamentos TO app_role;
GRANT SELECT ON dentistas TO app_role;
GRANT INSERT ON log_acesso TO app_role;
GRANT SELECT ON log_acesso TO app_role;
GRANT USAGE ON SEQUENCE log_acesso_id_seq TO app_role;

-- read_role: somente leitura
GRANT SELECT ON pacientes TO read_role;
GRANT SELECT ON agendamentos TO read_role;
GRANT SELECT ON dentistas TO read_role;
GRANT SELECT ON log_acesso TO read_role;

-- ============================================================
-- 7. DADOS INICIAIS — dentistas
-- ============================================================

INSERT INTO dentistas (nome, cro, especialidade) VALUES
  ('Ana Silva',    'CRO-12345', 'Ortodontia e Estética Dental'),
  ('Carlos Ramos', 'CRO-54321', 'Implantodontia e Cirurgia');

-- ============================================================
-- 8. CONFIGURAÇÕES RECOMENDADAS (postgresql.conf)
-- ============================================================
-- listen_addresses = '10.0.1.10'        -- nunca 0.0.0.0
-- ssl = on
-- ssl_min_protocol_version = 'TLSv1.2'
-- idle_in_transaction_session_timeout = '5min'
-- statement_timeout = '30s'
-- log_connections = on
-- log_disconnections = on
-- pgaudit.log = 'ddl,write,role'
-- shared_preload_libraries = 'pgaudit'

-- ============================================================
-- 9. pg_hba.conf RECOMENDADO
-- ============================================================
-- local   all        postgres               peer
-- hostssl dentista_db app_user 10.0.1.0/24 scram-sha-256
-- host    all        all       0.0.0.0/0   reject
