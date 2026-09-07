// ═══════════════════════════════════════════════════════════════════════════
// EL VIGÍA DE PRODUCCIÓN (16-ago-2026) — determinista, $0 de modelo.
//
// Cada 2 horas corre la GUARDIA A0 real (src/lib/admin/guardia.ts, las
// mismas reglas del copiloto) contra la base de PRODUCCIÓN y, si hay
// incidentes NUEVOS con un chofer/cliente/flujo (S1/S2, o fuentes ciegas),
// se lo escribe a Javier por WhatsApp al instante. S3 no interrumpe: lo
// recoge el brief de Jarvis. El dedup vive en .mejora-diaria/vigia-estado.json
// — se notifica el CAMBIO, no el estado (el mismo incidente no taladra cada
// 2 horas). Una base inalcanzable también avisa (una vez por racha): el
// vigía ciego que calla es el fallo que la casa no acepta.
//
// Corre con: npx tsx scripts/mejora-diaria/vigia-produccion.mts (launchd).
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = new URL('../..', import.meta.url).pathname;
const ESTADO = join(REPO, '.mejora-diaria', 'vigia-estado.json');

// tsx no carga .env.local: se inyecta a mano ANTES de importar la guardia.
for (const linea of readFileSync(join(REPO, '.env.local'), 'utf8').split('\n')) {
  const m = linea.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    // sin el comentario de cola y sin comillas envolventes (el formato de
    // .env.local las trae en algunas líneas — un supabaseUrl con comillas
    // dejó al vigía ciego en la primera corrida del 16-ago)
    process.env[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
}

const { clasificacionDeGuardia } = await import('../../src/lib/admin/guardia');

type Estado = { vistos: string[]; baseCaidaDesde: string | null };
// AUDITORÍA CODEQL (js/http-to-file-access): el patrón existsSync→readFileSync
// es un TOCTOU teórico; se lee con EAFP (try/catch ENOENT) en su lugar.
function leerEstado(): Estado {
  try {
    return JSON.parse(readFileSync(ESTADO, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { vistos: [], baseCaidaDesde: null };
    throw e;
  }
}
const previo: Estado = leerEstado();

function whatsapp(texto: string) {
  try {
    execFileSync('bash', [join(REPO, 'scripts/mejora-diaria/wa-notificar.sh'), texto], { stdio: 'inherit' });
  } catch { /* el fallo de WA ya quedó en el log del script; el vigía no muere por eso */ }
}

let clasificacion;
try {
  clasificacion = await clasificacionDeGuardia(Date.now());
} catch (e) {
  // Base inalcanzable: avisar UNA vez por racha, no cada 2 horas.
  if (!previo.baseCaidaDesde) {
    whatsapp(`🔴 VIGÍA: no puedo leer la base de producción (${e instanceof Error ? e.message.slice(0, 120) : 'error'}). Estoy ciego hasta que vuelva — reviso cada 2h.`);
    writeFileSync(ESTADO, JSON.stringify({ ...previo, baseCaidaDesde: new Date().toISOString() }));
  }
  console.error('[vigia] base inalcanzable:', e);
  process.exit(1);
}

if (previo.baseCaidaDesde) {
  whatsapp('🟢 VIGÍA: la base volvió — vuelvo a ver producción.');
}

// La clave de dedup: qué incidente ES (no cuándo se miró).
const clave = (i: { fuente: string; titulo: string; flota: string; desde: string }) =>
  `${i.fuente}|${i.titulo}|${i.flota}|${i.desde}`;

// Las cegueras van SIEMPRE al log con su error crudo — un vigía que no dice
// POR QUÉ no ve, no se puede arreglar.
for (const f of clasificacion.fuentesCiegas) {
  console.error(`[vigia] fuente ciega: ${f.fuente} → ${(f.error ?? 'sin detalle').slice(0, 160)}`);
}

const urgentes = clasificacion.items.filter((i) => i.severidad === 'S1' || i.severidad === 'S2');
const nuevos = urgentes.filter((i) => !previo.vistos.includes(clave(i)));
const ciegasNuevas = clasificacion.fuentesCiegas.filter(
  (f) => !previo.vistos.includes(`ciega|${f.fuente}`),
);

if (nuevos.length || ciegasNuevas.length) {
  const lineas = [
    `🚨 VIGÍA DE PRODUCCIÓN — ${nuevos.length} incidente(s) nuevo(s):`,
    ...nuevos.map((i) => `${i.severidad === 'S1' ? '🔴' : '🟠'} [${i.severidad}] ${i.titulo} — ${i.flota} (${i.fuente}, regla: ${i.regla})${i.vence ? ` · vence ${i.vence}` : ''}`),
    ...ciegasNuevas.map((f) => `🟠 [S2] Fuente CIEGA: ${f.fuente}${f.error ? ` — ${f.error.slice(0, 80)}` : ''}`),
    'Resuélvelo en app.likida.ai/admin',
  ];
  whatsapp(lineas.join('\n').slice(0, 3900));
  console.log(`[vigia] notificados ${nuevos.length} incidentes + ${ciegasNuevas.length} fuentes ciegas.`);
} else {
  console.log(`[vigia] sin incidentes nuevos (S1/S2 activos: ${urgentes.length}, ya avisados).`);
}

// El estado nuevo: TODO lo activo queda como visto; lo resuelto sale solo
// (si reaparece, es incidente nuevo y se vuelve a avisar).
writeFileSync(ESTADO, JSON.stringify({
  vistos: [...urgentes.map(clave), ...clasificacion.fuentesCiegas.map((f) => `ciega|${f.fuente}`)],
  baseCaidaDesde: null,
}, null, 2));
