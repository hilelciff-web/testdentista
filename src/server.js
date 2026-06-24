require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const authRoutes        = require('./routes/auth');
const agendamentosRoutes = require('./routes/agendamentos');
const adminRoutes        = require('./routes/admin');
const adminAuthRoutes    = require('./routes/adminAuth');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // necessário no Railway para capturar IP real do cliente (rate limit e auditoria)

// ============================================================
// 1. SEGURANÇA DE HEADERS — helmet
// Remove headers que revelam tecnologia, adiciona proteções
// ============================================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
     defaultSrc: ["'self'"],
scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
styleSrc:   ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
fontSrc:    ["'self'", "https://cdn.jsdelivr.net"],
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
  ? ['https://testdentista-production.up.railway.app']
  : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001', 'http://127.0.0.1:3001'];

app.use(cors({
  origin: origens,
  methods: ['GET', 'POST', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ============================================================
// 3. RATE LIMITING — limite de requisições por IP
// ============================================================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { erro: 'Muitas tentativas de login. Aguarde 15 minutos.' },
});
app.use('/api/auth', authLimiter);

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { erro: 'Muitas tentativas de login admin. Aguarde 15 minutos.' },
});
app.use('/api/admin/login', adminLoginLimiter);
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
app.use('/api/admin',      adminAuthRoutes);  // login do admin (rota pública)
app.use('/api/admin',      adminRoutes);      // rotas protegidas (precisam de token)

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
