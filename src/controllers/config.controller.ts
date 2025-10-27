// src/controllers/config.controller.ts
import { Request, Response } from 'express';
import { getAllConfig } from '../services/config.service';

export async function getBusinessRules(_req: Request, res: Response) {
  const config = await getAllConfig();
  res.json(config);
}
