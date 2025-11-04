// src/middleware/rateLimitMiddleware.ts
import rateLimit from 'express-rate-limit';

/**
 * Rate limiter para el endpoint de validación de QR proxy
 * Previene abuso limitando el número de validaciones por IP
 * 
 * Límites:
 * - 10 solicitudes por minuto por IP
 * - Ventana deslizante de 1 minuto
 */
export const resaleValidationRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10, // Máximo 10 solicitudes por ventana
  message: {
    error: 'Demasiados intentos de validación',
    message: 'Has excedido el límite de validaciones. Por favor, espera un momento antes de intentar nuevamente.',
    retryAfter: 60, // segundos
  },
  standardHeaders: true, // Devuelve info de rate limit en headers `RateLimit-*`
  legacyHeaders: false, // Deshabilita headers `X-RateLimit-*`
  // La librería usa automáticamente req.ip de forma segura (soporta IPv6)
  // Handler personalizado cuando se excede el límite
  handler: (req, res) => {
    console.warn(`Rate limit excedido para IP: ${req.ip || 'unknown'}`);
    res.status(429).json({
      error: 'Demasiados intentos de validación',
      message: 'Has excedido el límite de 10 validaciones por minuto. Por favor, espera un momento antes de intentar nuevamente.',
      retryAfter: 60,
    });
  },
  // Skipear rate limit para superadmins si están autenticados
  skip: (req) => {
    const user = (req as any).user;
    return user?.role === 'superadmin';
  },
});

/**
 * Rate limiter más estricto para endpoints de estadísticas
 * Previene scraping masivo de datos
 * 
 * Límites:
 * - 30 solicitudes por minuto por IP
 */
export const statsRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 30, // Máximo 30 solicitudes por ventana
  message: {
    error: 'Demasiadas solicitudes',
    message: 'Has excedido el límite de solicitudes. Por favor, espera un momento.',
    retryAfter: 60,
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`Rate limit de stats excedido para IP: ${req.ip || 'unknown'}`);
    res.status(429).json({
      error: 'Demasiadas solicitudes',
      message: 'Has excedido el límite de solicitudes. Por favor, espera un momento.',
      retryAfter: 60,
    });
  },
});

/**
 * Rate limiter general para APIs públicas
 * Protección básica contra abuso
 * 
 * Límites:
 * - 100 solicitudes por minuto por IP
 */
export const generalApiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 100, // Máximo 100 solicitudes por ventana
  message: {
    error: 'Demasiadas solicitudes',
    message: 'Has excedido el límite de solicitudes a la API.',
    retryAfter: 60,
  },
  standardHeaders: true,
  legacyHeaders: false,
});
