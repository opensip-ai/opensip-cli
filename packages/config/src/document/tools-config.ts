import { z } from 'zod';

export const toolsConfigSchema = z
  .object({
    trusted: z.array(z.string().min(1)).optional(),
  })
  .strict();
