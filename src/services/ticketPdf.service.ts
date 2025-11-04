// src/services/ticketPdf.service.ts
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

interface TicketData {
  eventName: string;
  eventDate: Date;
  eventLocation: string;
  buyerName: string;
  buyerEmail: string;
  seatAssignment?: string;
  sectionName?: string;        // Nombre de la sección
  qrCode: string;
  reservationCode: string;
  ticketNumber?: number;      // Número del ticket (1 de 3, 2 de 3, etc.)
  totalTickets?: number;       // Total de tickets en la reserva
  totalAmount: number;
  eventImage?: string;
}

const UPLOADS_BASE = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(process.cwd(), 'uploads');

const PDF_DIR = path.join(UPLOADS_BASE, 'private', 'tickets', 'generated');

/**
 * Genera un código QR único para el ticket
 */
export async function generateQRCode(): Promise<string> {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Genera un PDF con el ticket para eventos OWN
 * @param ticketData Datos del ticket y evento
 * @returns Ruta del archivo PDF generado
 */
export async function generateTicketPDF(ticketData: TicketData): Promise<string> {
  // Asegurar que el directorio existe
  await fsPromises.mkdir(PDF_DIR, { recursive: true });

  // Nombre del archivo
  const filename = `ticket-${ticketData.qrCode}.pdf`;
  const filepath = path.join(PDF_DIR, filename);

  // Generar imagen del código QR
  const qrImageBuffer = await QRCode.toBuffer(ticketData.qrCode, {
    errorCorrectionLevel: 'H',
    type: 'png',
    width: 180,
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 0, bottom: 40, left: 40, right: 40 },
    });

    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    const pageWidth = doc.page.width;
    const leftMargin = 40;
    const rightMargin = 40;
    const contentWidth = pageWidth - leftMargin - rightMargin;

    // ===================== HEADER CON COLOR DE FONDO =====================
    // Fondo del header (color azul/morado)
    doc
      .rect(0, 0, pageWidth, 120)
      .fillAndStroke('#2563eb', '#2563eb');

    // Nombre del evento en el header
    doc
      .fontSize(22)
      .font('Helvetica-Bold')
      .fillColor('#ffffff')
      .text(ticketData.eventName, leftMargin, 40, {
        width: contentWidth,
        align: 'center',
      });

    doc
      .fontSize(11)
      .font('Helvetica')
      .fillColor('#e0e7ff')
      .text('ENTRADA AL EVENTO', leftMargin, 75, {
        width: contentWidth,
        align: 'center',
      });

    // Resetear color de relleno para el resto del documento
    doc.fillColor('#000000');

    // ===================== CONTENIDO PRINCIPAL =====================
    let currentY = 150;

    // Layout: Datos a la izquierda, QR a la derecha
    const leftColumnX = leftMargin;
    const leftColumnWidth = contentWidth * 0.55;
    const qrColumnX = leftMargin + leftColumnWidth + 20;
    const qrSize = 180;

    // ===== COLUMNA IZQUIERDA: DATOS DEL EVENTO Y COMPRADOR =====
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#1f2937');
    doc.text('Evento:', leftColumnX, currentY);

    doc.fontSize(12).font('Helvetica').fillColor('#374151');
    const eventDateStr = new Date(ticketData.eventDate).toLocaleString('es-CL', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    doc.text(eventDateStr, leftColumnX, currentY + 15, { width: leftColumnWidth });

    currentY += 45;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#1f2937');
    doc.text('Ubicación:', leftColumnX, currentY);

    doc.fontSize(10).font('Helvetica').fillColor('#374151');
    doc.text(ticketData.eventLocation, leftColumnX, currentY + 15, { width: leftColumnWidth });

    currentY += 45;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#1f2937');
    doc.text('Asistente:', leftColumnX, currentY);

    doc.fontSize(10).font('Helvetica').fillColor('#374151');
    doc.text(ticketData.buyerName, leftColumnX, currentY + 15, { width: leftColumnWidth });

    currentY += 35;

    if (ticketData.sectionName) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#1f2937');
      doc.text('Sección:', leftColumnX, currentY);

      doc.fontSize(12).font('Helvetica-Bold').fillColor('#2563eb');
      doc.text(ticketData.sectionName, leftColumnX, currentY + 15, { width: leftColumnWidth });

      currentY += 40;
    }

    if (ticketData.seatAssignment) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#1f2937');
      doc.text('Asiento:', leftColumnX, currentY);

      doc.fontSize(12).font('Helvetica-Bold').fillColor('#2563eb');
      doc.text(ticketData.seatAssignment, leftColumnX, currentY + 15, { width: leftColumnWidth });

      currentY += 40;
    }

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#1f2937');
    doc.text('Precio:', leftColumnX, currentY);

    doc.fontSize(12).font('Helvetica').fillColor('#374151');
    const formattedPrice = new Intl.NumberFormat('es-CL', {
      style: 'currency',
      currency: 'CLP',
      maximumFractionDigits: 0,
    }).format(ticketData.totalAmount);
    doc.text(formattedPrice, leftColumnX, currentY + 15, { width: leftColumnWidth });

    // ===== COLUMNA DERECHA: QR CODE =====
    const qrY = 150;

    // Dibujar QR
    doc.image(qrImageBuffer, qrColumnX, qrY, { width: qrSize, height: qrSize });

    // Texto debajo del QR: código del QR
    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#6b7280')
      .text(ticketData.qrCode, qrColumnX - 10, qrY + qrSize + 10, {
        width: qrSize + 20,
        align: 'center',
      });

    // ===================== DETALLES DE LA RESERVA =====================
    currentY = qrY + qrSize + 50;

    // Línea separadora
    doc
      .strokeColor('#e5e7eb')
      .lineWidth(1)
      .moveTo(leftMargin, currentY)
      .lineTo(pageWidth - rightMargin, currentY)
      .stroke();

    currentY += 20;

    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1f2937');
    doc.text('DETALLES DE LA RESERVA', leftMargin, currentY);

    currentY += 25;

    // Grid de detalles (2 columnas)
    const col1X = leftMargin;
    const col2X = leftMargin + contentWidth / 2;
    const colWidth = contentWidth / 2 - 10;

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#6b7280');
    doc.text('Código de Reserva:', col1X, currentY, { width: colWidth });
    doc.font('Helvetica').fillColor('#374151');
    doc.text(ticketData.reservationCode, col1X, currentY + 12, { width: colWidth });

    doc.font('Helvetica-Bold').fillColor('#6b7280');
    doc.text('Email:', col2X, currentY, { width: colWidth });
    doc.font('Helvetica').fillColor('#374151');
    doc.text(ticketData.buyerEmail, col2X, currentY + 12, { width: colWidth });

    currentY += 35;

    if (ticketData.ticketNumber && ticketData.totalTickets) {
      doc.font('Helvetica-Bold').fillColor('#6b7280');
      doc.text('Número de Ticket:', col1X, currentY, { width: colWidth });
      doc.font('Helvetica').fillColor('#374151');
      doc.text(`${ticketData.ticketNumber} de ${ticketData.totalTickets}`, col1X, currentY + 12, { width: colWidth });

      currentY += 35;
    }

    // ===================== INSTRUCCIONES =====================
    currentY += 10;

    doc
      .strokeColor('#e5e7eb')
      .lineWidth(1)
      .moveTo(leftMargin, currentY)
      .lineTo(pageWidth - rightMargin, currentY)
      .stroke();

    currentY += 20;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#dc2626');
    doc.text('INSTRUCCIONES IMPORTANTES:', leftMargin, currentY);

    currentY += 18;

    doc.fontSize(9).font('Helvetica').fillColor('#374151');
    const instructions = [
      '• Presenta este código QR al ingresar al evento',
    ];

    instructions.forEach((instruction) => {
      doc.text(instruction, leftMargin, currentY, { width: contentWidth });
      currentY += 15;
    });

    // ===================== FOOTER =====================
    // Calcular posición del footer para que quede cerca de las instrucciones
    const footerY = currentY + 20;

    doc
      .strokeColor('#e5e7eb')
      .lineWidth(1)
      .moveTo(leftMargin, footerY)
      .lineTo(pageWidth - rightMargin, footerY)
      .stroke();

    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#9ca3af')
      .text('ConfiaTicket - Sistema de Venta de Entradas', leftMargin, footerY + 10, {
        width: contentWidth,
        align: 'center',
      });

    const generatedDate = new Date().toLocaleString('es-CL', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    doc.text(`Generado el ${generatedDate}`, leftMargin, footerY + 23, {
      width: contentWidth,
      align: 'center',
    });

    // Finalizar documento
    doc.end();

    stream.on('finish', () => {
      resolve(filepath);
    });

    stream.on('error', (error: Error) => {
      reject(error);
    });
  });
}

/**
 * Elimina un archivo PDF generado
 */
export async function deleteTicketPDF(filepath: string): Promise<void> {
  try {
    await fsPromises.unlink(filepath);
  } catch (error) {
    // Ignorar si el archivo no existe
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
