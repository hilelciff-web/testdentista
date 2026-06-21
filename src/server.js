require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const authRoutes        = require('./routes/auth');
const agendamentosRoutes = require('./routes/agendamentos');

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// 1. SEGURANÇA DE HEADERS — helmet
// Remove headers que revelam tecnologia, adiciona proteções
// ============================================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
    },
  },
  hsts: {
    maxAge: 31536000,         // 1 ano
    includeSubDomains: true,
    preload: true,
  },
}));

// ============================================================
// 2. CORS — só permite origens autorizadas
// ============================================================
const origens = process.env.NODE_ENV === 'production'
  ? ['https://seudominio.com.br']
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(cors({
  origin: origens,
  methods: ['GET', 'POST', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ============================================================
// 3. RATE LIMITING — limite de requisições por IP
// ============================================================

// Geral: 100 req / 15 min por IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { erro: 'Muitas requisições. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// Rotas de autenticação: mais restritivo — 10 tentativas / 15 min
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { erro: 'Muitas tentativas de login. Aguarde 15 minutos.' },
});
app.use('/api/auth', authLimiter);

// ============================================================
// 4. BODY PARSER com limite de tamanho
// ============================================================
app.use(express.json({ limit: '10kb' }));     // previne payloads gigantes
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ============================================================
// 5. ROTAS
// ============================================================
app.use('/api/auth',         authRoutes);
app.use('/api/agendamentos', agendamentosRoutes);

// Serve o frontend estático
app.use(express.static(path.join(__dirname, '../public')));

// Rota 404 para API
app.use('/api/*', (req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada.' });
});

// Fallback para SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ============================================================
// 6. HANDLER GLOBAL DE ERROS
// Nunca exponha stack traces em produção
// ============================================================
app.use((err, req, res, _next) => {
  console.error('[SERVER] Erro não tratado:', err.message);
  const status = err.status || 500;
  const mensagem = process.env.NODE_ENV === 'production'
    ? 'Erro interno do servidor.'
    : err.message;
  res.status(status).json({ erro: mensagem });
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  Clínica Sorriso Saudável — Backend      ║
║  http://localhost:${PORT}                   ║
║  Ambiente: ${process.env.NODE_ENV || 'development'}                  ║
╚══════════════════════════════════════════╝
  `);
});

module.exports = app;
