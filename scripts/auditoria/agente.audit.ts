// ═══════════════════════════════════════════════════════════════════════════
// AGENTE AUDITOR — un rubro, un archivo, su modelo.
//
// Construye el prompt EXACTO del skill (references/auditor-prompt.md) con el
// contexto del rubro (MAPA + sección + nota previa + abiertos + síntesis) y
// llama al modelo que le toca por rubro (modelos.audit.ts). Escribe UN solo
// archivo: docs/auditoria-N/<rubro>.md. Nunca toca código.
// ═══════════════════════════════════════════════════════════════════════════

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirRonda, NOTAS_PREVIAS } from './config.audit';
import { contextoAgente, evidenciaBaseline } from './contexto.audit';
import { modeloRubro } from './modelos.audit';
import { llamada, llamadaConTools } from './llamada.audit';
import type { Rubro } from './config.audit';

const NOMBRE_RUBRO: Record<Rubro, string> = {
  frontend: 'Frontend',
  backend: 'Backend y API',
  agentico: 'Sistema agéntico y orquestación',
  'tool-calling': 'Tool calling',
  seguridad: 'Seguridad',
  fiscal: 'Cumplimiento fiscal',
  legal: 'Cumplimiento legal',
  arquitectura: 'Arquitectura y mantenibilidad',
  pruebas: 'Pruebas',
  operabilidad: 'Operabilidad y DX',
  rendimiento: 'Rendimiento y costo',
  datos: 'Modelo de datos y esquema',
};

export interface ResultadoAuditor {
  rubro: Rubro;
  texto: string;
  modelo: string;
  tokIn: number;
  tokOut: number;
  cost: number;
  nota?: number;
  tools?: number;
}

function promptRubro(n: number, r: Rubro): string {
  const ctx = contextoAgente(n, r);
  const previa = ctx.k > 0 ? String(NOTAS_PREVIAS[r]) : '—';
  return `Eres un ${EXPERTOS[r] ?? 'auditor senior'} en Likida. Contexto fresco, mirada adversarial: tu trabajo es encontrar lo que está mal en TU rubro, abriendo los archivos con tus herramientas leer/buscar — nunca citar una línea que no leíste. No confirmas que está bien; buscas el caso que rompe.

Tu especialidad es un sesgo calculado: donde otro diría «esto se ve bien», tú preguntas «¿y si entra esto…?» y lo comprobas contra el código real.

## Producto
Likida liquida viajes de autotransporte federal de carga por WhatsApp para flotas en México. Pre-revenue, sin clientes. El comprador es el contralor de la flota. Un error que el contralor vea en la sala cuesta el trato.

## Línea base REAL de esta ronda (evidencia, no suposición)
${evidenciaBaseline(n) || '(baseline sin correr: las notas no miden suite nueva)'}

## Dónde está todo / qué no tocar
${ctx.mapa || '(sin MAPA previo)'}

TIENES HERRAMIENTAS REALES para leer el repositorio: leer (abre un archivo real con líneas), buscar (regex sobre el código) y listar (explora directorios). ÚSALAS SIEMPRE: cada hallazgo cita el «archivo:línea» que abriste tú; el orquestador lo re-verifica físicamente y uno inválido se descarta. No edites código ni corras npm test: tu trabajo es encontrar y calificar.

## Benchmark — el estándar enterprise
Nuestro estándar de producto: software B2B enterprise que maneja DINERO de clientes con alta exigencia regulatoria — por eso cada rubro se mide contra ese nivel: seguridad de producto financiero, datos con consentimiento y sin fuga, pruebas que atan decisiones, operabilidad que avisa a un humano, esquema que no acepta estados rotos.

Al final del encabezado de tu reporte agrega una línea:
**vs estándar enterprise:** <nota 0-10 que le darías a este rubro contra ese estándar> y en una línea qué le falta a Likida para ese estándar (o en qué lo supera).

## Tu rubro
${ctx.seccion || '(sección del rubro no disponible)'}

## De dónde vienes
Nota previa: ${previa}/10.
${ctx.sintesisPrev ? `Síntesis previa (para el delta):\n${ctx.sintesisPrev.slice(0, 4000)}` : ''}

Hallazgos abiertos que te tocan: ${ctx.abiertos.length > 400 ? ctx.abiertos.slice(0, 400) + '…' : ctx.abiertos}.

Los abiertos se verifican primero: si siguen ahí, se reportan como REINCIDENTE. Si ya se arreglaron, se dice, porque eso justifica subir la nota.

## Qué es un hallazgo
Un hallazgo tiene las cuatro cosas, o no existe:
1. \`archivo:línea\` exacto — abierto y leído por ti, no inferido de un nombre.
2. Escenario de falla concreto: entra X → sale Y mal, con valores. No «podría fallar»; sí «entra este mensaje → sale esta cifra mal».
3. Consecuencia para alguien real: el contralor, el chofer, el SAT, la flota o el equipo que mantiene esto.
4. Severidad: CRÍTICO (dinero mal, dato personal expuesto, o el demo se cae) · ALTO (falla silenciosa o efecto duplicado) · MEDIO (se degrada y se nota) · BAJO (deuda que va a cobrar factura).

Si no puedes escribir el escenario con valores, no lo reportes. Antes de escribir cada hallazgo, intenta refutarlo tú mismo: busca el guardarraíl que ya lo cubre.

## Qué NO hacer
- No propongas el arreglo. Ni el diff, ni el plan. Encuentras y calificas (una línea de causa raíz probable sí está permitida al final de cada hallazgo).
- No reportes estilo, nombres ni formato salvo que cambien el significado.
- No repitas lo que ya está resuelto en la ronda anterior.

## Entregable
Escribe UN archivo, y solo ese: docs/auditoria-${n}/${r}.md. Forma:

# ${NOMBRE_RUBRO[r]} — auditoría ${n}

**Nota: X/10** (antes Y). Razón del movimiento: se atacó y subió · deuda que cobró factura · mirada más profunda (la nota previa estaba inflada).

Una línea con el riesgo mayor del rubro, hoy.

## Hallazgos
### [SEVERIDAD] Título en una línea
\`archivo:línea\`
Escenario: entra X → sale Y mal (con valores).
Consecuencia: quién se afecta y cómo.
Causa probable: una línea. (REINCIDENTE si venía de la ronda anterior.)

## Lo que revisé y está bien
Caminos que abrí y salieron limpios (con \`archivo:línea\`).

## Lo que NO alcancé a revisar
Sin esto la nota es una mentira por omisión.

TU RESPUESTA COMPLETA ES EL ARCHIVO. Va TODO en esta respuesta única: encabezado, nota, hallazgos detallados, lo que revisé y está bien, y lo que no alcancé. No simules herramientas, ni XML de tool_calls, ni etiquetas: texto plano markdown. Máximo ~7,000 tokens de salida; el grueso no se queda en tu razonamiento interno. NO detengas hasta terminar el archivo completo.`;
}

/** Máscara de experto por rubro — "auditor experto" del rubro, no auditor genérico. */
const EXPERTOS: Record<Rubro, string> = {
  frontend: 'experto senior en React 19/Next 16 App Router: estados, accesibilidad, mapas de tipos, rendimiento de render',
  backend: 'arquitecto de APIs y sistemas de dinero: idempotencia, concurrencia, transacciones, manejo de errores del servidor',
  agentico: 'ingeniero de agentes y orquestación de largo aliento: ciclos de vida, confirmaciones, reintentos, estados de turno',
  'tool-calling': 'ingeniero de tool-calling y agentes multi-proveedor: finish_reason, fallback, atribución de costo y efectos',
  seguridad: 'pentester senior: fronteras de confianza, multi-tenant, authn/authz, ZDR, inyección y exfiltración de PII',
  fiscal: 'contador público mexicano con cédula: CFF, LIR, LIVA, LIF, RFA y su aplicación a flotas de autotransporte federal',
  legal: 'abogado de protección de datos (LFPDPPP/LAWS) y cumplimiento: consentimiento, ARCO, transferencias, cuotas de avisos',
  arquitectura: 'arquitecto de software: capas, acoplamiento, deuda estructural, fronteras entre módulos y motores',
  pruebas: 'ingeniero de calidad: cobertura significativa, arneses, flakiness, pruebas que atan decisiones',
  operabilidad: 'SRE: observabilidad, alertas, debuggabilidad, despliegue, cron jobs y recuperación post-fallo',
  rendimiento: 'perf engineer: N+1, índices, latencia, concurrencia, costos por petición y límites medibles',
  datos: 'DBA/arquitecto de datos: esquema, migraciones, constraints, unicidad, consistencia e integridad',
};

export function promptAuditorExpert(n: number, r: Rubro): string {
  return `Eres un ${EXPERTOS[r] ?? 'auditor senior'} en el equipo de Likida. Contexto fresco, mirada adversarial: tu trabajo es encontrar lo que está mal en TU rubro, con evidencia leída del código, no confirmar que está bien.

Tu especialización tiene un sesgo deliberado: ves antes de dónde cae tu rubro (donde otro respondería "se ve bien", tú abres el archivo y buscas el caso que rompe). Úsalo.`;

}

export async function correrUnAuditor(n: number, r: Rubro): Promise<ResultadoAuditor> {
  const modelo = modeloRubro(r);
  const prompt = promptRubro(n, r);
  const conTools = (process.env.AUDIT_TOOLS ?? '1') !== '0';
  const llamar = (o: Parameters<typeof llamada>[0]) => (conTools ? llamadaConTools(o) : llamada(o));
  const pasos = Number(process.env.AUDIT_PASOS ?? '20');
  let out = await llamar({
    modelo,
    quien: `auditor-${r}`,
    mensajes: [{ role: 'user', content: prompt }],
    maxTokens: 24000,
    temperatura: 0.2,
    ...(conTools ? { pasosMax: pasos } : {}),
  });
  // AUDITORÍA PROFUNDA: un rubro sin LECTURA REAL no cuenta. Si el modelo
  // respondió sin abrir ni un archivo, se relanza exigiéndole herramientas.
  if (conTools && (out.tools ?? 0) === 0) {
    process.stderr.write(`[audit] auditor-${r}: NO leyó archivos (0 tools) — relanzando con orden de lectura\n`);
    out = await llamar({
      modelo,
      quien: `auditor-${r}`,
      mensajes: [
        { role: 'user', content: prompt },
        { role: 'user', content: 'REGLA OBLIGATORIA: responde DESPUÉS de abrir al menos 3 archivos con la herramienta leer (o buscar). Abre archivos reales de tu rubro (listar + leer) y cita SOLO archivo:línea que hayas abierto. Si no abres ninguno, tu ronda queda SIN VALOR.' },
      ],
      maxTokens: 24000,
      temperatura: 0.2,
      ...(conTools ? { pasosMax: pasos } : {}),
    });
  }
  // Los modelos chinos de razonamiento a veces devuelven contenido corto o
  // simulan tool-calls. Un reporte vacío NO es un rubro limpio: se reintenta
  // una vez con la advertencia explícita, y se anota en el archivo si falló.
  let intentos = 0;
  while (out.text.trim().length < 300 && intentos < 1) {
    intentos++;
    process.stderr.write(`[audit] auditor-${r}: respuesta corta (${out.text.trim().length} chars) — reintento\n`);
    out = await llamada({
      modelo,
      quien: `auditor-${r}`,
      mensajes: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: out.text },
        { role: 'user', content: 'Tu respuesta anterior quedó vacía o incompleta. Escribe AHORA el reporte COMPLETO en markdown, sin etiquetas ni tool calls.' },
      ],
      maxTokens: 24000,
      temperatura: 0.2,
      ...(conTools ? { pasosMax: 10 } : {}),
    });
  }
  if (out.text.trim().length < 200) {
    out = { ...out, text: out.text + `\n\n**ADVERTENCIA**: respuesta insuficiente tras reintento (${out.text.trim().length} chars). Rubro sin cobertura real.` };
  }
  const texto = out.text;
  mkdirSync(dirRonda(n), { recursive: true });
  writeFileSync(`${dirRonda(n)}/${r}.md`, texto, 'utf8');
  return { rubro: r, texto, modelo: out.modelo, tokIn: out.tokIn, tokOut: out.tokOut, cost: out.cost, nota: extraerNota(texto), tools: out.tools };
}

function extraerNota(texto: string): number | undefined {
  const m = texto.match(/Nota[:：]?\s*\*{0,2}\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  return m ? Number(m[1]) : undefined;
}

export function leerReporte(n: number, r: Rubro): string {
  const p = `${dirRonda(n)}/${r}.md`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}