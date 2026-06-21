# Clínica Sorriso Saudável — Backend Seguro

Backend Node.js + PostgreSQL com segurança em todas as camadas.

## Estrutura do projeto

```
dentista/
├── src/
│   ├── db/
│   │   ├── setup.sql     ← Script de criação do banco (roles, tabelas, RLS)
│   │   └── pool.js       ← Pool de conexões com SSL
│   ├── middleware/
│   │   └── auth.js       ← Verificação de JWT
│   ├── routes/
│   │   ├── auth.js       ← Cadastro e login (bcrypt + auditoria)
│   │   └── agendamentos.js ← CRUD de agendamentos (RLS + whitelist)
│   └── server.js         ← Express com helmet, CORS, rate limiting
├── public/               ← Frontend estático (index.html)
├── .env.example          ← Variáveis de ambiente (copie para .env)
└── README.md
```

## Como rodar

### 1. Clonar e instalar

```bash
git clone <seu-repo>
cd dentista
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
# Edite o .env com suas credenciais reais
```

### 3. Criar o banco PostgreSQL

```bash
# Cria o banco e configura toda a segurança
npm run db:setup

# Ou manualmente:
psql -U postgres -f src/db/setup.sql
```

### 4. Configurar pg_hba.conf (produção)

```
# Só aceita conexão SSL do IP do servidor
hostssl dentista_db app_user 10.0.1.0/24 scram-sha-256
host    all         all       0.0.0.0/0  reject
```

### 5. Configurar postgresql.conf (produção)

```
ssl = on
ssl_min_protocol_version = 'TLSv1.2'
listen_addresses = '10.0.1.10'
idle_in_transaction_session_timeout = '5min'
statement_timeout = '30s'
shared_preload_libraries = 'pgaudit'
pgaudit.log = 'ddl,write,role'
```

### 6. Rodar o servidor

```bash
npm start          # produção
npm run dev        # desenvolvimento (nodemon)
```

---

## Endpoints da API

### Autenticação

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/auth/cadastro` | Cria conta (senha via bcrypt) |
| POST | `/api/auth/login` | Login (retorna JWT) |

**Exemplo — cadastro:**
```json
POST /api/auth/cadastro
{
  "nome": "João",
  "sobrenome": "Silva",
  "email": "joao@email.com",
  "cpf": "123.456.789-00",
  "dataNasc": "1990-05-15",
  "telefone": "(83) 99999-9999",
  "senha": "MinhaSenh@123"
}
```

**Exemplo — login:**
```json
POST /api/auth/login
{
  "email": "joao@email.com",
  "senha": "MinhaSenh@123"
}
```

### Agendamentos (requer JWT no header)

```
Authorization: Bearer <token>
```

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/agendamentos` | Lista agendamentos do paciente |
| POST | `/api/agendamentos` | Cria novo agendamento |
| PATCH | `/api/agendamentos/:id/cancelar` | Cancela agendamento |
| GET | `/api/agendamentos/horarios?data=2024-12-01` | Horários disponíveis |

---

## Segurança implementada

| Camada | Tecnologia | Onde |
|--------|-----------|------|
| SQL Injection | Prepared statements ($1, $2...) | Todas as queries |
| Senhas | bcrypt (12 rounds) | Cadastro e login |
| Autenticação | JWT com expiração | Rotas protegidas |
| Rate limiting | express-rate-limit | Login: 10 req/15min |
| Headers HTTP | helmet | Todos os responses |
| Dados em trânsito | TLS/SSL obrigatório | pg pool + HTTPS |
| Dados em repouso | TDE + pgcrypto | PostgreSQL |
| Controle de acesso | RBAC (roles) + RLS | PostgreSQL |
| Auditoria | pgaudit + log_acesso | Logins e queries |
| Validação | Whitelist de valores | Serviços, status |
