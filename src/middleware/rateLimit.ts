import rateLimit from 'express-rate-limit';

// Rate limiter estricto para login (prevenir fuerza bruta)
export const strictAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutos
  max: 5,                     // Solo 5 intentos por IP/ventana
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Por favor, intenta de nuevo en 15 minutos.' },
});

// Rate limiter para registro y otros endpoints de auth
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutos
  max: 10,                    // máx 10 intentos por IP/ventana
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta nuevamente más tarde.' },
});

export const readOnlyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minuto
  max: 100,                   // máx 100 peticiones por IP/ventana
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Intenta nuevamente en un momento.' },
});
