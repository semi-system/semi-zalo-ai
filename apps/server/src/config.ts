import { z } from 'zod';
// Bootstrap only: all user-facing settings live in PostgreSQL.
const schema = z.object({ DATABASE_URL: z.string().min(10) });
export const config = schema.parse(process.env);
