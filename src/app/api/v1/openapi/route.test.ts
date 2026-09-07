import { describe, it, expect } from 'vitest';
import { GET } from './route';

/**
 * Este documento es lo que convierte "tenemos una API" en un SDK generado. Si
 * se rompe, el integrador lo descubre cuando su generador truena — y eso pasa
 * en la llamada de demo, no antes. Por eso se prueba que SERIALICE y que sus
 * referencias RESUELVAN, no solo que el archivo compile.
 */
async function doc(): Promise<Record<string, unknown>> {
  const r = await GET(new Request('https://app.likida.ai/api/v1/openapi'));
  expect(r.status).toBe(200);
  return await r.json();
}

describe('el contrato de la API serializa y resuelve', () => {
  it('es OpenAPI 3.1 y sale como JSON válido', async () => {
    const d = await doc();
    expect(String(d.openapi)).toMatch(/^3\.1/);
    expect(d.info).toBeDefined();
  });

  it('TODOS los $ref apuntan a un esquema que existe', async () => {
    // Un `$ref` colgando es el modo de falla clásico: el documento se ve bien,
    // el generador falla al resolverlo, y nadie se entera hasta que alguien lo
    // usa de verdad.
    const d = await doc();
    const esquemas = new Set(Object.keys(((d.components as Record<string, unknown>).schemas ?? {}) as object));
    const refs: string[] = [];
    JSON.stringify(d, (k, v) => {
      if (k === '$ref' && typeof v === 'string') refs.push(v);
      return v;
    });
    expect(refs.length).toBeGreaterThan(5);
    const colgando = refs
      .map((r) => r.replace('#/components/schemas/', ''))
      .filter((n) => !esquemas.has(n));
    expect(colgando, `estos $ref no tienen esquema: ${colgando.join(', ')}`).toEqual([]);
  });

  it('describe las cinco rutas de datos y a sí mismo', async () => {
    const d = await doc();
    const rutas = Object.keys(d.paths as object);
    for (const r of ['/v1/viajes', '/v1/viajes/{id}', '/v1/viajes/{id}/contribucion', '/v1/unidades', '/v1/clientes']) {
      expect(rutas, `falta ${r}`).toContain(r);
    }
  });
});

describe('las credenciales que declara son las que EXISTEN', () => {
  it('declara la llave por flota, que ya está construida (mig. 0093)', async () => {
    const d = await doc();
    const esquemas = (d.components as Record<string, Record<string, Record<string, unknown>>>).securitySchemes;
    expect(esquemas.llaveDeFlota).toBeDefined();
    expect(esquemas.llaveDeFlota.type).toBe('http');
    expect(esquemas.llaveDeFlota.scheme).toBe('bearer');
  });

  it('la llave va PRIMERO: varios generadores toman el primer esquema como default', async () => {
    const d = await doc();
    const seg = d.security as Array<Record<string, unknown>>;
    expect(Object.keys(seg[0])[0]).toBe('llaveDeFlota');
  });

  it('NINGUNA descripción dice que la llave "no existe" — ya existe', async () => {
    // El documento afirmaba eso cuando era cierto. Dejarlo después de
    // construirla haría que el integrador no la use.
    const texto = JSON.stringify(await doc());
    expect(texto).not.toMatch(/todavía no existe/i);
  });

  it('sigue documentando la cookie, para el propio panel', async () => {
    const d = await doc();
    expect((d.components as Record<string, Record<string, unknown>>).securitySchemes.sesionLikida).toBeDefined();
  });
});

describe('el documento no pide credencial — y es a propósito', () => {
  it('responde 200 sin cookie ni llave', async () => {
    // Hay un huevo-y-gallina real: no se puede generar el cliente que sabe
    // autenticarse antes de tener el esquema. Es la excepción deliberada a
    // "fallar cerrado", que aplica a DATOS — y este documento no toca la base.
    const r = await GET(new Request('https://app.likida.ai/api/v1/openapi'));
    expect(r.status).toBe(200);
  });

  it('y no filtra un solo dato de ninguna flota', async () => {
    const texto = JSON.stringify(await doc());
    expect(texto).not.toMatch(/tenant_id|uuid-|@likida\.ai/i);
  });
});

describe('el spec no se queda atrás de las rutas', () => {
  /**
   * EL GUARDIA QUE FALTABA. `POST /v1/viajes` y `POST /v1/unidades` existieron
   * sin una línea en este documento: la API sabía escribir y su contrato decía
   * que era de solo lectura. Ese hueco no rompe nada —por eso duró—, pero un
   * SDK generado de aquí no trae el método, y el integrador concluye que hay
   * que capturar los viajes a mano.
   *
   * Se leen los `route.ts` de verdad y se compara contra el spec. Un `export
   * async function POST` nuevo sin su bloque hace fallar esta prueba.
   */
  it('cada método HTTP exportado por una ruta v1 está documentado', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const d = await doc();
    const paths = d.paths as Record<string, Record<string, unknown>>;

    const raiz = join(process.cwd(), 'src/app/api/v1');
    const faltan: string[] = [];

    const recorrer = (dir: string, ruta: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const e = d.name;
        const p = join(dir, e);
        if (d.isDirectory()) {
          // `openapi` se documenta a sí misma: no es parte del contrato.
          if (e !== 'openapi') recorrer(p, `${ruta}/${e.startsWith('[') ? `{${e.slice(1, -1)}}` : e}`);
          continue;
        }
        if (!d.isFile() || e !== 'route.ts') continue;
        const metodos = [...readFileSync(p, 'utf8').matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)]
          .map((m) => m[1].toLowerCase());
        for (const m of metodos) {
          if (!paths[ruta]?.[m]) faltan.push(`${m.toUpperCase()} ${ruta}`);
        }
      }
    };
    recorrer(raiz, '/v1');

    expect(faltan, `sin documentar en el OpenAPI: ${faltan.join(', ')}`).toEqual([]);
  });

  it('las dos escrituras exigen Idempotency-Key, y lo dicen', async () => {
    // Que sea OBLIGATORIA es la decisión de diseño que el documento tiene que
    // transmitir: sin ella, un timeout —el fallo normal, no el raro— deja al
    // integrador sin saber si el viaje se creó, y el reintento lo duplica.
    const d = await doc();
    const paths = d.paths as Record<string, Record<string, { parameters?: Array<{ name: string; in: string; required?: boolean }> }>>;
    for (const ruta of ['/v1/viajes', '/v1/unidades']) {
      const params = paths[ruta].post.parameters ?? [];
      const llave = params.find((p) => p.in === 'header' && /idempotency/i.test(p.name));
      expect(llave, `${ruta} no declara la cabecera`).toBeDefined();
      expect(llave!.required, `${ruta} la declara opcional`).toBe(true);
    }
  });

  it('las escrituras documentan el 200 de "ya existía", no solo el 201', async () => {
    // El 200 es el que hace segura la reintentabilidad. Un SDK que solo conoce
    // el 201 trata el reintento exitoso como un caso raro y suele lanzarlo
    // como error.
    const d = await doc();
    const paths = d.paths as Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    for (const ruta of ['/v1/viajes', '/v1/unidades']) {
      expect(Object.keys(paths[ruta].post.responses ?? {}), ruta).toEqual(
        expect.arrayContaining(['200', '201']),
      );
    }
  });
});
