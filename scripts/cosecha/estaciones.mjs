#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// PERMISO CRE → MARCA → UBICACIÓN, para las ~14,351 estaciones del país.
//
// POR QUÉ ESTO Y NO OTRA COSA. Se creyó primero que las fichas de estación de
// `gasolinerasmx.mx` traían el portal de facturación, y NO: traen precios,
// servicios, histórico y mapa. Se comprobó antes de correr 14,000 páginas para
// nada.
//
// Lo que sí traen es mejor: el PERMISO CRE y la COMPAÑÍA. Y el permiso viene
// impreso en el ticket —el de G500 Megasur decía `PL/22384/EXP/ES/2019`—, así
// que esta tabla convierte un dato del ticket en la identidad de la estación:
//
//     permiso CRE del ticket → marca → sistema de facturación que usa
//
// Ése es el eslabón que falta para Pemex, que no tiene portal central: 8,000+
// estaciones en franquicia y cada franquiciatario elige su sistema. Ningún
// competidor publica esta tabla.
//
// Guarda UN consolidado, no 14,351 fichas, y es reanudable por bloques.
//
//   node scripts/cosecha/estaciones.mjs --limite 3000
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const AQUI = dirname(new URL(import.meta.url).pathname);
const LISTA = join(AQUI, 'urls-estaciones.txt');
const OUT = join(AQUI, '../../docs/investigacion/cosecha/consolidado-estaciones.json');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const LIMITE = Number(arg('--limite', '0')) || Infinity;
const PAUSA = Number(arg('--pausa', '300'));

/** EAFP: evita el TOCTOU de existsSync()+readFileSync() sobre el mismo archivo. */
function leerJsonSiExiste(ruta) {
  try { return JSON.parse(readFileSync(ruta, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const st = leerJsonSiExiste(OUT) ?? { estaciones: {}, hechas: [], fallos: 0, sinPermiso: 0 };
const hechas = new Set(st.hechas);

const texto = (h) => h.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

function extraer(html, url) {
  const t = texto(html);
  const campo = (n) => t.match(new RegExp(`${n}\\s+([^]{2,70}?)(?=\\s+(?:Compañia|Ciudad\\/Municipio|Estado|Calle|Codigo Postal|Coordenadas|ID de|Servicios|Histórico|Marca|Precio)|$)`, 'i'))?.[1]?.trim() || null;
  return {
    permisoCre: t.match(/P[LT]\/[\dA-Z]+\/EXP\/[A-Z]{2}\/\d{4}/)?.[0] ?? null,
    compania: campo('Compañia'),
    direccion: campo('Direccion'),
    ciudad: campo('Ciudad\\/Municipio'),
    estado: campo('Estado'),
    cp: t.match(/Codigo Postal\s+(\d{5})/i)?.[1] ?? null,
    coords: t.match(/Coordenadas\s+(-?[\d.]+,\s*-?[\d.]+)/i)?.[1]?.replace(/\s/g, '') ?? null,
    url,
  };
}

const pendientes = readFileSync(LISTA, 'utf8').split('\n').map(s => s.trim())
  .filter(s => s && s.replace('https://', '').split('/').length >= 4 && !hechas.has(s));
console.log(`${pendientes.length} pendientes · ${hechas.size} ya hechas · ${Object.keys(st.estaciones).length} con permiso`);

let n = 0;
for (const u of pendientes.slice(0, LIMITE)) {
  try {
    const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; likida-research/1.0)' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(String(r.status));
    const e = extraer(await r.text(), u);
    // La llave es el permiso CRE: es lo que viene en el ticket. Sin permiso la
    // ficha no sirve para identificar, así que se cuenta y se descarta.
    if (e.permisoCre) st.estaciones[e.permisoCre] = e; else st.sinPermiso++;
    n++;
  } catch { st.fallos++; }
  hechas.add(u);
  if (n && n % 250 === 0) {
    st.hechas = [...hechas]; writeFileSync(OUT, JSON.stringify(st));
    console.log(`  ${n} · ${Object.keys(st.estaciones).length} permisos`);
  }
  await new Promise(s => setTimeout(s, PAUSA));
}
st.hechas = [...hechas];
writeFileSync(OUT, JSON.stringify(st));
const marcas = {};
for (const e of Object.values(st.estaciones)) if (e.compania) marcas[e.compania] = (marcas[e.compania] ?? 0) + 1;
console.log(`\n${Object.keys(st.estaciones).length} permisos CRE · ${st.sinPermiso} sin permiso · ${st.fallos} fallos`);
console.log('\nMARCAS CON MÁS ESTACIONES:');
for (const [m, c] of Object.entries(marcas).sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${String(c).padStart(5)}  ${m}`);
