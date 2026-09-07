// process_all_remaining.mjs
// ---------------------------------------------------------------
// 1️⃣  Prepara todos los batches que aún no tienen chunks.
// 2️⃣  Lanza sub‑agentes flash‑lite para cada chunk.
// 3️⃣  Ejecuta la ingestión final con auto_ingest_scanned.mjs.
// ---------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd(); // /Users/javiercamaraportepetit/likida
const STAGING = path.join(ROOT, "staging_canacar"); // datos de entrada / salida
const SCRIPTS = path.join(ROOT, "scripts", "outreach");

// ------------------------------------------------------------------
// 1️⃣  Preparar batches que todavía no tienen archivos *_chunk_*.json
// ------------------------------------------------------------------
function prepareMissingBatches() {
  const existing = new Set(
    readdirSync(STAGING)
      .filter(f => f.match(/^batch\d+_chunk_\d+\.json$/))
      .map(f => Number(f.match(/^batch(\d+)_/)[1]))
  );

  const candidates = readdirSync(STAGING)
    .filter(f => f.endsWith("_candidates.json"))
    .map(f => Number(f.match(/^batch(\d+)_candidates/)[1]))
    .sort((a, b) => a - b);

  for (const batch of candidates) {
    if (!existing.has(batch)) {
      console.log(`▶️  Preparando batch ${batch}…`);
      const scriptPath = path.join(SCRIPTS, `prepare_batch${batch}.mjs`);
      // Sólo ejecutar si el script realmente existe
      if (!existsSync(scriptPath)) {
        console.log(`⚠️  No se encontró script para batch ${batch}, se omite.`);
        continue;
      }
      execFileSync(process.execPath, [scriptPath], { stdio: "inherit" });
    }
  }
}

// ------------------------------------------------------------------
// 2️⃣  Lanzar sub‑agentes (flash‑lite) para cada chunk que aún no tiene su archivo *_results.json
// ------------------------------------------------------------------
function launchSubagents() {
  const chunkFiles = readdirSync(STAGING)
    .filter(f => f.match(/^batch\d+_chunk_\d+\.json$/));

  for (const chunkFile of chunkFiles) {
    const base = chunkFile.replace('.json', '');
    const resultFile = `${base}_results.json`;
    if (readdirSync(STAGING).includes(resultFile)) continue;
    console.log(`🚀  Lanzando sub‑agente para ${chunkFile}…`);
    const subName = `${base}_researcher`;
    const prompt = `
Investiga a fondo las 5 empresas mexicanas de transporte listadas en el archivo
${path.join(STAGING, chunkFile)}.

Para cada empresa busca:
- Director General / Dueño (nombre y puesto)
- LinkedIn (Director y Empresa)
- Página Facebook oficial
- Año de fundación y breve historia (2‑4 frases)
- Número estimado de empleados y flota
- TODOS los correos y teléfonos (CEDIS/Patios)
- Encaje Likida: SI / NO / DUDOSO
- Si es **SI**, redacta correo de venta hiperpersonalizado con:
  * Asunto: "Automatizar la liquidación de viajes, antes de contratar para el puesto"
  * Apertura al DG mencionando flota, rutas o patios
  * Presentación de Likida (liquidar por WhatsApp en tiempo real, cuadre de anticipos de diésel y casetas)
  * Sin em‑dashes, usando viñetas (•) o comas
  * 6 agentes Likida (Liquidación, Facturas, Cobranza, Conductores, Peajes, Proveedores)
  * Prueba social: Grupo GAL y Transportes Innovativos
  * Sin riesgo: levantamiento gratis, mes 1 gratis, pago a partir del mes 3
  * Cierre: "¿Tendrían 30 minutos esta semana o la próxima para platicarlo?"
Guarda el JSON resultante en ${path.join(STAGING, resultFile)} con {id, empresa, …, correo_venta, fecha, lote}`.trim();
    execFileSync("agy", ["subagents", "launch", "--name", subName, "--model", "flash_lite", "--workspace", ROOT, "-p", prompt], { stdio: "inherit" });
  }
}

// ------------------------------------------------------------------
// 3️⃣  Esperar a que terminen los sub‑agentes y ejecutar la ingestión
// ------------------------------------------------------------------
function waitAndIngest() {
  console.log('\n⏳  Esperando a que los sub‑agentes terminen…');
  const maxAttempts = 60; // 30 min máximo
  for (let i = 0; i < maxAttempts; i++) {
    const pending = readdirSync(STAGING)
      .filter(f => f.match(/^batch\d+_chunk_\d+\.json$/))
      .some(f => !readdirSync(STAGING).includes(f.replace('.json', '_results.json')));
    if (!pending) break;
    process.stdout.write('.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  }
  console.log('\n✅  Todos los resultados están listos. Ejecutando ingestión…');
  execFileSync(process.execPath, [path.join(SCRIPTS, 'auto_ingest_scanned.mjs')], { stdio: 'inherit' });
}

prepareMissingBatches();
launchSubagents();
waitAndIngest();

console.log('\n🎉  ¡Proceso completado! 🎉');
