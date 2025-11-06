// src/services/email.service.ts
import nodemailer from 'nodemailer';
import sgMail from '@sendgrid/mail';
import { env } from '../config/env';

// Determinar si usar SendGrid API o SMTP
const USE_SENDGRID_API = !!process.env.SENDGRID_API_KEY;

// Inicializar SendGrid si está configurado
if (USE_SENDGRID_API) {
  try {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
    console.log('✅ SendGrid API configurado');
  } catch (error) {
    console.error('❌ Error al configurar SendGrid:', error);
    console.error('   Verifica que SENDGRID_API_KEY sea válido');
  }
}

// Crear transporter reutilizable (solo si usamos SMTP)
let transporter: nodemailer.Transporter | null = null;

/**
 * Inicializa el transporter de nodemailer
 * Se llama automáticamente al importar el módulo
 */
function initializeTransporter() {
  // Si usamos SendGrid API, no necesitamos SMTP
  if (USE_SENDGRID_API) {
    console.log('📧 Usando SendGrid API para envío de emails');
    return null;
  }

  // Validar que las variables de entorno estén configuradas
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    console.warn('SMTP no configurado. Los emails no se enviarán.');
    console.warn('Configura SMTP_HOST, SMTP_USER y SMTP_PASS en .env');
    console.warn('O configura SENDGRID_API_KEY para usar SendGrid API');
    return null;
  }

  // ⚡ Configuración optimizada para Gmail en entornos cloud (Render, Heroku, etc.)
  const config: any = {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE, // true para 465, false para 587
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
    // 🔧 Configuraciones críticas para evitar timeouts en cloud
    pool: true, // Usar pool de conexiones para mejor rendimiento
    maxConnections: 5, // Máximo de conexiones simultáneas
    maxMessages: 100, // Mensajes por conexión antes de recrear
    rateDelta: 1000, // Ventana de tiempo para rate limiting (1 seg)
    rateLimit: 5, // Máximo 5 emails por segundo
    
    // ⏱️ Timeouts agresivos para fallar rápido en vez de colgar
    connectionTimeout: 10000, // 10 segundos (por defecto es 2 min)
    greetingTimeout: 5000, // 5 segundos
    socketTimeout: 15000, // 15 segundos
    
    // 🔒 Configuraciones de seguridad para Gmail
    tls: {
      // No fallar en certificados autofirmados (común en cloud)
      rejectUnauthorized: false,
      // Forzar TLS 1.2+
      minVersion: 'TLSv1.2',
    },
    
    // 📝 Debug mode (útil para troubleshooting)
    logger: process.env.NODE_ENV === 'development',
    debug: process.env.NODE_ENV === 'development',
  };

  const transport = nodemailer.createTransport(config);

  // Verificar conexión de forma NO bloqueante (async)
  // No queremos que esto bloquee el inicio del servidor
  setImmediate(() => {
    const verifyTimeout = setTimeout(() => {
      console.warn('⚠️ SMTP verify tomó más de 10 segundos, puede haber problemas de red');
      console.warn('   El servidor continuará funcionando, pero los emails pueden fallar');
    }, 10000);

    transport.verify((error) => {
      clearTimeout(verifyTimeout);
      
      if (error) {
        console.error('❌ Error de conexión SMTP:', error.message);
        console.error('   Verifica tus credenciales y configuración en .env');
        console.error('   Si usas Gmail, asegúrate de:');
        console.error('   1. Usar "Contraseña de aplicación" (no la contraseña normal)');
        console.error('   2. SMTP_HOST=smtp.gmail.com');
        console.error('   3. SMTP_PORT=587 y SMTP_SECURE=false (STARTTLS)');
        console.error('   O bien: SMTP_PORT=465 y SMTP_SECURE=true (SSL/TLS directo)');
      } else {
        console.log('✅ SMTP configurado correctamente');
        console.log(`   Host: ${env.SMTP_HOST}`);
        console.log(`   Port: ${env.SMTP_PORT} (secure: ${env.SMTP_SECURE})`);
        console.log(`   User: ${env.SMTP_USER}`);
        console.log(`   From: ${env.MAIL_FROM || env.SMTP_USER}`);
        console.log(`   Pool: enabled (max ${config.maxConnections} connections)`);
      }
    });
  });

  return transport;
}

// Inicializar al cargar el módulo solo si NO usamos SendGrid
// Esto evita intentar conectar a SMTP cuando ya tenemos SendGrid configurado
if (!USE_SENDGRID_API) {
  transporter = initializeTransporter();
} else {
  console.log('📧 Saltando inicialización de SMTP (usando SendGrid API)');
}

/**
 * Helper para formatear fechas en español
 */
function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date);
}

/**
 * Helper para formatear montos
 */
function formatAmount(amount: number): string {
  return `$${amount.toLocaleString('es-CL')}`;
}

/**
 * Envía un email (wrapper interno) con retry logic
 * Usa SendGrid API si está configurado, sino usa SMTP
 */
async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
  attachments?: any[];
}, retries = 3): Promise<boolean> {
  
  // 🚀 Usar SendGrid API si está configurado
  if (USE_SENDGRID_API) {
    return sendEmailWithSendGrid(options, retries);
  }

  // 📧 Fallback a SMTP
  return sendEmailWithSMTP(options, retries);
}

/**
 * Envía email usando SendGrid API
 */
async function sendEmailWithSendGrid(options: {
  to: string;
  subject: string;
  html: string;
  attachments?: any[];
}, retries = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const msg: any = {
        to: options.to,
        from: {
          email: env.MAIL_FROM || env.SMTP_USER || 'noreply@confiaticket.cl',
          name: 'ConfiaTicket',
        },
        subject: options.subject,
        html: options.html,
      };

      // Agregar attachments si existen
      if (options.attachments && options.attachments.length > 0) {
        msg.attachments = options.attachments.map((att: any) => ({
          content: att.content.toString('base64'),
          filename: att.filename,
          type: att.contentType || 'application/octet-stream',
          disposition: 'attachment',
        }));
      }

      await sgMail.send(msg);
      
      console.log(`✅ Email enviado via SendGrid a ${options.to}: ${options.subject}`);
      return true;
      
    } catch (error: any) {
      const isLastAttempt = attempt === retries;
      
      if (isLastAttempt) {
        console.error(`❌ Error enviando email via SendGrid a ${options.to} (intento ${attempt}/${retries}):`, error.message);
        if (error.response) {
          console.error(`   Status: ${error.response.statusCode}`);
          console.error(`   Body:`, error.response.body);
        }
        return false;
      }
      
      // Esperar antes de reintentar (backoff exponencial)
      const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      console.warn(`⚠️ Reintentando email a ${options.to} en ${delay}ms (intento ${attempt}/${retries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return false;
}

/**
 * Envía email usando SMTP (nodemailer)
 */
async function sendEmailWithSMTP(options: {
  to: string;
  subject: string;
  html: string;
  attachments?: any[];
}, retries = 3): Promise<boolean> {
  if (!transporter) {
    console.warn(`No se pudo enviar email a ${options.to}: SMTP no configurado`);
    return false;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const info = await transporter.sendMail({
        from: env.MAIL_FROM || env.SMTP_USER,
        to: options.to,
        subject: options.subject,
        html: options.html,
        attachments: options.attachments,
      });

      console.log(`✅ Email enviado via SMTP a ${options.to}: ${options.subject}`);
      console.log(`   MessageID: ${info.messageId}`);
      console.log(`   Response: ${info.response}`);
      return true;
      
    } catch (error: any) {
      const isLastAttempt = attempt === retries;
      
      // Errores recuperables (reintentar)
      const isRetriable = 
        error.code === 'ETIMEDOUT' || 
        error.code === 'ECONNRESET' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'ESOCKET' ||
        error.responseCode >= 400;

      if (isLastAttempt || !isRetriable) {
        console.error(`❌ Error enviando email a ${options.to} (intento ${attempt}/${retries}):`, error.message);
        console.error(`   Code: ${error.code || 'N/A'}`);
        console.error(`   Response: ${error.response || 'N/A'}`);
        
        // Logging detallado para troubleshooting
        if (error.code === 'ETIMEDOUT') {
          console.error('   💡 Timeout - Posibles causas:');
          console.error('      - Firewall de Render bloqueando puerto SMTP');
          console.error('      - Configuración incorrecta de puerto/secure');
          console.error('      - Gmail bloqueando la IP de Render');
        } else if (error.code === 'EAUTH') {
          console.error('   💡 Autenticación fallida - Verifica:');
          console.error('      - Usar "Contraseña de aplicación" no contraseña normal');
          console.error('      - SMTP_USER debe ser el email completo');
        }
        
        return false;
      }

      // Esperar antes de reintentar (backoff exponencial)
      const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.warn(`⚠️ Reintento ${attempt}/${retries} para ${options.to} en ${backoffMs}ms...`);
      console.warn(`   Error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  return false;
}

/* =================== TEMPLATES DE EMAILS =================== */

/**
 * Envía email de confirmación de compra al comprador
 */
export async function sendPurchaseConfirmationEmail(data: {
  buyerEmail: string;
  buyerName: string;
  eventTitle: string;
  eventDate: Date;
  eventLocation: string;
  quantity: number;
  totalAmount: number;
  reservationCode: string;
  reservationId: number;
}): Promise<boolean> {
  const {
    buyerEmail,
    buyerName,
    eventTitle,
    eventDate,
    eventLocation,
    quantity,
    totalAmount,
    reservationCode,
    reservationId,
  } = data;

  const formattedDate = formatDate(eventDate);
  const formattedAmount = formatAmount(totalAmount);
  const ticketsUrl = `${env.FRONTEND_URL}/mis-entradas`;

  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          margin: 0;
          padding: 0;
          background-color: #f3f4f6;
        }
        .container {
          max-width: 600px;
          margin: 20px auto;
          background: white;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .header {
          background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
          color: white;
          padding: 40px 30px;
          text-align: center;
        }
        .header h1 {
          margin: 0;
          font-size: 28px;
          font-weight: 700;
        }
        .header .emoji {
          font-size: 48px;
          margin-bottom: 10px;
        }
        .content {
          padding: 40px 30px;
        }
        .greeting {
          font-size: 16px;
          margin-bottom: 20px;
        }
        .ticket-info {
          background: #f9fafb;
          border-left: 4px solid #2563eb;
          padding: 20px;
          margin: 25px 0;
          border-radius: 8px;
        }
        .ticket-info h2 {
          margin: 0 0 15px 0;
          color: #1f2937;
          font-size: 20px;
        }
        .info-row {
          display: flex;
          justify-content: space-between;
          margin: 10px 0;
          padding: 8px 0;
          border-bottom: 1px solid #e5e7eb;
        }
        .info-row:last-child {
          border-bottom: none;
        }
        .info-label {
          font-weight: 600;
          color: #6b7280;
        }
        .info-value {
          font-weight: 500;
          color: #111827;
        }
        .code {
          background: #fef3c7;
          padding: 8px 12px;
          border-radius: 6px;
          font-family: 'Courier New', monospace;
          font-weight: 700;
          color: #92400e;
          letter-spacing: 1px;
        }
        .button {
          display: inline-block;
          background: #2563eb;
          color: white !important;
          padding: 14px 28px;
          text-decoration: none;
          border-radius: 8px;
          font-weight: 600;
          margin: 20px 0;
          text-align: center;
          transition: background 0.3s;
        }
        .button:hover {
          background: #1d4ed8;
        }
        .alert {
          background: #fef2f2;
          border-left: 4px solid #ef4444;
          padding: 15px;
          margin: 25px 0;
          border-radius: 8px;
        }
        .alert strong {
          color: #991b1b;
        }
        .footer {
          text-align: center;
          padding: 30px;
          background: #f9fafb;
          color: #6b7280;
          font-size: 13px;
          border-top: 1px solid #e5e7eb;
        }
        .footer-logo {
          font-size: 18px;
          font-weight: 700;
          color: #2563eb;
          margin-bottom: 10px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <!-- Header -->
        <div class="header">
          <div class="emoji">🎉</div>
          <h1>¡Compra Confirmada!</h1>
        </div>

        <!-- Content -->
        <div class="content">
          <p class="greeting">
            Hola <strong>${buyerName}</strong>,
          </p>
          <p>
            Tu compra se ha procesado exitosamente. ¡Nos vemos en el evento! 
            A continuación encontrarás todos los detalles de tu reserva.
          </p>

          <!-- Ticket Info -->
          <div class="ticket-info">
            <h2>📅 ${eventTitle}</h2>
            <div class="info-row">
              <span class="info-label">Fecha y hora:</span>
              <span class="info-value">${formattedDate}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Lugar:</span>
              <span class="info-value">${eventLocation}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Cantidad de tickets:</span>
              <span class="info-value">${quantity} ${quantity === 1 ? 'entrada' : 'entradas'}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Total pagado:</span>
              <span class="info-value" style="font-size: 18px; color: #059669;">${formattedAmount}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Código de reserva:</span>
              <span class="code">${reservationCode}</span>
            </div>
          </div>

          <!-- CTA Button -->
          <div style="text-align: center;">
            <a href="${ticketsUrl}" class="button">
              📥 Ver Mis Tickets
            </a>
          </div>

          <!-- Important Notice -->
          <div class="alert">
            <strong>⚠️ Importante:</strong> 
            <ul style="margin: 10px 0; padding-left: 20px;">
              <li>Descarga tus tickets desde "Mis Tickets" en tu cuenta</li>
              <li>Cada ticket tiene un código QR único</li>
              <li>Presenta el QR en la entrada del evento</li>
              <li>Llega con anticipación para evitar filas</li>
            </ul>
          </div>

          <p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
            Si tienes alguna pregunta o problema, no dudes en contactarnos.
          </p>
        </div>

        <!-- Footer -->
        <div class="footer">
          <div class="footer-logo">ConfiaTicket</div>
          <p>Tu plataforma de confianza para eventos</p>
          <p style="margin-top: 15px; font-size: 12px;">
            Este es un correo automático, por favor no responder.<br>
            Para soporte, visita nuestro sitio web.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to: buyerEmail,
    subject: `✅ Confirmación de compra - ${eventTitle}`,
    html,
  });
}

/**
 * Envía notificación al admin sobre nueva compra
 */
export async function sendPurchaseNotificationToAdmin(data: {
  buyerName: string;
  buyerEmail: string;
  eventTitle: string;
  quantity: number;
  totalAmount: number;
  reservationId: number;
}): Promise<boolean> {
  const { buyerName, buyerEmail, eventTitle, quantity, totalAmount, reservationId } = data;

  // Email del admin desde env o por defecto
  const adminEmail = env.ADMIN_NOTIFICATION_EMAIL || env.SMTP_USER;
  
  if (!adminEmail) {
    console.warn('No se pudo enviar notificación: ADMIN_NOTIFICATION_EMAIL no configurado');
    return false;
  }

  const formattedAmount = formatAmount(totalAmount);
  // Link al panel de compras del admin con filtro por ID de reserva
  const purchasesUrl = `${env.FRONTEND_URL}/admin/compras?q=${reservationId}`;

  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          line-height: 1.6;
          color: #333;
          margin: 0;
          padding: 0;
          background-color: #f3f4f6;
        }
        .container {
          max-width: 600px;
          margin: 20px auto;
          background: white;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .header {
          background: linear-gradient(135deg, #059669 0%, #047857 100%);
          color: white;
          padding: 30px;
          text-align: center;
        }
        .header h1 {
          margin: 0;
          font-size: 24px;
        }
        .content {
          padding: 30px;
        }
        .info-box {
          background: #f0fdf4;
          border-left: 4px solid #059669;
          padding: 20px;
          margin: 20px 0;
          border-radius: 8px;
        }
        .info-row {
          margin: 10px 0;
        }
        .label {
          font-weight: 600;
          color: #065f46;
        }
        .value {
          color: #111827;
        }
        .button {
          display: inline-block;
          background: #059669;
          color: white !important;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 8px;
          font-weight: 600;
          margin: 20px 0;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>💰 Nueva Compra Registrada</h1>
        </div>
        <div class="content">
          <p>Se ha registrado una nueva compra en el sistema:</p>
          
          <div class="info-box">
            <div class="info-row">
              <span class="label">Evento:</span>
              <div class="value" style="font-size: 18px; font-weight: 600;">${eventTitle}</div>
            </div>
            <div class="info-row">
              <span class="label">Comprador:</span>
              <div class="value">${buyerName} (${buyerEmail})</div>
            </div>
            <div class="info-row">
              <span class="label">Cantidad:</span>
              <div class="value">${quantity} ticket(s)</div>
            </div>
            <div class="info-row">
              <span class="label">Monto total:</span>
              <div class="value" style="font-size: 20px; font-weight: 700; color: #059669;">${formattedAmount}</div>
            </div>
            <div class="info-row">
              <span class="label">ID Reserva:</span>
              <div class="value">#${reservationId}</div>
            </div>
          </div>

          <div style="text-align: center;">
            <a href="${purchasesUrl}" class="button">
              Ver Compra en el Panel
            </a>
          </div>

          <p style="margin-top: 30px; font-size: 14px; color: #6b7280;">
            Puedes revisar todos los detalles de esta compra en el panel de administracion.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to: adminEmail,
    subject: `💰 Nueva compra - ${eventTitle}`,
    html,
  });
}

/**
 * Envía confirmación de reclamo creado al comprador
 */
export async function sendClaimCreatedEmail(data: {
  buyerEmail: string;
  buyerName: string;
  claimId: number;
  eventTitle: string;
  reason: string;
}): Promise<boolean> {
  const { buyerEmail, buyerName, claimId, eventTitle, reason } = data;

  const reasonText: Record<string, string> = {
    TICKET_NOT_RECEIVED: 'No recibí el ticket',
    TICKET_INVALID: 'El ticket es inválido o falso',
    TICKET_DUPLICATED: 'El ticket ya fue usado/vendido',
    EVENT_CANCELLED: 'El evento fue cancelado',
    EVENT_CHANGED: 'El evento cambió de fecha/lugar',
    WRONG_SEATS: 'Los asientos no corresponden',
    POOR_QUALITY: 'Mala calidad del ticket',
    OVERCHARGED: 'Me cobraron de más',
    OTHER: 'Otro motivo',
  };

  const claimUrl = `${env.FRONTEND_URL}/mis-reclamos/${claimId}`;

  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          line-height: 1.6;
          color: #333;
          background-color: #f3f4f6;
        }
        .container {
          max-width: 600px;
          margin: 20px auto;
          background: white;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .header {
          background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
          color: white;
          padding: 30px;
          text-align: center;
        }
        .content {
          padding: 30px;
        }
        .info-box {
          background: #fef2f2;
          border-left: 4px solid #dc2626;
          padding: 20px;
          margin: 20px 0;
          border-radius: 8px;
        }
        .button {
          display: inline-block;
          background: #dc2626;
          color: white !important;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 8px;
          font-weight: 600;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📢 Reclamo Registrado</h1>
        </div>
        <div class="content">
          <p>Hola <strong>${buyerName}</strong>,</p>
          <p>
            Hemos recibido tu reclamo y nuestro equipo lo está revisando. 
            Te responderemos lo antes posible.
          </p>
          
          <div class="info-box">
            <p><strong>Evento:</strong> ${eventTitle}</p>
            <p><strong>Motivo:</strong> ${reasonText[reason] || reason}</p>
            <p><strong>ID del reclamo:</strong> #${claimId}</p>
            <p><strong>Tiempo estimado de respuesta:</strong> 24-48 horas</p>
          </div>

          <p>
            Puedes seguir el estado de tu reclamo y agregar información adicional desde tu panel:
          </p>

          <div style="text-align: center;">
            <a href="${claimUrl}" class="button">
              Ver Mi Reclamo
            </a>
          </div>

          <p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
            <strong>Nota:</strong> Recibirás un correo cuando haya actualizaciones en tu reclamo.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to: buyerEmail,
    subject: `📢 Reclamo registrado #${claimId} - ${eventTitle}`,
    html,
  });
}

/**
 * Envía notificación de actualización de estado de reclamo
 */
export async function sendClaimStatusUpdateEmail(data: {
  buyerEmail: string;
  buyerName: string;
  claimId: number;
  eventTitle: string;
  newStatus: string;
  adminResponse?: string;
}): Promise<boolean> {
  const { buyerEmail, buyerName, claimId, eventTitle, newStatus, adminResponse } = data;

  const statusText: Record<string, { text: string; color: string }> = {
    IN_REVIEW: { text: 'En revisión', color: '#2563eb' },
    WAITING_INFO: { text: 'Esperando información adicional', color: '#f59e0b' },
    RESOLVED: { text: 'Resuelto', color: '#059669' },
    REJECTED: { text: 'Rechazado', color: '#dc2626' },
  };

  const status = statusText[newStatus] || { text: newStatus, color: '#6b7280' };
  const claimUrl = `${env.FRONTEND_URL}/mis-reclamos/${claimId}`;

  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: sans-serif; line-height: 1.6; color: #333; background: #f3f4f6; }
        .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .header { background: ${status.color}; color: white; padding: 30px; text-align: center; }
        .content { padding: 30px; }
        .status-badge { display: inline-block; background: ${status.color}; color: white; padding: 8px 16px; border-radius: 20px; font-weight: 600; }
        .response-box { background: #f9fafb; border-left: 4px solid ${status.color}; padding: 20px; margin: 20px 0; border-radius: 8px; }
        .button { display: inline-block; background: ${status.color}; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🔔 Actualización de Reclamo</h1>
        </div>
        <div class="content">
          <p>Hola <strong>${buyerName}</strong>,</p>
          <p>
            Hay una actualización en tu reclamo <strong>#${claimId}</strong> 
            sobre el evento <strong>${eventTitle}</strong>.
          </p>
          
          <p style="margin: 20px 0;">
            <strong>Nuevo estado:</strong> 
            <span class="status-badge">${status.text}</span>
          </p>

          ${adminResponse ? `
            <div class="response-box">
              <strong>Respuesta del equipo:</strong>
              <p style="margin: 10px 0 0 0;">${adminResponse}</p>
            </div>
          ` : ''}

          <div style="text-align: center; margin: 30px 0;">
            <a href="${claimUrl}" class="button">
              Ver Reclamo Completo
            </a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to: buyerEmail,
    subject: `🔔 Actualización de reclamo #${claimId} - ${status.text}`,
    html,
  });
}

export default {
  sendPurchaseConfirmationEmail,
  sendPurchaseNotificationToAdmin,
  sendClaimCreatedEmail,
  sendClaimStatusUpdateEmail,
};
