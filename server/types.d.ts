import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    sessionId?: string;
    user?: { id: number; email: string; role: 'admin' | 'analyst' | 'viewer' };
  }
}
