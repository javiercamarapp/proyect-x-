#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// COSECHADOR DE SITIOS DE PROSPECTOS — 26-ago-2026
//
// POR QUÉ EXISTE. Hay ~5,500 prospectos con `sitio` mapeado y sin decisor.
// Investigarlos "uno por uno" con buscador toma años y los buscadores
// (DDG/Bing/Mojeek) bloquean el acceso anónimo de curl a las pocas peticiones.
// Pero el sitio oficial NO necesita buscador: la URL ya está en la base. Un
// fetch directo trae texto, correos, teléfonos y a veces nombres de directivos
// — gratis, sin rate limit externo y sin depender de nadie.
//
// QUÉ HACE por cada prospecto pendiente:
//   1. Trae https://<sitio> (con fallbacks http/www). 1 nivel de profundidad:
//      si encuentra enlaces a nosotros/quienes-somos/equipo/contacto, los baja
//      también (máx 3 subpáginas) porque ahí viven los nombres.
//   2. Extrae: título, texto limpio, correos, teléfonos 10 dígitos MX, y
//      nombres propios junto a palabras de cargo (director/gerente/dueño...).
//   3. Guarda el JSON crudo en SALIDA (reanudable: si existe, se salta).
//   4. Escribe de vuelta a Supabase: `sitio_verificado` según respondió o no,
//      `correo` SOLO si estaba null y salió público del sitio, y nota
//      `COSECHA <fecha>: ...` (marcador distinto de PROSPECCIÓN para que el
//      agente diario siga pasando por aquí con el contexto ya listo).
//
// ES REANUDABLE A PROPÓSITO: corta y vuelve a correr, sigue donde iba.
//
//   node scripts/cosecha/prospectos.mjs                  # todo lo pendiente
//   node scripts/cosecha/prospectos.mjs --limite 50      # una tanda
//   node scripts/cosecha/prospectos.mjs --sin-escribir   # solo cosechar al disco
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const AQUI = dirname(new URL(import.meta.url).pathname);
const SALIDA = join(AQUI, 'salida-prospectos');
const ENV = join(AQUI, '../../.env.local');

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const LIMITE = Number(arg('--limite', '0')) || Infinity;
const PAUSA = Number(arg('--pausa', '1200'));       // cortesía: es un sitio ajeno
const TIMEOUT_MS = Number(arg('--timeout', '15000'));
const ESCRIBIR = !process.argv.includes('--sin-escribir');

// credenciales del .env.local del repo (mismo patrón que usa mejora-diaria)
for (const linea of readFileSync(ENV, 'utf8').split('\n')) {
  const m = linea.match(/^([A-Z_]+)=\s*"?([^"#\r\n]*?)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error('Faltan credenciales Supabase en .env.local'); process.exit(1); }

mkdirSync(SALIDA, { recursive: true });
const hoy = new Date().toISOString().slice(0, 10);
const dormi = (ms) => new Promise((r) => setTimeout(r, ms));

/** EAFP: evita el TOCTOU de existsSync()+readFileSync() sobre el mismo archivo. */
function leerJsonSiExiste(ruta) {
  try { return JSON.parse(readFileSync(ruta, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function sbFetch(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json', ...(opts.headers || {}),
    },
  });
  if (!r.ok && r.status !== 204) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r;
}

/** Trae una URL con timeout; devuelve texto o null. Sin UA mentiroso: decimos quiénes somos. */
async function traer(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LikidaCosecha/1.0; +https://likida.ai)' },
    });
    if (!r.ok) return null;
    const tipo = r.headers.get('content-type') || '';
    if (!tipo.includes('html') && !tipo.includes('text')) return null;
    return await r.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

const limpio = (s) => s?.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim() || null;

const CARGO = /(director[ao]|gerente|dueñ[oa]|fundad(?:or|ora)|propietari[oa]|presidente|ceo|encargad[oa]|titular)/i;
const NOMBRE = /\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}){1,3}\b/g;

function extraer(htmls, dominio) {
  const todo = htmls.map((h) => h.html).join('\n');
  const texto = limpio(todo) || '';
  const f = { dominio, cosechado: new Date().toISOString(), paginas: htmls.map((h) => h.url) };
  f.titulo = limpio(htmls[0].html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]);
  f.texto_muestra = texto.slice(0, 3000);

  // correos públicos del sitio — nunca adivinados, solo los que están escritos
  f.correos = [...new Set(texto.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])]
    .filter((c) => !/\.(png|jpg|jpeg|gif|webp|css|js)$/i.test(c)).slice(0, 6);
  f.telefonos = [...new Set(texto.replace(/[\s()-]/g, '').match(/\b(?:52)?\d{10}\b/g) || [])]
    .filter((t) => !/^0{5}|^12345/.test(t)).slice(0, 4);

  // nombres junto a cargo: ventana de ±90 caracteres alrededor de cada mención
  const nombres = [];
  for (const m of texto.matchAll(new RegExp(CARGO.source, 'gi'))) {
    const v = texto.slice(Math.max(0, m.index - 90), m.index + m[0].length + 90);
    for (const n of v.match(NOMBRE) || []) {
      const nl = n.toLowerCase();
      if (!/(empresa|transporte|logistic|grupo|servicio|solucion|camion|carga|queretaro|mexico|guadalajara|monterrey|s\.?a\.?|de cv|copyright|todos los derechos)/i.test(nl))
        nombres.push(n);
    }
  }
  f.candidatos_decisor = [...new Set(nombres)].slice(0, 8);
  f.hallazgo_cargo = (texto.match(new RegExp('[^.]{0,80}' + CARGO.source + '[^.]{0,100}', 'gi')) || []).slice(0, 5)
    .map((s) => s.trim());
  return f;
}

/** Subpáginas donde suelen vivir nombres: 1 nivel, máx 3. */
function subpaginas(html, base) {
  const out = [];
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    const h = m[1];
    if (/nosotros|quienes[-_]somos|equipo|directorio|contacto|empresa|historia/i.test(h) && !/^mailto:|^tel:/i.test(h)) {
      try { out.push(new URL(h, base).href); } catch {}
    }
  }
  return [...new Set(out)].slice(0, 3);
}

/** Variantes de URL: https→http, con/sin www. La primera que responda gana. */
async function traerSitio(sitio) {
  const d = sitio.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const variantes = [`https://${d}`, `https://www.${d}`, `http://${d}`, `http://www.${d}`];
  for (const u of variantes) {
    const html = await traer(u);
    if (html && html.length > 200) return { url: u, html, dominio: d };
    await dormi(300);
  }
  return null;
}

// ── Lote: con sitio, sin decisor, sin COSECHA previa ──
console.log(' trayendo lote de Supabase…');
const q = 'prospecto?select=id,empresa,sitio,correo,notas'
  + '&sitio=not.is.null&contacto_nombre=is.null'
  + '&notas=not.ilike.*COSECHA*&order=necesidad_pct.desc.nullslast,id.asc'
  + `&limit=${LIMITE}`;
const lote = await (await sbFetch(q)).json();
console.log(` lote: ${lote.length} prospectos`);

let vivos = 0, muertos = 0, correos_nuevos = 0;
let n = 0;
for (const p of lote) {
  n++;
  const etiqueta = `${n}/${lote.length} ${p.empresa?.slice(0, 40)}`;
  if (!/^[0-9a-f-]{36}$/i.test(p.id)) { console.log(` ${etiqueta} → id no es uuid, se salta`); continue; }
  const archivo = join(SALIDA, `${p.id}.json`);
  let data = leerJsonSiExiste(archivo);                           // reanudar: ya está en disco
  if (!data) {
    const hit = await traerSitio(p.sitio);
    if (!hit) {
      data = { id: p.id, empresa: p.empresa, sitio: p.sitio, vivo: false, cosechado: new Date().toISOString() };
    } else {
      const paginas = [{ url: hit.url, html: hit.html }];
      for (const sub of subpaginas(hit.html, hit.url)) {
        const sh = await traer(sub);
        if (sh) paginas.push({ url: sub, html: sh });
        await dormi(PAUSA);
      }
      data = { id: p.id, empresa: p.empresa, sitio: p.sitio, vivo: true, ...extraer(paginas, hit.dominio) };
    }
    writeFileSync(archivo, JSON.stringify(data, null, 1));
    await dormi(PAUSA);
  }

  if (data.vivo) vivos++; else muertos++;

  if (ESCRIBIR) {
    const parche = { sitio_verificado: !!data.vivo };
    // correo: SOLO hueco, SOLO correo publicado en su propio sitio
    if (!p.correo && data.correos?.length) {
      parche.correo = data.correos.find((c) => c.includes(data.dominio)) || data.correos[0];
      correos_nuevos++;
    }
    const partes = [];
    if (data.vivo) {
      partes.push(`sitio vivo (${data.paginas?.length || 1} pág)`);
      if (data.titulo) partes.push(`"${data.titulo}"`);
      if (data.correos?.length) partes.push(`correos: ${data.correos.join(', ')}`);
      if (data.candidatos_decisor?.length) partes.push(`posibles directivos: ${data.candidatos_decisor.join(', ')}`);
      else partes.push('sin directivos públicos');
    } else {
      partes.push('sitio CAÍDO o inaccesible');
    }
    const nota = `COSECHA ${hoy}: ${partes.join(' · ')}`;
    parche.notas = ((p.notas || '') + ' · ' + nota).replace(/^ · /, '');
    try {
      await sbFetch(`prospecto?id=eq.${p.id}`, { method: 'PATCH', body: JSON.stringify(parche) });
    } catch (e) { console.log(`  ⚠ PATCH falló ${p.id}: ${e.message}`); }
  }
  console.log(` ${etiqueta} → ${data.vivo ? `VIVO${data.candidatos_decisor?.length ? ` ★ ${data.candidatos_decisor.length} candidatos` : ''}` : 'caído'}`);
}

console.log(`\nVEREDICTO: ${vivos} sitios vivos, ${muertos} caídos, ${correos_nuevos} correos nuevos${ESCRIBIR ? ', escrito a Supabase' : ' (modo --sin-escribir)'}`);
