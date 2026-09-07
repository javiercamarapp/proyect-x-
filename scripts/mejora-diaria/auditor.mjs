#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// EL AUDITOR BARATO de la mejora diaria (16-ago-2026).
//
// Mitad 1 del pipeline: un modelo barato (espeja el rol `codigo` de
// src/lib/llm/models.ts — gpt-oss-120b) LEE un área del repo y caza errores,
// fallos, huecos y bugs. SOLO produce hallazgos: el arreglo es de la mitad 2
// (correr.sh → Claude Code por suscripción), nunca de este script.
//
// Diseño:
//  · Un área por día de la semana — contexto acotado, cobertura completa a la
//    semana. Override con MEJORA_AREA=<ruta> para probar barato.
//  · El registro (.mejora-diaria/registro.jsonl, gitignored) evita reabrir lo
//    ya visto: un hallazgo descartado ayer no vuelve a proponerse hoy.
//  · ZDR igual que el gateway del app: data_collection 'deny' en la llamada.
//  · Fallar cerrado y decirlo: sin API key, sin red o sin JSON parseable el
//    script sale con código ≠ 0 y un motivo — jamás "0 hallazgos" fingido.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const RAIZ = new URL('../..', import.meta.url).pathname;
const CARPETA = join(RAIZ, '.mejora-diaria');
mkdirSync(join(CARPETA, 'logs'), { recursive: true });

// La key se lee de .env.local (no viaja por el entorno de launchd).
function leerEnvLocal(nombre) {
  if (process.env[nombre]) return process.env[nombre];
  try {
    const linea = readFileSync(join(RAIZ, '.env.local'), 'utf8')
      .split('\n').find((l) => l.startsWith(`${nombre}=`));
    return linea ? linea.slice(nombre.length + 1).trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}
const KEY = leerEnvLocal('OPENROUTER_API_KEY');
if (!KEY) { console.error('SIN OPENROUTER_API_KEY (.env.local) — el auditor no corre a ciegas.'); process.exit(2); }

// Espeja el default del rol `codigo`; override para experimentos.
const MODELO = process.env.MEJORA_MODELO || 'openai/gpt-oss-120b';

// ── El área del día (rotación semanal; domingo = 0) ────────────────────────
const ROTACION = [
  ['src/lib/llm', 'src/lib/agents'],                 // dom — el ruteo de modelos
  ['src/lib/likida'],                                // lun — el core del negocio
  ['src/app/api'],                                   // mar — la superficie HTTP
  ['src/lib/admin'],                                 // mié — las consultas de dirección
  ['src/app/dashboard'],                             // jue — el panel del cliente
  ['src/app/admin'],                                 // vie — el panel superadmin
  ['supabase/migrations', 'src/lib'],                // sáb — contrato de base + misc
];
const areas = process.env.MEJORA_AREA ? [process.env.MEJORA_AREA] : ROTACION[new Date().getDay()];

// ── Juntar el código (sin tests ni previews; con techo de tamaño) ──────────
const TECHO_ARCHIVO = 24_000;   // chars por archivo
const TECHO_TOTAL = 320_000;    // chars total — dentro del contexto del modelo
function archivosDe(dir) {
  const abs = join(RAIZ, dir);
  if (!existsSync(abs)) return [];
  const salida = [];
  const cola = [abs];
  while (cola.length) {
    const d = cola.pop();
    for (const n of readdirSync(d)) {
      const ruta = join(d, n);
      if (statSync(ruta).isDirectory()) {
        if (!/node_modules|zzz-preview|\.next/.test(n)) cola.push(ruta);
      } else if (/\.(ts|tsx|sql|mjs)$/.test(n) && !/\.test\./.test(n)) {
        salida.push(ruta);
      }
    }
  }
  return salida.sort();
}
let contexto = '';
let recortados = 0;
for (const area of areas) {
  for (const ruta of archivosDe(area)) {
    if (contexto.length >= TECHO_TOTAL) { recortados++; continue; }
    let cuerpo = readFileSync(ruta, 'utf8');
    if (cuerpo.length > TECHO_ARCHIVO) { cuerpo = cuerpo.slice(0, TECHO_ARCHIVO) + '\n… [recortado]'; }
    contexto += `\n═══ ${relative(RAIZ, ruta)} ═══\n${cuerpo}`;
  }
}
if (!contexto) { console.error(`Área vacía: ${areas.join(', ')}`); process.exit(2); }
if (recortados) console.log(`(techo de contexto: ${recortados} archivos del área quedaron fuera hoy)`);

// ── Lo ya visto (cualquier estado: pendiente, pr_abierto, descartado…) ─────
const RUTA_REGISTRO = join(CARPETA, 'registro.jsonl');
const vistos = new Set();
// AUDITORÍA CODEQL (js/http-to-file-access): EAFP en vez de existsSync→read,
// que es un TOCTOU teórico contra el mismo archivo que appendFileSync escribe.
let registro = '';
try { registro = readFileSync(RUTA_REGISTRO, 'utf8'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
for (const l of registro.split('\n')) {
  if (!l.trim()) continue;
  try { vistos.add(JSON.parse(l).hash); } catch { /* línea rota: se ignora */ }
}
const hashDe = (h) => createHash('sha256').update(`${h.archivo}|${h.titulo}`).digest('hex').slice(0, 12);

// ── La llamada — mismo contrato ZDR que el gateway del app ─────────────────
const SYSTEM = `Eres el auditor de código de Likida (Next.js + Supabase, multi-tenant, dinero fiscal).
SOLO cazas defectos REALES: bugs, fallos, huecos y errores. Lo que más caza en este repo:
- errores de supabase-js POR VALOR sin comprobar (una base caída leída como "no hay datos");
- autorización multi-tenant: consultas sin filtro de tenant o ids de otro tenant aceptados (IDOR);
- rótulos que mienten (dice "del periodo" y no filtra por fecha);
- cifras inventadas o rellenos que parecen medición;
- promesas sin await, carreras, estados que se pierden entre pasos;
- en SQL: constraints ausentes, RLS incompleta, migraciones sin verificación.
PROHIBIDO reportar: estilo, nombres, preferencias, "podría ser más limpio", rendimiento hipotético.
Máximo 5 hallazgos, los más graves. Si el área está sana, un arreglo vacío es la respuesta correcta.
Responde SOLO un JSON: {"hallazgos":[{"archivo":"ruta","linea":N,"titulo":"…","severidad":"critica|alta|media","escenario":"con qué entrada/estado pasa y qué sale mal","evidencia":"el fragmento exacto"}]}`;

const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODELO,
    provider: { data_collection: 'deny' },
    temperature: 0,
    max_tokens: 2500,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `ÁREA DE HOY: ${areas.join(', ')}\n${contexto}` },
    ],
  }),
});
if (!res.ok) { console.error(`OpenRouter contestó ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
const data = await res.json();
const crudo = data.choices?.[0]?.message?.content ?? '';
const match = crudo.match(/\{[\s\S]*\}/);
if (!match) { console.error(`Sin JSON en la respuesta del modelo:\n${crudo.slice(0, 400)}`); process.exit(1); }
let hallazgos;
try { hallazgos = JSON.parse(match[0]).hallazgos ?? []; }
catch (e) { console.error(`JSON roto del modelo: ${e.message}`); process.exit(1); }

// ── Filtrar, registrar como pendientes y escribir el paquete del día ───────
const nuevos = hallazgos
  .filter((h) => h?.archivo && h?.titulo)
  .map((h) => ({ ...h, hash: hashDe(h) }))
  .filter((h) => !vistos.has(h.hash));
for (const h of nuevos) {
  appendFileSync(RUTA_REGISTRO, JSON.stringify({ hash: h.hash, archivo: h.archivo, titulo: h.titulo, estado: 'pendiente', fecha: new Date().toISOString() }) + '\n');
}
writeFileSync(join(CARPETA, 'hoy-hallazgos.json'), JSON.stringify({ area: areas, modelo: MODELO, generado: new Date().toISOString(), hallazgos: nuevos }, null, 2));

const uso = data.usage ? ` (tokens ${data.usage.prompt_tokens}→${data.usage.completion_tokens})` : '';
console.log(`Auditor [${MODELO}] sobre ${areas.join(', ')}: ${hallazgos.length} hallazgos, ${nuevos.length} nuevos${uso}.`);
for (const h of nuevos) console.log(`  · [${h.severidad}] ${h.archivo}:${h.linea ?? '?'} — ${h.titulo}`);
