// ═══════════════════════════════════════════════════════════════════════════
// RUTINAS EXPERTAS — el catálogo de la imagen (11 agentes).
//
// Cada rutina = un experto con su checklist (pasos que EXIGE hacer sobre el
// repo con leer/buscar), su modelo (de la mezcla decidida) y la posibilidad
// de APLICAR el cambio con compuerta real (tsc + tests + commit atómico).
// Si el cambio es riesgoso o el gate cae → queda como propuesta PENDIENTE
// en docs/auditoria-N/rutinas.md. Cero cambios a ciegas.
// ═══════════════════════════════════════════════════════════════════════════

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirRonda } from './config.audit';
import { M } from './modelos.audit';
import { llamadaConTools } from './llamada.audit';
import { aplicarCambio } from './aplicar.audit';
import type { Cambio } from './aplicar.audit';

export interface Rutina {
  id: string;
  nombre: string;
  queHace: string;
  modelo: string;
  /** Checklist: pasos que el agente DEBE ejecutar con sus herramientas. */
  checklist: string[];
}

const RUTINAS: Rutina[] = [
  {
    id: 'crash-fuzzer', nombre: 'Crash fuzzer', queHace: 'Encuentra crashes reales de la app y abre fixes de causa raíz', modelo: M.grok,
    checklist: [
      'Busca exponentes de throw (throw new Error) en src/lib y src/app/api y clasifícalos por alcanzabilidad desde paths con input externo (webhook, API, OCR).',
      'Busca accesos a propiedades sin guard (obj.x, arr[i], JSON.parse, .at()) en caminos de dinero y entrada no autenticada.',
      'Elige UN crash con escenario concreto (entra X → truena Y) y propón el fix de causa raíz con repro.',
    ],
  },
  {
    id: 'ant-shipper', nombre: 'Ant-only shipper', queHace: 'Detecta features internas olvidadas (solo para el demo/equipo) y decide: ship o delete', modelo: M.gemini,
    checklist: [
      'Detecta botones, flags y rutas accesibles solo por cuenta de dueño/team (offline) — src/app/(admin)/ y flags en dashboard.',
      'Para cada una: ¿alguien la usa fuera del repo? Si solo el equipo la conoce y no está en el demo/client-visible, propón borrarla o blindarla.',
    ],
  },
  {
    id: 'logic-simplifier', nombre: 'Logic simplifier', queHace: 'Simplifica lógica de negocio enredada sin cambiar comportamiento', modelo: M.gemini,
    checklist: [
      'Busca bloques con 3+ ifs anidados o condiciones largas (>120 chars) en las rutas del cuadre y liquidación.',
      'Simplifica UNA sin cambiar comportamiento (mismo arbol de decisión) y con test que lo cubra.',
    ],
  },
  {
    id: 'logic-bugfixer', nombre: 'Logic bugfixer', queHace: 'Modela la lógica tramposa para encontrar y arreglar bugs de negocio', modelo: M.proChino,
    checklist: [
      'Elige UN ciclo de dinero (liquidación o facturación) y modelalo: estados, transiciones, idempotencia, duplicados.',
      'Busca puntos donde un efecto doble o una falla intermedia no deja rastro (sin log, sin estado, sin rollback).',
      'Propón arreglo con repro concreto.',
    ],
  },
  {
    id: 'dup-unifier', nombre: 'Dup unifier', queHace: 'Funde implementaciones duplicadas en una', modelo: M.luna,
    checklist: [
      'Busca funciones/const con nombres repetidos o lógica idéntica (mismo cuerpo) en src/lib; propón fusión para UN par.',
    ],
  },
  {
    id: 'dead-code-removal', nombre: 'Dead-code removal', queHace: 'Borra código demostrablemente inalcanzable', modelo: M.flashChino,
    checklist: [
      'Busca exports defu "a /* usado" y componentes no importados (grep de la ruta del archivo).',
      'Solo propón borrar si la búsqueda de imports/uso da 0 (además de su propio test) y tsc sin ese archivo sigue sano.',
    ],
  },
  {
    id: 'useless-pruner', nombre: 'Useless-test pruner', queHace: 'Detecta tests que no pueden fallar (decoración) y los borra o los hace significativos', modelo: M.flashChino,
    checklist: [
      'Busca tests con expect siempre-verdadero, aserciones vacías o víctimas del valor literal (expect(x).toBe(x)).',
      'Propón borrar/arreglar solo donde la aserción no ata nada real.',
    ],
  },
  {
    id: 'shipped-inliner', nombre: 'Shipped-feature inliner', queHace: 'Quita flags de features ya desplegadas al 100%', modelo: M.gemini,
    checklist: [
      'Busca flags/feature-toggle (en env, config o funciones) y comprueba que todos los caminos usan la rama NUEVA.',
      'Si la rama vieja no suma (sin uso, sin futuro), propón inline directo.',
    ],
  },
  {
    id: 'flaky-fixer', nombre: 'Flaky-test fixer', queHace: 'Enraíza y corrige tests que fallan de forma intermitente (CI)', modelo: M.grok,
    checklist: [
      'Busca tiempo (setTimeout, sleep, await en timing), aleatoriedad (Math.random, Date.now no mocked), .only/.skip segun.',
      'Busca tests que comparten estado global sin orden (network).',
    ],
  },
  {
    id: 'abstraction-improver', nombre: 'Abstraction improver', queHace: 'Aplana abstracciones sobre-ingenierizadas', modelo: M.gemini,
    checklist: [
      'Busca capas de abstracción de 1 uso (wrapper que solo llama). Propón inlining solo si no rompe test.',
    ],
  },
  {
    id: 'abstraction-police', nombre: 'Abstraction police', queHace: 'Arregla violaciones de capas (UI import del moto de pagos, etc.)', modelo: M.grok,
    checklist: [
      'Requiere probar que UI (src/app/dashboard, components) NO importa de lib/likida/agentes ni de la capa de pagos directamente; buscará esas importancias.',
    ],
  },
];

export interface ResultadoRutina {
  id: string;
  nombre: string;
  estado: string;
  cambios: number;
  detalle: string;
}

export async function correrRutina(n: number, rt: Rutina): Promise<ResultadoRutina> {
  const checklist = rt.checklist.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const out = await llamadaConTools({
    modelo: rt.modelo,
    quien: `rutina-${rt.id}`,
    maxTokens: 16000,
    temperatura: 0.2,
    pasosMax: 16,
    mensajes: [
      {
        role: 'user',
        content: `Eres "${rt.nombre}" ejecutándose en el repositorio de Likida (Next 16 + Supabase, liquidación de viajes de carga por WhatsApp). Es tu turno: completa TU checklist real contra el código.

## Qué haces
${rt.queHace}.

## Tu checklist (pasos que debes ejecutar con LECTURA REAL con las herramientas leer/buscar/listar)
${checklist}

## Reglas
1. Cada afirmación se sostiene con \`archivo:línea\` que ABRISTE con leer.
2. Al final responde en dos partes, YA SEPARADAS por "===CAMBIOS===":
   - Parte 1 (texto): qué hiciste, qué encontraste (archivo:línea, por qué es un problema real o por qué no hay nada), y qué NO pudiste sostener.
   - Parte 2: arreglo OPIÓNal en JSON array, con cada objeto: {"archivo":"<rel>","desde":N,"hasta":M,"reemplazo":"<texto>","descripcion":"<por qué>"} — máx 2 objetos, SOLO si estás seguro (este repo maneja dinero; el gate dispara tsc+test y hará rollback si rompes).
3. Si nada aplicable existe, responde solo "NADA QUE HACER: <razón con archivo:línea>". Nunca inventes líneas.`,
      },
    ],
  });
  const texto = out.text;
  const hayCambios = texto.includes('===CAMBIOS===');
  const parteCambios = hayCambios ? texto.split('===CAMBIOS===')[1] ?? '' : '';
  const cambiosPropuestos: Cambio[] = [];
  if (hayCambios) {
    try {
      const ini = parteCambios.indexOf('[');
      const fin = parteCambios.lastIndexOf(']');
      if (ini >= 0 && fin > ini) {
        const arr = JSON.parse(parteCambios.slice(ini, fin + 1)) as Array<{
          archivo?: string; desde?: number; hasta?: number; reemplazo?: string; descripcion?: string;
        }>;
        for (const c of arr.slice(0, 4)) {
          if (c.archivo && c.desde && c.reemplazo !== undefined && c.hasta) {
            cambiosPropuestos.push({ id: rt.id, descripcion: c.descripcion ?? 'cambio de rutina', archivo: c.archivo, desde: c.desde, hasta: c.hasta ?? c.desde, reemplazo: c.reemplazo });
          }
        }
      }
    } catch {
      /* JSON inválido: los cambios quedan como propuesta */
    }
  }
  let aplicados = 0;
  const detalles: string[] = [];
  for (const cambio of cambiosPropuestos) {
    const res = await aplicarCambio(n, cambio);
    detalles.push(`- [${res.estado}] ${cambio.archivo}:${cambio.desde}-${cambio.hasta} — ${cambio.descripcion.slice(0, 70)} — ${res.detalle.slice(0, 160)}`);
    if (res.estado === 'APLICADO') aplicados++;
  }
  const estado = cambiosPropuestos.length === 0 ? 'REVISADO (sin cambios aplicables)' : `${aplicados}/${cambiosPropuestos.length} cambios aplicados`;
  const detalle = [aplicados ? estado : estado, ...detalles, hayCambios ? '' : `Conclusión: ${texto.slice(0, 600)}`].join('\n');
  return { id: rt.id, nombre: rt.nombre, estado, cambios: cambiosPropuestos.length, detalle };
}

export async function correrRutinas(n: number): Promise<ResultadoRutina[]> {
  const resultados: ResultadoRutina[] = [];
  for (const rt of RUTINAS) {
    process.stderr.write(`[audit] ⚙️ rutina ${rt.nombre} (${rt.modelo})…\n`);
    try {
      resultados.push(await correrRutina(n, rt));
    } catch (e) {
      resultados.push({ id: rt.id, nombre: rt.nombre, estado: 'ERROR', cambios: 0, detalle: String((e as Error).message).slice(0, 200) });
    }
  }
  const md = [
    `# Rutinas expertas — auditoría ${n}`,
    '',
    ...resultados.map((r) => `## ${r.nombre} (${r.id}) — ${r.estado}\n${r.detalle}`),
  ].join('\n');
  const dir = dirRonda(n);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/rutinas.md`, md, 'utf8');
  return resultados;
}