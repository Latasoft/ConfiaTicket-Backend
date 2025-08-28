// Augmentación de tipos para Express

// 1) Define el payload que vas a colgar en req.user
declare global {
  namespace Express {
    interface UserPayload {
      id: number;
      role: 'superadmin' | 'organizer' | 'buyer';
    }
  }
}

// 2) Extiende la Request *del módulo real* que usa Express
declare module 'express-serve-static-core' {
  interface Request {
    user?: Express.UserPayload;

    // Si usas uploads, estos son opcionales
    file?: {
      path: string;
      originalname: string;
      mimetype: string;
      filename?: string;
      size?: number;
    };
    files?: Array<{
      path: string;
      originalname: string;
      mimetype: string;
      filename?: string;
      size?: number;
    }>;
  }
}

export {};




