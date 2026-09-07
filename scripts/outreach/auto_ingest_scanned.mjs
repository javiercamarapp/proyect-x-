import fs from 'fs';
import path from 'path';
import { saveCompanyResult, crearSiNoExiste } from './canacar_runner.mjs';

const brainDir = '/Users/javiercamaraportepetit/.gemini/antigravity-cli/brain';
const stagingDir = '/Users/javiercamaraportepetit/likida/staging_canacar';
const trackerPath = '/Users/javiercamaraportepetit/likida/staging_canacar/ingested_files.json';

// Initialize tracker if it doesn't exist — sin el hueco entre comprobar y
// escribir del patrón existsSync+writeFileSync (ver canacar_runner.mjs).
crearSiNoExiste(trackerPath, JSON.stringify([], null, 2));

async function run() {
  const processedFiles = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
  const processedSet = new Set(processedFiles);

  const dirs = fs.readdirSync(brainDir);
  console.log(`Scanning subagent directories and staging...`);

  let newIngested = [];
  let filesToScan = [];

  // Gather brain subdirectories files
  for (const d of dirs) {
    if (d === '35f4055e-6432-45cf-b68a-fe5e9b5c5daf') continue; // skip parent
    const fullPath = path.join(brainDir, d);
    
    if (fs.statSync(fullPath).isDirectory()) {
      let files = [];
      try {
        files = fs.readdirSync(fullPath);
      } catch (e) {
        continue;
      }
      for (const f of files) {
        if (f.endsWith('.json') && !f.endsWith('.metadata.json')) {
          filesToScan.push(path.join(fullPath, f));
        }
      }
    }
  }

  // Gather staging_canacar results files
  if (fs.existsSync(stagingDir)) {
    const stagingFiles = fs.readdirSync(stagingDir);
    for (const f of stagingFiles) {
      if (f.endsWith('.json') && !f.includes('candidates') && !f.includes('progress_state') && !f.includes('ingested_files')) {
        // Also skip raw input chunks like batch5_chunk_1.json unless it has results
        if (/batch\d+_chunk_\d+\.json$/.test(f)) continue;
        filesToScan.push(path.join(stagingDir, f));
      }
    }
  }

  for (const filePath of filesToScan) {
    if (processedSet.has(filePath)) continue;

    // Attempt to parse and ingest
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].empresa) {
        console.log(`\n>>> Found new results file: ${filePath}`);
        console.log(`Ingesting ${parsed.length} companies...`);
        
        for (const item of parsed) {
          console.log(`Ingesting ${item.empresa}...`);
          await saveCompanyResult(item);
        }
        
        processedSet.add(filePath);
        newIngested.push(filePath);
      }
    } catch (e) {
      // Not a results file or parsing failed
    }
  }

  if (newIngested.length > 0) {
    fs.writeFileSync(trackerPath, JSON.stringify(Array.from(processedSet), null, 2), 'utf8');
    console.log(`\nSuccessfully ingested ${newIngested.length} files!`);
  } else {
    console.log('\nNo new files to ingest.');
  }
}

run().catch(console.error);
