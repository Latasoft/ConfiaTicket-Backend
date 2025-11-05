// src/controllers/email.test.controller.ts
import { Request, Response } from 'express';
import { sendPurchaseConfirmationEmail } from '../services/email.service';

/**
 * POST /api/test/email
 * Endpoint de prueba para verificar configuración SMTP
 * Solo disponible en modo desarrollo o para superadmin
 */
export async function testEmail(req: Request, res: Response) {
  try {
    // Verificar que sea admin
    const user = (req as any).user;
    const isAdmin = user?.role === 'superadmin';
    const isDev = process.env.NODE_ENV === 'development';

    if (!isAdmin && !isDev) {
      return res.status(403).json({ 
        error: 'Solo disponible para superadmin o en desarrollo' 
      });
    }

    const { to } = req.body as { to?: string };
    const testEmail = to || user?.email || 'test@example.com';

    console.log(`📧 [TEST] Enviando email de prueba a: ${testEmail}`);

    const success = await sendPurchaseConfirmationEmail({
      buyerEmail: testEmail,
      buyerName: 'Usuario de Prueba',
      eventTitle: 'Evento de Prueba - Verificación SMTP',
      eventDate: new Date(),
      eventLocation: 'Ubicación de Prueba',
      quantity: 1,
      totalAmount: 1000,
      reservationCode: 'TEST-' + Date.now(),
      reservationId: 999999,
    });

    if (success) {
      return res.json({
        ok: true,
        message: `Email de prueba enviado exitosamente a ${testEmail}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      return res.status(500).json({
        ok: false,
        error: 'No se pudo enviar el email. Revisa los logs del servidor.',
        hint: 'Verifica las variables SMTP_* en .env',
      });
    }
  } catch (error: any) {
    console.error('❌ [TEST] Error en testEmail:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Error al enviar email de prueba',
      code: error.code,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
}

/**
 * GET /api/test/smtp-config
 * Verifica la configuración SMTP actual (sin exponer credenciales)
 */
export async function getSmtpConfig(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const isAdmin = user?.role === 'superadmin';
    const isDev = process.env.NODE_ENV === 'development';

    if (!isAdmin && !isDev) {
      return res.status(403).json({ 
        error: 'Solo disponible para superadmin o en desarrollo' 
      });
    }

    const config = {
      host: process.env.SMTP_HOST || '(no configurado)',
      port: process.env.SMTP_PORT || '(no configurado)',
      secure: process.env.SMTP_SECURE || 'false',
      user: process.env.SMTP_USER || '(no configurado)',
      // NO exponer la contraseña, solo indicar si existe
      passwordSet: !!process.env.SMTP_PASS,
      mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || '(no configurado)',
      adminEmail: process.env.ADMIN_NOTIFICATION_EMAIL || '(no configurado)',
    };

    const warnings = [];
    if (!process.env.SMTP_HOST) warnings.push('SMTP_HOST no configurado');
    if (!process.env.SMTP_USER) warnings.push('SMTP_USER no configurado');
    if (!process.env.SMTP_PASS) warnings.push('SMTP_PASS no configurado');

    const isConfigured = warnings.length === 0;

    return res.json({
      ok: true,
      configured: isConfigured,
      config,
      warnings,
      recommendations: [
        'Para Gmail: usar puerto 465 con SMTP_SECURE=true',
        'Usar "Contraseña de aplicación" no contraseña normal',
        'Verificar que la IP de Render no esté bloqueada por Gmail',
      ],
    });
  } catch (error: any) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
