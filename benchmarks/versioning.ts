import { Pylon, type TransformPair } from '@ossl/pylon-core';
import { pylonHono } from '@ossl/pylon-hono';
import { pylonNext } from '@ossl/pylon-next';
import { Hono } from 'hono';
import { z } from 'zod';
import { runBenchmark } from '../packages/cli/src/actions/bench.js';

const iterations = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? 1000);
const versions = ['v1', 'v2', 'v3', 'v4'];
const requestSchema = z.object({ name: z.string(), value: z.number(), blob: z.string() });
const responseSchema = requestSchema.extend({ id: z.number() });
type Body = z.infer<typeof requestSchema>;
const results = [];

for (const bytes of [1024, 16384, 65536]) {
  const input = JSON.stringify({ name: 'Ada', value: 0, blob: 'x'.repeat(bytes) });
  for (const async of [false, true]) {
    for (const hops of [0, 1, 3]) {
      const source = versions[3 - hops]!;
      for (const adapter of ['core', 'hono', 'next', 'plain-hono']) {
        if (adapter === 'plain-hono' && (async || hops)) continue;
        const transforms: Record<string, TransformPair> = {};
        for (let i = 0; i < 3; i++) {
          const upgrade = (body: Body) => ({ ...body, value: body.value + 1 });
          const downgrade = (body: Body & { id: number }) => ({ ...body, value: body.value - 1 });
          transforms[`${versions[i]}->${versions[i + 1]}`] = {
            request: async ? (body: Body) => Promise.resolve(upgrade(body)) : upgrade,
            response: async
              ? (body: Body & { id: number }) => Promise.resolve(downgrade(body))
              : downgrade,
          };
        }
        const start = performance.now();
        const pylon = new Pylon({
          current: 'v4',
          versions,
          endpoints: {
            users: {
              method: 'POST',
              path: '/users',
              transforms,
              contracts: Object.fromEntries(
                versions.map((version) => [
                  version,
                  { request: requestSchema, response: responseSchema },
                ]),
              ),
            },
          },
        });
        const startupMs = performance.now() - start;
        let operation: () => Promise<unknown>;
        if (adapter === 'core') {
          operation = async () => {
            const scoped = pylon.forRoute('POST', '/users');
            const req = await scoped.processRequest(
              { 'api-version': source },
              '/users',
              {},
              JSON.parse(input),
            );
            if (req.transformResult.status === 'error') throw new Error(JSON.stringify(req.body));
            const res = await scoped.processResponse(
              req.version,
              { ...(req.body as Body), id: 1 },
              req.headers,
              [],
            );
            if (res.status) throw new Error(JSON.stringify(res.body));
            return JSON.stringify(res.body);
          };
        } else {
          let send: (request: Request) => Response | Promise<Response>;
          if (adapter === 'next') {
            send = pylonNext(pylon)(async (request: Request) =>
              Response.json({ ...(await request.json()), id: 1 }),
            );
          } else {
            const app = new Hono();
            if (adapter === 'hono') app.use('*', pylonHono(pylon));
            app.post('/users', async (c) => c.json({ ...(await c.req.json()), id: 1 }));
            send = (request) => app.fetch(request);
          }
          operation = async () => {
            const res = await send(
              new Request('http://localhost/users', {
                method: 'POST',
                headers: { 'api-version': source, 'content-type': 'application/json' },
                body: input,
              }),
            );
            if (res.status !== 200) throw new Error(await res.text());
            return res.text();
          };
        }
        const timings = await runBenchmark(operation, iterations);
        const wire = JSON.parse((await operation()) as string);
        if (wire.value !== 0 || wire.id !== 1 || wire.blob.length !== bytes)
          throw new Error('Invalid benchmark output');
        results.push({
          adapter,
          inputBytes: Buffer.byteLength(input),
          hops,
          async,
          startupMs: adapter === 'plain-hono' ? 0 : startupMs,
          ...timings,
        });
      }
    }
  }
}
if (process.argv.includes('--json'))
  console.log(JSON.stringify({ runtime: process.versions, results }, null, 2));
else {
  console.log('Adapter\tBytes\tHops\tAsync\tStartup ms\tCold ms\tMedian ms\tp99 ms\tops/sec');
  for (const r of results)
    console.log(
      `${r.adapter}\t${r.inputBytes}\t${r.hops}\t${r.async}\t${r.startupMs.toFixed(3)}\t${r.coldMs.toFixed(3)}\t${r.medianMs.toFixed(3)}\t${r.p99Ms.toFixed(3)}\t${r.opsPerSecond.toFixed(0)}`,
    );
}
