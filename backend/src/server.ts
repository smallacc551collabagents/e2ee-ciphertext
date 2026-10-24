import Fastify from 'fastify';

// Logger: never log request bodies (ciphertext envelopes) or auth material.
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

app.get('/healthz', async () => ({ status: 'ok' }));

app.get('/readyz', async (_req, reply) => {
  // TODO(Phase 0): check Postgres connectivity via Prisma before reporting ready.
  return reply.send({ status: 'ready' });
});

// TODO(Phase 0): auth/session middleware (backend/src/middleware).
// TODO(Phase 0): authenticated WebSocket doorbell (backend/src/websocket).

const port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
